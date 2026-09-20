use std::collections::HashSet;

use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::ingestion::validate_adapter_endpoint;

const CATALOG: &str = include_str!("source-directory-2026-09-10.json");
const REFERENCE_PODCAST: &str = "https://feed.xyzfm.space/r8t44lmvu99m";
const REFERENCE_NOTE: &str = "原文说明此节目使用 AI 翻译、克隆英文播客，属于二次加工。保留关注入口，但不作为原始新闻采集；原节目另行直接订阅，避免重复报道和虚假多方互证。";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Directory {
    id: String,
    title: String,
    origin_url: String,
    entries: Vec<Entry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    id: String,
    platform: String,
    name: String,
    handle: Option<String>,
    profile_url: Option<String>,
    status: String,
    note: String,
    origin_block: String,
    document_urls: Vec<String>,
    subscription: Option<Subscription>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Subscription {
    name: String,
    endpoint: String,
    adapter: String,
    content_type: String,
    publisher: String,
    publisher_type: String,
    official_domains: Vec<String>,
    publisher_scope: String,
    tier: String,
    topic_ids: Vec<String>,
    verification_urls: Vec<String>,
    feed_title: String,
}

fn https(value: &str) -> Result<()> {
    let url = url::Url::parse(value)?;
    ensure!(
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none(),
        "directory links must be HTTPS without credentials"
    );
    Ok(())
}

fn parse(raw: &str) -> Result<Directory> {
    let directory: Directory =
        serde_json::from_str(raw).context("invalid source directory manifest")?;
    ensure!(
        !directory.id.is_empty() && !directory.entries.is_empty(),
        "empty source directory"
    );
    https(&directory.origin_url)?;
    let mut ids = HashSet::new();
    for entry in &directory.entries {
        ensure!(
            ids.insert(&entry.id),
            "duplicate directory identity: {}",
            entry.id
        );
        ensure!(
            !entry.name.trim().is_empty()
                && !entry.note.trim().is_empty()
                && !entry.origin_block.is_empty(),
            "directory entry lacks name, provenance or explanation"
        );
        ensure!(
            matches!(
                entry.platform.as_str(),
                "x" | "wechat"
                    | "podcast"
                    | "blog"
                    | "youtube"
                    | "weibo"
                    | "reddit"
                    | "bilibili"
                    | "collection"
                    | "github"
                    | "community"
            ),
            "unsupported following platform"
        );
        ensure!(
            matches!(
                entry.status.as_str(),
                "feed_linked"
                    | "needs_authorization"
                    | "needs_connector"
                    | "needs_endpoint"
                    | "rate_limited"
                    | "needs_confirmation"
                    | "needs_selection"
                    | "reference_only"
            ),
            "unsupported following status"
        );
        if let Some(profile) = &entry.profile_url {
            https(profile)?;
        }
        for link in &entry.document_urls {
            https(link)?;
        }
        ensure!(
            (entry.status == "feed_linked") == entry.subscription.is_some(),
            "feed link status lacks subscription"
        );
        if let Some(source) = &entry.subscription {
            https(&source.endpoint)?;
            validate_adapter_endpoint(&source.adapter, &source.endpoint)?;
            ensure!(
                matches!(source.adapter.as_str(), "rss" | "atom" | "podcast_rss"),
                "unreviewed directory adapter"
            );
            ensure!(
                matches!(source.content_type.as_str(), "blog" | "podcast"),
                "unreviewed directory content type"
            );
            ensure!(
                (source.adapter == "podcast_rss") == (source.content_type == "podcast"),
                "podcast format mismatch"
            );
            ensure!(
                matches!(source.tier.as_str(), "T1.5" | "T2"),
                "directory recommendations cannot grant T1"
            );
            ensure!(
                matches!(
                    source.publisher_type.as_str(),
                    "author" | "podcast" | "publication" | "community"
                ),
                "unreviewed publisher type"
            );
            ensure!(
                !source.name.trim().is_empty()
                    && !source.publisher.trim().is_empty()
                    && !source.feed_title.trim().is_empty()
                    && !source.verification_urls.is_empty(),
                "unverified directory subscription"
            );
            https(&source.publisher_scope)?;
            for link in &source.verification_urls {
                https(link)?;
            }
            ensure!(
                source.topic_ids.iter().collect::<HashSet<_>>().len() == source.topic_ids.len(),
                "duplicate source topic"
            );
            ensure!(
                source
                    .official_domains
                    .iter()
                    .all(|host| !host.is_empty() && !host.contains(['/', ':', '@', ' '])),
                "invalid official domain"
            );
        }
    }
    Ok(directory)
}

pub async fn import(pool: &PgPool) -> Result<()> {
    import_directory(pool).await?;
    apply_original_source_policy(pool).await
}

async fn import_directory(pool: &PgPool) -> Result<()> {
    let directory = parse(CATALOG)?;
    let canonical = serde_json::to_vec(&serde_json::from_str::<serde_json::Value>(CATALOG)?)?;
    let hash = format!("{:x}", Sha256::digest(canonical));
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('source-directory-import'))")
        .execute(&mut *tx)
        .await?;
    let previous: Option<String> =
        sqlx::query_scalar("SELECT manifest_hash FROM source_directory_imports WHERE id=$1")
            .bind(&directory.id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(previous) = previous {
        ensure!(
            previous == hash,
            "applied source directory was modified; add a new version instead"
        );
        tx.commit().await?;
        return Ok(());
    }
    let mut added = 0;
    for entry in &directory.entries {
        let mut linked_source = None;
        if let Some(source) = &entry.subscription {
            // One polling subscription per original endpoint. Preserve existing names, pauses, health and cursors.
            linked_source = sqlx::query_scalar::<_, Uuid>(
                "SELECT id FROM sources WHERE endpoint=$1 ORDER BY (adapter_type=$2) DESC,created_at,id LIMIT 1")
                .bind(&source.endpoint).bind(&source.adapter).fetch_optional(&mut *tx).await?;
            if linked_source.is_none() {
                let mut publisher: Option<Uuid> = sqlx::query_scalar(
                    "SELECT id FROM publishers WHERE lower(name)=lower($1) ORDER BY created_at,id LIMIT 1")
                    .bind(&source.publisher).fetch_optional(&mut *tx).await?;
                if publisher.is_none() {
                    let id = Uuid::new_v4();
                    sqlx::query("INSERT INTO publishers(id,name,entity_type,official_domains) VALUES($1,$2,$3,$4)")
                        .bind(id).bind(&source.publisher).bind(&source.publisher_type).bind(json!(source.official_domains))
                        .execute(&mut *tx).await?;
                    publisher = Some(id);
                }
                let topics: i64 =
                    sqlx::query_scalar("SELECT count(*) FROM taxonomy_nodes WHERE id=ANY($1)")
                        .bind(&source.topic_ids)
                        .fetch_one(&mut *tx)
                        .await?;
                ensure!(
                    topics as usize == source.topic_ids.len(),
                    "directory contains an unknown taxonomy"
                );
                let id = Uuid::new_v4();
                sqlx::query("INSERT INTO sources(id,publisher_id,name,endpoint,content_type,adapter_type,tier,
                    lifecycle_status,schedule_minutes,compliance) VALUES($1,$2,$3,$4,$5,$6,$7,'observing',360,$8)")
                    .bind(id).bind(publisher).bind(&source.name).bind(&source.endpoint).bind(&source.content_type)
                    .bind(&source.adapter).bind(&source.tier).bind(json!({
                        "catalogVersion":directory.id,"verificationUrls":source.verification_urls,
                        "sampleFeedTitle":source.feed_title,"publisherScope":source.publisher_scope,
                        "directoryUrl":directory.origin_url,"observationRequired":true,"authentication":"none",
                        "bodyPolicy":"original public feed metadata only; no audio, private pages or third-party transcripts",
                        "paginationPolicy":"bounded feed page; no complete history claim"
                    })).execute(&mut *tx).await?;
                for (index, topic) in source.topic_ids.iter().enumerate() {
                    sqlx::query("INSERT INTO source_topics(source_id,taxonomy_id,relevance,origin) VALUES($1,$2,$3,'source_directory')")
                        .bind(id).bind(topic).bind(if index==0 {1.0_f32} else {0.8_f32}).execute(&mut *tx).await?;
                }
                linked_source = Some(id);
                added += 1;
            }
        }
        sqlx::query("INSERT INTO source_watchlist(id,platform,name,handle,profile_url,status,note,source_id,
            origin_url,origin_label,origin_block,document_urls) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            ON CONFLICT(id) DO UPDATE SET source_id=COALESCE(source_watchlist.source_id,EXCLUDED.source_id),
                origin_url=COALESCE(source_watchlist.origin_url,EXCLUDED.origin_url),
                origin_label=COALESCE(source_watchlist.origin_label,EXCLUDED.origin_label),
                origin_block=COALESCE(source_watchlist.origin_block,EXCLUDED.origin_block),
                document_urls=CASE WHEN source_watchlist.document_urls='[]'::jsonb THEN EXCLUDED.document_urls
                    ELSE source_watchlist.document_urls END")
            .bind(&entry.id).bind(&entry.platform).bind(&entry.name).bind(&entry.handle).bind(&entry.profile_url)
            .bind(&entry.status).bind(&entry.note).bind(linked_source).bind(&directory.origin_url).bind(&directory.title)
            .bind(&entry.origin_block).bind(json!(entry.document_urls)).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO source_directory_imports(id,manifest_hash,origin_url,entry_count,new_source_count) VALUES($1,$2,$3,$4,$5)")
        .bind(&directory.id).bind(hash).bind(&directory.origin_url).bind(directory.entries.len() as i32).bind(added)
        .execute(&mut *tx).await?;
    sqlx::query("INSERT INTO admin_audits(id,actor,action,target_type,target_id,after_value,reason)
        VALUES($1,'local','source_directory_import','source_directory',$2,$3,'用户要求补充原文全部信源')")
        .bind(Uuid::new_v4()).bind(&directory.id).bind(json!({"entries":directory.entries.len(),"newSources":added}))
        .execute(&mut *tx).await?;
    tx.commit().await?;
    tracing::info!(directory=%directory.id,entries=directory.entries.len(),new_sources=added,"source directory imported");
    Ok(())
}

async fn apply_original_source_policy(pool: &PgPool) -> Result<()> {
    let directory = parse(CATALOG)?;
    let id = format!("{}-original-source-policy-v1", directory.id);
    let policy = json!({"endpoint":REFERENCE_PODCAST,"status":"reference_only","note":REFERENCE_NOTE,"documentBlock":"109"});
    let hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&policy)?));
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('source-directory-import'))")
        .execute(&mut *tx)
        .await?;
    let previous: Option<String> =
        sqlx::query_scalar("SELECT manifest_hash FROM source_directory_imports WHERE id=$1")
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(previous) = previous {
        ensure!(
            previous == hash,
            "applied source policy was modified; add a new version instead"
        );
        tx.commit().await?;
        return Ok(());
    }
    // The directory explicitly describes AI-translated/cloned material, not an independent original show.
    sqlx::query(
        "UPDATE sources SET lifecycle_status='paused',updated_at=now(),
        compliance=compliance||$1 WHERE endpoint=$2 AND compliance->>'catalogVersion'=$3",
    )
    .bind(json!({"collectionPolicy":"reference_only","policyReason":REFERENCE_NOTE}))
    .bind(REFERENCE_PODCAST)
    .bind(&directory.id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE source_watchlist SET source_id=NULL,status='reference_only',note=$1,origin_block='107,109'
        WHERE origin_url=$2 AND source_id IN(SELECT id FROM sources WHERE endpoint=$3)")
        .bind(REFERENCE_NOTE).bind(&directory.origin_url).bind(REFERENCE_PODCAST).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO source_directory_imports(id,manifest_hash,origin_url,entry_count,new_source_count)
        VALUES($1,$2,$3,1,0)").bind(&id).bind(hash).bind(&directory.origin_url).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO admin_audits(id,actor,action,target_type,target_id,after_value,reason)
        VALUES($1,'local','source_directory_policy','source_directory',$2,$3,$4)",
    )
    .bind(Uuid::new_v4())
    .bind(&id)
    .bind(policy)
    .bind(REFERENCE_NOTE)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_directory_is_complete_and_does_not_fake_social_subscriptions() {
        let directory = parse(CATALOG).unwrap();
        assert_eq!(directory.entries.len(), 88);
        for (platform, count) in [
            ("podcast", 25),
            ("blog", 10),
            ("x", 21),
            ("weibo", 12),
            ("reddit", 5),
            ("bilibili", 10),
            ("collection", 2),
            ("github", 1),
            ("community", 2),
        ] {
            assert_eq!(
                directory
                    .entries
                    .iter()
                    .filter(|entry| entry.platform == platform)
                    .count(),
                count
            );
        }
        for entry in &directory.entries {
            if matches!(
                entry.platform.as_str(),
                "x" | "weibo" | "bilibili" | "collection" | "github" | "community"
            ) {
                assert!(entry.subscription.is_none());
            }
        }
        assert_eq!(
            directory
                .entries
                .iter()
                .find(|e| e.id == "x-karpathy")
                .unwrap()
                .status,
            "needs_authorization"
        );
    }

    #[test]
    fn source_directory_rejects_duplicate_identities_and_fake_feed_status() {
        let mut value: serde_json::Value = serde_json::from_str(CATALOG).unwrap();
        let duplicate = value["entries"][0].clone();
        value["entries"].as_array_mut().unwrap().push(duplicate);
        assert!(parse(&value.to_string()).is_err());
        let entries = value["entries"].as_array_mut().unwrap();
        entries.pop();
        entries[0]["subscription"] = serde_json::Value::Null;
        entries[0]["status"] = json!("feed_linked");
        assert!(parse(&value.to_string()).is_err());
    }

    #[tokio::test]
    #[ignore = "requires a disposable local scoutnews_e2e_<32 hex> database"]
    async fn source_directory_database_contract() {
        let connection = std::env::var("SCOUTNEWS_DIRECTORY_TEST_DATABASE_URL").unwrap();
        let url = url::Url::parse(&connection).unwrap();
        assert!(matches!(url.host_str(), Some("localhost" | "127.0.0.1")));
        let suffix = url.path().strip_prefix("/scoutnews_e2e_").unwrap();
        assert!(suffix.len() == 32 && suffix.bytes().all(|b| b.is_ascii_hexdigit()));
        let pool = PgPool::connect(&connection).await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query("UPDATE sources SET name='Owner renamed feed',lifecycle_status='paused',
            schedule_minutes=1440,cursor='{\"owner\":\"preserve\"}' WHERE id='20000000-0000-0000-0000-000000000120'")
            .execute(&pool).await.unwrap();
        sqlx::query(
            "UPDATE source_watchlist SET note='Owner following note' WHERE id='x-karpathy'",
        )
        .execute(&pool)
        .await
        .unwrap();
        let old_ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM sources")
            .fetch_all(&pool)
            .await
            .unwrap();
        let before: String = sqlx::query_scalar(
            "SELECT md5(jsonb_agg(to_jsonb(s) ORDER BY id)::text) FROM sources s WHERE id=ANY($1)",
        )
        .bind(&old_ids)
        .fetch_one(&pool)
        .await
        .unwrap();
        import(&pool).await.unwrap();
        let directory = parse(CATALOG).unwrap();
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM source_watchlist WHERE origin_url=$1")
                .bind(&directory.origin_url)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, directory.entries.len() as i64);
        for entry in directory
            .entries
            .iter()
            .filter(|entry| entry.subscription.is_some())
        {
            let endpoint = &entry.subscription.as_ref().unwrap().endpoint;
            let links: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM source_watchlist w JOIN sources s ON s.id=w.source_id
                WHERE w.id=$1 AND s.endpoint=$2",
            )
            .bind(&entry.id)
            .bind(endpoint)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(links, if endpoint == REFERENCE_PODCAST { 0 } else { 1 });
            if endpoint == REFERENCE_PODCAST {
                let state: String =
                    sqlx::query_scalar("SELECT lifecycle_status FROM sources WHERE endpoint=$1")
                        .bind(endpoint)
                        .fetch_one(&pool)
                        .await
                        .unwrap();
                assert_eq!(state, "paused");
            }
            let subscriptions: i64 =
                sqlx::query_scalar("SELECT count(*) FROM sources WHERE endpoint=$1")
                    .bind(endpoint)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(subscriptions, 1);
        }
        let total: i64 = sqlx::query_scalar("SELECT count(*) FROM sources")
            .fetch_one(&pool)
            .await
            .unwrap();
        import(&pool).await.unwrap();
        let repeated: i64 = sqlx::query_scalar("SELECT count(*) FROM sources")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(total, repeated);
        let after: String = sqlx::query_scalar(
            "SELECT md5(jsonb_agg(to_jsonb(s) ORDER BY id)::text) FROM sources s WHERE id=ANY($1)",
        )
        .bind(&old_ids)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(before, after);
        let note: String =
            sqlx::query_scalar("SELECT note FROM source_watchlist WHERE id='x-karpathy'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(note, "Owner following note");
        let imports: i64 = sqlx::query_scalar("SELECT count(*) FROM source_directory_imports")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(imports, 2);
        pool.close().await;
    }
}
