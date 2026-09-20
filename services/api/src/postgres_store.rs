use anyhow::{Context, Result};
use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use serde_json::Value;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    models::{
        BriefHistory, DailyBrief, Event, EventQuery, EventStateInput, Evidence, GeneratedSummary,
        Source, SourceInput, SourceUpdate, Topic,
    },
    processing::{plain_text, score_event, score_order_sql},
    reader,
    store::Store,
    visitor_interests::VisitorInterests,
};

#[derive(Clone)]
pub struct PostgresStore {
    pool: PgPool,
}

impl PostgresStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    async fn coverage_records(
        &self,
        ids: Option<&[Uuid]>,
        start: Option<DateTime<Utc>>,
        end: Option<DateTime<Utc>>,
        cutoff: DateTime<Utc>,
        visitor: bool,
    ) -> Result<Vec<crate::coverage::Record>> {
        let started = std::time::Instant::now();
        let rows = sqlx::query(r#"SELECT e.*,
            jsonb_agg(jsonb_build_object(
                'id',ci.id,'sourceName',s.name,'sourceTier',s.tier,'title',ci.title,'url',ci.original_url,
                'isOfficial',ee.is_official,'publishedAt',COALESCE(ci.published_at,ci.created_at),
                'originalPublishedAt',ci.published_at,'collectedAt',ci.created_at,
                'publicationPrecision',COALESCE(ci.metadata->'sourceMetadata'->>'datePrecision','time'),
                'excerpt',left(COALESCE(news_publisher_excerpt(ci.original_url,ci.metadata),''),3000),
                'readingContext',NULL::jsonb)
                ORDER BY ci.published_at DESC NULLS LAST,ci.id) AS coverage_evidence,
            jsonb_agg(jsonb_build_object('evidenceId',ci.id,
                'publisher',COALESCE(ee.independence_group,'publisher:'||p.id::text,'source:'||s.id::text),
                'kind',CASE WHEN p.entity_type='community' OR s.content_type='repository' OR s.adapter_type IN ('github_search','github_repository')
                    THEN 'community' WHEN p.entity_type IN ('publication','author','podcast') THEN 'editorial'
                    WHEN ee.is_official THEN 'official' ELSE 'editorial' END)) AS coverage_sources
            FROM events e JOIN event_evidence ee ON ee.event_id=e.id
            JOIN content_items ci ON ci.id=ee.content_item_id JOIN sources s ON s.id=ci.source_id
            LEFT JOIN publishers p ON p.id=s.publisher_id
            LEFT JOIN user_event_states us ON us.event_id=e.id AND us.user_id='local' AND NOT $5
            WHERE e.status='published' AND s.adapter_type<>'aihot_public'
              AND ci.metadata->'sourceMetadata'->'aggregation' IS NULL AND ci.metadata->'aggregation' IS NULL
              AND ($1::uuid[] IS NULL OR (e.created_at <= $3 AND ci.created_at <= $3))
              AND ($1::uuid[] IS NULL OR e.id=ANY($1))
              AND ($1::uuid[] IS NOT NULL OR $5 OR us.not_interested_at IS NULL)
              AND ($2::timestamptz IS NULL OR EXISTS(SELECT 1 FROM event_evidence ce
                  JOIN content_items cc ON cc.id=ce.content_item_id WHERE ce.event_id=e.id
                  AND cc.published_at BETWEEN $2 AND COALESCE($4,$3)))
            GROUP BY e.id ORDER BY e.id"#)
            .bind(ids).bind(start).bind(cutoff).bind(end).bind(visitor).fetch_all(&self.pool).await?;
        tracing::debug!(stage="record_query",elapsed_ms=started.elapsed().as_millis(),rows=rows.len(),"coverage material timing");
        let records = rows.into_iter()
            .map(|row| {
                let mut evidence: Vec<Evidence> =
                    serde_json::from_value(row.try_get("coverage_evidence")?)?;
                for item in &mut evidence {
                    item.title = plain_text(&item.title);
                    item.excerpt = plain_text(&item.excerpt);
                }
                let identities: Value = row.try_get("coverage_sources")?;
                let sources = identities
                    .as_array()
                    .context("coverage sources must be an array")?
                    .iter()
                    .map(|source| {
                        Ok(crate::coverage::SourceIdentity {
                            evidence_id: serde_json::from_value(source["evidenceId"].clone())?,
                            publisher: source["publisher"]
                                .as_str()
                                .context("coverage publisher missing")?
                                .into(),
                            kind: source["kind"]
                                .as_str()
                                .context("coverage kind missing")?
                                .into(),
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                let material_kind = crate::coverage::material_kind(&sources);
                let (published_at, publication_precision) = reader::publication_context(&evidence);
                Ok(crate::coverage::Record::new(
                    crate::models::CoverageMember {
                        event_id: row.try_get("id")?,
                        content_version: row.try_get("content_version")?,
                        title: plain_text(&row.try_get::<String, _>("canonical_title")?),
                        display_title: row.try_get("display_title")?,
                        event_type: row.try_get("event_type")?,
                        published_at,
                        publication_precision,
                        summary_kind: row.try_get("summary_kind")?,
                        summary: plain_text(&row.try_get::<String, _>("summary")?),
                        summary_points: serde_json::from_value(row.try_get("summary_points")?)?,
                        summary_material_limit: row.try_get("summary_material_limit")?,
                        summary_limitations: serde_json::from_value(
                            row.try_get("summary_limitations")?,
                        )?,
                        summary_model: row.try_get("summary_model")?,
                        summarized_at: row.try_get("summarized_at")?,
                        evidence,
                        relationship: "unrelated".into(),
                        material_kind,
                        matches_filters: true,
                        release_target: None,
                        release_version: None,
                    },
                    sources,
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        tracing::debug!(stage="record_parse",elapsed_ms=started.elapsed().as_millis(),records=records.len(),"coverage material timing");
        Ok(records)
    }

    async fn build_brief(&self, cutoff: DateTime<Utc>, interests: Option<&VisitorInterests>) -> Result<DailyBrief> {
        let (settings, _) = crate::edition::EditionStore::new(self.pool.clone())
            .settings()
            .await?;
        let rows = sqlx::query("SELECT e.*,r.*,0::real AS material_penalty,
              (NOT EXISTS(SELECT 1 FROM event_evidence ae JOIN content_items ac ON ac.id=ae.content_item_id
                JOIN sources ads ON ads.id=ac.source_id WHERE ae.event_id=e.id AND ads.adapter_type='aihot_public')
              AND (r.confirmed OR ($3 AND EXISTS(SELECT 1 FROM event_evidence ee
                JOIN content_items ci ON ci.id=ee.content_item_id JOIN sources s ON s.id=ci.source_id
                WHERE ee.event_id=e.id AND s.lifecycle_status='observing' AND s.last_success_at IS NOT NULL
                AND s.consecutive_failures=0 AND s.adapter_type<>'github_search')))) AS source_eligible
            FROM events e JOIN reader_editorial_recommendations_for_profile($4,$2,false,ARRAY(
              SELECT DISTINCT ee.event_id FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
              WHERE ci.published_at BETWEEN $1 AND $2),$5) r ON r.event_id=e.id
            WHERE e.status='published' AND e.event_type<>'repository'
              AND NOT reader_is_opaque_engineering_release(e.event_type,e.canonical_title)
              AND NOT r.not_interested AND (r.editorial->>'briefEligible')::boolean
              AND NOT EXISTS(SELECT 1 FROM event_evidence old JOIN content_items ci ON ci.id=old.content_item_id
                WHERE old.event_id=e.id AND ci.published_at<$1)
            ORDER BY r.rank_score DESC,e.id")
            .bind(cutoff-chrono::Duration::days(7)).bind(cutoff).bind(settings.include_observing)
            .bind(interests.is_none().then_some("local")).bind(interests.map(VisitorInterests::as_json))
            .fetch_all(&self.pool).await?;
        let mut events = Vec::new();
        let mut eligibility = crate::models::BriefEligibility {
            window_candidates: rows.len() as i64,
            awaiting_summary: 0,
            awaiting_source_confirmation: 0,
        };
        for row in rows {
            if !row.try_get::<bool, _>("source_eligible")? {
                eligibility.awaiting_source_confirmation += 1;
                continue;
            }
            if row.try_get::<String, _>("summary_kind")? != "copilot"
                || row.try_get::<i32, _>("summary_format_version")? < 2 {
                eligibility.awaiting_summary += 1;
                continue;
            }
            events.push(self.hydrate_event(row, false, interests).await?);
        }
        events.retain(|e| reader::brief_qualified(e, cutoff));
        reader::sort_candidates(&mut events, cutoff);
        // Enrich before selection so a related repository need not be eligible for a news slot.
        // Only original eligible news dates participate in select_brief_limit's freshness window.
        let records = self
            .coverage_records(
                None,
                Some(cutoff - chrono::Duration::days(14)),
                None,
                cutoff,
                interests.is_some(),
            )
            .await?;
        let groups = crate::coverage::groups(
            &records,
            &events.iter().map(|e| e.id).collect::<Vec<_>>(),
            cutoff,
        );
        let mut by_id: std::collections::HashMap<_, _> =
            events.into_iter().map(|e| (e.id, e)).collect();
        let events = groups
            .into_iter()
            .filter_map(|group| {
                let mut event = by_id.remove(&group.lead)?;
                crate::coverage::apply(&mut event, group.bundle);
                Some(event)
            })
            .collect();
        let mut brief = reader::select_brief_limit(events, cutoff, settings.brief_limit);
        brief.eligibility = Some(eligibility);
        Ok(brief)
    }

    async fn read_event(&self, id: Uuid, interests: Option<&VisitorInterests>) -> Result<Option<Event>> {
        let row = sqlx::query("SELECT e.*,r.*,0::real AS material_penalty FROM events e
            JOIN reader_editorial_recommendations_for_profile($2,now(),false,ARRAY[$1],$3) r
              ON r.event_id=e.id WHERE e.id=$1")
            .bind(id).bind(interests.is_none().then_some("local"))
            .bind(interests.map(VisitorInterests::as_json))
            .fetch_optional(&self.pool).await?;
        let Some(row) = row else { return Ok(None) };
        let mut event = self.hydrate_event(row, true, interests).await?;
        if !event.not_interested {
            if let Some(date) = event.freshness_at.or(event.published_at) {
                let records = self.coverage_records(None,
                    Some(date - chrono::Duration::hours(crate::coverage::WINDOW_HOURS)),
                    Some((date + chrono::Duration::hours(crate::coverage::WINDOW_HOURS)).min(Utc::now())),
                    Utc::now(), interests.is_some()).await?;
                if let Some(group) = crate::coverage::groups(&records, &[id], Utc::now()).into_iter().next() {
                    crate::coverage::apply(&mut event, group.bundle);
                }
            }
        }
        Ok(Some(event))
    }

    async fn hydrate_event(
        &self,
        row: sqlx::postgres::PgRow,
        include_reading_context: bool,
        interests: Option<&VisitorInterests>,
    ) -> Result<Event> {
        let id: Uuid = row.try_get("id")?;
        let reading_context = if include_reading_context {
            "ci.metadata->'readingContext'"
        } else {
            "NULL::jsonb"
        };
        let evidence_rows = sqlx::query(&format!(r#"SELECT ci.id,s.name AS source_name,s.tier AS source_tier,
            ci.title,ci.original_url,ee.is_official,COALESCE(ci.published_at,ci.created_at) AS published_at,
            ci.published_at AS original_published_at,ci.created_at AS collected_at,
            COALESCE(ci.metadata->'sourceMetadata'->>'datePrecision','time') AS publication_precision,
            COALESCE(news_publisher_excerpt(ci.original_url,ci.metadata),'') AS excerpt,
            news_technical_basis(ci.original_url,ci.title,ci.metadata) AS technical_basis,
            ci.metadata->'sourceMetadata'->'aggregation' AS aggregation,
            {reading_context} AS reading_context
            FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
            JOIN sources s ON s.id=ci.source_id WHERE ee.event_id=$1 ORDER BY published_at DESC,ci.id"#))
            .bind(id).fetch_all(&self.pool).await?;
        let evidence = evidence_rows
            .into_iter()
            .map(|item| -> Result<Evidence> {
                Ok(Evidence {
                    id: item.try_get("id")?,
                    source_name: item.try_get("source_name")?,
                    source_tier: item.try_get("source_tier")?,
                    title: plain_text(&item.try_get::<String, _>("title")?),
                    url: item.try_get("original_url")?,
                    is_official: item.try_get("is_official")?,
                    published_at: item.try_get("published_at")?,
                    original_published_at: item.try_get("original_published_at")?,
                    publication_precision: item.try_get("publication_precision")?,
                    collected_at: item.try_get("collected_at")?,
                    excerpt: plain_text(&item.try_get::<String, _>("excerpt")?)
                        .chars()
                        .take(3000)
                        .collect(),
                    technical_basis: item.try_get("technical_basis")?,
                    aggregation: item
                        .try_get::<Option<Value>, _>("aggregation")?
                        .map(serde_json::from_value)
                        .transpose()?,
                    reading_context: item
                        .try_get::<Option<Value>, _>("reading_context")?
                        .map(|value| {
                            serde_json::from_value::<crate::reading_context::ReadingContext>(value)
                                .map(crate::reading_context::ReadingContext::respect_publisher_access)
                                .context("invalid evidence reading context")
                        })
                        .transpose()?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let topics: Vec<String> = row.try_get("facets")?;
        let updated_at = row.try_get("updated_at")?;
        let score = score_event(&evidence, updated_at, Utc::now());
        let state = if interests.is_some() { None } else {
            sqlx::query("SELECT saved_at IS NOT NULL AS saved,read_at IS NOT NULL AS read,later_at IS NOT NULL AS later,not_interested_reason FROM user_event_states WHERE user_id='local' AND event_id=$1")
                .bind(id).fetch_optional(&self.pool).await?
        };
        let (saved, read, later) = match state {
            Some(ref row) => (
                row.try_get("saved")?,
                row.try_get("read")?,
                row.try_get("later")?,
            ),
            None => (false, false, false),
        };
        let job = if interests.is_some() { None } else { sqlx::query(
            "SELECT status,last_error,next_attempt_at FROM summary_jobs WHERE event_id=$1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await? };
        let (published_at, publication_precision) = reader::publication_context(&evidence);
        let freshness_at = evidence
            .iter()
            .filter_map(|item| item.original_published_at)
            .min();
        let collected_at = evidence.iter().filter_map(|item| item.collected_at).max();
        let mut event = Event {
            editorial: Some(serde_json::from_value(row.try_get("editorial")?)?),
            display_title: row.try_get("display_title")?,
            not_interested_reason: state.as_ref().map(|s| s.try_get::<Option<String>, _>("not_interested_reason"))
                .transpose()?.flatten().map(|s| serde_json::from_value(serde_json::Value::String(s))).transpose()?,
            editorial_publishers: row.try_get("publisher_keys")?,
            editorial_community: row.try_get("is_community")?,
            coverage: None,
            id,
            title: plain_text(&row.try_get::<String, _>("canonical_title")?),
            summary: plain_text(&row.try_get::<String, _>("summary")?),
            importance: row.try_get("importance")?,
            primary_topic: topics.first().cloned().unwrap_or_else(|| "其他动态".into()),
            topics,
            event_type: row.try_get("event_type")?,
            first_seen_at: row.try_get("first_seen_at")?,
            updated_at,
            published_at,
            freshness_at,
            publication_precision,
            collected_at,
            evidence,
            score,
            personal_relevance: 0.0,
            personal_reason: String::new(),
            saved,
            read,
            later,
            summary_kind: row.try_get("summary_kind")?,
            summary_model: row.try_get("summary_model")?,
            summarized_at: row.try_get("summarized_at")?,
            summary_evidence_ids: serde_json::from_value(
                row.try_get::<Value, _>("summary_evidence_ids")?,
            )?,
            content_version: row.try_get("content_version")?,
            summary_status: job.as_ref().map(|row| row.try_get("status")).transpose()?,
            summary_error: job.as_ref().map(|row| row.try_get("last_error")).transpose()?.flatten(),
            summary_next_attempt_at: job.as_ref().map(|row| row.try_get("next_attempt_at")).transpose()?.flatten(),
            summary_format_version: row.try_get("summary_format_version")?,
            summary_reasoning_effort: row.try_get("summary_reasoning_effort")?,
            summary_points:serde_json::from_value(row.try_get("summary_points")?)?,
            summary_material_limit:row.try_get("summary_material_limit")?,
            summary_limitations:serde_json::from_value(row.try_get("summary_limitations")?)?,
            not_interested: row.try_get("not_interested")?,
            seen: row.try_get("seen")?,
            opened: row.try_get("opened")?,
            recommendation: Some(crate::models::Recommendation {
                material_penalty:row.try_get("material_penalty")?,
                score: row.try_get("rank_score")?,
                freshness: row.try_get("recency")?,
                affinity: row.try_get("affinity")?,
                novelty_penalty: row.try_get("novelty_penalty")?,
                facets: row.try_get("facets")?,
                source_confirmed: row.try_get("confirmed")?,
                explanation: "article-value-v1：文章价值30% + 来源质量25% + 显式兴趣20% + 分类型时效15% + 主动反馈5% + 独立来源覆盖5%。时效使用最早来源日期；研究/分析/教程96小时、发布48小时、新闻30小时半衰期，周报168小时。曝光最多减3分、打开最多减6分并衰减；周报不扣重复分。价值是原始材料的保守规则估计，不是AI判断或事实核验。默认不感兴趣仅弱调相似类型内容；过时/低价值不降低主题兴趣。".into(),
            }),
        };
        (event.personal_relevance, event.personal_reason) = match interests {
            Some(profile) => reader::relevance(&event, profile.topics()),
            None => reader::relevance(&event, &self.topics().await?),
        };
        Ok(event)
    }

    async fn snapshot(&self, date: NaiveDate) -> Result<Option<DailyBrief>> {
        let Some(row) =
            sqlx::query("SELECT * FROM daily_briefs WHERE local_date=$1 AND status='published'")
                .bind(date)
                .fetch_optional(&self.pool)
                .await?
        else {
            return Ok(None);
        };
        let id: Uuid = row.try_get("id")?;
        let generated_at: DateTime<Utc> = row.try_get("generated_at")?;
        let rows = sqlx::query(
            r#"SELECT bi.snapshot,bi.event_id,
            COALESCE(us.saved_at IS NOT NULL,false) AS saved,
            COALESCE(us.read_at IS NOT NULL,false) AS read,
            COALESCE(us.later_at IS NOT NULL,false) AS later
            ,COALESCE(us.not_interested_at IS NOT NULL,false) AS not_interested,us.not_interested_reason
            FROM daily_brief_items bi LEFT JOIN user_event_states us
            ON us.event_id=bi.event_id AND us.user_id='local'
            WHERE bi.brief_id=$1 ORDER BY bi.rank"#,
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await?;
        let mut items = Vec::new();
        for item in rows {
            let mut event = if let Some(value) = item.try_get::<Option<Value>, _>("snapshot")? {
                serde_json::from_value::<Event>(value).context("invalid brief snapshot")?
            } else {
                self.get_event(item.try_get("event_id")?)
                    .await?
                    .context("missing brief event")?
            };
            (event.saved, event.read, event.later) = (
                item.try_get("saved")?,
                item.try_get("read")?,
                item.try_get("later")?,
            );
            event.not_interested = item.try_get("not_interested")?;
            event.not_interested_reason = item.try_get::<Option<String>, _>("not_interested_reason")?
                .map(|s| serde_json::from_value(Value::String(s))).transpose()?;
            if !event.not_interested {
                items.push(event);
            }
        }
        let items = crate::coverage::rollup_release_snapshots(items, generated_at);
        let mut sections: Vec<crate::models::BriefSection> = serde_json::from_value(row.try_get("sections")?)?;
        for section in &mut sections {
            section.event_ids.retain(|id| items.iter().any(|e| e.id == *id));
        }
        sections.retain(|s| !s.event_ids.is_empty());
        Ok(Some(DailyBrief {
            sections,
            local_date: date.to_string(),
            generated_at,
            estimated_minutes: ((items.len() as i32 + 1) / 2).min(5),
            items,
            is_snapshot: true,
            window_start: row
                .try_get::<Option<DateTime<Utc>>, _>("window_start")?
                .unwrap_or(generated_at - chrono::Duration::hours(24)),
            window_end: row
                .try_get::<Option<DateTime<Utc>>, _>("window_end")?
                .unwrap_or(generated_at),
            primary_window_start: Some(row.try_get::<Option<DateTime<Utc>>, _>("window_end")?.unwrap_or(generated_at) - chrono::Duration::hours(24)),
            selection_note: Some("已保存的历史选文与原始快照保持原样；同项目集中发布仅收拢展示，不补入存档之外的材料。".into()),
            eligibility: None,
        }))
    }
}

#[cfg(test)]
mod coverage_contract_tests {
    use super::*;

    #[tokio::test]
    #[ignore = "explicit local read-only DB contract; no ingestion, settings writes or model calls"]
    async fn coverage_read_only_database_contract() -> Result<()> {
        let connection = std::env::var("SCOUTNEWS_COVERAGE_READ_ONLY_DATABASE_URL")?;
        let url = url::Url::parse(&connection)?;
        anyhow::ensure!(
            matches!(url.host_str(), Some("127.0.0.1" | "localhost")),
            "local database required"
        );
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .after_connect(|connection, _| {
                Box::pin(async move {
                    sqlx::query("SET default_transaction_read_only=on")
                        .execute(connection)
                        .await?;
                    Ok(())
                })
            })
            .connect(&connection)
            .await?;
        assert_eq!(
            sqlx::query_scalar::<_, String>("SHOW default_transaction_read_only")
                .fetch_one(&pool)
                .await?,
            "on"
        );
        let store = PostgresStore::new(pool);
        let cutoff = Utc::now();
        let q = std::env::var("SCOUTNEWS_COVERAGE_TEST_QUERY").unwrap_or_else(|_| "Grok".into());
        let raw = store
            .list_events(&EventQuery {
                q: Some(q.clone()),
                limit: Some(100),
                as_of: Some(cutoff),
                ..Default::default()
            })
            .await?;
        let grouped = store
            .list_events(&EventQuery {
                q: Some(q.clone()),
                coverage: Some(true),
                limit: Some(100),
                as_of: Some(cutoff),
                ..Default::default()
            })
            .await?;
        assert!(!raw.is_empty(), "collect real matching material first");
        let mut original_ids: Vec<_> = raw.iter().map(|e| e.id).collect();
        let mut grouped_ids: Vec<_> = grouped
            .iter()
            .flat_map(|e| {
                e.coverage.as_ref().map_or_else(
                    || vec![e.id],
                    |bundle| bundle.members.iter().map(|m| m.event_id).collect(),
                )
            })
            .collect();
        original_ids.sort();
        grouped_ids.sort();
        assert_eq!(original_ids, grouped_ids);
        for (offset, expected) in grouped.iter().enumerate() {
            let page = store
                .list_events(&EventQuery {
                    q: Some(q.clone()),
                    coverage: Some(true),
                    limit: Some(1),
                    offset: Some(offset as i64),
                    as_of: Some(cutoff),
                    ..Default::default()
                })
                .await?;
            assert_eq!(page.len(), 1);
            assert_eq!(page[0].id, expected.id);
            assert_eq!(
                page[0].coverage.as_ref().map(|b| &b.key),
                expected.coverage.as_ref().map(|b| &b.key)
            );
        }
        for event in &grouped {
            assert!(store.get_event(event.id).await?.is_some());
        }
        if std::env::var("SCOUTNEWS_COVERAGE_REQUIRE_BUNDLE").is_ok_and(|v| v == "true") {
            for bundle in grouped.iter().filter_map(|e| e.coverage.as_ref()) {
                assert!(bundle.members.len() >= 2);
                assert!(matches!(
                    (bundle.relation.as_str(), bundle.method.as_str()),
                    ("same_event_evidence", "exact-event-reference-v1")
                        | ("release_family", "release-family-v1")
                        | ("release_family", "release-family-v2")
                ));
                if bundle.community_material_count > 0 && bundle.editorial_source_count == 1 {
                    assert_eq!(bundle.popularity_boost, 0.0);
                }
            }
        }
        let brief = store.latest_brief().await?;
        assert!(brief.items.iter().all(|e| e.event_type != "repository"));
        eprintln!(
            "read-only contract: {} records -> {} rows; {} brief leaders, {} with coverage",
            raw.len(),
            grouped.len(),
            brief.items.len(),
            brief.items.iter().filter(|e| e.coverage.is_some()).count()
        );
        eprintln!(
            "brief bundles: {}",
            brief
                .items
                .iter()
                .filter_map(|e| e.coverage.as_ref())
                .map(|b| format!("{} [{}]", b.topic, b.members.len()))
                .collect::<Vec<_>>()
                .join(", ")
        );
        Ok(())
    }
}

#[async_trait]
impl Store for PostgresStore {
    async fn provider_auth_mode(&self) -> Result<String> {
        Ok(
            sqlx::query_scalar("SELECT value FROM app_settings WHERE key='copilot_auth_mode'")
                .fetch_one(&self.pool)
                .await?,
        )
    }

    async fn set_provider_auth_mode(&self, mode: &str) -> Result<()> {
        sqlx::query("INSERT INTO app_settings(key,value) VALUES('copilot_auth_mode',$1) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=now()")
            .bind(mode).execute(&self.pool).await?;
        Ok(())
    }

    async fn list_events(&self, query: &EventQuery) -> Result<Vec<Event>> {
        let started = std::time::Instant::now();
        let coverage = query.coverage.unwrap_or(false);
        let cutoff = query.as_of.unwrap_or_else(Utc::now);
        let sql = format!(
            r#"SELECT e.*,r.*,0::real AS material_penalty FROM events e
            JOIN reader_editorial_recommendations_for_profile($21,$12,$20,ARRAY(
              SELECT candidate.id FROM events candidate
                LEFT JOIN user_event_states cs ON cs.event_id=candidate.id AND cs.user_id=$21
              WHERE candidate.status='published'
                AND ($3::boolean IS NULL OR (cs.saved_at IS NOT NULL)=$3)
                AND ($4::boolean IS NULL OR (cs.read_at IS NOT NULL)=$4)
                AND ($5::boolean IS NULL OR (cs.later_at IS NOT NULL)=$5)
                AND (cs.not_interested_at IS NOT NULL)=$11
                AND ($19::boolean OR $3::boolean=true OR $11::boolean=true
                  OR NOT reader_is_opaque_engineering_release(candidate.event_type,candidate.canonical_title))
                AND ($9::bigint=0 OR EXISTS(SELECT 1 FROM event_evidence ee
                  JOIN content_items ci ON ci.id=ee.content_item_id WHERE ee.event_id=candidate.id
                    AND ci.published_at BETWEEN $12-($9*interval '1 hour') AND $12))
                AND ($13::text IS NULL AND $15::uuid IS NULL AND $17::boolean IS NULL OR EXISTS(
                  SELECT 1 FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
                  JOIN sources s ON s.id=ci.source_id WHERE ee.event_id=candidate.id
                    AND ($13::text IS NULL OR s.tier=$13) AND ($15::uuid IS NULL OR s.id=$15)
                    AND ($17::boolean IS NULL OR (news_technical_basis(ci.original_url,ci.title,ci.metadata) IS NOT NULL)=$17)))
            ),$22) r ON r.event_id=e.id
            LEFT JOIN user_event_states us ON us.event_id=e.id AND us.user_id=$21
            WHERE e.status='published'
            AND (NOT $20 OR ((r.editorial->>'briefEligible')::boolean
                AND e.summary_kind='copilot' AND e.summary_format_version>=2))
            AND ($18::boolean=false OR e.created_at<=$12)
            AND ($19::boolean OR $3::boolean=true OR $11::boolean=true
                OR NOT reader_is_opaque_engineering_release(e.event_type,e.canonical_title))
            AND ($1::text IS NULL OR news_topic_alias($1)=ANY(r.facets))
            AND ($2::text IS NULL OR e.canonical_title ILIKE '%'||$2||'%' OR e.display_title ILIKE '%'||$2||'%' OR e.summary ILIKE '%'||$2||'%'
                OR EXISTS(SELECT 1 FROM unnest(r.facets) facet WHERE facet ILIKE '%'||$2||'%'))
            AND ($3::boolean IS NULL OR (us.saved_at IS NOT NULL)=$3)
            AND ($4::boolean IS NULL OR (us.read_at IS NOT NULL)=$4)
            AND ($5::boolean IS NULL OR (us.later_at IS NOT NULL)=$5)
            AND r.not_interested=$11
            AND ($13::text IS NULL AND $15::uuid IS NULL AND $17::boolean IS NULL OR EXISTS(
                SELECT 1 FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
                JOIN sources s ON s.id=ci.source_id WHERE ee.event_id=e.id
                  AND ($13::text IS NULL OR s.tier=$13) AND ($15::uuid IS NULL OR s.id=$15)
                  AND ($17::boolean IS NULL OR (news_technical_basis(ci.original_url,ci.title,ci.metadata) IS NOT NULL)=$17)))
            AND ($14::text IS NULL OR e.event_type=$14 OR r.editorial->>'contentKind'=$14)
            AND ($16::boolean IS NULL OR (r.opened AND r.seen)=$16)
            AND ($10::text IS NULL OR $10=ANY(r.facets))
            AND ($9::bigint=0 OR EXISTS(SELECT 1 FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
                WHERE ee.event_id=e.id AND ci.published_at >= $12-($9*interval '1 hour') AND ci.published_at <= $12))
            ORDER BY CASE WHEN $6 IN('recommended','weekly') THEN r.rank_score WHEN $6='newest' THEN 0 ELSE {} END DESC,
                CASE WHEN $6='newest' THEN (SELECT max(ci.published_at) FROM event_evidence ee
                    JOIN content_items ci ON ci.id=ee.content_item_id WHERE ee.event_id=e.id)
                    ELSE e.updated_at END DESC NULLS LAST,
                e.updated_at DESC,e.id LIMIT $7 OFFSET $8"#,
            score_order_sql()
        );
        let rows = sqlx::query(&sql)
            .bind(query.topic.as_deref())
            .bind(query.q.as_deref())
            .bind(query.saved)
            .bind(query.read)
            .bind(query.later)
            .bind(query.sort.as_deref().unwrap_or("recommended"))
            .bind(if coverage || query.sort.as_deref() == Some("weekly") {
                i64::MAX
            } else {
                query.limit.unwrap_or(50)
            })
            .bind(if coverage {
                0
            } else {
                query.offset.unwrap_or(0)
            })
            .bind(query.hours.unwrap_or(0))
            .bind(query.facet.as_deref())
            .bind(query.not_interested.unwrap_or(false))
            .bind(cutoff)
            .bind(query.tier.as_deref())
            .bind(query.kind.as_deref())
            .bind(query.source)
            .bind(query.opened)
            .bind(query.technical)
            .bind(coverage)
            .bind(query.include_engineering.unwrap_or(false))
            .bind(query.sort.as_deref() == Some("weekly"))
            .bind(query.interests.is_none().then_some("local"))
            .bind(query.interests.as_ref().map(VisitorInterests::as_json))
            .fetch_all(&self.pool)
            .await?;
        if coverage {
            tracing::debug!(stage="query",elapsed_ms=started.elapsed().as_millis(),rows=rows.len(),"grouped reader timing");
            let ids = rows
                .iter()
                .map(|r| r.try_get::<Uuid, _>("id"))
                .collect::<std::result::Result<Vec<_>, _>>()?;
            // Ordinary article/podcast URLs cannot form a verified group. Keep
            // their singleton positions without decoding every archived excerpt.
            let references = sqlx::query("SELECT ee.event_id,ci.original_url FROM event_evidence ee
                JOIN content_items ci ON ci.id=ee.content_item_id
                WHERE ee.event_id=ANY($1) AND ci.created_at<=$2")
                .bind(&ids).bind(cutoff).fetch_all(&self.pool).await?;
            let mut groupable_ids = std::collections::HashSet::new();
            for reference in references {
                if crate::coverage::event_reference(&reference.try_get::<String,_>("original_url")?).is_some() {
                    groupable_ids.insert(reference.try_get::<Uuid,_>("event_id")?);
                }
            }
            let groupable_ids: Vec<_> = groupable_ids.into_iter().collect();
            let records = if groupable_ids.is_empty() {
                Vec::new()
            } else {
                self.coverage_records(Some(&groupable_ids), None, None, cutoff, query.interests.is_some()).await?
            };
            tracing::debug!(stage="records",elapsed_ms=started.elapsed().as_millis(),records=records.len(),"grouped reader timing");
            let positions: std::collections::HashMap<_, _> =
                ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
            let ranks = rows
                .iter()
                .map(|r| {
                    Ok((
                        r.try_get::<Uuid, _>("id")?,
                        r.try_get::<f32, _>("rank_score")?,
                    ))
                })
                .collect::<Result<std::collections::HashMap<_, _>>>()?;
            let community: std::collections::HashSet<_> = records
                .iter()
                .filter(|r| r.member.material_kind == "community")
                .map(|r| r.member.event_id)
                .collect();
            let mut leaders = ids;
            leaders.sort_by_key(|id| community.contains(id));
            let mut groups = crate::coverage::groups(&records, &leaders, cutoff);
            tracing::debug!(stage="group",elapsed_ms=started.elapsed().as_millis(),groups=groups.len(),"grouped reader timing");
            groups.sort_by(|a, b| {
                if matches!(query.sort.as_deref().unwrap_or("recommended"),"recommended" | "weekly") {
                    let score = |g: &crate::coverage::Group| {
                        ranks[&g.lead]
                    };
                    score(b)
                        .total_cmp(&score(a))
                        .then(positions[&a.lead].cmp(&positions[&b.lead]))
                } else {
                    positions[&a.lead].cmp(&positions[&b.lead])
                }
            });
            let mut rows: std::collections::HashMap<_, _> = rows
                .into_iter()
                .map(|row| Ok((row.try_get::<Uuid, _>("id")?, row)))
                .collect::<Result<_>>()?;
            let mut items = Vec::new();
            for group in groups
                .into_iter()
                .skip(query.offset.unwrap_or(0) as usize)
                .take(query.limit.unwrap_or(50) as usize)
            {
                let mut event = self
                    .hydrate_event(
                        rows.remove(&group.lead)
                            .context("coverage leader missing")?,
                        false,
                        query.interests.as_ref(),
                    )
                    .await?;
                crate::coverage::apply(&mut event, group.bundle);
                items.push(event);
            }
            tracing::debug!(stage="hydrated",elapsed_ms=started.elapsed().as_millis(),items=items.len(),"grouped reader timing");
            return Ok(items);
        }
        let mut items = Vec::with_capacity(rows.len());
        for row in rows {
            items.push(self.hydrate_event(row, false, query.interests.as_ref()).await?);
        }
        Ok(items)
    }

    async fn get_event(&self, id: Uuid) -> Result<Option<Event>> {
        self.read_event(id, None).await
    }

    async fn visitor_event(&self, id: Uuid, interests: &VisitorInterests) -> Result<Option<Event>> {
        self.read_event(id, Some(interests)).await
    }

    async fn update_event_state(&self, id: Uuid, input: EventStateInput) -> Result<Option<Event>> {
        if self.get_event(id).await?.is_none() {
            return Ok(None);
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query(r#"INSERT INTO user_event_states(user_id,event_id,read_at,saved_at,later_at)
            VALUES('local',$1,CASE WHEN $2::boolean THEN now() END,CASE WHEN $3::boolean THEN now() END,
                CASE WHEN $4::boolean THEN now() END)
            ON CONFLICT(user_id,event_id) DO UPDATE SET
            read_at=CASE WHEN $2::boolean IS NULL THEN user_event_states.read_at WHEN $2 THEN now() END,
            saved_at=CASE WHEN $3::boolean IS NULL THEN user_event_states.saved_at WHEN $3 THEN now() END,
            later_at=CASE WHEN $4::boolean IS NULL THEN user_event_states.later_at WHEN $4 THEN now() END"#)
            .bind(id).bind(input.read).bind(input.saved).bind(input.later).execute(&mut *tx).await?;
        sqlx::query("UPDATE user_event_states SET
            not_interested_at=CASE WHEN $2=true THEN COALESCE(not_interested_at,now()) WHEN $2=false OR $3=true THEN NULL ELSE not_interested_at END,
            not_interested_reason=CASE WHEN $2=true THEN $5 WHEN $2=false OR $3=true THEN NULL ELSE not_interested_reason END,
            saved_at=CASE WHEN $2=true THEN NULL ELSE saved_at END,
            opened_at=CASE WHEN $4=true THEN now() ELSE opened_at END,
            last_seen_at=CASE WHEN $4=true THEN now() ELSE last_seen_at END,
            seen_content_version=CASE WHEN $4=true THEN (SELECT content_version FROM events WHERE id=$1) ELSE seen_content_version END
            WHERE user_id='local' AND event_id=$1")
            .bind(id).bind(input.not_interested).bind(input.saved).bind(input.opened)
            .bind(input.not_interested_reason.map(|reason| reason.as_str())).execute(&mut *tx).await?;
        tx.commit().await?;
        self.get_event(id).await
    }

    async fn record_exposures(&self, items: Vec<crate::models::Exposure>) -> Result<u64> {
        let ids: Vec<_> = items.iter().map(|item| item.event_id).collect();
        let versions: Vec<_> = items.iter().map(|item| item.content_version).collect();
        Ok(sqlx::query("WITH valid AS (
            SELECT e.id,e.content_version FROM unnest($1::uuid[],$2::bigint[]) i(id,version)
            JOIN events e ON e.id=i.id AND e.content_version=i.version WHERE e.status='published'
        ), observed AS (
            INSERT INTO event_exposures(user_id,event_id,local_date,content_version)
            SELECT 'local',id,(now() AT TIME ZONE 'Asia/Shanghai')::date,content_version FROM valid
            ON CONFLICT(user_id,event_id,local_date) DO UPDATE SET content_version=EXCLUDED.content_version,observed_at=now()
            WHERE event_exposures.content_version<>EXCLUDED.content_version RETURNING event_id,content_version,observed_at
        ) INSERT INTO user_event_states(user_id,event_id,last_seen_at,seen_content_version)
          SELECT 'local',event_id,observed_at,content_version FROM observed
          ON CONFLICT(user_id,event_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at,seen_content_version=EXCLUDED.seen_content_version")
            .bind(ids).bind(versions).execute(&self.pool).await?.rows_affected())
    }

    async fn latest_brief(&self) -> Result<DailyBrief> {
        self.build_brief(Utc::now(), None).await
    }

    async fn visitor_brief(&self, cutoff: DateTime<Utc>, interests: &VisitorInterests) -> Result<DailyBrief> {
        self.build_brief(cutoff, Some(interests)).await
    }

    async fn brief(&self, date: NaiveDate, persist: bool) -> Result<Option<DailyBrief>> {
        if let Some(brief) = self.snapshot(date).await? {
            return Ok(Some(brief));
        }
        let now = Utc::now();
        if date != reader::local_date(now) {
            return Ok(None);
        }
        let mut tx = self.pool.begin().await?;
        if persist {
            sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
                .bind(format!("brief:{date}"))
                .execute(&mut *tx)
                .await?;
            if let Some(brief) = self.snapshot(date).await? {
                return Ok(Some(brief));
            }
        }
        let cutoff: DateTime<Utc> = sqlx::query_scalar("SELECT COALESCE(
            (SELECT window_end FROM morning_runs WHERE local_date=$1 AND
              (SELECT value::jsonb->>'mode' FROM app_settings WHERE key='reader_settings')='daily'),$2)")
            .bind(date).bind(now).fetch_one(&self.pool).await?;
        let mut brief = self.build_brief(cutoff, None).await?;
        brief.generated_at = now;
        if persist {
            if brief.items.is_empty() {
                return Ok(None);
            }
            let id = Uuid::new_v4();
            sqlx::query(r#"INSERT INTO daily_briefs(id,local_date,status,generated_at,published_at,rule_version,window_start,window_end,sections)
                VALUES($1,$2,'published',$3,$3,'article-value-v1',$4,$5,$6)"#)
                .bind(id).bind(date).bind(now).bind(brief.window_start).bind(cutoff)
                .bind(serde_json::to_value(&brief.sections)?).execute(&mut *tx).await?;
            for (index, event) in brief.items.iter().enumerate() {
                sqlx::query(r#"INSERT INTO daily_brief_items(brief_id,event_id,rank,section,selection_reason,snapshot)
                    VALUES($1,$2,$3,$4,$5,$6)"#).bind(id).bind(event.id).bind((index+1) as i32)
                    .bind(&event.primary_topic).bind(&event.score.explanation).bind(serde_json::to_value(event)?)
                    .execute(&mut *tx).await?;
            }
            brief.is_snapshot = true;
        }
        tx.commit().await?;
        if persist {
            self.snapshot(date).await
        } else {
            Ok(Some(brief))
        }
    }

    async fn brief_history(&self) -> Result<Vec<BriefHistory>> {
        let rows = sqlx::query(
            r#"SELECT b.local_date,b.generated_at,count(bi.event_id) AS item_count
            FROM daily_briefs b LEFT JOIN daily_brief_items bi ON bi.brief_id=b.id
            WHERE b.status='published' GROUP BY b.id ORDER BY b.local_date DESC LIMIT 365"#,
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(BriefHistory {
                    local_date: row.try_get("local_date")?,
                    generated_at: row.try_get("generated_at")?,
                    item_count: row.try_get("item_count")?,
                })
            })
            .collect()
    }

    async fn topics(&self) -> Result<Vec<Topic>> {
        let profile = sqlx::query_scalar::<_, Value>(
            "SELECT profile FROM interest_profiles WHERE user_id='local'",
        )
        .fetch_optional(&self.pool)
        .await?;
        match profile {
            Some(profile) => serde_json::from_value(
                profile
                    .get("topics")
                    .context("missing profile topics")?
                    .clone(),
            )
            .context("invalid interest profile"),
            None => Ok(vec![]),
        }
    }

    async fn replace_topics(&self, topics: Vec<Topic>) -> Result<Vec<Topic>> {
        sqlx::query("INSERT INTO interest_profiles(user_id,profile) VALUES('local',$1) ON CONFLICT(user_id) DO UPDATE SET profile=$1,updated_at=now()")
            .bind(serde_json::json!({"topics":topics})).execute(&self.pool).await?;
        Ok(topics)
    }

    async fn sources(&self) -> Result<Vec<Source>> {
        let rows = sqlx::query(r#"SELECT s.id,s.name,p.name AS publisher,s.content_type,s.adapter_type,s.endpoint,s.tier,
            s.lifecycle_status,s.last_success_at,s.schedule_minutes,s.consecutive_failures,
            (SELECT error FROM fetch_runs WHERE source_id=s.id ORDER BY started_at DESC,id LIMIT 1) AS last_error,
            COALESCE(array_agg(tn.label ORDER BY tn.label) FILTER(WHERE tn.label IS NOT NULL),'{}') AS topics
            FROM sources s LEFT JOIN publishers p ON p.id=s.publisher_id
            LEFT JOIN source_topics st ON st.source_id=s.id LEFT JOIN taxonomy_nodes tn ON tn.id=st.taxonomy_id
            GROUP BY s.id,p.name ORDER BY s.name"#).fetch_all(&self.pool).await?;
        rows.into_iter()
            .map(|row| -> Result<Source> {
                Ok(Source {
                    id: row.try_get("id")?,
                    name: row.try_get("name")?,
                    publisher: row
                        .try_get::<Option<String>, _>("publisher")?
                        .unwrap_or_else(|| "自定义来源".into()),
                    content_type: row.try_get("content_type")?,
                    adapter: row.try_get("adapter_type")?,
                    endpoint: row.try_get("endpoint")?,
                    tier: row.try_get("tier")?,
                    lifecycle_status: row.try_get("lifecycle_status")?,
                    topics: row.try_get("topics")?,
                    last_success_at: row.try_get("last_success_at")?,
                    schedule_minutes: row.try_get("schedule_minutes")?,
                    consecutive_failures: row.try_get("consecutive_failures")?,
                    last_error: row.try_get("last_error")?,
                })
            })
            .collect()
    }

    async fn create_source(&self, input: SourceInput) -> Result<Source> {
        let id = Uuid::new_v4();
        let mut tx = self.pool.begin().await?;
        let compliance = if input.adapter == "x_public_preview" {
            serde_json::json!({
                "originalPostUrls":crate::ingestion::validate_x_post_urls(&input.endpoint, input.original_post_urls.as_deref().unwrap_or_default())?,
                "coverage":"registered_posts_only",
                "observationRequired":true
            })
        } else { serde_json::json!({}) };
        sqlx::query(r#"INSERT INTO sources(id,name,endpoint,content_type,adapter_type,tier,lifecycle_status,schedule_minutes,compliance)
            VALUES($1,$2,$3,$4,$5,$6,'observing',$7,$8)"#)
            .bind(id).bind(&input.name).bind(&input.endpoint).bind(&input.content_type).bind(&input.adapter)
            .bind(&input.tier).bind(input.schedule_minutes).bind(compliance).execute(&mut *tx).await?;
        if let Some(topic) = input.topic.as_deref().filter(|v| !v.trim().is_empty()) {
            let existing: Option<String> = sqlx::query_scalar(
                "SELECT id FROM taxonomy_nodes WHERE lower(label)=lower($1) ORDER BY id LIMIT 1",
            )
            .bind(topic)
            .fetch_optional(&mut *tx)
            .await?;
            let topic_id = if let Some(id) = existing {
                id
            } else {
                let topic_id = format!("custom-{}", Uuid::new_v4());
                sqlx::query(
                    "INSERT INTO taxonomy_nodes(id,label,group_name) VALUES($1,$2,'自定义')",
                )
                .bind(&topic_id)
                .bind(topic)
                .execute(&mut *tx)
                .await?;
                topic_id
            };
            sqlx::query(
                "INSERT INTO source_topics(source_id,taxonomy_id,relevance) VALUES($1,$2,1)",
            )
            .bind(id)
            .bind(topic_id)
            .execute(&mut *tx)
            .await?;
        }
        sqlx::query("INSERT INTO admin_audits(id,actor,action,target_type,target_id,after_value,reason) VALUES($1,'local','source_create','source',$2,$3,'用户添加 Feed')")
            .bind(Uuid::new_v4()).bind(id.to_string()).bind(serde_json::json!({"endpoint":input.endpoint,"name":input.name,"originalPostUrls":input.original_post_urls}))
            .execute(&mut *tx).await?;
        tx.commit().await?;
        self.sources()
            .await?
            .into_iter()
            .find(|source| source.id == id)
            .context("created source missing")
    }

    async fn update_source(&self, id: Uuid, input: SourceUpdate) -> Result<Option<Source>> {
        let mut tx = self.pool.begin().await?;
        let Some(before) = sqlx::query(
            "SELECT lifecycle_status,schedule_minutes,last_success_at,consecutive_failures,adapter_type FROM sources WHERE id=$1 FOR UPDATE",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        else {
            return Ok(None);
        };
        if input.confirmed == Some(true)
            && (before
                .try_get::<Option<DateTime<Utc>>, _>("last_success_at")?
                .is_none()
                || before.try_get::<i32, _>("consecutive_failures")? > 0
                || before.try_get::<String, _>("adapter_type")? == "github_search"
                || before.try_get::<String, _>("lifecycle_status")? == "paused")
        {
            return Ok(None);
        }
        sqlx::query(r#"UPDATE sources SET lifecycle_status=CASE WHEN $2::boolean IS NULL THEN lifecycle_status
            WHEN $2 THEN COALESCE(compliance->>'resumeStatus','observing') ELSE 'paused' END,
            compliance=CASE WHEN $2::boolean=false AND lifecycle_status<>'paused'
                THEN jsonb_set(compliance,'{resumeStatus}',to_jsonb(lifecycle_status)) ELSE compliance END,
            schedule_minutes=COALESCE($3,schedule_minutes),updated_at=now() WHERE id=$1"#)
            .bind(id).bind(input.enabled).bind(input.schedule_minutes).execute(&mut *tx).await?;
        if input.confirmed == Some(true) {
            sqlx::query("UPDATE sources SET lifecycle_status='stable',
                compliance=compliance || jsonb_build_object('observationRequired',false,'reviewedAt',now(),'resumeStatus','stable')
                WHERE id=$1").bind(id).execute(&mut *tx).await?;
        }
        sqlx::query("INSERT INTO admin_audits(id,actor,action,target_type,target_id,before_value,after_value,reason) VALUES($1,'local','source_update','source',$2,$3,$4,'用户调整采集')")
            .bind(Uuid::new_v4()).bind(id.to_string())
            .bind(serde_json::json!({"lifecycleStatus":before.try_get::<String,_>("lifecycle_status")?,"scheduleMinutes":before.try_get::<i32,_>("schedule_minutes")?}))
            .bind(serde_json::json!({"enabled":input.enabled,"scheduleMinutes":input.schedule_minutes,"confirmed":input.confirmed})).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(self
            .sources()
            .await?
            .into_iter()
            .find(|source| source.id == id))
    }

    async fn save_summary(
        &self,
        id: Uuid,
        summary: GeneratedSummary,
        model: &str,
        expected_version: i64,
        reasoning_effort: Option<&str>,
    ) -> Result<Option<Event>> {
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT summary,importance FROM events WHERE id=$1 AND content_version=$2 FOR UPDATE",
        )
        .bind(id)
        .bind(expected_version)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(before) = row else {
            return Ok(None);
        };
        sqlx::query("UPDATE events SET summary=$2,importance=$3,summary_kind='copilot',summary_model=$4,summarized_at=now(),summary_evidence_ids=$5,summary_format_version=$6,summary_reasoning_effort=$7,summary_points=$8,summary_material_limit=$9,summary_limitations=$10,display_title=$11 WHERE id=$1")
            .bind(id).bind(&summary.summary).bind(&summary.importance).bind(model).bind(serde_json::to_value(&summary.evidence_ids)?)
            .bind(crate::summary::FORMAT_VERSION).bind(reasoning_effort)
            .bind(serde_json::to_value(&summary.points)?).bind(&summary.material_limit)
            .bind(serde_json::to_value(&summary.limitations)?).bind(&summary.display_title).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO admin_audits(id,actor,action,target_type,target_id,before_value,after_value,reason) VALUES($1,'local','summarize','event',$2,$3,$4,'按用户确认的处理策略生成，基于来源证据摘录')")
            .bind(Uuid::new_v4()).bind(id.to_string())
            .bind(serde_json::json!({"summary":before.try_get::<String,_>("summary")?,"importance":before.try_get::<String,_>("importance")?}))
            .bind(serde_json::json!({"summary":summary,"model":model,"formatVersion":crate::summary::FORMAT_VERSION,"reasoningEffort":reasoning_effort})).execute(&mut *tx).await?;
        tx.commit().await?;
        self.get_event(id).await
    }

    async fn summary_attempts(&self) -> Result<i64> {
        Ok(sqlx::query_scalar("SELECT count(*) FROM admin_audits WHERE action='summarize_attempt' AND created_at >= now()-interval '24 hours'")
            .fetch_one(&self.pool).await?)
    }

    async fn record_summary_attempt(&self, id: Uuid, model: &str, automatic: bool) -> Result<()> {
        sqlx::query("INSERT INTO admin_audits(id,actor,action,target_type,target_id,after_value,reason) VALUES($1,'local','summarize_attempt','event',$2,$3,$4)")
            .bind(Uuid::new_v4()).bind(id.to_string()).bind(serde_json::json!({"model":model,"automatic":automatic,"promptVersion":crate::summary::PROMPT_VERSION,"requestedReasoningEffort":"low"}))
            .bind(if automatic { "用户启用的自动摘要队列" } else { "用户手动生成摘要" }).execute(&self.pool).await?;
        Ok(())
    }
}
