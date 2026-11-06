use super::*;

pub(super) async fn verify_development_queue(pool: &PgPool) -> anyhow::Result<()> {
    let pending: Vec<(Uuid, Option<chrono::DateTime<chrono::Utc>>)> =
        sqlx::query_as("SELECT event_id,next_attempt_at FROM summary_jobs WHERE status='pending'")
            .fetch_all(pool)
            .await?;
    sqlx::query(
        "UPDATE summary_jobs SET next_attempt_at=now()+interval '1 day' WHERE status='pending'",
    )
    .execute(pool)
    .await?;
    let build = Uuid::new_v4();
    let version = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO events(id,canonical_title,summary,importance,primary_topic,event_type,
        first_seen_at,updated_at,summary_kind,content_version)
        VALUES($1,'trunk/abcdef1234567890: Align XPU test decorators (#186089)',
            'Isolated internal build fixture','','AI Infra','release',now(),now(),'feed',1)",
    )
    .bind(build)
    .execute(pool)
    .await?;
    let automation = crate::automation::AutomationStore::new(pool.clone());
    assert!(
        automation.claim_event_for_test().await?.is_none(),
        "development builds must not consume automatic calls"
    );
    let state: (String, i32) =
        sqlx::query_as("SELECT status,attempts FROM summary_jobs WHERE event_id=$1")
            .bind(build)
            .fetch_one(pool)
            .await?;
    assert_eq!(
        state,
        ("pending".into(), 0),
        "skip without rewriting job history"
    );
    sqlx::query("INSERT INTO events(id,canonical_title,summary,importance,primary_topic,event_type,
        first_seen_at,updated_at,summary_kind,content_version)
        VALUES($1,'PyTorch 2.9.0','Isolated user-facing release fixture','','AI Infra','release',now(),now(),'feed',1)")
        .bind(version).execute(pool).await?;
    assert_eq!(
        automation.claim_event_for_test().await?,
        Some(version),
        "real releases remain eligible"
    );
    assert!(automation.claim_event_for_test().await?.is_none());
    sqlx::query("DELETE FROM events WHERE id=ANY($1)")
        .bind(vec![build, version])
        .execute(pool)
        .await?;
    for (event, next_attempt) in pending {
        sqlx::query("UPDATE summary_jobs SET next_attempt_at=$2 WHERE event_id=$1")
            .bind(event)
            .bind(next_attempt)
            .execute(pool)
            .await?;
    }
    Ok(())
}

pub(super) async fn verify_copy_ownership(
    pool: &PgPool,
    a: &Reader,
    b: &Reader,
) -> anyhow::Result<()> {
    let tag = format!("COPY_QUALITY_{}", Uuid::new_v4().simple());
    let (source_one, public_one) = fixture(pool, None, &tag).await?;
    let (source_two, public_two) = fixture(pool, None, &tag).await?;
    let (source_a, private_a) = fixture(pool, Some(a.id.to_string()), &tag).await?;
    let (source_b, private_b) = fixture(pool, Some(b.id.to_string()), &tag).await?;
    for (reader, visible, forbidden) in [(a, private_a, private_b), (b, private_b, private_a)] {
        let response = reader
            .ok(
                "GET",
                &format!("/api/v1/events?q={tag}&coverage=true&hours=0"),
                Value::Null,
            )
            .await;
        assert_eq!(response["items"].as_array().unwrap().len(), 1);
        let bundle = &response["items"][0]["coverage"];
        assert_eq!(bundle["relation"], "same_article");
        let ids: std::collections::BTreeSet<Uuid> = bundle["members"]
            .as_array()
            .unwrap()
            .iter()
            .map(|member| member["eventId"].as_str().unwrap().parse().unwrap())
            .collect();
        assert_eq!(ids, [public_one, public_two, visible].into_iter().collect());
        assert!(!response.to_string().contains(&forbidden.to_string()));
        let detail = reader
            .ok("GET", &format!("/api/v1/events/{public_one}"), Value::Null)
            .await;
        assert_eq!(detail["coverage"]["members"].as_array().unwrap().len(), 3);
        assert!(!detail.to_string().contains(&forbidden.to_string()));
    }
    let public =
        crate::postgres_store::PostgresStore::new(ScopedDb::from(pool.clone()).reader("local"));
    let interests = crate::visitor_interests::VisitorInterests::try_from("agents:50".to_owned())
        .map_err(anyhow::Error::msg)?;
    let result = public
        .list_events(&crate::models::EventQuery {
            q: Some(tag),
            coverage: Some(true),
            hours: Some(0),
            interests: Some(interests),
            ..Default::default()
        })
        .await?;
    assert_eq!(result.len(), 1);
    let ids: std::collections::BTreeSet<_> = result[0]
        .coverage
        .as_ref()
        .unwrap()
        .members
        .iter()
        .map(|member| member.event_id)
        .collect();
    assert_eq!(ids, [public_one, public_two].into_iter().collect());
    let events = vec![public_one, public_two, private_a, private_b];
    let sources = vec![source_one, source_two, source_a, source_b];
    sqlx::query("DELETE FROM event_evidence WHERE event_id=ANY($1)")
        .bind(&events)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM events WHERE id=ANY($1)")
        .bind(&events)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM content_items WHERE source_id=ANY($1)")
        .bind(&sources)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM sources WHERE id=ANY($1)")
        .bind(&sources)
        .execute(pool)
        .await?;
    Ok(())
}
