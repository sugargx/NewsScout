use super::{Reader, Uuid};
use crate::{
    models::{EventQuery, EventStateInput},
    postgres_store::PostgresStore,
    scoped_db::ScopedDb,
    store::Store,
    visitor_interests::VisitorInterests,
};
use anyhow::{Context, Result};
use serde_json::json;
use sqlx::{PgPool, Row, postgres::PgPoolOptions};
use std::{collections::HashSet, time::Instant};

const EVENT_COUNT: i32 = 2_400;
const ACTIVE_EVENT_COUNT: i32 = 60;

fn fixture_id(kind: &str, ordinal: i32) -> Uuid {
    let namespace = match kind {
        "source" => 0x50_u128,
        "event" => 0x51_u128,
        "content" => 0x52_u128,
        "release-event" => 0x53_u128,
        "release-content" => 0x54_u128,
        "publisher" => 0x55_u128,
        _ => unreachable!("unknown performance fixture kind"),
    };
    Uuid::from_u128((namespace << 120) | ordinal as u128)
}

async fn seed(pool: &PgPool) -> Result<()> {
    let source = fixture_id("source", 1);
    sqlx::query(
        "INSERT INTO sources(id,name,endpoint,content_type,adapter_type,tier,lifecycle_status,last_success_at)
         VALUES($1,'PERF_R8_SOURCE',$2,'blog','rss','T1','stable',now())
         ON CONFLICT(id) DO NOTHING",
    )
    .bind(source)
    .bind(format!("https://perf.scoutnews.test/{source}/feed"))
    .execute(pool)
    .await?;
    let event_ids: Vec<_> = (1..=EVENT_COUNT)
        .map(|ordinal| fixture_id("event", ordinal))
        .collect();
    let content_ids: Vec<_> = (1..=EVENT_COUNT)
        .map(|ordinal| fixture_id("content", ordinal))
        .collect();
    let ordinals: Vec<_> = (1..=EVENT_COUNT).collect();
    sqlx::query(
        "INSERT INTO events(id,canonical_title,summary,importance,primary_topic,event_type,
            first_seen_at,updated_at,created_at,summary_kind,summary_model,summary_format_version,
            content_version,summary_points,summarized_at,status)
         SELECT fixture.id,'PERF_R8 ordinary '||fixture.ordinal,
            'PERF_R8 bounded synthetic summary '||fixture.ordinal,
            'Measured results','工程与开源','blog',
            now()-make_interval(mins=>fixture.ordinal),now(),now()-make_interval(mins=>fixture.ordinal),
            'copilot','gpt-5.6-terra',3,1,
            jsonb_build_array('PERF_R8 point '||fixture.ordinal),now(),
            CASE WHEN fixture.ordinal<=$3 THEN 'published' ELSE 'withdrawn' END
         FROM unnest($1::uuid[],$2::integer[]) fixture(id,ordinal)
         ON CONFLICT(id) DO NOTHING",
    )
    .bind(&event_ids)
    .bind(&ordinals)
    .bind(ACTIVE_EVENT_COUNT)
    .execute(pool)
    .await?;
    sqlx::query(
        "INSERT INTO content_items(id,source_id,content_type,original_url,canonical_url,title,
            content_hash,published_at,created_at,metadata)
         SELECT fixture.id,$1,'blog',
            CASE WHEN fixture.ordinal<=40
              THEN 'https://github.com/scoutnews/perf/issues/'||((fixture.ordinal+1)/2)
              ELSE 'https://perf.scoutnews.test/articles/'||fixture.ordinal END,
            CASE WHEN fixture.ordinal<=40
              THEN 'https://github.com/scoutnews/perf/issues/'||((fixture.ordinal+1)/2)
              ELSE 'https://perf.scoutnews.test/articles/'||fixture.ordinal END,
            'PERF_R8 ordinary '||fixture.ordinal,fixture.id::text,
            CASE WHEN fixture.ordinal<=$4
              THEN now()-make_interval(mins=>fixture.ordinal)
              ELSE now()-make_interval(days=>fixture.ordinal) END,
            CASE WHEN fixture.ordinal<=$4
              THEN now()-make_interval(mins=>fixture.ordinal)
              ELSE now()-make_interval(days=>fixture.ordinal) END,
            jsonb_build_object(
              'feedSummary',repeat('PERF_R8 measured latency and throughput material. ',12),
              'sourceMetadata',jsonb_build_object('datePrecision','time'))
         FROM unnest($2::uuid[],$3::integer[]) fixture(id,ordinal)
         ON CONFLICT(id) DO NOTHING",
    )
    .bind(source)
    .bind(&content_ids)
    .bind(&ordinals)
    .bind(ACTIVE_EVENT_COUNT)
    .execute(pool)
    .await?;
    sqlx::query(
        "INSERT INTO event_evidence(event_id,content_item_id,is_official)
         SELECT fixture.event_id,fixture.content_id,true
         FROM unnest($1::uuid[],$2::uuid[]) fixture(event_id,content_id)
         ON CONFLICT DO NOTHING",
    )
    .bind(&event_ids)
    .bind(&content_ids)
    .execute(pool)
    .await?;
    Ok(())
}

async fn seed_release_family(pool: &PgPool, releases: &[(i32, &str, &str)]) -> Result<()> {
    // The vendor's own release feed is first-party material. editorial-significance-v1
    // correctly keeps an unclassified source's patch release out of the daily brief.
    let publisher = fixture_id("publisher", 1);
    sqlx::query(
        "INSERT INTO publishers(id,name,entity_type) VALUES($1,'PERF_R8_RELEASE_VENDOR','company')
         ON CONFLICT(id) DO NOTHING",
    )
    .bind(publisher)
    .execute(pool)
    .await?;
    let source = fixture_id("source", 2);
    sqlx::query(
        "INSERT INTO sources(id,publisher_id,name,endpoint,content_type,adapter_type,tier,lifecycle_status,last_success_at)
         VALUES($1,$2,'PERF_R8_RELEASES',$3,'release','rss','T1','stable',now())
         ON CONFLICT(id) DO NOTHING",
    )
    .bind(source)
    .bind(publisher)
    .bind(format!("https://perf.scoutnews.test/{source}/releases.atom"))
    .execute(pool)
    .await?;
    for &(ordinal, target, version) in releases {
        let event = fixture_id("release-event", ordinal);
        let content = fixture_id("release-content", ordinal);
        let title = format!("Perf Releases {target} Plugin (v{version})");
        let url = format!(
            "https://github.com/scoutnews/perf-releases/releases/tag/{}-v{version}",
            target.to_ascii_lowercase()
        );
        sqlx::query(
            "INSERT INTO events(id,canonical_title,summary,importance,primary_topic,event_type,
                first_seen_at,updated_at,summary_kind,summary_model,summary_format_version,
                content_version,summary_points,summarized_at)
             VALUES($1,$2,$3,'Measured results','工程与开源','release',
                now()-interval '30 minutes',now(),'copilot','gpt-5.6-terra',3,1,$4,now())
             ON CONFLICT(id) DO NOTHING",
        )
        .bind(event)
        .bind(&title)
        .bind(format!("PERF_R8 release {target}"))
        .bind(json!([format!("PERF_R8 {target} release")]))
        .execute(pool)
        .await?;
        sqlx::query(
            "INSERT INTO content_items(id,source_id,content_type,original_url,canonical_url,title,
                content_hash,published_at,metadata)
             VALUES($1,$2,'release',$3,$3,$4,$5,now()-interval '30 minutes',$6)
             ON CONFLICT(id) DO NOTHING",
        )
        .bind(content)
        .bind(source)
        .bind(&url)
        .bind(&title)
        .bind(content.to_string())
        .bind(json!({
            "feedSummary":"Shared release change #42",
            "sourceMetadata":{"datePrecision":"time"}
        }))
        .execute(pool)
        .await?;
        sqlx::query(
            "INSERT INTO event_evidence(event_id,content_item_id,is_official)
             VALUES($1,$2,true) ON CONFLICT DO NOTHING",
        )
        .bind(event)
        .bind(content)
        .execute(pool)
        .await?;
    }
    Ok(())
}

async fn verify_coverage_context(
    pool: &PgPool,
    a_id: Uuid,
    a_store: &PostgresStore,
    b_store: &PostgresStore,
) -> Result<()> {
    let visitor = VisitorInterests::try_from("agents:50".to_owned())
        .map_err(anyhow::Error::msg)?;
    let mut failures = Vec::new();
    for (kind, hidden_ordinal, visible_ordinal) in [("event", 2, 1), ("release-event", 2, 1)] {
        let hidden_id = fixture_id(kind, hidden_ordinal);
        let visible_id = fixture_id(kind, visible_ordinal);
        let hidden = a_store
            .update_event_state(
                hidden_id,
                EventStateInput {
                    not_interested: Some(true),
                    ..Default::default()
                },
            )
            .await?
            .context("dismissed detail must remain explicitly readable")?;
        assert!(hidden.not_interested);
        let detail = a_store
            .get_event(visible_id)
            .await?
            .context("visible coverage seed missing")?;
        if detail.coverage.as_ref().is_some_and(|coverage| {
            coverage.members.iter().any(|member| member.event_id == hidden_id)
        }) {
            failures.push(format!("{kind}: dismissed detail member returned"));
        }
        for other in [
            b_store.get_event(visible_id).await?,
            a_store.visitor_event(visible_id, &visitor).await?,
        ] {
            let coverage = other
                .context("other reader or visitor detail missing")?
                .coverage
                .context("other reader or visitor coverage missing")?;
            assert!(coverage.members.iter().any(|member| member.event_id == hidden_id));
        }
        if kind == "release-event" {
            // Saved editions are fixed, and reader A saved one earlier in this contract.
            // Check the live selection a new edition would save from current material.
            sqlx::query(
                "DELETE FROM daily_brief_items WHERE brief_id IN(SELECT id FROM daily_briefs WHERE owner_user_id=$1)",
            )
            .bind(a_id.to_string())
            .execute(pool)
            .await?;
            sqlx::query("DELETE FROM daily_briefs WHERE owner_user_id=$1")
                .bind(a_id.to_string())
                .execute(pool)
                .await?;
            let brief = a_store.latest_brief().await?;
            assert!(!brief.is_snapshot);
            let visible = brief.items.iter().find(|event| event.id == visible_id)
                .context("eligible release seed must appear in the private brief")?;
            if visible.coverage.as_ref().is_some_and(|coverage| {
                coverage.members.iter().any(|member| member.event_id == hidden_id)
            }) {
                failures.push("brief: dismissed related member returned".to_owned());
            }
        }
        a_store
            .update_event_state(
                hidden_id,
                EventStateInput {
                    not_interested: Some(false),
                    ..Default::default()
                },
            )
            .await?
            .context("restored synthetic member missing")?;
    }

    seed_release_family(pool, &[(3, "Cline", "1.2.5")]).await?;
    for (ordinal, minutes) in [(1, 25 * 60), (2, 2 * 60), (3, 1)] {
        sqlx::query(
            "UPDATE content_items SET published_at=now()-make_interval(mins=>$2) WHERE id=$1",
        )
        .bind(fixture_id("release-content", ordinal))
        .bind(minutes)
        .execute(pool)
        .await?;
    }
    let list = a_store
        .list_events(&EventQuery {
            q: Some("Perf Releases".into()),
            hours: Some(72),
            coverage: Some(true),
            limit: Some(50),
            ..Default::default()
        })
        .await?;
    let oldest = fixture_id("release-event", 1);
    let newest_members: HashSet<_> = [2, 3]
        .map(|ordinal| fixture_id("release-event", ordinal))
        .into_iter()
        .collect();
    assert!(list.iter().any(|event| event.id == oldest && event.coverage.is_none()));
    assert!(list.iter().any(|event| event.coverage.as_ref().is_some_and(|coverage| {
        coverage.members.iter().map(|member| member.event_id).collect::<HashSet<_>>()
            == newest_members
    })));
    for ordinal in 1..=3 {
        let id = fixture_id("release-event", ordinal);
        let detail = a_store.get_event(id).await?.context("cohort detail missing")?;
        let detail_members: HashSet<_> = detail.coverage.as_ref()
            .map(|coverage| coverage.members.iter().map(|member| member.event_id).collect())
            .unwrap_or_else(|| HashSet::from([id]));
        let expected = if ordinal == 1 { HashSet::from([oldest]) } else { newest_members.clone() };
        if detail_members != expected {
            failures.push(format!("release {ordinal}: detail cohort differs from list"));
        }
    }
    anyhow::ensure!(failures.is_empty(), "coverage context regressions: {}", failures.join("; "));
    Ok(())
}

async fn profile_ranker(db: &ScopedDb, actor: &str, timeout: &str) -> Result<(f64, f64, i64)> {
    let mut tx = db.begin().await?;
    sqlx::query(&format!("SET LOCAL statement_timeout='{timeout}'"))
        .execute(&mut *tx)
        .await?;
    let row = sqlx::query(
        r#"EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
        SELECT e.id,r.rank_score FROM events e
        JOIN reader_editorial_recommendations_for_profile($1,$2,false,ARRAY(
          SELECT candidate.id FROM events candidate
          LEFT JOIN user_event_states cs ON cs.event_id=candidate.id AND cs.user_id=$1
          WHERE candidate.status='published' AND cs.not_interested_at IS NULL
            AND NOT reader_is_opaque_engineering_release(
              candidate.event_type,candidate.canonical_title)
        ),NULL) r ON r.event_id=e.id
        LEFT JOIN user_event_states us ON us.event_id=e.id AND us.user_id=$1
        WHERE e.status='published'
          AND NOT reader_is_opaque_engineering_release(e.event_type,e.canonical_title)
          AND NOT r.not_interested
          AND (e.canonical_title ILIKE '%PERF_R8%'
            OR e.display_title ILIKE '%PERF_R8%'
            OR e.summary ILIKE '%PERF_R8%'
            OR EXISTS(SELECT 1 FROM unnest(r.facets) facet
              WHERE facet ILIKE '%PERF_R8%'))
        ORDER BY r.rank_score DESC,e.updated_at DESC,e.id LIMIT 50"#,
    )
    .bind(actor)
    .bind(chrono::Utc::now())
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    let plan: serde_json::Value = row.try_get("QUERY PLAN")?;
    let report = plan
        .as_array()
        .and_then(|plans| plans.first())
        .context("rank plan report missing")?;
    Ok((
        report["Planning Time"]
            .as_f64()
            .context("rank planning time missing")?,
        report["Execution Time"]
            .as_f64()
            .context("rank execution time missing")?,
        report["Plan"]["Actual Rows"]
            .as_i64()
            .context("rank actual rows missing")?,
    ))
}

async fn profile_first_list(actor: &str, settings: &[&str]) -> Result<u128> {
    let url = std::env::var("SCOUTNEWS_CLOUD_TEST_DATABASE_URL")?;
    let pool = if settings.is_empty() {
        crate::connect_runtime_database(&url).await?
    } else {
        let settings: Vec<String> = settings.iter().map(|setting| (*setting).into()).collect();
        PgPoolOptions::new()
            .max_connections(1)
            .after_connect(move |connection, _| {
                let settings = settings.clone();
                Box::pin(async move {
                    for setting in settings {
                        sqlx::query(&setting).execute(&mut *connection).await?;
                    }
                    Ok(())
                })
            })
            .connect(&url)
            .await?
    };
    let store = PostgresStore::new(ScopedDb::from(pool.clone()).reader(actor));
    let query = EventQuery {
        q: Some("PERF_R8".into()),
        limit: Some(50),
        ..Default::default()
    };
    let started = Instant::now();
    let events = store.list_events(&query).await?;
    let elapsed = started.elapsed().as_millis();
    assert_eq!(events.len(), 50);
    if settings.is_empty() {
        assert!(elapsed < 5_000, "first reader request after production bootstrap took {elapsed}ms");
        for repeat in 1..=8 {
            let started = Instant::now();
            let repeated = store.list_events(&query).await?;
            let elapsed = started.elapsed().as_millis();
            assert_eq!(
                repeated.iter().map(|event| event.id).collect::<Vec<_>>(),
                events.iter().map(|event| event.id).collect::<Vec<_>>(),
            );
            assert!(elapsed < 5_000, "runtime pool request {repeat} took {elapsed}ms");
            eprintln!("PERF_R8 runtime_pool_repeat={repeat} elapsed_ms={elapsed}");
        }
    }
    pool.close().await;
    Ok(elapsed)
}

async fn profile_coverage_candidates(db: &ScopedDb) -> Result<(f64, i64, i64)> {
    let mut tx = db.begin().await?;
    let row = sqlx::query(
        r#"EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
        WITH published_candidates AS MATERIALIZED (
          SELECT DISTINCT window_evidence.event_id
          FROM content_items window_content
          JOIN event_evidence window_evidence
            ON window_evidence.content_item_id=window_content.id
          WHERE window_content.published_at BETWEEN $1 AND $2
            AND window_content.created_at<=$2
        ), authorized_events AS MATERIALIZED (
          SELECT e.id,e.event_type
          FROM published_candidates candidate
          JOIN events e ON e.id=candidate.event_id
          LEFT JOIN user_event_states us
            ON us.event_id=e.id AND us.user_id=scoutnews_actor() AND NOT $3
          WHERE e.status='published' AND e.created_at<=$2
            AND ($3 OR us.not_interested_at IS NULL)
        )
        SELECT DISTINCT e.id,e.event_type,ci.original_url
        FROM authorized_events e
        JOIN event_evidence ee ON ee.event_id=e.id
        JOIN content_items ci ON ci.id=ee.content_item_id
        WHERE ci.created_at<=$2
          AND (lower(ci.original_url) LIKE 'https://github.com/%/releases/tag/%'
            OR lower(ci.original_url) LIKE 'https://github.com/%/pull/%'
            OR lower(ci.original_url) LIKE 'https://github.com/%/issues/%'
            OR lower(ci.original_url) LIKE 'https://arxiv.org/abs/%')"#,
    )
    .bind(chrono::Utc::now() - chrono::Duration::days(14))
    .bind(chrono::Utc::now())
    .bind(false)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    let plan: serde_json::Value = row.try_get("QUERY PLAN")?;
    anyhow::ensure!(
        plan.to_string().contains("content_items_reader_published"),
        "publication candidate index missing from plan"
    );
    let report = plan
        .as_array()
        .and_then(|plans| plans.first())
        .context("coverage candidate plan report missing")?;
    Ok((
        report["Execution Time"]
            .as_f64()
            .context("coverage candidate execution time missing")?,
        report["Plan"]["Shared Hit Blocks"]
            .as_i64()
            .context("coverage candidate shared hits missing")?,
        report["Plan"]["Actual Rows"]
            .as_i64()
            .context("coverage candidate actual rows missing")?,
    ))
}

pub(super) async fn verify_reader_performance(pool: &PgPool, a: &Reader, b: &Reader) -> Result<()> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("scoutnews_api::postgres_store=debug")
        .with_ansi(false)
        .with_test_writer()
        .try_init();
    seed(pool).await?;
    let a_store = PostgresStore::new(ScopedDb::from(pool.clone()).reader(&a.id.to_string()));
    let b_store = PostgresStore::new(ScopedDb::from(pool.clone()).reader(&b.id.to_string()));
    let a_db = ScopedDb::from(pool.clone()).reader(&a.id.to_string());
    let query = || EventQuery {
        q: Some("PERF_R8".into()),
        limit: Some(50),
        ..Default::default()
    };

    eprintln!("PERF_R8 pool size={} idle={}", pool.size(), pool.num_idle());
    eprintln!("PERF_R8 stage=list");
    let started = Instant::now();
    let page = a_store.list_events(&query()).await?;
    let list_ms = started.elapsed().as_millis();
    assert_eq!(page.len(), 50);
    assert!(page.iter().all(|event| !event.evidence.is_empty()));
    eprintln!("PERF_R8 stage=list-warm");
    let started = Instant::now();
    let warm_page = a_store.list_events(&query()).await?;
    let list_warm_ms = started.elapsed().as_millis();
    assert_eq!(
        page.iter().map(|event| event.id).collect::<Vec<_>>(),
        warm_page.iter().map(|event| event.id).collect::<Vec<_>>()
    );

    let page_query = |offset| EventQuery {
        q: Some("PERF_R8".into()),
        coverage: Some(true),
        limit: Some(25),
        offset: Some(offset),
        ..Default::default()
    };
    eprintln!("PERF_R8 stage=grouped");
    let started = Instant::now();
    let first = a_store.list_events(&page_query(0)).await?;
    let second = a_store.list_events(&page_query(25)).await?;
    let grouped_ms = started.elapsed().as_millis();
    assert_eq!(first.len(), 25);
    assert_eq!(second.len(), 15);
    let first_ids: HashSet<_> = first.iter().map(|event| event.id).collect();
    assert!(second.iter().all(|event| !first_ids.contains(&event.id)));
    assert_eq!(
        first.iter().map(|event| event.id).collect::<Vec<_>>(),
        a_store
            .list_events(&page_query(0))
            .await?
            .iter()
            .map(|event| event.id)
            .collect::<Vec<_>>()
    );

    eprintln!("PERF_R8 stage=explore");
    let started = Instant::now();
    let explore = a
        .ok("GET", "/api/v1/explore?q=PERF_R8", serde_json::Value::Null)
        .await;
    let explore_ms = started.elapsed().as_millis();
    assert_eq!(explore["sampleSize"], ACTIVE_EVENT_COUNT);

    eprintln!("PERF_R8 stage=brief");
    let started = Instant::now();
    let brief = a_store.latest_brief().await?;
    let brief_ms = started.elapsed().as_millis();
    assert!(brief.items.len() <= ACTIVE_EVENT_COUNT as usize);

    eprintln!("PERF_R8 stage=rank-plan-60");
    let (rank60_planning_ms, rank60_execution_ms, rank60_rows) =
        profile_ranker(&a_db, &a.id.to_string(), "30s").await?;
    assert_eq!(rank60_rows, 50);
    eprintln!("PERF_R8 stage=coverage-candidate-plan");
    let (coverage_candidate_execution_ms, coverage_candidate_shared_hits, coverage_candidate_rows) =
        profile_coverage_candidates(&a_db).await?;
    eprintln!("PERF_R8 stage=list-fresh-default");
    let list_fresh_default_ms = profile_first_list(&a.id.to_string(), &[]).await?;
    eprintln!("PERF_R8 stage=list-jit-off");
    let list_jit_off_ms = profile_first_list(&a.id.to_string(), &["SET jit=off"]).await?;
    eprintln!("PERF_R8 stage=list-force-generic");
    let list_force_generic_ms = profile_first_list(
        &a.id.to_string(),
        &["SET plan_cache_mode=force_generic_plan"],
    )
    .await?;
    eprintln!("PERF_R8 stage=list-generic-no-jit");
    let list_generic_no_jit_ms = profile_first_list(
        &a.id.to_string(),
        &["SET plan_cache_mode=force_generic_plan", "SET jit=off"],
    )
    .await?;

    let singleton_id = fixture_id("event", 50);
    eprintln!("PERF_R8 stage=singleton");
    let started = Instant::now();
    let singleton = a_store
        .get_event(singleton_id)
        .await?
        .context("singleton event missing")?;
    let singleton_ms = started.elapsed().as_millis();
    assert!(singleton.coverage.is_none());
    let singleton_list = a_store
        .list_events(&EventQuery {
            q: Some("PERF_R8 ordinary 50".into()),
            limit: Some(1),
            ..Default::default()
        })
        .await?;
    assert_eq!(singleton_list.len(), 1);
    assert_eq!(singleton_list[0].id, singleton.id);
    assert_eq!(singleton_list[0].title, singleton.title);
    assert_eq!(singleton_list[0].summary, singleton.summary);
    assert_eq!(
        serde_json::to_value(&singleton_list[0].evidence)?,
        serde_json::to_value(&singleton.evidence)?
    );

    let related_id = fixture_id("event", 1);
    eprintln!("PERF_R8 stage=related");
    let started = Instant::now();
    let related = a_store
        .get_event(related_id)
        .await?
        .context("related event missing")?;
    let related_ms = started.elapsed().as_millis();
    let bundle = related.coverage.context("exact-reference bundle missing")?;
    assert_eq!(bundle.relation, "same_event_evidence");
    assert_eq!(bundle.members.len(), 2);
    seed_release_family(pool, &[(1, "Claude", "1.2.3"), (2, "Cursor", "1.2.4")]).await?;
    let release = a_store
        .get_event(fixture_id("release-event", 1))
        .await?
        .context("release event missing")?;
    let release_bundle = release.coverage.context("release-family bundle missing")?;
    assert_eq!(release_bundle.relation, "release_family");
    assert_eq!(release_bundle.members.len(), 2);

    eprintln!("PERF_R8 stage=state");
    let started = Instant::now();
    let updated = a_store
        .update_event_state(
            singleton_id,
            EventStateInput {
                saved: Some(true),
                read: Some(true),
                opened: Some(true),
                ..Default::default()
            },
        )
        .await?
        .context("state update event missing")?;
    let state_ms = started.elapsed().as_millis();
    assert!(updated.saved && updated.read && updated.opened);
    assert!(
        !b_store
            .get_event(singleton_id)
            .await?
            .context("other reader event missing")?
            .saved
    );
    assert!(
        a_store
            .update_event_state(
                fixture_id("event", EVENT_COUNT + 1),
                EventStateInput {
                    saved: Some(true),
                    ..Default::default()
                },
            )
            .await?
            .is_none()
    );
    assert!(
        !b.ok("GET", "/api/v1/events?limit=1", serde_json::Value::Null)
            .await
            .to_string()
            .contains(&a.id.to_string())
    );

    let expanded_ids: Vec<_> = (ACTIVE_EVENT_COUNT + 1..=300)
        .map(|ordinal| fixture_id("event", ordinal))
        .collect();
    sqlx::query("UPDATE events SET status='published' WHERE id=ANY($1)")
        .bind(&expanded_ids)
        .execute(pool)
        .await?;
    eprintln!("PERF_R8 stage=rank-plan-300");
    let rank300 = profile_ranker(&a_db, &a.id.to_string(), "120s").await;
    sqlx::query("UPDATE events SET status='withdrawn' WHERE id=ANY($1)")
        .bind(&expanded_ids)
        .execute(pool)
        .await?;
    let (rank300_planning_ms, rank300_execution_ms, rank300_rows) = rank300?;
    assert_eq!(rank300_rows, 50);

    eprintln!(
        "PERF_R8 events={EVENT_COUNT} active_events={ACTIVE_EVENT_COUNT} \
        list_ms={list_ms} list_warm_ms={list_warm_ms} \
        grouped_two_pages_ms={grouped_ms} explore_ms={explore_ms} \
        brief_ms={brief_ms} singleton_detail_ms={singleton_ms} \
        related_detail_ms={related_ms} state_update_ms={state_ms} \
        list_fresh_default_ms={list_fresh_default_ms} \
        list_jit_off_ms={list_jit_off_ms} \
        list_force_generic_ms={list_force_generic_ms} \
        list_generic_no_jit_ms={list_generic_no_jit_ms} \
        coverage_candidate_rows={coverage_candidate_rows} \
        coverage_candidate_shared_hits={coverage_candidate_shared_hits} \
        coverage_candidate_execution_ms={coverage_candidate_execution_ms:.3} \
        rank60_planning_ms={rank60_planning_ms:.3} \
        rank60_execution_ms={rank60_execution_ms:.3} \
        rank300_planning_ms={rank300_planning_ms:.3} \
        rank300_execution_ms={rank300_execution_ms:.3}"
    );
    eprintln!("PERF_R8 stage=coverage-context-regressions");
    verify_coverage_context(pool, a.id, &a_store, &b_store).await?;
    Ok(())
}
