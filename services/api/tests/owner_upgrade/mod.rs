use anyhow::Result;
use sqlx::PgPool;

const TABLES: &[&str] = &[
    "sources",
    "source_topics",
    "taxonomy_nodes",
    "events",
    "content_items",
    "event_evidence",
    "event_tags",
    "score_snapshots",
    "interest_profiles",
    "user_event_states",
    "event_exposures",
    "daily_briefs",
    "daily_brief_items",
    "reader_shares",
    "admin_audits",
    "summary_jobs",
    "knowledge_nodes",
    "knowledge_edges",
    "morning_runs",
    "app_settings",
];

async fn fingerprints(
    pool: &PgPool,
    tables: &[&'static str],
) -> Result<Vec<(&'static str, i64, Option<String>)>> {
    let mut values = Vec::new();
    for &table in tables {
        // Compare original columns; realm ownership and published snapshots are added by 0025.
        let query = format!(
            "SELECT count(*),md5(string_agg(digest,'' ORDER BY digest)) FROM (
              SELECT md5((to_jsonb(r)-'owner_user_id'-'published_document')::text) AS digest
              FROM {table} r) rows"
        );
        let (count, digest): (i64, Option<String>) = sqlx::query_as(&query).fetch_one(pool).await?;
        values.push((table, count, digest));
    }
    Ok(values)
}

#[tokio::test]
#[ignore = "Requires a restored private backup in an isolated loopback upgrade-check database"]
async fn restored_owner_database_migrates_without_rewriting_history() -> Result<()> {
    let database_url = std::env::var("SCOUTNEWS_OWNER_UPGRADE_DATABASE_URL")?;
    let url = url::Url::parse(&database_url)?;
    anyhow::ensure!(
        url.host_str() == Some("127.0.0.1")
            && url.port() == Some(55490)
            && url.path().starts_with("/scoutnews_upgrade_check_"),
        "upgrade checks must target the separate loopback instance, never the daily database"
    );
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await?;
    let version: i64 =
        sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations WHERE success")
            .fetch_one(&pool)
            .await?;
    anyhow::ensure!(version == 24, "expected the pre-cloud migration-24 backup");
    let before = fingerprints(&pool, TABLES).await?;
    let settings: Vec<(String, String)> =
        sqlx::query_as("SELECT key,value FROM app_settings ORDER BY key")
            .fetch_all(&pool)
            .await?;
    let migrator = sqlx::migrate!("./migrations");
    migrator.run(&pool).await?;
    assert_eq!(
        before,
        fingerprints(&pool, TABLES).await?,
        "migration rewrote existing data"
    );
    let after_settings: Vec<(String, String)> =
        sqlx::query_as("SELECT key,value FROM app_settings ORDER BY key")
            .fetch_all(&pool)
            .await?;
    assert!(
        settings == after_settings,
        "local model, quota and reader settings must be preserved"
    );
    let after_version: i64 =
        sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations WHERE success")
            .fetch_one(&pool)
            .await?;
    assert_eq!(after_version, migrator.iter().last().unwrap().version);
    crate::source_directory::import(&pool).await?;
    let history_tables: Vec<_> = TABLES
        .iter()
        .copied()
        .filter(|table| !["sources", "source_topics", "taxonomy_nodes"].contains(table))
        .collect();
    let expected_history: Vec<_> = before
        .iter()
        .filter(|(table, _, _)| history_tables.contains(table))
        .cloned()
        .collect();
    assert_eq!(
        expected_history,
        fingerprints(&pool, &history_tables).await?,
        "startup directory refresh changed private history or settings"
    );
    let local = crate::scoped_db::ScopedDb::from(pool.clone()).reader("local");
    for table in [
        "daily_briefs",
        "daily_brief_items",
        "reader_shares",
        "user_event_states",
        "interest_profiles",
    ] {
        let visible: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&local)
            .await?;
        let original = before.iter().find(|(name, _, _)| *name == table).unwrap().1;
        assert_eq!(visible, original, "local reader lost access to {table}");
    }
    println!(
        "Restored owner database upgraded {version}->{after_version}; all {} original table fingerprints, private snapshots and local settings preserved.",
        TABLES.len()
    );
    pool.close().await;
    Ok(())
}
