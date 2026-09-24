use super::*;
use crate::ingestion::{AdapterSource, FeedWorker, FetchOutcome, FetchedItem, SourceAdapter};
use anyhow::Result;
use async_trait::async_trait;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::sync::Semaphore;

struct FixtureFeed {
    item: FetchedItem,
    paused: bool,
    entered: Semaphore,
    release: Semaphore,
    calls: AtomicUsize,
}

impl FixtureFeed {
    fn new(url: String, paused: bool) -> Arc<Self> {
        Arc::new(Self {
            item: FetchedItem {
                external_id: "public-regression-item".into(),
                title: "Public architecture benchmark evaluation with measured throughput".into(),
                url,
                published_at: Some(chrono::Utc::now()),
                summary: Some("Public architecture benchmark measured throughput and latency with reproducible evaluation. ".repeat(20)),
                content_hash: Uuid::new_v4().to_string(),
                enclosures: vec![],
                source_metadata: json!({}),
                reading_context: None,
                reading_context_resources: json!({}),
            },
            paused,
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
            calls: AtomicUsize::new(0),
        })
    }

    async fn wait_for_fetch(&self) -> Result<()> {
        tokio::time::timeout(Duration::from_secs(10), self.entered.acquire())
            .await??
            .forget();
        Ok(())
    }
}

#[async_trait]
impl SourceAdapter for FixtureFeed {
    async fn fetch(&self, _: &AdapterSource) -> Result<FetchOutcome> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.add_permits(1);
        if self.paused {
            tokio::time::timeout(Duration::from_secs(10), self.release.acquire())
                .await??
                .forget();
        }
        Ok(FetchOutcome::Items {
            items: vec![self.item.clone()],
            etag: None,
            last_modified: None,
        })
    }
}

fn worker(pool: &PgPool, feed: Arc<FixtureFeed>) -> FeedWorker {
    FeedWorker::new(pool.clone(), reqwest::Client::new()).with_test_adapter(feed)
}

pub(super) struct LegacyMixedEvent {
    shared_source: Uuid,
    private_source: Uuid,
    public_content: Uuid,
    private_content: Uuid,
    event: Uuid,
    brief: Uuid,
    snapshot: Value,
    public_url: String,
}

pub(super) async fn seed_legacy_mixed_event(pool: &PgPool) -> Result<LegacyMixedEvent> {
    let legacy = LegacyMixedEvent {
        shared_source: Uuid::new_v4(),
        private_source: Uuid::new_v4(),
        public_content: Uuid::new_v4(),
        private_content: Uuid::new_v4(),
        event: Uuid::new_v4(),
        brief: Uuid::new_v4(),
        snapshot: json!({"title":"LEGACY_PRIVATE_SENTINEL","summary":"frozen mixed-source edition"}),
        public_url: format!("https://example.com/research/legacy-{}", Uuid::new_v4()),
    };
    for (source, name) in [
        (legacy.shared_source, "legacy shared"),
        (legacy.private_source, "legacy private"),
    ] {
        sqlx::query(
            "INSERT INTO sources(id,name,endpoint,content_type,adapter_type,tier,lifecycle_status)
            VALUES($1,$2,$3,'blog','rss','T1','paused')",
        )
        .bind(source)
        .bind(name)
        .bind(format!("https://example.com/{source}/feed"))
        .execute(pool)
        .await?;
    }
    sqlx::query(
        "INSERT INTO admin_audits(id,actor,action,target_type,target_id,reason)
        VALUES($1,'local','source_create','source',$2,'isolated legacy fixture')",
    )
    .bind(Uuid::new_v4())
    .bind(legacy.private_source.to_string())
    .execute(pool)
    .await?;
    for (content, source, url, summary) in [
        (
            legacy.public_content,
            legacy.shared_source,
            legacy.public_url.clone(),
            "original public excerpt",
        ),
        (
            legacy.private_content,
            legacy.private_source,
            format!("https://example.com/private/{}", legacy.event),
            "LEGACY_PRIVATE_SENTINEL",
        ),
    ] {
        sqlx::query("INSERT INTO content_items(id,source_id,content_type,external_id,original_url,canonical_url,title,content_hash,metadata)
            VALUES($1,$2,'blog','public-regression-item',$3,$3,'Legacy mixed architecture report',$4,$5)")
            .bind(content).bind(source).bind(url).bind(content.to_string())
            .bind(json!({"feedSummary":summary})).execute(pool).await?;
    }
    sqlx::query("INSERT INTO events(id,canonical_title,summary,importance,event_type,first_seen_at,updated_at,content_version)
        VALUES($1,'Legacy mixed architecture report','LEGACY_PRIVATE_SENTINEL','historical','blog','2020-01-02','2020-01-02',17)")
        .bind(legacy.event).execute(pool).await?;
    for content in [legacy.public_content, legacy.private_content] {
        sqlx::query(
            "INSERT INTO event_evidence(event_id,content_item_id,is_official) VALUES($1,$2,true)",
        )
        .bind(legacy.event)
        .bind(content)
        .execute(pool)
        .await?;
    }
    sqlx::query(
        "INSERT INTO daily_briefs(id,local_date,status,generated_at,rule_version)
        VALUES($1,'2020-01-02','published','2020-01-02','legacy-fixture')",
    )
    .bind(legacy.brief)
    .execute(pool)
    .await?;
    sqlx::query(
        "INSERT INTO daily_brief_items(brief_id,event_id,rank,section,selection_reason,snapshot)
        VALUES($1,$2,1,'essential','historical',$3)",
    )
    .bind(legacy.brief)
    .bind(legacy.event)
    .bind(&legacy.snapshot)
    .execute(pool)
    .await?;
    sqlx::query(
        "INSERT INTO user_event_states(user_id,event_id,saved_at) VALUES('local',$1,now())",
    )
    .bind(legacy.event)
    .execute(pool)
    .await?;
    Ok(legacy)
}

impl LegacyMixedEvent {
    pub(super) async fn verify_quarantine_before_repair(&self, pool: &PgPool) -> Result<()> {
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT owner_user_id FROM events WHERE id=$1")
                .bind(self.event)
                .fetch_one(pool)
                .await?,
            "local"
        );
        assert!(
            sqlx::query_scalar::<_, Option<String>>(
                "SELECT owner_user_id FROM content_items WHERE id=$1"
            )
            .bind(self.public_content)
            .fetch_one(pool)
            .await?
            .is_none()
        );
        let error = sqlx::query("INSERT INTO event_evidence(event_id,content_item_id,is_official)
            VALUES($1,$2,true) ON CONFLICT(event_id,content_item_id) DO UPDATE SET is_official=true")
            .bind(self.event).bind(self.public_content).execute(pool).await.unwrap_err();
        assert_eq!(
            error.as_database_error().and_then(|e| e.code()).as_deref(),
            Some("42501")
        );
        Ok(())
    }

    pub(super) async fn verify_public_reingestion(
        &self,
        pool: &PgPool,
        a: &Reader,
        b: &Reader,
    ) -> Result<()> {
        // The forward migration explicitly preserves the valid public -> private
        // direction, including BEFORE INSERT on an existing evidence upsert.
        sqlx::query("INSERT INTO event_evidence(event_id,content_item_id,is_official)
            VALUES($1,$2,true) ON CONFLICT(event_id,content_item_id) DO UPDATE SET is_official=true")
            .bind(self.event).bind(self.public_content).execute(pool).await?;
        sqlx::query("UPDATE sources SET lifecycle_status='stable' WHERE id=$1")
            .bind(self.shared_source)
            .execute(pool)
            .await?;
        let feed = FixtureFeed::new(self.public_url.clone(), false);
        let collector = worker(pool, feed);
        let first = collector
            .run_authorized_source(self.shared_source, &a.id.to_string())
            .await?;
        assert_eq!(first.updated, 1);
        let public: Uuid = sqlx::query_scalar(
            "SELECT e.id FROM events e JOIN event_evidence ee ON ee.event_id=e.id
            WHERE ee.content_item_id=$1 AND e.owner_user_id IS NULL",
        )
        .bind(self.public_content)
        .fetch_one(pool)
        .await?;
        assert_ne!(public, self.event);
        assert_eq!(
            collector
                .run_authorized_source(self.shared_source, &a.id.to_string())
                .await?
                .ingested,
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM event_evidence WHERE content_item_id=$1"
            )
            .bind(self.public_content)
            .fetch_one(pool)
            .await?,
            2,
            "history remains linked; repeated refresh must not duplicate events"
        );
        let historical =
            sqlx::query("SELECT summary,content_version,owner_user_id FROM events WHERE id=$1")
                .bind(self.event)
                .fetch_one(pool)
                .await?;
        assert_eq!(
            historical.try_get::<String, _>("summary")?,
            "LEGACY_PRIVATE_SENTINEL"
        );
        assert_eq!(historical.try_get::<i64, _>("content_version")?, 17);
        assert_eq!(historical.try_get::<String, _>("owner_user_id")?, "local");
        let snapshot: Value = sqlx::query_scalar(
            "SELECT snapshot FROM daily_brief_items WHERE brief_id=$1 AND event_id=$2",
        )
        .bind(self.brief)
        .bind(self.event)
        .fetch_one(pool)
        .await?;
        assert_eq!(snapshot, self.snapshot);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT owner_user_id FROM daily_briefs WHERE id=$1")
                .bind(self.brief)
                .fetch_one(pool)
                .await?,
            "local"
        );
        assert!(sqlx::query_scalar::<_, bool>("SELECT saved_at IS NOT NULL FROM user_event_states WHERE user_id='local' AND event_id=$1")
            .bind(self.event).fetch_one(pool).await?);
        let local = crate::postgres_store::PostgresStore::new(pool.clone());
        assert!(local.get_event(self.event).await?.is_some());
        for reader in [a, b] {
            assert_eq!(
                reader
                    .call(
                        "GET",
                        &format!("/api/v1/events/{}", self.event),
                        Value::Null
                    )
                    .await
                    .0,
                StatusCode::NOT_FOUND
            );
            let current = reader
                .ok("GET", &format!("/api/v1/events/{public}"), Value::Null)
                .await;
            assert!(!current.to_string().contains("LEGACY_PRIVATE_SENTINEL"));
            assert!(
                !current
                    .to_string()
                    .contains(&self.private_content.to_string())
            );
            assert!(
                !current
                    .to_string()
                    .contains(&self.private_source.to_string())
            );
            for path in [
                "/api/v1/events?coverage=true",
                "/api/v1/explore",
                "/api/v1/weekly",
                "/api/v1/sources/coverage",
            ] {
                let body = reader.ok("GET", path, Value::Null).await;
                assert!(
                    !body.to_string().contains("LEGACY_PRIVATE_SENTINEL"),
                    "legacy leak at {path}"
                );
                assert!(
                    !body.to_string().contains(&self.event.to_string()),
                    "legacy event leak at {path}"
                );
            }
        }
        let (_, private_a) = fixture(pool, Some(a.id.to_string()), "DIRECTION_ALPHA").await?;
        let (_, private_b) = fixture(pool, Some(b.id.to_string()), "DIRECTION_BETA").await?;
        let a_content: Uuid =
            sqlx::query_scalar("SELECT content_item_id FROM event_evidence WHERE event_id=$1")
                .bind(private_a)
                .fetch_one(pool)
                .await?;
        let b_content: Uuid =
            sqlx::query_scalar("SELECT content_item_id FROM event_evidence WHERE event_id=$1")
                .bind(private_b)
                .fetch_one(pool)
                .await?;
        let system = ScopedDb::from(pool.clone());
        let a_db = system.reader(&a.id.to_string());
        let b_db = system.reader(&b.id.to_string());
        sqlx::query("INSERT INTO event_evidence(event_id,content_item_id) VALUES($1,$2)")
            .bind(private_a)
            .bind(self.public_content)
            .execute(&a_db)
            .await?;
        for (db, event, content) in [
            (&system, public, self.private_content),
            (&system, private_a, self.private_content),
            (&system, private_a, b_content),
            (&system, private_b, a_content),
            (&a_db, public, a_content),
            (&a_db, public, b_content),
            (&a_db, private_a, b_content),
            (&b_db, public, a_content),
        ] {
            let error =
                sqlx::query("INSERT INTO event_evidence(event_id,content_item_id) VALUES($1,$2)")
                    .bind(event)
                    .bind(content)
                    .execute(db)
                    .await
                    .unwrap_err();
            assert_eq!(
                error.as_database_error().and_then(|e| e.code()).as_deref(),
                Some("42501")
            );
        }
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM event_evidence ee
            JOIN events e ON e.id=ee.event_id JOIN content_items c ON c.id=ee.content_item_id
            WHERE c.owner_user_id IS NOT NULL AND c.owner_user_id IS DISTINCT FROM e.owner_user_id"
            )
            .fetch_one(pool)
            .await?,
            0
        );
        eprintln!(
            "Verified pre-0025 mixed-history upgrade, public reingestion, frozen IDs/snapshots and directional evidence guards."
        );
        Ok(())
    }
}

pub(super) async fn verify_effective_source_authorization(
    pool: &PgPool,
    a: &Reader,
    b: &Reader,
) -> Result<()> {
    let (source, _) = fixture(pool, None, "OVERRIDE_REGRESSION").await?;
    sqlx::query("UPDATE sources SET lifecycle_status='paused' WHERE id=$1")
        .bind(source)
        .execute(pool)
        .await?;
    let path = format!("/api/v1/sources/{source}");
    a.ok("PUT", &path, json!({"enabled":true})).await;
    let a_db = ScopedDb::from(pool.clone()).reader(&a.id.to_string());
    let b_db = ScopedDb::from(pool.clone()).reader(&b.id.to_string());
    assert!(
        sqlx::query_scalar::<_, bool>("SELECT scoutnews_source_enabled($1)")
            .bind(source)
            .fetch_one(&a_db)
            .await?
    );
    assert!(
        !sqlx::query_scalar::<_, bool>("SELECT scoutnews_source_enabled($1)")
            .bind(source)
            .fetch_one(&b_db)
            .await?
    );
    let feed = FixtureFeed::new(
        format!("https://example.com/research/override-{}", Uuid::new_v4()),
        false,
    );
    let collector = worker(pool, feed.clone());
    assert_eq!(
        collector
            .run_authorized_source(source, &a.id.to_string())
            .await?
            .ingested,
        1
    );
    assert!(
        collector
            .run_authorized_source(source, &b.id.to_string())
            .await
            .is_err()
    );
    assert!(
        collector.run_source(source).await.is_err(),
        "the system schedule must still respect the global pause"
    );
    assert_eq!(feed.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT lifecycle_status FROM sources WHERE id=$1")
            .bind(source)
            .fetch_one(pool)
            .await?,
        "paused"
    );
    let public: Uuid = sqlx::query_scalar(
        "SELECT ee.event_id FROM event_evidence ee JOIN content_items c ON c.id=ee.content_item_id
        WHERE c.source_id=$1 AND c.canonical_url=$2",
    )
    .bind(source)
    .bind(&feed.item.url)
    .fetch_one(pool)
    .await?;
    a.ok("GET", &format!("/api/v1/events/{public}"), Value::Null)
        .await;
    assert_eq!(
        b.call("GET", &format!("/api/v1/events/{public}"), Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );

    for remove in [false, true] {
        a.ok("PUT", &path, json!({"enabled":true})).await;
        let blocked = FixtureFeed::new(
            format!("https://example.com/research/cancelled-{}", Uuid::new_v4()),
            true,
        );
        let running_worker = worker(pool, blocked.clone());
        let actor = a.id.to_string();
        let running =
            tokio::spawn(async move { running_worker.run_authorized_source(source, &actor).await });
        blocked.wait_for_fetch().await?;
        if remove {
            sqlx::query("DELETE FROM user_source_overrides WHERE user_id=$1 AND source_id=$2")
                .bind(a.id.to_string())
                .bind(source)
                .execute(pool)
                .await?;
        } else {
            a.ok("PUT", &path, json!({"enabled":false})).await;
        }
        blocked.release.add_permits(1);
        assert!(
            tokio::time::timeout(Duration::from_secs(10), running)
                .await??
                .is_err()
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM content_items WHERE canonical_url=$1"
            )
            .bind(&blocked.item.url)
            .fetch_one(pool)
            .await?,
            0,
            "revocation must roll back the entire fetched batch"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i32>("SELECT consecutive_failures FROM sources WHERE id=$1")
                .bind(source)
                .fetch_one(pool)
                .await?,
            0,
            "a reader revocation must not degrade the shared catalog's health"
        );
    }

    // A first explicit disable inserted during a fetch must override the stable
    // catalog default too; there is no pre-existing override row to lock.
    sqlx::query("UPDATE sources SET lifecycle_status='stable' WHERE id=$1")
        .bind(source)
        .execute(pool)
        .await?;
    let blocked = FixtureFeed::new(
        format!(
            "https://example.com/research/first-disable-{}",
            Uuid::new_v4()
        ),
        true,
    );
    let running_worker = worker(pool, blocked.clone());
    let actor = b.id.to_string();
    let running =
        tokio::spawn(async move { running_worker.run_authorized_source(source, &actor).await });
    blocked.wait_for_fetch().await?;
    b.ok("PUT", &path, json!({"enabled":false})).await;
    blocked.release.add_permits(1);
    assert!(
        tokio::time::timeout(Duration::from_secs(10), running)
            .await??
            .is_err()
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM content_items WHERE canonical_url=$1")
            .bind(&blocked.item.url)
            .fetch_one(pool)
            .await?,
        0
    );

    // Drive the real following-schedule path without any outbound requests.
    sqlx::query("UPDATE sources SET lifecycle_status='paused'")
        .execute(pool)
        .await?;
    sqlx::query("UPDATE user_source_overrides SET enabled=false WHERE source_id<>$1")
        .bind(source)
        .execute(pool)
        .await?;
    a.ok("PUT", &path, json!({"enabled":true,"scheduleMinutes":15}))
        .await;
    sqlx::query("UPDATE fetch_runs SET started_at=now()-interval '2 days' WHERE source_id=$1")
        .bind(source)
        .execute(pool)
        .await?;
    let scheduled = FixtureFeed::new(
        format!("https://example.com/research/scheduled-{}", Uuid::new_v4()),
        false,
    );
    worker(pool, scheduled.clone()).run_cloud_due().await?;
    assert_eq!(scheduled.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM content_items WHERE canonical_url=$1")
            .bind(&scheduled.item.url)
            .fetch_one(pool)
            .await?,
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT lifecycle_status FROM sources WHERE id=$1")
            .bind(source)
            .fetch_one(pool)
            .await?,
        "paused"
    );
    assert!(
        !sqlx::query_scalar::<_, bool>("SELECT scoutnews_source_enabled($1)")
            .bind(source)
            .fetch_one(&b_db)
            .await?
    );
    eprintln!(
        "Verified enabled-over-paused collection, independent readers, mid-fetch disable/removal and scheduled overrides."
    );
    Ok(())
}
