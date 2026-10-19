use super::*;

/// The registered AI Infra catalog must survive migration on a fresh database,
/// classify the systems layer without absorbing hardware product news, and keep
/// machine tags behind the existing development-build toggle.
pub(super) async fn verify_ai_infra_catalog(pool: &PgPool) -> anyhow::Result<()> {
    let topic: (String, String, bool) =
        sqlx::query_as("SELECT label,group_name,enabled FROM taxonomy_nodes WHERE id='ai-infra'")
            .fetch_one(pool)
            .await?;
    assert_eq!(topic, ("AI Infra".into(), "Developer".into(), true));
    for label in ["AI Infra", "ai-infra", "AI 基础设施"] {
        let alias: String = sqlx::query_scalar("SELECT news_topic_alias($1)")
            .bind(label)
            .fetch_one(pool)
            .await?;
        assert_eq!(alias, "AI Infra", "{label}");
    }
    // Every profile can weight the topic, including ones created before it existed.
    let missing: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM interest_profiles ip WHERE NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(ip.profile->'topics') topic
           WHERE topic->>'id'='ai-infra')",
    )
    .fetch_one(pool)
    .await?;
    assert_eq!(missing, 0, "the topic must be weightable in every profile");
    let entry: (String, i64, bool) = sqlx::query_as(
        "SELECT topic->>'label',(topic->>'weight')::bigint,(topic->>'enabled')::boolean
         FROM interest_profiles ip CROSS JOIN LATERAL
           jsonb_array_elements(ip.profile->'topics') topic
         WHERE ip.user_id='local' AND topic->>'id'='ai-infra'",
    )
    .fetch_one(pool)
    .await?;
    assert_eq!(entry, ("AI Infra".into(), 50, true));

    let registered: Vec<(String, String, String, String, String)> = sqlx::query_as(
        "SELECT s.name,s.endpoint,s.adapter_type,s.tier,s.content_type FROM sources s
         JOIN source_topics st ON st.source_id=s.id AND st.taxonomy_id='ai-infra'
         WHERE s.owner_user_id IS NULL ORDER BY s.endpoint",
    )
    .fetch_all(pool)
    .await?;
    assert_eq!(registered.len(), 16, "every verified AI Infra feed registers");
    for (name, endpoint, adapter, tier, content_type) in &registered {
        assert!(endpoint.starts_with("https://"), "{name}");
        assert!(
            matches!(adapter.as_str(), "rss" | "atom" | "github_release_atom" | "arxiv_atom"),
            "{name} uses {adapter}"
        );
        assert!(matches!(tier.as_str(), "T1" | "T1.5" | "T2"), "{name}");
        assert_eq!(
            content_type == "release",
            adapter == "github_release_atom",
            "{name} release feeds keep the release content type"
        );
    }
    // Catalog metadata records the sampled evidence rather than a claim of quality.
    let unverified: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sources s JOIN source_topics st ON st.source_id=s.id
         WHERE st.taxonomy_id='ai-infra' AND (s.compliance->>'sampleTitle' IS NULL
           OR s.compliance->>'verifiedAt' IS NULL OR s.compliance->>'provenance'<>'direct_publisher')",
    )
    .fetch_one(pool)
    .await?;
    assert_eq!(unverified, 0);
    let aggregated: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sources WHERE adapter_type='aihot_public'
           OR lower(endpoint) ~ '^https://([a-z0-9-]+\\.)*(aihot\\.news|aihot\\.virxact\\.com)([/:?]|$)'",
    )
    .fetch_one(pool)
    .await?;
    assert_eq!(aggregated, 0, "no aggregate platform is reintroduced");

    for (title, summary, expected) in [
        (
            "vLLM v0.32.1rc0",
            "Continuous batching and paged attention improvements for the inference engine.",
            "AI Infra",
        ),
        (
            "分布式训练中的张量并行实践",
            "介绍流水线并行与算子优化带来的吞吐量变化。",
            "AI Infra",
        ),
        (
            "NVIDIA announces a new GeForce graphics card",
            "The GPU ships with more VRAM for consumer desktops.",
            "芯片与硬件",
        ),
    ] {
        let facets: Vec<String> =
            sqlx::query_scalar("SELECT unnest(news_facets($1,$2,'release','AI Infra'))")
                .bind(title)
                .bind(summary)
                .fetch_all(pool)
                .await?;
        assert_eq!(facets.first().map(String::as_str), Some(expected), "{title}");
    }
    // A source topic still supplies the label when no keyword matches at all.
    let fallback: Vec<String> =
        sqlx::query_scalar("SELECT unnest(news_facets('b11727','','release','AI Infra'))")
            .fetch_all(pool)
            .await?;
    assert_eq!(fallback, vec!["AI Infra".to_owned()]);

    for tag in [
        "viable/strict/1792399349",
        "b11727",
        "nightly-last-green: Release process-group caches before worker shutdown (#8846)",
        "nightly",
    ] {
        let opaque: bool =
            sqlx::query_scalar("SELECT reader_is_opaque_engineering_release('release',$1)")
                .bind(tag)
                .fetch_one(pool)
                .await?;
        assert!(opaque, "machine tag must stay behind the toggle: {tag}");
    }
    for tag in [
        "v0.32.1rc0",
        "Ray-2.59.0",
        "CUTLASS 4.8.0",
        "JAX v0.11.2",
        "gfx950-tutorial-v3.1",
    ] {
        let opaque: bool =
            sqlx::query_scalar("SELECT reader_is_opaque_engineering_release('release',$1)")
                .bind(tag)
                .fetch_one(pool)
                .await?;
        assert!(!opaque, "a named release must stay visible: {tag}");
    }
    let blog: bool =
        sqlx::query_scalar("SELECT reader_is_opaque_engineering_release('blog','b11727')")
            .fetch_one(pool)
            .await?;
    assert!(!blog, "the toggle only applies to release tags");
    Ok(())
}
