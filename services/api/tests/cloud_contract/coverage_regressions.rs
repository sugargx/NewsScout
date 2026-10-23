use super::*;
use chrono::Utc;

/// Publishers that a day of aggregator picks showed this catalog could not see.
const REGISTERED: [(&str, &str, &str, &str); 5] = [
    (
        "DeepSeek GitHub repositories",
        "https://api.github.com/search/repositories?q=org%3Adeepseek-ai+archived%3Afalse&sort=updated&order=desc&per_page=20",
        "github_search",
        "repository",
    ),
    ("vLLM Blog", "https://vllm.ai/blog/rss.xml", "rss", "blog"),
    ("IBM Research Blog", "https://research.ibm.com/rss", "rss", "blog"),
    ("Ai2 Blog", "https://allenai.org/rss.xml", "rss", "blog"),
    ("Claude Product Blog", "https://claude.com/resources/articles", "claude_blog", "blog"),
];

/// Publishers that were already registered before this catalog. Re-adding one
/// would create a duplicate subscription, so the migration must skip it and the
/// original row must stay untouched.
const ALREADY_COVERED: [&str; 1] = ["https://huggingface.co/blog/feed.xml"];

/// The coverage catalog must register on a fresh database, stay inside the
/// adapters' public contracts, and claim only topics that exist.
pub(super) async fn verify_coverage_catalog(pool: &PgPool) -> anyhow::Result<()> {
    for (name, endpoint, adapter, content_type) in REGISTERED {
        let source: (String, String, String, String, String, Value) = sqlx::query_as(
            "SELECT s.name,s.adapter_type,s.content_type,s.tier,s.lifecycle_status,s.compliance
             FROM sources s WHERE s.owner_user_id IS NULL AND s.endpoint=$1",
        )
        .bind(endpoint)
        .fetch_one(pool)
        .await?;
        assert_eq!(source.0, name);
        assert_eq!(source.1, adapter, "{name}");
        assert_eq!(source.2, content_type, "{name}");
        assert_eq!(source.3, "T1", "{name}");
        assert_eq!(source.4, "observing", "{name}");
        assert_eq!(source.5["provenance"], json!("direct_publisher"), "{name}");
        assert!(
            source.5["sampleTitle"].as_str().is_some_and(|title| !title.trim().is_empty()),
            "{name} must record the entry that was actually sampled"
        );
        // Every endpoint must satisfy the adapter contract a reader-added source
        // would be held to; a migration may not smuggle in a wider one.
        crate::ingestion::validate_adapter_endpoint(adapter, endpoint)
            .unwrap_or_else(|error| panic!("{name} endpoint is outside its contract: {error}"));
        let topics: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM source_topics st JOIN sources s ON s.id=st.source_id
             WHERE s.endpoint=$1",
        )
        .bind(endpoint)
        .fetch_one(pool)
        .await?;
        assert!(topics > 0, "{name} must land in at least one real topic");
    }
    for endpoint in ALREADY_COVERED {
        let rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM sources WHERE owner_user_id IS NULL AND endpoint=$1",
        )
        .bind(endpoint)
        .fetch_one(pool)
        .await?;
        assert_eq!(rows, 1, "{endpoint} must stay a single subscription");
        let late: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM sources WHERE endpoint=$1
               AND compliance->>'catalogVersion'='2026-10-21-coverage'",
        )
        .bind(endpoint)
        .fetch_one(pool)
        .await?;
        assert_eq!(late, 0, "{endpoint} was already covered and must not be re-registered");
    }

    let unknown: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT claimed FROM sources s
         CROSS JOIN LATERAL jsonb_array_elements_text(s.compliance->'topicIds') claimed
         WHERE s.compliance->>'catalogVersion'='2026-10-21-coverage'
           AND NOT EXISTS(SELECT 1 FROM taxonomy_nodes tn WHERE tn.id=claimed)",
    )
    .fetch_all(pool)
    .await?;
    assert_eq!(unknown, Vec::<String>::new(), "a catalog may not claim a topic that does not exist");

    // The repository search is restricted to one owning account. An open search
    // would make unvetted repositories look like a publisher's own work.
    let search: String = sqlx::query_scalar(
        "SELECT endpoint FROM sources WHERE name='DeepSeek GitHub repositories'",
    )
    .fetch_one(pool)
    .await?;
    assert!(search.contains("q=org%3Adeepseek-ai"), "{search}");

    let aggregated: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sources WHERE adapter_type='aihot_public'
           OR lower(endpoint) ~ '^https://([a-z0-9-]+\\.)*(aihot\\.news|aihot\\.virxact\\.com)([/:?]|$)'",
    )
    .fetch_one(pool)
    .await?;
    assert_eq!(aggregated, 0, "no aggregate platform is reintroduced");
    let same_publisher: bool = sqlx::query_scalar(
        "SELECT count(DISTINCT publisher_id)=1 FROM sources
         WHERE adapter_type IN('anthropic_news','anthropic_research','anthropic_engineering','claude_blog')",
    ).fetch_one(pool).await?;
    assert!(same_publisher, "a product subdomain must not create false independent corroboration");
    Ok(())
}

pub(super) async fn verify_source_failure_projection(pool: &PgPool, reader: &Reader) -> anyhow::Result<()> {
    let (source, event) = fixture(pool, None, "Failure projection").await?;
    let run = Uuid::new_v4();
    sqlx::query("INSERT INTO fetch_runs(id,source_id,started_at,status,error,http_meta)
        VALUES($1,$2,now(),'failed','PRIVATE_UPSTREAM_RESPONSE',
        '{\"failureCode\":\"format_changed\"}')")
        .bind(run).bind(source).execute(pool).await?;
    for (code, expected) in [
        ("format_changed", "来源格式已变化或不符合适配器约定，需要维护适配器"),
        ("PRIVATE_ARBITRARY_CODE", "Collection failed; retry later"),
    ] {
        sqlx::query("UPDATE fetch_runs SET http_meta=jsonb_build_object('failureCode',$2::text) WHERE id=$1")
            .bind(run).bind(code).execute(pool).await?;
        let response = reader.ok("GET", "/api/v1/sources", Value::Null).await;
        let visible = response["items"].as_array().unwrap().iter()
            .find(|item| item["id"] == source.to_string()).unwrap();
        assert_eq!(visible["lastError"], expected);
        assert!(!response.to_string().contains("PRIVATE_"));
    }
    sqlx::query("DELETE FROM events WHERE id=$1").bind(event).execute(pool).await?;
    sqlx::query("DELETE FROM content_items WHERE source_id=$1").bind(source).execute(pool).await?;
    sqlx::query("DELETE FROM fetch_runs WHERE source_id=$1").bind(source).execute(pool).await?;
    sqlx::query("DELETE FROM sources WHERE id=$1").bind(source).execute(pool).await?;
    Ok(())
}

pub(super) async fn verify_critical_disclosure_selection(pool: &PgPool) -> anyhow::Result<()> {
    for (title, kind, entity, expected) in [
        ("Agents uncover critical vulnerabilities in a runtime", "news", "company", true),
        ("Researchers disclose a zero-day vulnerability", "research", "lab", true),
        ("How to discover critical vulnerabilities", "tutorial", "company", false),
        ("Our security webinar", "promotion", "company", false),
        ("Agents uncover critical vulnerabilities in a runtime", "news", "community", false),
        ("An ordinary product update", "news", "company", false),
    ] {
        let policy: Value = sqlx::query_scalar("SELECT news_editorial_significance($1,$2,$3)")
            .bind(title).bind(kind).bind(entity).fetch_one(pool).await?;
        assert_eq!(policy["criticalDisclosure"].as_bool().unwrap_or(false), expected, "{title}");
    }
    let publisher = Uuid::new_v4();
    sqlx::query("INSERT INTO publishers(id,name,entity_type,official_domains) VALUES($1,$2,'company','[\"example.com\"]')")
        .bind(publisher).bind(format!("Disclosure publisher {publisher}")).execute(pool).await?;
    let mut pairs = Vec::new();
    let titles = [
        "Patch the Planet: global response coordination as agents uncover critical vulnerabilities",
        "How we built a new advertising platform",
        "Systems technical report",
    ];
    for title in titles {
        let (source, event) = fixture(pool, None, "Disclosure selection").await?;
        pairs.push((source, event));
        sqlx::query("UPDATE sources SET publisher_id=$2 WHERE id=$1")
            .bind(source).bind(publisher).execute(pool).await?;
        sqlx::query("UPDATE events SET canonical_title=$2,primary_topic='Agent' WHERE id=$1")
            .bind(event).bind(title).execute(pool).await?;
        sqlx::query("UPDATE content_items SET title=$2,original_url=$3,canonical_url=$3,
            published_at=now()-interval '15 hours',metadata='{\"feedSummary\":\"An original short publisher description.\"}' WHERE source_id=$1")
            .bind(source).bind(title).bind(format!("https://example.com/index/{event}"))
            .execute(pool).await?;
    }
    let store = crate::postgres_store::PostgresStore::new(pool.clone());
    let mut candidates = Vec::new();
    for (_, id) in &pairs {
        candidates.push(store.get_event(*id).await?.unwrap());
    }
    let now = Utc::now();
    let selected = crate::reader::select_brief(candidates.clone(), now);
    assert_eq!(selected.items.len(), 2, "publisher cap remains two");
    assert!(selected.items.iter().any(|event| event.id == pairs[0].1),
        "a short original critical disclosure must not lose both publisher slots to routine content");
    candidates[0].recommendation.as_mut().unwrap().score -= 25.0 * 0.35;
    let before_scores: Vec<_> = candidates.iter().map(|event|
        (&event.title, event.recommendation.as_ref().map(|rank| rank.score))).collect();
    let diagnostic = format!("{before_scores:?}");
    let before = crate::reader::select_brief(candidates, now);
    assert!(!before.items.iter().any(|event| event.id == pairs[0].1),
        "fixture must reproduce the pre-fix omission, not only assert the new score: {diagnostic}");
    for (source, event) in pairs {
        sqlx::query("DELETE FROM events WHERE id=$1").bind(event).execute(pool).await?;
        sqlx::query("DELETE FROM content_items WHERE source_id=$1").bind(source).execute(pool).await?;
        sqlx::query("DELETE FROM sources WHERE id=$1").bind(source).execute(pool).await?;
    }
    sqlx::query("DELETE FROM publishers WHERE id=$1").bind(publisher).execute(pool).await?;
    Ok(())
}

pub(super) async fn verify_explicit_edition_correction(
    pool: &PgPool,
    a: &Reader,
    b: &Reader,
) -> anyhow::Result<()> {
    let today = crate::reader::local_date(Utc::now());
    let date = today.pred_opt().unwrap();
    let cutoff = crate::edition::slot(date, 6);
    let (old_source, old) = fixture(pool, None, "Original saved edition").await?;
    let (new_source, required) = fixture(pool, Some(a.id.to_string()), "Recovered original publication").await?;
    sqlx::query("UPDATE content_items SET published_at=$2 WHERE source_id=ANY($1)")
        .bind(vec![old_source, new_source]).bind(cutoff-chrono::Duration::hours(1)).execute(pool).await?;
    let store_a = crate::postgres_store::PostgresStore::new(ScopedDb::from(pool.clone()).reader(&a.id.to_string()));
    let store_b = crate::postgres_store::PostgresStore::new(ScopedDb::from(pool.clone()).reader(&b.id.to_string()));
    let snapshot = serde_json::to_value(store_a.get_event(old).await?.unwrap())?;
    let mut briefs = Vec::new();
    for (owner, saved_date) in [
        (a.id, date), (a.id, date.pred_opt().unwrap()), (a.id, today), (b.id, date),
    ] {
        let id = Uuid::new_v4();
        briefs.push(id);
        let end = crate::edition::slot(saved_date, 6);
        sqlx::query("INSERT INTO daily_briefs(id,local_date,status,generated_at,published_at,rule_version,
            window_start,window_end,sections,owner_user_id)
            VALUES($1,$2,'published',$3,$3,$4,$5,$3,'[]',$6)")
            .bind(id).bind(saved_date).bind(end).bind(crate::reader::DAILY_SELECTION_RULE)
            .bind(end-chrono::Duration::days(7)).bind(owner.to_string()).execute(pool).await?;
        sqlx::query("INSERT INTO daily_brief_items(brief_id,event_id,rank,section,selection_reason,snapshot)
            VALUES($1,$2,1,'fixture','original',$3)")
            .bind(id).bind(old).bind(&snapshot).execute(pool).await?;
    }
    let frozen = |ids: Vec<Uuid>| async move {
        sqlx::query_scalar::<_, Value>("SELECT jsonb_agg(jsonb_build_object('brief',to_jsonb(b),
            'items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.rank) FROM daily_brief_items i WHERE i.brief_id=b.id))
            ORDER BY b.id) FROM daily_briefs b WHERE b.id=ANY($1)")
            .bind(ids).fetch_one(pool).await
    };
    let before = frozen(briefs.clone()).await?;
    assert!(store_a.correct_saved_edition(date, cutoff+chrono::Duration::seconds(1), &[required]).await.is_err());
    assert!(store_b.correct_saved_edition(date, cutoff, &[required]).await.is_err(),
        "another reader's private event cannot be forced into an edition");
    sqlx::query("UPDATE events SET summary_kind='feed' WHERE id=$1").bind(required).execute(pool).await?;
    assert!(store_a.correct_saved_edition(date, cutoff, &[required]).await.is_err(),
        "an incomplete summary must leave the saved edition untouched");
    assert_eq!(frozen(briefs.clone()).await?, before);
    sqlx::query("UPDATE events SET summary_kind='copilot' WHERE id=$1").bind(required).execute(pool).await?;
    assert!(store_a.correct_saved_edition(date, cutoff, &[required]).await?);
    assert!(!store_a.correct_saved_edition(date, cutoff, &[required]).await?, "correction is once only");
    let corrected = store_a.brief(date, false).await?.unwrap();
    assert!(corrected.items.iter().any(|event| event.id == required));
    assert_eq!(corrected.window_end, cutoff);
    let other_ids = briefs[1..].to_vec();
    let others_after = frozen(other_ids.clone()).await?;
    let before_others: Vec<_> = before.as_array().unwrap().iter()
        .filter(|row| row["brief"]["id"] != briefs[0].to_string()).cloned().collect();
    assert_eq!(others_after, json!(before_others), "other dates and readers stay byte-identical");
    let audits: Vec<Value> = sqlx::query_scalar("SELECT before_value FROM admin_audits
        WHERE action='edition_correction' AND target_id=$1")
        .bind(briefs[0].to_string()).fetch_all(pool).await?;
    assert_eq!(audits.len(), 1);
    assert_eq!(audits[0]["items"][0]["snapshot"], snapshot);
    sqlx::query("DELETE FROM admin_audits WHERE action='edition_correction' AND target_id=$1")
        .bind(briefs[0].to_string()).execute(pool).await?;
    sqlx::query("DELETE FROM daily_briefs WHERE id=ANY($1)").bind(briefs).execute(pool).await?;
    for (source, event) in [(old_source, old), (new_source, required)] {
        sqlx::query("DELETE FROM events WHERE id=$1").bind(event).execute(pool).await?;
        sqlx::query("DELETE FROM content_items WHERE source_id=$1").bind(source).execute(pool).await?;
        sqlx::query("DELETE FROM sources WHERE id=$1").bind(source).execute(pool).await?;
    }
    Ok(())
}

/// A shared catalog source must follow its own interval instead of waiting for
/// the daily edition slot, and the per-adapter floor must never shorten an
/// interval a reader deliberately made longer.
pub(super) async fn verify_catalog_follows_its_own_interval(pool: &PgPool) -> anyhow::Result<()> {
    let publisher = Uuid::new_v4();
    sqlx::query("INSERT INTO publishers(id,name,entity_type,official_domains) VALUES($1,$2,'lab','[]')")
        .bind(publisher)
        .bind(format!("Cadence publisher {publisher}"))
        .execute(pool)
        .await?;
    let shared = Uuid::new_v4();
    let slow = Uuid::new_v4();
    for (id, schedule) in [(shared, 180), (slow, 1440)] {
        sqlx::query(
            "INSERT INTO sources(id,publisher_id,name,endpoint,content_type,adapter_type,tier,
               lifecycle_status,schedule_minutes,language,compliance)
             VALUES($1,$2,$3,$4,'blog','rss','T1','observing',$5,'en','{}')",
        )
        .bind(id)
        .bind(publisher)
        .bind(format!("Cadence source {id}"))
        .bind(format!("https://cadence.example/{id}/feed.xml"))
        .bind(schedule)
        .execute(pool)
        .await?;
    }
    // Both were collected four hours ago. Only the 180-minute source is due.
    for id in [shared, slow] {
        sqlx::query(
            "INSERT INTO fetch_runs(id,source_id,started_at,finished_at,status)
             VALUES($1,$2,now()-interval '4 hours',now()-interval '4 hours','success')",
        )
        .bind(Uuid::new_v4())
        .bind(id)
        .execute(pool)
        .await?;
    }
    let due: Vec<Uuid> = sqlx::query_scalar(crate::ingestion::DUE_SOURCES_SQL)
        .bind(false)
        .bind(None::<Uuid>)
        .bind(vec!["rss".to_owned()])
        .bind(None::<chrono::DateTime<Utc>>)
        .fetch_all(pool)
        .await?;
    assert!(
        due.contains(&shared),
        "a shared catalog source must become due on its own interval, not once a day"
    );
    assert!(
        !due.contains(&slow),
        "the adapter floor must not shorten a deliberately longer interval"
    );

    // The daily run still forces a sweep so nothing that stayed due is skipped.
    let forced: Vec<Uuid> = sqlx::query_scalar(crate::ingestion::DUE_SOURCES_SQL)
        .bind(true)
        .bind(None::<Uuid>)
        .bind(vec!["rss".to_owned()])
        .bind(None::<chrono::DateTime<Utc>>)
        .fetch_all(pool)
        .await?;
    assert!(forced.contains(&shared) && forced.contains(&slow));

    sqlx::query("DELETE FROM fetch_runs WHERE source_id=ANY($1)")
        .bind(&vec![shared, slow])
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM sources WHERE id=ANY($1)")
        .bind(&vec![shared, slow])
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM publishers WHERE id=$1")
        .bind(publisher)
        .execute(pool)
        .await?;
    Ok(())
}
