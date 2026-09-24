use crate::{
    app::{self, AppState},
    auth::{Auth, AuthMode},
    scoped_db::ScopedDb,
    store::Store,
};
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use std::{collections::HashMap, sync::Arc};
use tower::ServiceExt;
use uuid::Uuid;

const ORIGIN: &str = "https://cloud.example.com";
const PROXY: &str = "isolated-test-proxy-secret-32-bytes-minimum";
const CSRF: &str = "isolated-test-csrf-secret-32-bytes-minimum";

mod ingestion_regressions;
mod invitation_regressions;
mod reader_performance_regressions;

fn principal(tenant: Uuid, object: Uuid, name: &str) -> String {
    STANDARD.encode(
        serde_json::to_vec(&json!({"auth_typ":"aad","claims":[
            {"typ":"tid","val":tenant},{"typ":"oid","val":object},{"typ":"name","val":name}
        ]}))
        .unwrap(),
    )
}

async fn send(
    app: &Router,
    principal: Option<&str>,
    method: &str,
    path: &str,
    body: Value,
    csrf: Option<&str>,
    origin: Option<&str>,
    proxy: bool,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if proxy {
        request = request.header("x-scoutnews-proxy-token", PROXY);
    }
    if let Some(value) = principal {
        request = request.header("x-ms-client-principal", value);
    }
    if let Some(value) = csrf {
        request = request.header("x-csrf-token", value);
    }
    if let Some(value) = origin {
        request = request.header("origin", value);
    }
    let response = app
        .clone()
        .oneshot(
            request
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({"text":String::from_utf8_lossy(&bytes)}));
    (status, value)
}

struct Reader {
    app: Router,
    principal: String,
    id: Uuid,
    csrf: String,
}
impl Reader {
    async fn new(app: &Router, principal: String) -> Self {
        let (status, session) = send(
            app,
            Some(&principal),
            "GET",
            "/api/v1/session",
            Value::Null,
            None,
            None,
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "session: {session}");
        assert_eq!(session["capabilities"]["manageReadingSettings"], false);
        assert_eq!(session["telemetryConsent"], false);
        Self {
            app: app.clone(),
            principal,
            id: session["user"]["id"].as_str().unwrap().parse().unwrap(),
            csrf: session["csrfToken"].as_str().unwrap().into(),
        }
    }
    async fn call(&self, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
        send(
            &self.app,
            Some(&self.principal),
            method,
            path,
            body,
            Some(&self.csrf),
            Some(ORIGIN),
            true,
        )
        .await
    }
    async fn ok(&self, method: &str, path: &str, body: Value) -> Value {
        let (status, value) = self.call(method, path, body).await;
        assert_eq!(status, StatusCode::OK, "{method} {path}: {value}");
        value
    }
}

async fn fixture(pool: &PgPool, owner: Option<String>, name: &str) -> anyhow::Result<(Uuid, Uuid)> {
    let source = Uuid::new_v4();
    let event = Uuid::new_v4();
    let content = Uuid::new_v4();
    sqlx::query("INSERT INTO sources(id,name,endpoint,content_type,adapter_type,tier,lifecycle_status,last_success_at,owner_user_id)
        VALUES($1,$2,$3,'blog','rss','T1','stable',now(),$4)")
        .bind(source).bind(name).bind(format!("https://example.com/{source}/feed")).bind(&owner).execute(pool).await?;
    sqlx::query("INSERT INTO events(id,canonical_title,summary,importance,primary_topic,event_type,
        first_seen_at,updated_at,summary_kind,summary_model,summary_format_version,content_version,
        summary_points,summarized_at,owner_user_id)
        VALUES($1,$2,$3,'Measured results','工程与开源','blog',now()-interval '1 hour',now(),'copilot','gpt-5.6-terra',3,1,$4,now(),$5)")
        .bind(event).bind(format!("{name} technical report architecture evaluation"))
        .bind(format!("{name} unique reviewed summary with benchmark results."))
        .bind(json!([format!("{name} benchmark findings are bounded by the published experiment.")]))
        .bind(&owner).execute(pool).await?;
    sqlx::query("INSERT INTO content_items(id,source_id,content_type,original_url,canonical_url,title,content_hash,published_at,metadata)
        VALUES($1,$2,'blog',$3,$3,$4,$5,now()-interval '1 hour',$6)")
        .bind(content).bind(source).bind(format!("https://example.com/research/{event}"))
        .bind(format!("{name} technical report architecture evaluation")).bind(content.to_string())
        .bind(json!({"feedSummary":format!("{name} architecture benchmark experiment measured latency and throughput. ").repeat(20)}))
        .execute(pool).await?;
    sqlx::query(
        "INSERT INTO event_evidence(event_id,content_item_id,is_official) VALUES($1,$2,true)",
    )
    .bind(event)
    .bind(content)
    .execute(pool)
    .await?;
    Ok((source, event))
}

fn root(pool: PgPool, invitations: &[(Uuid, Uuid)]) -> AppState {
    let auth = Arc::new(Auth {
        mode: AuthMode::Azure {
            origin: ORIGIN.into(),
            proxy_secret: PROXY.into(),
            csrf_secret: CSRF.into(),
            invited_readers: invitations
                .iter()
                .map(|(tenant, object)| format!("{tenant}:{object}"))
                .collect(),
        },
        pool: Some(pool.clone()),
    });
    AppState {
        store: Arc::new(crate::postgres_store::PostgresStore::new(pool.clone())),
        http: reqwest::Client::new(),
        oauth_states: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        provider: Arc::new(tokio::sync::RwLock::new(app::ProviderConnection::default())),
        feed_worker: Some(crate::ingestion::FeedWorker::new(
            pool.clone(),
            reqwest::Client::new(),
        )),
        generation_lock: Arc::new(tokio::sync::Mutex::new(())),
        automation: Some(crate::automation::AutomationStore::new(pool.clone())),
        edition: Some(crate::edition::EditionStore::new(pool.clone())),
        publishing: Some(crate::publishing::Publishing {
            pool: ScopedDb::from(pool).reader("local"),
            public_origin: Some(ORIGIN.into()),
        }),
        auth,
        identity: None,
    }
}

#[tokio::test]
#[ignore = "requires a NEW isolated scoutnews_cloud_test_<uuid> DB; run tests/run-cloud-isolation.ps1"]
async fn complete_two_reader_isolation_contract() -> anyhow::Result<()> {
    let url = std::env::var("SCOUTNEWS_CLOUD_TEST_DATABASE_URL")?;
    let parsed = url::Url::parse(&url)?;
    anyhow::ensure!(
        parsed.host_str() == Some("127.0.0.1")
            && parsed.path().starts_with("/scoutnews_cloud_test_")
            && parsed
                .path()
                .trim_start_matches("/scoutnews_cloud_test_")
                .len()
                == 32,
        "disposable cloud-test database required"
    );
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(6)
        .connect(&url)
        .await?;
    let privileges = sqlx::query(
        "SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=current_user",
    )
    .fetch_one(&pool)
    .await?;
    assert!(
        !privileges.try_get::<bool, _>("rolsuper")?,
        "runtime/migration owner must not be superuser"
    );
    assert!(
        !privileges.try_get::<bool, _>("rolbypassrls")?,
        "runtime/migration owner must not have BYPASSRLS"
    );
    assert!(
        privileges.try_get::<bool, _>("rolcreaterole")?,
        "isolated migrator must exercise restricted role provisioning"
    );
    assert!(
        !sqlx::query_scalar::<_, bool>("SELECT to_regclass('app_users') IS NOT NULL")
            .fetch_one(&pool)
            .await?,
        "test database must be new, not a personal or previously initialized DB"
    );
    let mut migrator = sqlx::migrate!("./migrations");
    let all_migrations = migrator.migrations.clone();
    migrator.migrations = std::borrow::Cow::Owned(
        all_migrations
            .iter()
            .filter(|migration| migration.version <= 24)
            .cloned()
            .collect(),
    );
    migrator.run(&pool).await?;
    let legacy = ingestion_regressions::seed_legacy_mixed_event(&pool).await?;
    migrator.migrations = std::borrow::Cow::Owned(
        all_migrations
            .iter()
            .filter(|migration| migration.version <= 26)
            .cloned()
            .collect(),
    );
    migrator.run(&pool).await?;
    legacy.verify_quarantine_before_repair(&pool).await?;
    migrator.migrations = all_migrations;
    migrator.run(&pool).await?;
    verify_explicit_role_membership(&pool).await?;
    crate::source_directory::import(&pool).await?;
    sqlx::query("UPDATE interest_profiles SET profile=$1 WHERE user_id='local'")
        .bind(json!({"topics":[{"id":"local","label":"LOCAL_OWNER_SENTINEL","group":"local","context":"work","weight":99,"enabled":true}]}))
        .execute(&pool).await?;
    sqlx::query("UPDATE app_settings SET value=jsonb_set(value::jsonb,'{dailyLimit}','5000')::text WHERE key='summary_settings'")
        .execute(&pool).await?;
    let tenant = Uuid::new_v4();
    let identities = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
    let invitations = identities.map(|object| (tenant, object));
    let state = root(pool.clone(), &invitations);
    let app = app::router(state.clone());
    let a = Reader::new(&app, principal(tenant, identities[0], "Same display name")).await;
    let b = Reader::new(&app, principal(tenant, identities[1], "Same display name")).await;
    assert_ne!(a.id, b.id);
    assert_ne!(a.csrf, b.csrf);
    invitation_regressions::verify_admission(&pool, &app, &a, tenant, identities[0]).await?;
    let (shared_source, shared) = fixture(&pool, None, "PUBLIC_FIXTURE").await?;
    let (a_source, a_event) = fixture(&pool, Some(a.id.to_string()), "PRIVATE_ALPHA").await?;
    let (b_source, b_event) = fixture(&pool, Some(b.id.to_string()), "PRIVATE_BETA").await?;
    assert_eq!(
        a.call(
            "POST",
            &format!("/api/v1/events/{shared}/summarize"),
            json!({"model":"gpt-5.6-terra"})
        )
        .await
        .0,
        StatusCode::PRECONDITION_FAILED
    );
    assert_eq!(
        a.call(
            "POST",
            &format!("/api/v1/events/{shared}/summarize"),
            json!({"model":"gpt-5.5"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    for (principal_value, csrf, origin, proxy, expected) in [
        (None, None, None, true, StatusCode::UNAUTHORIZED),
        (Some("forged"), None, None, true, StatusCode::UNAUTHORIZED),
        (
            Some(a.principal.as_str()),
            None,
            None,
            false,
            StatusCode::UNAUTHORIZED,
        ),
        (
            Some(a.principal.as_str()),
            None,
            Some(ORIGIN),
            true,
            StatusCode::FORBIDDEN,
        ),
        (
            Some(a.principal.as_str()),
            Some(b.csrf.as_str()),
            Some(ORIGIN),
            true,
            StatusCode::FORBIDDEN,
        ),
        (
            Some(a.principal.as_str()),
            Some(a.csrf.as_str()),
            None,
            true,
            StatusCode::FORBIDDEN,
        ),
        (
            Some(a.principal.as_str()),
            Some(a.csrf.as_str()),
            Some("https://evil.example"),
            true,
            StatusCode::FORBIDDEN,
        ),
    ] {
        let (status, _) = send(
            &app,
            principal_value,
            "PUT",
            &format!("/api/v1/events/{shared}/state"),
            json!({"saved":true}),
            csrf,
            origin,
            proxy,
        )
        .await;
        assert_eq!(status, expected);
    }
    for (method, path) in [
        ("PUT", "/api/v1/reader-settings"),
        ("PUT", "/api/v1/processing/settings"),
        ("POST", "/api/v1/model-providers/github-copilot/local"),
        ("GET", "/api/v1/auth/github/start"),
        ("PUT", "/api/v1/share-settings"),
        ("POST", "/api/v1/processing/retry"),
    ] {
        assert_eq!(
            a.call(method, path, json!({})).await.0,
            StatusCode::FORBIDDEN
        );
    }
    let initial = a.ok("GET", "/api/v1/me/interests", Value::Null).await;
    assert!(!initial.to_string().contains("LOCAL_OWNER_SENTINEL"));
    let mut topics = initial["items"].as_array().unwrap().clone();
    topics[0]["weight"] = json!(7);
    topics[0]["label"] = json!("ALPHA_INTEREST");
    a.ok("PUT", "/api/v1/me/interests", json!({"topics":topics}))
        .await;
    assert!(
        !b.ok("GET", "/api/v1/me/interests", Value::Null)
            .await
            .to_string()
            .contains("ALPHA_INTEREST")
    );
    a.ok(
        "PUT",
        &format!("/api/v1/events/{shared}/state"),
        json!({"saved":true,"read":true,"opened":true}),
    )
    .await;
    a.ok(
        "POST",
        "/api/v1/events/exposures",
        json!({"items":[{"eventId":shared,"contentVersion":1}]}),
    )
    .await;
    let own = a
        .ok("GET", &format!("/api/v1/events/{shared}"), Value::Null)
        .await;
    let other = b
        .ok("GET", &format!("/api/v1/events/{shared}"), Value::Null)
        .await;
    assert_eq!(own["saved"], true);
    assert_eq!(other["saved"], false);
    assert_eq!(other["opened"], false);
    for path in [
        format!("/api/v1/events/{a_event}"),
        format!("/api/v1/events/{a_event}?interests=agents:100"),
    ] {
        assert_eq!(
            b.call("GET", &path, Value::Null).await.0,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        b.call(
            "PUT",
            &format!("/api/v1/events/{a_event}/state"),
            json!({"saved":true})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    for path in [
        "/api/v1/events?coverage=true",
        "/api/v1/events?limit=1&offset=1",
        "/api/v1/events?interests=agents:100",
        "/api/v1/explore",
        "/api/v1/weekly",
        "/api/v1/briefs/latest",
        "/api/v1/sources/coverage",
        "/api/v1/reader-status",
        "/api/v1/processing",
    ] {
        let value = b.ok("GET", path, Value::Null).await;
        assert!(
            !value.to_string().contains("PRIVATE_ALPHA"),
            "leak at {path}"
        );
        assert!(
            !value.to_string().contains(&a_source.to_string()),
            "source id leak at {path}"
        );
    }
    let sources = a.ok("GET", "/api/v1/sources", Value::Null).await;
    assert!(!sources.to_string().contains("PRIVATE_BETA"));
    a.ok(
        "PUT",
        &format!("/api/v1/sources/{shared_source}"),
        json!({"enabled":false}),
    )
    .await;
    assert_eq!(
        a.call("GET", &format!("/api/v1/events/{shared}"), Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    b.ok("GET", &format!("/api/v1/events/{shared}"), Value::Null)
        .await;
    a.ok(
        "PUT",
        &format!("/api/v1/sources/{shared_source}"),
        json!({"enabled":true,"scheduleMinutes":120}),
    )
    .await;
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT lifecycle_status FROM sources WHERE id=$1")
            .bind(shared_source)
            .fetch_one(&pool)
            .await?,
        "stable"
    );
    assert_eq!(
        b.call(
            "PUT",
            &format!("/api/v1/sources/{a_source}"),
            json!({"enabled":false})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        b.call(
            "POST",
            &format!("/api/v1/sources/{a_source}/refresh"),
            json!({})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let source_input = json!({"name":"MY_REGISTERED_POSTS","endpoint":"https://x.com/testreader","adapter":"x_public_preview",
        "contentType":"blog","tier":"T2","scheduleMinutes":60,"originalPostUrls":["https://x.com/testreader/status/1234567890123456789"]});
    let custom_a = a.ok("POST", "/api/v1/sources", source_input.clone()).await;
    let custom_b = b.ok("POST", "/api/v1/sources", source_input).await;
    assert_ne!(custom_a["id"], custom_b["id"]);
    let registry = format!(
        "/api/v1/sources/{}/x-posts",
        custom_a["id"].as_str().unwrap()
    );
    a.ok("GET", &registry, Value::Null).await;
    assert_eq!(
        b.call("GET", &registry, Value::Null).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        b.call(
            "PUT",
            &registry,
            json!({"urls":["https://x.com/testreader/status/2234567890123456789"]})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    a.ok(
        "PUT",
        &registry,
        json!({"urls":["https://x.com/testreader/status/2234567890123456789"]}),
    )
    .await;
    let catalog_x = Uuid::new_v4();
    sqlx::query("INSERT INTO sources(id,name,endpoint,content_type,adapter_type,tier,lifecycle_status,compliance)
        VALUES($1,'Public profile','https://x.com/catalogreader','blog','x_public_preview','T2','observing',$2)")
        .bind(catalog_x).bind(json!({"originalPostUrls":["https://x.com/catalogreader/status/3234567890123456789"]}))
        .execute(&pool).await?;
    let catalog_registry = format!("/api/v1/sources/{catalog_x}/x-posts");
    let fork = a
        .ok(
            "PUT",
            &catalog_registry,
            json!({"urls":["https://x.com/catalogreader/status/4234567890123456789"]}),
        )
        .await;
    assert_ne!(fork["sourceId"], catalog_x.to_string());
    assert_eq!(
        a.ok("GET", &catalog_registry, Value::Null).await["urls"][0],
        "https://x.com/catalogreader/status/4234567890123456789"
    );
    assert_eq!(
        b.ok("GET", &catalog_registry, Value::Null).await["urls"][0],
        "https://x.com/catalogreader/status/3234567890123456789"
    );
    assert_eq!(
        b.call(
            "GET",
            &format!(
                "/api/v1/sources/{}/x-posts",
                fork["sourceId"].as_str().unwrap()
            ),
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let share = a
        .ok(
            "POST",
            "/api/v1/shares",
            json!({"kind":"event","eventId":a_event}),
        )
        .await;
    let id = share["id"].as_str().unwrap();
    assert_eq!(
        send(
            &app,
            None,
            "GET",
            &format!("/api/v1/public/shares/{id}"),
            Value::Null,
            None,
            None,
            true
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    for (method, path) in [
        ("GET", format!("/api/v1/shares/{id}")),
        ("DELETE", format!("/api/v1/shares/{id}")),
        ("POST", format!("/api/v1/shares/{id}/publish")),
        ("PUT", format!("/api/v1/shares/{id}/draft")),
    ] {
        let body = if method == "PUT" {
            editor(&share)
        } else {
            json!({})
        };
        assert_eq!(b.call(method, &path, body).await.0, StatusCode::NOT_FOUND);
    }
    assert!(
        !b.ok("GET", "/api/v1/shares", Value::Null)
            .await
            .to_string()
            .contains(id)
    );
    assert_eq!(
        b.call(
            "POST",
            "/api/v1/shares",
            json!({"kind":"brief","date":"latest","selection":[
        {"eventId":a_event,"contentVersion":1,"summarizedAt":null}]})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    a.ok("PUT", &format!("/api/v1/shares/{id}/draft"), editor(&share))
        .await;
    let published = a
        .ok(
            "POST",
            &format!("/api/v1/shares/{id}/publish"),
            json!({"editor":editor(&share)}),
        )
        .await;
    assert_eq!(published["publicUrl"], format!("{ORIGIN}/p/{id}"));
    let (status, public) = send(
        &app,
        None,
        "GET",
        &format!("/api/v1/public/shares/{id}"),
        Value::Null,
        None,
        None,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(public["title"], "Explicit public title");
    assert!(public.get("editor").is_none());
    assert!(!public.to_string().contains(&a.id.to_string()));
    assert_eq!(
        a.call("PUT", &format!("/api/v1/shares/{id}/draft"), editor(&share))
            .await
            .0,
        StatusCode::CONFLICT
    );
    a.ok("DELETE", &format!("/api/v1/shares/{id}"), json!({}))
        .await;
    assert_eq!(
        send(
            &app,
            None,
            "GET",
            &format!("/api/v1/public/shares/{id}"),
            Value::Null,
            None,
            None,
            true
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    verify_atomic_publishing(&a, &b, a_event, shared).await;
    a.ok("POST", "/api/v1/briefs/today/generate", json!({}))
        .await;
    assert_eq!(
        b.ok("GET", "/api/v1/briefs", Value::Null).await["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    b.ok("POST", "/api/v1/briefs/today/generate", json!({}))
        .await;
    let saved =
        sqlx::query("SELECT owner_user_id,id FROM daily_briefs WHERE owner_user_id=ANY($1)")
            .bind(vec![a.id.to_string(), b.id.to_string()])
            .fetch_all(&pool)
            .await?;
    assert_eq!(saved.len(), 2);
    assert_ne!(
        saved[0].try_get::<Uuid, _>("id")?,
        saved[1].try_get::<Uuid, _>("id")?
    );
    let c = Reader::new(&app, principal(tenant, identities[2], "Archive reader")).await;
    sqlx::query("UPDATE app_settings SET value=jsonb_set(value::jsonb,'{hour}','0')::text WHERE key='reader_settings'")
        .execute(&pool).await?;
    crate::edition::archive_cloud_readers(&state, chrono::Utc::now()).await?;
    let archive = c.ok("GET", "/api/v1/briefs/today", Value::Null).await;
    assert_eq!(archive["isSnapshot"], true);
    assert!(
        !archive.to_string().contains("PRIVATE_ALPHA")
            && !archive.to_string().contains("PRIVATE_BETA")
    );
    assert_eq!(
        c.ok("GET", "/api/v1/briefs", Value::Null).await["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let analytics = json!({"events":[{"name":"page_view","page":"reading","durationMs":12.5}]});
    assert_eq!(
        a.call("POST", "/api/v1/telemetry", analytics.clone())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    a.ok(
        "PUT",
        "/api/v1/me/telemetry-consent",
        json!({"enabled":true}),
    )
    .await;
    assert_eq!(
        a.ok("POST", "/api/v1/telemetry", analytics).await["accepted"],
        1
    );
    for body in [
        json!({"events":[{"name":"page_view","page":"reading","url":"https://secret"}]}),
        json!({"events":[{"name":"page_view","page":"reading","durationMs":-1}]}),
        json!({"events":[{"name":"page_view","page":"raw query"}]}),
    ] {
        assert!(
            a.call("POST", "/api/v1/telemetry", body)
                .await
                .0
                .is_client_error()
        );
    }
    let exported = a.ok("POST", "/api/v1/me/export", json!({})).await;
    assert_eq!(exported["userId"], a.id.to_string());
    assert_eq!(exported["telemetryConsent"], true);
    assert!(!exported.to_string().contains("PRIVATE_BETA"));
    assert!(!exported.to_string().contains("LOCAL_OWNER_SENTINEL"));
    assert!(!exported.to_string().contains("summary_settings"));
    assert!(!exported.to_string().contains(CSRF));
    a.ok(
        "PUT",
        "/api/v1/me/telemetry-consent",
        json!({"enabled":false}),
    )
    .await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM reader_telemetry WHERE user_id=$1")
            .bind(a.id.to_string())
            .fetch_one(&pool)
            .await?,
        0
    );
    let job = a
        .ok(
            "POST",
            &format!("/api/v1/sources/{a_source}/refresh"),
            json!({}),
        )
        .await;
    let job_id = job["jobId"].as_str().unwrap();
    a.ok(
        "GET",
        &format!("/api/v1/ingestion-runs/{job_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(
        b.call(
            "GET",
            &format!("/api/v1/ingestion-runs/{job_id}"),
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let duplicate = a.ok("POST", "/api/v1/admin/ingestion/run", json!({})).await;
    assert_eq!(duplicate["jobId"], job["jobId"]);
    sqlx::query("UPDATE ingestion_runs SET status='running',lease_until=now()-interval '1 second' WHERE id=$1")
        .bind(Uuid::parse_str(job_id)?).execute(&pool).await?;
    crate::ingestion_jobs::recover(&state).await?;
    let recovered = a
        .ok(
            "GET",
            &format!("/api/v1/ingestion-runs/{job_id}"),
            Value::Null,
        )
        .await;
    assert_eq!(recovered["status"], "failed");
    assert_eq!(recovered["error"], "worker_interrupted");
    let queued = b
        .ok(
            "POST",
            &format!("/api/v1/sources/{b_source}/refresh"),
            json!({}),
        )
        .await;
    b.ok(
        "PUT",
        &format!("/api/v1/sources/{b_source}"),
        json!({"enabled":false}),
    )
    .await;
    // A fresh worker state resumes persisted pending jobs. The fixture disables
    // its source after submit, exercising a real terminal failure without any
    // outbound network or fake success response.
    crate::ingestion_jobs::tick(&root(pool.clone(), &invitations)).await?;
    let completed = b
        .ok(
            "GET",
            &format!(
                "/api/v1/ingestion-runs/{}",
                queued["jobId"].as_str().unwrap()
            ),
            Value::Null,
        )
        .await;
    assert_eq!(completed["status"], "failed");
    assert_eq!(completed["completed"], 1);
    assert_eq!(completed["result"]["failed"], 1);
    // Scope reset survives commit, rollback and cancellation; a reused pool
    // connection must never retain the previous reader's actor or SQL role.
    let a_db = ScopedDb::from(pool.clone()).reader(&a.id.to_string());
    let b_db = ScopedDb::from(pool.clone()).reader(&b.id.to_string());
    for db in [&a_db, &b_db, &a_db] {
        let actor: String = sqlx::query_scalar("SELECT scoutnews_actor()")
            .fetch_one(db)
            .await?;
        assert_eq!(actor, db.actor());
    }
    {
        let _transaction = a_db.begin().await?;
    }
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT scoutnews_actor()")
            .fetch_one(&pool)
            .await?,
        "local"
    );
    let local = crate::postgres_store::PostgresStore::new(pool.clone());
    assert!(local.get_event(a_event).await?.is_none());
    assert!(local.get_event(b_event).await?.is_none());
    assert!(
        local
            .topics()
            .await?
            .iter()
            .any(|t| t.label == "LOCAL_OWNER_SENTINEL")
    );
    sqlx::query("UPDATE sources SET lifecycle_status='paused' WHERE id=$1")
        .bind(shared_source)
        .execute(&pool)
        .await?;
    assert!(
        local.get_event(shared).await?.is_some(),
        "local pause still stops collection, not access to previously saved material"
    );
    sqlx::query("UPDATE sources SET lifecycle_status='stable' WHERE id=$1")
        .bind(shared_source)
        .execute(&pool)
        .await?;
    assert_eq!(
        state
            .automation
            .as_ref()
            .unwrap()
            .settings()
            .await?
            .daily_limit,
        5000
    );
    let mut local_state = state.clone();
    local_state.auth = Arc::new(Auth {
        mode: AuthMode::Local,
        pool: Some(pool.clone()),
    });
    let local_app = app::router(local_state);
    let (_, local_session) = send(
        &local_app,
        None,
        "GET",
        "/api/v1/session",
        Value::Null,
        None,
        None,
        false,
    )
    .await;
    assert_eq!(local_session["capabilities"]["manageReadingSettings"], true);
    let (local_status, local_export) = send(
        &local_app,
        None,
        "POST",
        "/api/v1/me/export",
        json!({}),
        None,
        None,
        false,
    )
    .await;
    assert_eq!(local_status, StatusCode::OK, "local export {local_export}");
    assert_eq!(
        local_export["userId"],
        crate::auth::LOCAL_USER_ID.to_string()
    );
    assert!(local_export.to_string().contains("LOCAL_OWNER_SENTINEL"));
    assert!(!local_export.to_string().contains("PRIVATE_ALPHA"));
    let (local_status, local_share) = send(
        &local_app,
        None,
        "POST",
        "/api/v1/shares",
        json!({"kind":"event","eventId":shared}),
        None,
        None,
        false,
    )
    .await;
    assert_eq!(local_status, StatusCode::OK);
    let legacy_publish = local_app
        .clone()
        .oneshot(
            Request::post(format!(
                "/api/v1/shares/{}/publish",
                local_share["id"].as_str().unwrap()
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await?;
    assert_eq!(
        legacy_publish.status(),
        StatusCode::OK,
        "local legacy publish without a JSON body remains supported"
    );
    // A system worker must deduplicate only within a realm, even for identical URLs/titles.
    crate::ingestion::test_realm_ingestion(&pool, [shared_source, a_source, b_source]).await?;
    let raw_roles:Vec<String>=sqlx::query_scalar("SELECT rolname FROM pg_roles WHERE rolname='scoutnews_reader' AND (rolsuper OR rolbypassrls)")
        .fetch_all(&pool).await?;
    assert!(raw_roles.is_empty());
    assert!(b_db.begin().await?.rollback().await.is_ok());
    let serial_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await?;
    let cancelled = ScopedDb::from(serial_pool.clone()).reader(&a.id.to_string());
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(30),
            sqlx::query("SELECT pg_sleep(0.2)").execute(&cancelled)
        )
        .await
        .is_err()
    );
    let role: String = sqlx::query_scalar("SELECT current_user::text")
        .fetch_one(&serial_pool)
        .await?;
    assert_ne!(role, "scoutnews_reader");
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT scoutnews_actor()")
            .fetch_one(&serial_pool)
            .await?,
        "local"
    );
    serial_pool.close().await;
    sqlx::query(
        "INSERT INTO reader_telemetry(id,user_id,name,page,created_at)
        VALUES($1,$2,'page_view','brief',now()-interval '31 days')",
    )
    .bind(Uuid::new_v4())
    .bind(a.id.to_string())
    .execute(&pool)
    .await?;
    crate::ingestion_jobs::recover(&state).await?;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM reader_telemetry")
            .fetch_one(&pool)
            .await?,
        0
    );
    sqlx::query("INSERT INTO reader_shares(id,owner_user_id,document) VALUES($1,$2,jsonb_build_object('title',repeat('x',21*1024*1024)))")
        .bind(Uuid::new_v4()).bind(a.id.to_string()).execute(&pool).await?;
    assert_eq!(
        a.call("POST", "/api/v1/me/export", json!({})).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        a.call("POST", "/api/v1/me/export", json!({})).await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    legacy.verify_public_reingestion(&pool, &a, &b).await?;
    ingestion_regressions::verify_effective_source_authorization(&pool, &a, &b).await?;
    reader_performance_regressions::verify_reader_performance(&pool, &a, &b).await?;
    eprintln!(
        "Verified A/B authentication, interests/state/exposures, visible graphs/coverage/briefs, source overrides/registry, shares, exports, consent, durable jobs, realm ingestion, reader performance and local settings preservation."
    );
    pool.close().await;
    Ok(())
}

fn editor(share: &Value) -> Value {
    json!({"title":"Explicit public title","subtitle":"","caption":"EDITOR_PRIVATE_SENTINEL","cta":"",
        "format":"portrait","theme":"light","items":share["document"]["items"].as_array().unwrap().iter().enumerate()
            .map(|(index,item)|json!({"index":index,"title":item["title"],"summary":item["summary"],"selected":true}))
            .collect::<Vec<_>>()})
}

async fn verify_explicit_role_membership(pool: &PgPool) -> anyhow::Result<()> {
    let hardening = include_str!("../../migrations/0026_reader_role_membership.sql");
    sqlx::query("GRANT scoutnews_reader TO CURRENT_USER WITH SET FALSE, INHERIT FALSE")
        .execute(pool)
        .await?;
    let mut denied = pool.begin().await?;
    assert!(
        sqlx::query("SET LOCAL ROLE scoutnews_reader")
            .execute(&mut *denied)
            .await
            .is_err(),
        "CREATEROLE/ADMIN permission alone must not grant SET ROLE"
    );
    denied.rollback().await?;
    sqlx::query(hardening).execute(pool).await?;
    let membership = sqlx::query("SELECT bool_or(set_option) AS can_set,bool_or(inherit_option) AS inherits
        FROM pg_auth_members WHERE roleid='scoutnews_reader'::regrole AND member=current_user::regrole")
        .fetch_one(pool).await?;
    assert!(membership.try_get::<bool, _>("can_set")?);
    assert!(!membership.try_get::<bool, _>("inherits")?);
    sqlx::query("CREATE ROLE scoutnews_test_parent NOLOGIN NOINHERIT NOBYPASSRLS")
        .execute(pool)
        .await?;
    sqlx::query("GRANT scoutnews_test_parent TO scoutnews_reader WITH SET FALSE, INHERIT FALSE")
        .execute(pool)
        .await?;
    assert!(
        sqlx::query(hardening).execute(pool).await.is_err(),
        "a pre-provisioned request role with parent memberships must fail closed"
    );
    sqlx::query("REVOKE scoutnews_test_parent FROM scoutnews_reader")
        .execute(pool)
        .await?;
    sqlx::query("DROP ROLE scoutnews_test_parent")
        .execute(pool)
        .await?;
    sqlx::query(hardening).execute(pool).await?;
    let owned: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_class
        WHERE relowner='scoutnews_reader'::regrole AND relnamespace='public'::regnamespace",
    )
    .fetch_one(pool)
    .await?;
    assert_eq!(owned, 0);
    Ok(())
}

async fn verify_atomic_publishing(a: &Reader, b: &Reader, selected: Uuid, unchecked: Uuid) {
    let selected_event = a
        .ok("GET", &format!("/api/v1/events/{selected}"), Value::Null)
        .await;
    let unchecked_event = a
        .ok("GET", &format!("/api/v1/events/{unchecked}"), Value::Null)
        .await;
    let share=a.ok("POST","/api/v1/shares",json!({"kind":"brief","date":"latest","selection":[
        {"eventId":selected,"contentVersion":selected_event["contentVersion"],"summarizedAt":selected_event["summarizedAt"]},
        {"eventId":unchecked,"contentVersion":unchecked_event["contentVersion"],"summarizedAt":unchecked_event["summarizedAt"]}
    ]})).await;
    let id = share["id"].as_str().unwrap();
    let publish_path = format!("/api/v1/shares/{id}/publish");
    let draft_path = format!("/api/v1/shares/{id}/draft");
    let public_path = format!("/api/v1/public/shares/{id}");
    let mut current = editor(&share);
    current["title"] = json!("CURRENT_EXPLICIT_SELECTION");
    current["items"][0]["title"] = json!("VALIDATED_SELECTED_TITLE");
    current["items"][0]["summary"] = json!("VALIDATED_SELECTED_SUMMARY");
    current["items"][1]["selected"] = json!(false);
    let mut other_tab = editor(&share);
    other_tab["title"] = json!("UNREQUESTED_OTHER_TAB");
    other_tab["items"][0]["selected"] = json!(false);
    other_tab["items"][1]["summary"] = json!("UNCHECKED_OTHER_TAB_STORY");
    a.ok("PUT", &draft_path, other_tab.clone()).await;
    assert_eq!(
        a.call("POST", &publish_path, json!({})).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut bad_index = current.clone();
    bad_index["items"][0]["index"] = json!(99);
    let mut incomplete = current.clone();
    incomplete["items"].as_array_mut().unwrap().pop();
    let mut oversized = current.clone();
    oversized["items"][0]["summary"] = json!("x".repeat(4001));
    let mut empty_title = current.clone();
    empty_title["items"][0]["title"] = json!("");
    for invalid in [bad_index, incomplete, oversized, empty_title] {
        assert_eq!(
            a.call("POST", &publish_path, json!({"editor":invalid}))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }

    let mut unselected = current.clone();
    unselected["items"][0]["selected"] = json!(false);
    assert_eq!(
        a.call("POST", &publish_path, json!({"editor":unselected}))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        b.call("POST", &publish_path, json!({"editor":current}))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        send(
            &a.app,
            None,
            "GET",
            &public_path,
            Value::Null,
            None,
            None,
            true
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    // Both orderings are legal: the other tab saves before the publish lock,
    // or its conditional UPDATE waits and rejects after publication. Neither
    // may change the exact editor supplied with the publish request.
    let (save, publish) = tokio::join!(
        a.call("PUT", &draft_path, other_tab.clone()),
        a.call("POST", &publish_path, json!({"editor":current}))
    );
    assert!(matches!(save.0, StatusCode::OK | StatusCode::CONFLICT));
    assert_eq!(publish.0, StatusCode::OK, "atomic publish: {}", publish.1);
    let (status, public) = send(
        &a.app,
        None,
        "GET",
        &public_path,
        Value::Null,
        None,
        None,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(public["title"], "CURRENT_EXPLICIT_SELECTION");
    assert_eq!(public["items"].as_array().unwrap().len(), 1);
    assert_eq!(public["items"][0]["title"], "VALIDATED_SELECTED_TITLE");
    assert_eq!(public["items"][0]["summary"], "VALIDATED_SELECTED_SUMMARY");
    let serialized = public.to_string();
    for forbidden in [
        "UNCHECKED_OTHER_TAB_STORY",
        "PUBLIC_FIXTURE",
        "EDITOR_PRIVATE_SENTINEL",
        "UNREQUESTED_OTHER_TAB",
        unchecked.to_string().as_str(),
    ] {
        assert!(
            !serialized.contains(forbidden),
            "public snapshot leaked {forbidden}"
        );
    }
    let owned = a
        .ok("GET", &format!("/api/v1/shares/{id}"), Value::Null)
        .await;
    assert_eq!(owned["editor"], current);
    assert_eq!(
        a.call("POST", &publish_path, json!({"editor":other_tab}))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        send(
            &a.app,
            None,
            "GET",
            &public_path,
            Value::Null,
            None,
            None,
            true
        )
        .await
        .1,
        public
    );
}
