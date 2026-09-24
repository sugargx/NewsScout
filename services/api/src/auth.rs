use std::{collections::HashSet, env, sync::Arc};

use anyhow::Context;
use axum::{
    Json,
    extract::{FromRequestParts, Request, State},
    http::{Method, StatusCode, request::Parts},
    middleware::Next,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use sqlx::{PgPool, Row};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::{
    app::{ApiError, AppState},
    scoped_db::ScopedDb,
};

#[derive(Clone, Default)]
pub enum AuthMode {
    #[default]
    Local,
    Azure {
        origin: String,
        proxy_secret: String,
        csrf_secret: String,
        invited_readers: HashSet<String>,
    },
}

#[derive(Clone, Default)]
pub struct Auth {
    pub mode: AuthMode,
    pub pool: Option<PgPool>,
}

#[derive(Clone)]
pub struct Identity {
    pub id: Uuid,
    pub display_name: String,
    pub telemetry_consent: bool,
}
pub const LOCAL_USER_ID: Uuid = Uuid::from_u128(1);

pub struct ReaderState<T = AppState>(pub T);

impl FromRequestParts<AppState> for ReaderState {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, root: &AppState) -> Result<Self, ApiError> {
        if let Some(state) = parts.extensions.get::<AppState>() {
            return Ok(Self(state.clone()));
        }
        if root.auth.cloud() {
            return Err(ApiError::Unauthorized("Sign in required".into()));
        }
        Ok(Self(root.clone()))
    }
}

// The legacy public-only router has no reader or provider capability.
impl FromRequestParts<crate::publishing::Publishing>
    for ReaderState<crate::publishing::Publishing>
{
    type Rejection = ApiError;
    async fn from_request_parts(
        _: &mut Parts,
        state: &crate::publishing::Publishing,
    ) -> Result<Self, ApiError> {
        Ok(Self(state.clone()))
    }
}

impl Auth {
    pub fn from_env() -> anyhow::Result<Self> {
        Self::configure(|key| env::var(key).ok())
    }

    fn configure(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let mode = get("SCOUTNEWS_AUTH_MODE").unwrap_or_else(|| "local".into());
        if mode == "local" {
            anyhow::ensure!(
                !get("CONTAINER_APP_NAME").is_some_and(|v| !v.is_empty())
                    && get("SCOUTNEWS_PROXY_TOKEN").is_none()
                    && get("SCOUTNEWS_CSRF_SECRET").is_none(),
                "Azure runtime requires SCOUTNEWS_AUTH_MODE=azure"
            );
            return Ok(Self::default());
        }
        anyhow::ensure!(mode == "azure", "unsupported SCOUTNEWS_AUTH_MODE");
        anyhow::ensure!(
            !get("SCOUTNEWS_DEMO_MODE").is_some_and(|v| v.eq_ignore_ascii_case("true"))
                && !get("SCOUTNEWS_PUBLIC_ONLY").is_some_and(|v| v.eq_ignore_ascii_case("true")),
            "Azure authentication requires the durable full application"
        );
        let origin = get("WEB_ORIGIN").ok_or_else(|| anyhow::anyhow!("WEB_ORIGIN is required"))?;
        let url = url::Url::parse(&origin)?;
        anyhow::ensure!(
            url.scheme() == "https"
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none()
                && url.origin().ascii_serialization() == origin,
            "WEB_ORIGIN must be an exact HTTPS origin without a trailing slash"
        );
        let proxy_secret = get("SCOUTNEWS_PROXY_TOKEN")
            .ok_or_else(|| anyhow::anyhow!("SCOUTNEWS_PROXY_TOKEN is required"))?;
        let csrf_secret = get("SCOUTNEWS_CSRF_SECRET")
            .ok_or_else(|| anyhow::anyhow!("SCOUTNEWS_CSRF_SECRET is required"))?;
        anyhow::ensure!(
            proxy_secret.len() >= 32 && csrf_secret.len() >= 32,
            "cloud proxy and CSRF secrets require at least 32 bytes"
        );
        let invited_readers = parse_invitations(
            &get("SCOUTNEWS_INVITED_READERS")
                .ok_or_else(|| anyhow::anyhow!("SCOUTNEWS_INVITED_READERS is required"))?,
        )?;
        Ok(Self {
            mode: AuthMode::Azure {
                origin,
                proxy_secret,
                csrf_secret,
                invited_readers,
            },
            pool: None,
        })
    }

    pub fn cloud(&self) -> bool {
        matches!(self.mode, AuthMode::Azure { .. })
    }

    pub fn origin(&self) -> Option<&str> {
        match &self.mode {
            AuthMode::Azure { origin, .. } => Some(origin),
            _ => None,
        }
    }

    pub fn csrf(&self, id: Uuid) -> String {
        match &self.mode {
            AuthMode::Azure { csrf_secret, .. } => {
                let mut mac = Hmac::<Sha256>::new_from_slice(csrf_secret.as_bytes())
                    .expect("HMAC accepts any key size");
                mac.update(b"newsscout-csrf-v1:");
                mac.update(id.as_bytes());
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
            }
            AuthMode::Local => String::new(),
        }
    }
}

fn parse_invitations(value: &str) -> anyhow::Result<HashSet<String>> {
    let entries: Vec<String> = serde_json::from_str(value)
        .context("SCOUTNEWS_INVITED_READERS must be a JSON array of tenant-ID:object-ID pairs")?;
    anyhow::ensure!(
        entries.len() <= 100,
        "at most 100 preview accounts may be approved"
    );
    entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let invalid = || {
                anyhow::anyhow!(
                    "invalid approved account at index {index}: two nonzero UUIDs are required"
                )
            };
            let (tenant, object) = entry.split_once(':').ok_or_else(invalid)?;
            let tenant = Uuid::parse_str(tenant).map_err(|_| invalid())?;
            let object = Uuid::parse_str(object).map_err(|_| invalid())?;
            anyhow::ensure!(!tenant.is_nil() && !object.is_nil(), "{}", invalid());
            Ok(format!("{tenant}:{object}"))
        })
        .collect()
}

#[derive(Deserialize)]
struct Principal {
    auth_typ: String,
    claims: Vec<Claim>,
}
#[derive(Deserialize)]
struct Claim {
    typ: String,
    val: String,
}

struct PlatformIdentity {
    issuer: String,
    subject: String,
    display_name: String,
    invitation_key: String,
}

fn principal(value: &str) -> Result<PlatformIdentity, ApiError> {
    let invalid = || ApiError::Unauthorized("Invalid platform identity".into());
    if value.len() > 16384 {
        return Err(invalid());
    }
    let bytes = STANDARD.decode(value).map_err(|_| invalid())?;
    let principal: Principal = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if principal.auth_typ != "aad"
        || principal.claims.len() > 100
        || principal
            .claims
            .iter()
            .any(|c| c.typ.len() > 256 || c.val.len() > 2048)
    {
        return Err(invalid());
    }
    let claim = |names: &[&str]| -> Result<Option<&str>, ApiError> {
        let mut values = principal
            .claims
            .iter()
            .filter(|c| names.contains(&c.typ.as_str()));
        let first = values.next().map(|c| c.val.as_str());
        if values.any(|c| Some(c.val.as_str()) != first) {
            return Err(invalid());
        }
        Ok(first)
    };
    let tenant = Uuid::parse_str(
        claim(&[
            "tid",
            "http://schemas.microsoft.com/identity/claims/tenantid",
        ])?
        .ok_or_else(invalid)?,
    )
    .map_err(|_| invalid())?;
    let object = Uuid::parse_str(
        claim(&[
            "oid",
            "http://schemas.microsoft.com/identity/claims/objectidentifier",
        ])?
        .ok_or_else(invalid)?,
    )
    .map_err(|_| invalid())?;
    if tenant.is_nil() || object.is_nil() {
        return Err(invalid());
    }
    let issuer = format!("https://login.microsoftonline.com/{tenant}/v2.0");
    if let Some(iss) = claim(&["iss"])?
        && iss != issuer
        && iss != format!("https://sts.windows.net/{tenant}/")
    {
        return Err(invalid());
    }
    let name = claim(&[
        "name",
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
    ])?
    .unwrap_or("Reader")
    .chars()
    .filter(|c| !c.is_control())
    .take(80)
    .collect::<String>();
    Ok(PlatformIdentity {
        issuer,
        subject: object.to_string(),
        display_name: if name.trim().is_empty() {
            "Reader".into()
        } else {
            name
        },
        invitation_key: format!("{tenant}:{object}"),
    })
}

fn matches_secret(actual: Option<&axum::http::HeaderValue>, expected: &str) -> bool {
    actual.is_some_and(|v| bool::from(v.as_bytes().ct_eq(expected.as_bytes())))
}

pub fn owner_route(path: &str, method: &Method) -> bool {
    path.starts_with("/api/v1/model-providers")
        || path.starts_with("/api/v1/auth/")
        || path == "/api/v1/reader-settings"
        || path == "/api/v1/processing/settings"
        || path == "/api/v1/processing/retry"
        || path == "/api/v1/share-settings" && method != Method::GET
}

pub async fn middleware(
    State(root): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let AuthMode::Azure {
        origin,
        proxy_secret,
        invited_readers,
        ..
    } = &root.auth.mode
    else {
        return next.run(request).await;
    };
    if request.uri().path() == "/health" {
        return next.run(request).await;
    }
    if !matches_secret(
        request.headers().get("x-scoutnews-proxy-token"),
        proxy_secret,
    ) {
        return ApiError::Unauthorized("Trusted proxy required".into()).into_response();
    }
    for header in [
        "x-scoutnews-proxy-token",
        "x-ms-client-principal",
        "x-csrf-token",
        "origin",
    ] {
        if request.headers().get_all(header).iter().count() > 1 {
            return ApiError::Unauthorized("Ambiguous authentication headers".into())
                .into_response();
        }
    }
    if request.uri().path().starts_with("/api/v1/public/shares/")
        && matches!(*request.method(), Method::GET | Method::HEAD)
    {
        let mut response = next.run(request).await;
        response
            .headers_mut()
            .insert("cache-control", "no-store, private".parse().unwrap());
        return response;
    }
    let headers = request.headers().clone();
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let identity = headers
        .get("x-ms-client-principal")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| ApiError::Unauthorized("Sign in required".into()))
        .and_then(principal);
    let identity = match identity {
        Ok(identity) => identity,
        Err(error) => return error.into_response(),
    };
    // Admission precedes account creation and every private read or write.
    if !invited_readers.contains(&identity.invitation_key) {
        return (
            StatusCode::FORBIDDEN,
            [("cache-control", "no-store, private")],
            Json(serde_json::json!({
                "error":"invitation_required",
                "message":"This Microsoft account has not been approved for the preview.",
                "invitationKey":identity.invitation_key
            })),
        )
            .into_response();
    }
    let result = async {
        if method == Method::OPTIONS {
            if !matches_secret(headers.get("origin"), origin) {
                return Err(ApiError::Forbidden);
            }
            return Ok(None);
        }
        let pool = root
            .auth
            .pool
            .as_ref()
            .ok_or_else(|| ApiError::Configuration("Cloud database unavailable".into()))?;
        let row = sqlx::query(
            "INSERT INTO app_users(id,issuer,subject,display_name)
            VALUES($1,$2,$3,$4) ON CONFLICT(issuer,subject) DO UPDATE
            SET display_name=EXCLUDED.display_name,last_seen_at=now()
            RETURNING id,display_name,telemetry_consent",
        )
        .bind(Uuid::new_v4())
        .bind(identity.issuer)
        .bind(identity.subject)
        .bind(identity.display_name)
        .fetch_one(pool)
        .await
        .map_err(anyhow::Error::from)?;
        let identity = Identity {
            id: row.try_get("id").map_err(anyhow::Error::from)?,
            display_name: row.try_get("display_name").map_err(anyhow::Error::from)?,
            telemetry_consent: row
                .try_get("telemetry_consent")
                .map_err(anyhow::Error::from)?,
        };
        if !matches!(method, Method::GET | Method::HEAD) {
            if !matches_secret(headers.get("origin"), origin)
                || !matches_secret(headers.get("x-csrf-token"), &root.auth.csrf(identity.id))
            {
                return Err(ApiError::Forbidden);
            }
        } else if headers.contains_key("origin") && !matches_secret(headers.get("origin"), origin) {
            return Err(ApiError::Forbidden);
        }
        if owner_route(&path, &method) {
            return Err(ApiError::Forbidden);
        }
        let scoped = root.for_reader(identity);
        let db = scoped.reader_db()?;
        sqlx::query(
            "INSERT INTO interest_profiles(user_id,profile)
            SELECT scoutnews_actor(),jsonb_build_object('topics',COALESCE(jsonb_agg(
              jsonb_build_object('id',id,'label',label,'group',group_name,'weight',50,
                'context','long_term','enabled',true) ORDER BY id),'[]'::jsonb))
            FROM taxonomy_nodes WHERE owner_user_id IS NULL AND enabled
            ON CONFLICT(user_id) DO NOTHING",
        )
        .execute(&db)
        .await
        .map_err(anyhow::Error::from)?;
        Ok::<_, ApiError>(Some(scoped))
    }
    .await;
    match result {
        Ok(Some(state)) => {
            request.extensions_mut().insert(state);
            let mut response = next.run(request).await;
            response
                .headers_mut()
                .insert("cache-control", "no-store, private".parse().unwrap());
            response
        }
        Ok(None) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => error.into_response(),
    }
}

impl AppState {
    pub fn account_id(&self) -> Uuid {
        self.identity
            .as_ref()
            .map_or(LOCAL_USER_ID, |identity| identity.id)
    }

    pub fn display_name(&self) -> &str {
        self.identity
            .as_ref()
            .map_or("Local reader", |identity| identity.display_name.as_str())
    }

    pub fn for_reader(&self, identity: Identity) -> Self {
        let mut state = self.clone();
        let db = ScopedDb::from(
            self.auth
                .pool
                .as_ref()
                .expect("cloud database validated")
                .clone(),
        )
        .reader(&identity.id.to_string());
        state.store = Arc::new(crate::postgres_store::PostgresStore::new(db.clone()));
        state.automation = Some(crate::automation::AutomationStore::new(db.clone()));
        state.edition = Some(crate::edition::EditionStore::new(db.clone()));
        state.publishing = Some(crate::publishing::Publishing {
            pool: db.clone(),
            public_origin: self.auth.origin().map(str::to_owned),
        });
        state.feed_worker = self.feed_worker.as_ref().map(|worker| worker.scoped(db));
        state.identity = Some(identity);
        state
    }

    pub fn reader_db(&self) -> Result<ScopedDb, ApiError> {
        self.publishing
            .as_ref()
            .map(|p| p.pool.clone())
            .ok_or_else(|| ApiError::Configuration("Persistent database required".into()))
    }
}

pub async fn session(ReaderState(state): ReaderState) -> Result<Json<serde_json::Value>, ApiError> {
    match &state.identity {
        Some(identity) => Ok(Json(serde_json::json!({
            "user":{"id":identity.id,"displayName":identity.display_name},
            "csrfToken":state.auth.csrf(identity.id),
            "capabilities":{"manageReadingSettings":false},
            "telemetryConsent":identity.telemetry_consent
        }))),
        None => {
            let consent = if let Ok(db) = state.reader_db() {
                sqlx::query_scalar::<_, bool>("SELECT telemetry_consent FROM app_users WHERE id=$1")
                    .bind(LOCAL_USER_ID)
                    .fetch_optional(&db)
                    .await
                    .map_err(anyhow::Error::from)?
                    .unwrap_or(false)
            } else {
                false
            };
            Ok(Json(serde_json::json!({
                "user":{"id":LOCAL_USER_ID,"displayName":"Local reader"},
                "csrfToken":"","capabilities":{"manageReadingSettings":true},"telemetryConsent":consent
            })))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_is_tenant_object_not_name_or_email() {
        let tid = Uuid::new_v4();
        let oid = Uuid::new_v4();
        let encoded=STANDARD.encode(serde_json::to_vec(&serde_json::json!({
            "auth_typ":"aad","claims":[{"typ":"tid","val":tid},{"typ":"oid","val":oid},
                {"typ":"email","val":"not-an-authority@example.test"},{"typ":"name","val":"Reader"}]
        })).unwrap());
        let identity = principal(&encoded).unwrap();
        assert_eq!(identity.subject, oid.to_string());
        assert_eq!(identity.invitation_key, format!("{tid}:{oid}"));
        assert!(
            principal(
                &STANDARD.encode(br#"{"auth_typ":"aad","claims":[{"typ":"email","val":"admin"}]}"#)
            )
            .is_err()
        );
        assert!(principal("malformed").is_err());
    }
    #[test]
    fn owner_controls_do_not_include_collection() {
        assert!(owner_route(
            "/api/v1/model-providers/github-copilot/local",
            &Method::POST
        ));
        assert!(owner_route("/api/v1/reader-settings", &Method::PUT));
        assert!(!owner_route("/api/v1/admin/ingestion/run", &Method::POST));
        let auth = Auth {
            mode: AuthMode::Azure {
                origin: "https://test.example".into(),
                proxy_secret: "p".repeat(32),
                csrf_secret: "c".repeat(32),
                invited_readers: HashSet::new(),
            },
            pool: None,
        };
        assert_ne!(auth.csrf(Uuid::new_v4()), auth.csrf(Uuid::new_v4()));
    }

    #[test]
    fn incomplete_cloud_configuration_is_fail_closed() {
        let valid = std::collections::HashMap::from([
            ("SCOUTNEWS_AUTH_MODE", "azure".to_owned()),
            ("WEB_ORIGIN", "https://example.com".into()),
            ("SCOUTNEWS_PROXY_TOKEN", "p".repeat(32)),
            ("SCOUTNEWS_CSRF_SECRET", "c".repeat(32)),
            ("SCOUTNEWS_INVITED_READERS", "[]".into()),
        ]);
        assert!(
            Auth::configure(|key| valid.get(key).cloned())
                .unwrap()
                .cloud()
        );
        for key in [
            "SCOUTNEWS_AUTH_MODE",
            "WEB_ORIGIN",
            "SCOUTNEWS_PROXY_TOKEN",
            "SCOUTNEWS_CSRF_SECRET",
            "SCOUTNEWS_INVITED_READERS",
        ] {
            let mut values = valid.clone();
            values.remove(key);
            assert!(Auth::configure(|key| values.get(key).cloned()).is_err());
        }
        for (key, value) in [
            ("SCOUTNEWS_DEMO_MODE", "true"),
            ("SCOUTNEWS_PUBLIC_ONLY", "true"),
            ("WEB_ORIGIN", "http://example.com"),
            ("WEB_ORIGIN", "https://example.com/"),
            ("WEB_ORIGIN", "https://example.com/path"),
            ("SCOUTNEWS_PROXY_TOKEN", "short"),
            ("SCOUTNEWS_CSRF_SECRET", "short"),
            ("SCOUTNEWS_AUTH_MODE", "unknown"),
            ("SCOUTNEWS_INVITED_READERS", ""),
            ("SCOUTNEWS_INVITED_READERS", "null"),
            ("SCOUTNEWS_INVITED_READERS", r#"["reader@example.com"]"#),
            ("SCOUTNEWS_INVITED_READERS", r#"["*:anything"]"#),
        ] {
            let mut values = valid.clone();
            values.insert(key, value.into());
            assert!(
                Auth::configure(|key| values.get(key).cloned()).is_err(),
                "{key}"
            );
        }
        assert!(!Auth::configure(|_| None).unwrap().cloud());
        assert!(
            Auth::configure(|key| (key == "CONTAINER_APP_NAME").then(|| "cloud".into())).is_err()
        );
    }

    #[test]
    fn invitation_keys_are_exact_immutable_pairs() {
        let tenant = Uuid::new_v4();
        let object = Uuid::new_v4();
        let key = format!("{tenant}:{object}");
        let values = serde_json::to_string(&vec![key.to_uppercase(), key.clone()]).unwrap();
        let invitations = parse_invitations(&values).unwrap();
        assert_eq!(invitations.len(), 1);
        assert!(invitations.contains(&key));
        assert!(!invitations.contains(&format!("{}:{object}", Uuid::new_v4())));
        assert!(!invitations.contains(&format!("{tenant}:{}", Uuid::new_v4())));
        assert!(parse_invitations("[]").unwrap().is_empty());
        for invalid in [
            format!(r#"["{}:{object}"]"#, Uuid::nil()),
            format!(r#"["{tenant}:{}"]"#, Uuid::nil()),
            format!(r#"["{tenant}:{object}:extra"]"#),
            serde_json::to_string(&vec![key; 101]).unwrap(),
        ] {
            assert!(parse_invitations(&invalid).is_err());
        }
    }
}
