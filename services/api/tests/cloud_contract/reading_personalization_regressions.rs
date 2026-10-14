use super::*;
use chrono::{DateTime, Duration, Utc};

const SETTINGS: &str = "/api/v1/me/reading-personalization";
const SIGNALS: &str = "/api/v1/events/reading-signals";

pub(super) async fn protected_fingerprints(pool: &PgPool) -> anyhow::Result<Vec<String>> {
    let mut fingerprints = Vec::new();
    for table in [
        "app_users",
        "app_settings",
        "interest_profiles",
        "user_event_states",
        "event_exposures",
        "daily_briefs",
        "daily_brief_items",
        "reader_shares",
        "sources",
        "user_source_overrides",
        "events",
        "content_items",
    ] {
        fingerprints.push(sqlx::query_scalar(&format!(
            "SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) FROM {table} t"
        )).fetch_one(pool).await?);
    }
    Ok(fingerprints)
}

fn signal(event: Uuid, generation: &Value) -> Value {
    json!({"eventId":event,"contentVersion":1,"generation":generation,"activeMs":20_000,"surface":"radar"})
}

async fn ranking(
    db: &ScopedDb,
    event: Uuid,
    at: DateTime<Utc>,
    baseline: bool,
    weekly: bool,
    visitor: bool,
) -> anyhow::Result<(f32, f32, bool)> {
    let function = if baseline {
        "reader_recommendations_before_learning_test"
    } else {
        "reader_editorial_recommendations_for_profile"
    };
    let row = sqlx::query(&format!(
        "SELECT rank_score,affinity,not_interested FROM {function}($1,$2,$3,ARRAY[$4],$5)"
    ))
    .bind((!visitor).then_some(db.actor()))
    .bind(at)
    .bind(weekly)
    .bind(event)
    .bind(visitor.then(|| json!([{"label":"Agent","weight":65,"enabled":true}])))
    .fetch_one(db)
    .await?;
    Ok((row.try_get(0)?, row.try_get(1)?, row.try_get(2)?))
}

async fn edition_fingerprint(db: &ScopedDb) -> anyhow::Result<String> {
    Ok(sqlx::query_scalar(
        "SELECT md5(COALESCE(string_agg(to_jsonb(i)::text,E'\\n' ORDER BY i.brief_id,i.rank),''))
         FROM daily_brief_items i JOIN daily_briefs b ON b.id=i.brief_id
         WHERE b.owner_user_id=scoutnews_actor()",
    )
    .fetch_one(db)
    .await?)
}

pub(super) async fn verify(pool: &PgPool, app: &Router) -> anyhow::Result<()> {
    let old = include_str!("../../migrations/0029_editorial_significance.sql");
    let start = old
        .find("CREATE OR REPLACE FUNCTION reader_editorial_recommendations_for_profile")
        .ok_or_else(|| anyhow::anyhow!("baseline scoring function missing"))?;
    sqlx::raw_sql(&old[start..].replacen(
        "reader_editorial_recommendations_for_profile",
        "reader_recommendations_before_learning_test",
        1,
    ))
    .execute(pool)
    .await?;
    let a = Reader::new(
        app,
        principal(Uuid::new_v4(), Uuid::new_v4(), "Reading fixture A"),
    )
    .await;
    let b = Reader::new(
        app,
        customer_principal(&Uuid::new_v4().to_string(), "Reading fixture B"),
    )
    .await;
    let db = ScopedDb::from(pool.clone()).reader(&a.id.to_string());
    let other = ScopedDb::from(pool.clone()).reader(&b.id.to_string());
    let (_, first) = fixture(pool, Some(a.id.to_string()), "AI coding agent first").await?;
    let (_, second) = fixture(pool, Some(a.id.to_string()), "AI coding agent second").await?;
    let (_, third) = fixture(pool, Some(a.id.to_string()), "AI coding agent third").await?;
    let (_, candidate) = fixture(pool, None, "AI coding agent candidate").await?;
    let at = Utc::now() + Duration::hours(1);
    let initial = a.ok("GET", SETTINGS, Value::Null).await;
    assert_eq!(
        initial,
        json!({"enabled":false,"generation":null,"signalCount":0})
    );
    assert_eq!(b.ok("GET", SETTINGS, Value::Null).await, initial);
    for weekly in [false, true] {
        assert_eq!(
            ranking(&db, candidate, at, false, weekly, false).await?,
            ranking(&db, candidate, at, true, weekly, false).await?,
            "cold start changed ranking"
        );
    }
    assert_eq!(
        a.call("POST", SIGNALS, signal(first, &json!(Uuid::new_v4())))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let settings = a.ok("PUT", SETTINGS, json!({"enabled":true})).await;
    let generation = settings["generation"].clone();
    assert_eq!(
        a.ok("PUT", SETTINGS, json!({"enabled":true})).await["generation"],
        generation,
        "idempotent enable must not reset accumulated reading"
    );
    assert_eq!(
        a.ok("GET", "/api/v1/session", Value::Null).await["readingPersonalization"],
        settings
    );
    let other_generation =
        b.ok("PUT", SETTINGS, json!({"enabled":true})).await["generation"].clone();
    assert_eq!(
        b.call("POST", SIGNALS, signal(first, &other_generation))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let (status, _) = send(
        app,
        Some(&a.principal),
        "POST",
        SIGNALS,
        signal(first, &generation),
        None,
        Some(ORIGIN),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    for milliseconds in [19_999, 120_001, -1] {
        let mut input = signal(first, &generation);
        input["activeMs"] = json!(milliseconds);
        assert_eq!(
            a.call("POST", SIGNALS, input).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    for field in ["userId", "facets", "recordedAt"] {
        let mut input = signal(first, &generation);
        input[field] = json!("not a trusted client field");
        assert!(a.call("POST", SIGNALS, input).await.0.is_client_error());
    }
    let mut stale = signal(first, &generation);
    stale["contentVersion"] = json!(0);
    assert_eq!(a.call("POST", SIGNALS, stale).await.0, StatusCode::CONFLICT);
    assert_eq!(a.ok("GET", SETTINGS, Value::Null).await["signalCount"], 0);

    a.ok("POST", "/api/v1/briefs/today/generate", json!({}))
        .await;
    let snapshots = edition_fingerprint(&db).await?;
    let baseline = ranking(&db, candidate, at, true, false, false).await?;
    assert_eq!(
        a.ok("POST", SIGNALS, signal(first, &generation)).await["recorded"],
        true
    );
    assert_eq!(
        ranking(&db, candidate, at, false, false, false).await?,
        baseline,
        "one article must not create a learned interest"
    );
    let stored: Value = sqlx::query_scalar(
        "SELECT to_jsonb(s) FROM reader_reading_signals s WHERE event_id=$1 AND user_id=scoutnews_actor()"
    ).bind(first).fetch_one(&db).await?;
    let repeated = a.ok("POST", SIGNALS, signal(first, &generation)).await;
    assert_eq!(repeated["recorded"], false);
    let again: Value = sqlx::query_scalar(
        "SELECT to_jsonb(s) FROM reader_reading_signals s WHERE event_id=$1 AND user_id=scoutnews_actor()"
    ).bind(first).fetch_one(&db).await?;
    assert_eq!(stored, again, "retry must not renew the timestamp or count");
    a.ok("POST", SIGNALS, signal(second, &generation)).await;
    let learned = ranking(&db, candidate, at, false, false, false).await?;
    assert!(learned.0 > baseline.0 && learned.0 < baseline.0 + 0.21);
    assert!(learned.1 > 53.9 && learned.1 < 54.0);
    assert_eq!(
        ranking(&other, candidate, at, false, false, false).await?,
        ranking(&other, candidate, at, true, false, false).await?,
        "other reader inherited learning"
    );
    for weekly in [false, true] {
        assert_eq!(
            ranking(&db, candidate, at, false, weekly, true).await?,
            ranking(&db, candidate, at, true, weekly, true).await?,
            "visitor inherited a private signal"
        );
    }
    assert_eq!(
        ranking(&db, first, at, false, false, false).await?.1,
        50.0,
        "an article's own reading must not recommend itself"
    );
    assert_eq!(edition_fingerprint(&db).await?, snapshots);
    assert_eq!(
        crate::reader::DAILY_SELECTION_RULE,
        "editorial-significance-v1-ranked-v3-t1"
    );

    let exported = a.ok("POST", "/api/v1/me/export", json!({})).await;
    assert_eq!(exported["readingSignals"].as_array().unwrap().len(), 2);
    assert_eq!(exported["readingPersonalization"][0]["enabled"], true);
    assert!(
        exported["readingSignals"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["user_id"] == a.id.to_string())
    );
    let other_export = b.ok("POST", "/api/v1/me/export", json!({})).await;
    assert_eq!(other_export["readingSignals"], json!([]));
    a.ok(
        "PUT",
        "/api/v1/me/telemetry-consent",
        json!({"enabled":false}),
    )
    .await;
    assert_eq!(
        a.ok("GET", SETTINGS, Value::Null).await["signalCount"],
        2,
        "optional analytics consent must not control reading learning"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM reader_reading_signals")
            .fetch_one(&other)
            .await?,
        0
    );
    assert!(
        sqlx::query(
            "UPDATE reader_personalization SET enabled=false,enabled_since=NULL WHERE user_id=$1"
        )
        .bind(a.id.to_string())
        .execute(&other)
        .await?
        .rows_affected()
            == 0
    );

    a.ok(
        "PUT",
        &format!("/api/v1/events/{first}/state"),
        json!({"saved":true}),
    )
    .await;
    let saved = ranking(&db, candidate, at, false, false, false).await?;
    assert!(
        saved.1 > learned.1,
        "one bookmark must outweigh two weak reading samples"
    );
    assert_eq!(
        saved,
        ranking(&db, candidate, at, true, false, false).await?,
        "bookmark was counted a second time as reading"
    );
    a.ok("POST", SIGNALS, signal(third, &generation)).await;
    a.ok(
        "PUT",
        &format!("/api/v1/events/{first}/state"),
        json!({"notInterested":true,"notInterestedReason":"topic"}),
    )
    .await;
    assert_eq!(
        ranking(&db, candidate, at, false, false, false).await?,
        ranking(&db, candidate, at, true, false, false).await?,
        "reading overrode explicit negative feedback"
    );
    assert!(ranking(&db, candidate, at, false, false, false).await?.1 < 50.0);
    a.ok(
        "PUT",
        &format!("/api/v1/events/{first}/state"),
        json!({"notInterested":false}),
    )
    .await;

    let profile: Value =
        sqlx::query_scalar("SELECT profile FROM interest_profiles WHERE user_id=scoutnews_actor()")
            .fetch_one(&db)
            .await?;
    sqlx::query(
        "UPDATE interest_profiles SET profile=(SELECT jsonb_build_object('topics',jsonb_agg(
        jsonb_build_object('label',facet,'weight',0,'enabled',false))) FROM (
          SELECT DISTINCT unnest(facets) AS facet FROM reader_reading_signals WHERE user_id=$1) f)
        WHERE user_id=$1",
    )
    .bind(a.id.to_string())
    .execute(pool)
    .await?;
    assert_eq!(
        ranking(&db, candidate, at, false, false, false).await?,
        ranking(&db, candidate, at, true, false, false).await?,
        "disabled topics gained implicit affinity"
    );
    sqlx::query("UPDATE interest_profiles SET profile=$2 WHERE user_id=$1")
        .bind(a.id.to_string())
        .bind(profile)
        .execute(pool)
        .await?;

    let cleared = a.ok("DELETE", SETTINGS, Value::Null).await;
    assert_eq!(cleared["enabled"], true);
    assert_eq!(cleared["signalCount"], 0);
    assert_ne!(cleared["generation"], generation);
    assert_eq!(
        a.call("POST", SIGNALS, signal(first, &generation)).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        ranking(&db, candidate, at, false, false, false).await?,
        ranking(&db, candidate, at, true, false, false).await?
    );
    let generation = cleared["generation"].clone();
    a.ok("POST", SIGNALS, signal(first, &generation)).await;
    a.ok("POST", SIGNALS, signal(second, &generation)).await;
    let enabled_since: DateTime<Utc> =
        sqlx::query_scalar("SELECT enabled_since FROM reader_personalization WHERE user_id=$1")
            .bind(a.id.to_string())
            .fetch_one(pool)
            .await?;
    assert_eq!(
        ranking(
            &db,
            candidate,
            enabled_since - Duration::milliseconds(1),
            false,
            false,
            false
        )
        .await?
        .1,
        50.0
    );
    sqlx::query("UPDATE reader_personalization SET enabled_since=$2 WHERE user_id=$1")
        .bind(a.id.to_string())
        .bind(at - Duration::days(40))
        .execute(pool)
        .await?;
    sqlx::query("UPDATE reader_reading_signals SET recorded_at=$2 WHERE user_id=$1")
        .bind(a.id.to_string())
        .bind(at - Duration::days(14))
        .execute(pool)
        .await?;
    assert!(
        (ranking(&db, candidate, at, false, false, false).await?.1 - 52.0).abs() < 0.001,
        "reading affinity must halve after 14 days"
    );
    sqlx::query("UPDATE reader_reading_signals SET recorded_at=$2 WHERE user_id=$1")
        .bind(a.id.to_string())
        .bind(at + Duration::seconds(1))
        .execute(pool)
        .await?;
    assert_eq!(
        ranking(&db, candidate, at, false, false, false).await?.1,
        50.0,
        "future signal leaked backwards"
    );
    sqlx::query("UPDATE reader_reading_signals SET recorded_at=$2 WHERE user_id=$1")
        .bind(a.id.to_string())
        .bind(at - Duration::days(31))
        .execute(pool)
        .await?;
    assert_eq!(
        ranking(&db, candidate, at, false, false, false).await?.1,
        50.0,
        "expired signal remained active"
    );
    a.ok("POST", SIGNALS, signal(third, &generation)).await;
    assert_eq!(
        a.ok("GET", SETTINGS, Value::Null).await["signalCount"],
        1,
        "recording must purge expired signals even between retention sweeps"
    );
    sqlx::query("INSERT INTO user_event_states(user_id,event_id,saved_at,not_interested_at,not_interested_reason)
        VALUES($1,$2,$3,$4,'topic') ON CONFLICT(user_id,event_id) DO UPDATE
          SET saved_at=$3,not_interested_at=$4,not_interested_reason='topic'")
        .bind(a.id.to_string()).bind(first).bind(at-Duration::hours(1)).bind(at+Duration::days(1))
        .execute(pool).await?;
    assert!(
        !ranking(&db, first, at, false, false, false).await?.2,
        "future dismissal leaked backwards"
    );
    assert!(
        ranking(&db, candidate, at, false, false, false).await?.1 > 50.0,
        "a future dismissal must not turn an earlier bookmark into negative feedback"
    );
    sqlx::query("DELETE FROM user_event_states WHERE user_id=$1 AND event_id=$2")
        .bind(a.id.to_string())
        .bind(first)
        .execute(pool)
        .await?;

    let fixture_ids: Vec<Uuid> = sqlx::query_scalar(
        "INSERT INTO events(id,canonical_title,summary,importance,primary_topic,event_type,owner_user_id,first_seen_at,updated_at,content_version)
         SELECT gen_random_uuid(),'AI coding cap fixture','Fixture','Fixture','AI 编程','blog',$1,now(),now(),1
         FROM generate_series(1,151) RETURNING id"
    ).bind(a.id.to_string()).fetch_all(pool).await?;
    sqlx::query("INSERT INTO reader_reading_signals(user_id,event_id,generation,content_version,surface,active_ms,facets)
        SELECT $1,id,$2,1,'radar',20000,ARRAY['AI 编程'] FROM unnest($3::uuid[]) id")
        .bind(a.id.to_string()).bind(generation.as_str().unwrap().parse::<Uuid>()?)
        .bind(&fixture_ids[..150]).execute(pool).await?;
    let capped = ranking(&db, candidate, at, false, false, false).await?;
    let old = ranking(&db, candidate, at, true, false, false).await?;
    assert_eq!(capped.1, 70.0);
    assert!(
        (capped.0 - old.0 - 1.0).abs() < 0.0001,
        "implicit ranking boost exceeded one point"
    );
    assert_eq!(
        a.call("POST", SIGNALS, signal(fixture_ids[150], &generation))
            .await
            .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    sqlx::query(
        "UPDATE reader_reading_signals SET facets='{}' WHERE user_id=$1 AND event_id=ANY($2)",
    )
    .bind(a.id.to_string())
    .bind(&fixture_ids)
    .execute(pool)
    .await?;
    sqlx::query("INSERT INTO reader_reading_signals(user_id,event_id,generation,content_version,surface,active_ms,facets,recorded_at)
        SELECT $1,id,$2,1,'radar',20000,ARRAY['AI 编程'],$4 FROM unnest($3::uuid[]) id")
        .bind(a.id.to_string()).bind(generation.as_str().unwrap().parse::<Uuid>()?)
        .bind([first,second]).bind(at-Duration::days(1)).execute(pool).await?;
    assert_eq!(
        ranking(&db, candidate, at, false, false, false).await?.1,
        50.0,
        "signals outside the latest 150 entered the profile"
    );
    sqlx::query("DELETE FROM reader_reading_signals WHERE user_id=$1 AND event_id=ANY($2)")
        .bind(a.id.to_string())
        .bind(&fixture_ids[..2])
        .execute(pool)
        .await?;
    assert!(
        ranking(&db, candidate, at, false, false, false).await?.1 > 50.0,
        "recent-window control did not include two qualifying examples"
    );
    assert_eq!(edition_fingerprint(&db).await?, snapshots);
    let disabled = a.ok("PUT", SETTINGS, json!({"enabled":false})).await;
    assert_eq!(disabled["signalCount"], 0);
    assert_ne!(disabled["generation"], generation);
    assert_eq!(
        a.call("POST", SIGNALS, signal(first, &generation)).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        ranking(&db, candidate, at, false, false, false).await?,
        ranking(&db, candidate, at, true, false, false).await?
    );
    assert_eq!(
        b.ok("GET", SETTINGS, Value::Null).await["enabled"],
        true,
        "another account was disabled"
    );
    assert_eq!(edition_fingerprint(&db).await?, snapshots);
    sqlx::raw_sql("DROP FUNCTION reader_recommendations_before_learning_test(text,timestamptz,boolean,uuid[],jsonb)")
        .execute(pool).await?;
    eprintln!(
        "Verified opt-in reading: strict inputs/CSRF/RLS, duplicate/version/generation guards, cold/visitor parity, decay/cap/future boundaries, stronger explicit feedback, export/clear/disable, and unchanged saved editions. Synthetic evidence only; no measured personal recommendation lift."
    );
    Ok(())
}
