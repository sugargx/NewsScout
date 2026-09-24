use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use std::collections::HashMap;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::models::{
    BriefHistory, DailyBrief, Event, EventQuery, EventStateInput, Evidence, GeneratedSummary,
    ScoreBreakdown, Source, SourceInput, SourceUpdate, Topic,
};
use crate::visitor_interests::VisitorInterests;

#[async_trait]
pub trait Store: Send + Sync {
    async fn list_events(&self, query: &EventQuery) -> Result<Vec<Event>>;
    async fn get_event(&self, id: Uuid) -> Result<Option<Event>>;
    async fn visitor_event(&self, id: Uuid, interests: &VisitorInterests) -> Result<Option<Event>>;
    async fn update_event_state(&self, id: Uuid, input: EventStateInput) -> Result<Option<Event>>;
    async fn brief(&self, date: NaiveDate, persist: bool) -> Result<Option<DailyBrief>>;
    /// Re-select today's saved edition once after a selection-rule change; past
    /// editions never change. Returns whether the saved items were replaced.
    async fn reselect_outdated_brief(&self, _date: NaiveDate) -> Result<bool> {
        Ok(false)
    }
    async fn brief_history(&self) -> Result<Vec<BriefHistory>>;
    async fn latest_brief(&self) -> Result<DailyBrief>;
    async fn visitor_brief(
        &self,
        cutoff: DateTime<Utc>,
        interests: &VisitorInterests,
    ) -> Result<DailyBrief>;
    async fn record_exposures(&self, items: Vec<crate::models::Exposure>) -> Result<u64>;
    async fn topics(&self) -> Result<Vec<Topic>>;
    async fn replace_topics(&self, topics: Vec<Topic>) -> Result<Vec<Topic>>;
    async fn sources(&self) -> Result<Vec<Source>>;
    async fn create_source(&self, input: SourceInput) -> Result<Source>;
    async fn update_source(&self, id: Uuid, input: SourceUpdate) -> Result<Option<Source>>;
    async fn save_summary(
        &self,
        id: Uuid,
        summary: GeneratedSummary,
        model: &str,
        expected_version: i64,
        reasoning_effort: Option<&str>,
    ) -> Result<Option<Event>>;
    async fn summary_attempts(&self) -> Result<i64>;
    async fn record_summary_attempt(&self, id: Uuid, model: &str, automatic: bool) -> Result<()>;
    async fn provider_auth_mode(&self) -> Result<String>;
    async fn set_provider_auth_mode(&self, mode: &str) -> Result<()>;
}

#[derive(Clone)]
pub struct MemoryStore {
    state: Arc<RwLock<MemoryState>>,
}

struct MemoryState {
    events: Vec<Event>,
    topics: Vec<Topic>,
    sources: Vec<Source>,
    briefs: HashMap<NaiveDate, DailyBrief>,
    provider_auth_mode: String,
}

impl MemoryStore {
    pub fn demo() -> Self {
        Self {
            state: Arc::new(RwLock::new(seed_state())),
        }
    }

    fn apply_visitor(event: &mut Event, interests: &VisitorInterests) {
        event.saved = false;
        event.read = false;
        event.later = false;
        event.not_interested = false;
        event.not_interested_reason = None;
        event.seen = false;
        event.opened = false;
        let interest = interests
            .topics()
            .iter()
            .filter(|topic| event.topics.contains(&topic.label))
            .map(|topic| topic.weight)
            .max()
            .unwrap_or(35) as f32;
        // Demo scores are synthetic; only PostgreSQL implements the real editorial feature model.
        event.recommendation = Some(crate::models::Recommendation {
            score: event.score.total * 0.8 + interest * 0.2,
            freshness: event.score.freshness,
            affinity: 50.0,
            novelty_penalty: 0.0,
            material_penalty: 0.0,
            facets: event.topics.clone(),
            source_confirmed: true,
            explanation: "演示样本的访客兴趣排序，不代表真实新闻评分。".into(),
        });
        (event.personal_relevance, event.personal_reason) =
            crate::reader::relevance(event, interests.topics());
    }
}

#[cfg(test)]
mod visitor_tests {
    use super::*;

    #[tokio::test]
    async fn visitor_global_score_preserves_publication_ties() {
        let store = MemoryStore::demo();
        {
            let mut state = store.state.write().await;
            state.events.truncate(2);
            for (index, event) in state.events.iter_mut().enumerate() {
                event.id = Uuid::from_u128(index as u128 + 1);
                event.event_type = "blog".into();
                event.score.total = 50.0;
                event.published_at = Some(Utc::now() - Duration::hours(2 - index as i64));
            }
        }
        let profile = VisitorInterests::try_from("agents:100".to_owned()).unwrap();
        for interests in [None, Some(profile)] {
            let result = store
                .list_events(&EventQuery {
                    interests,
                    sort: Some("score".into()),
                    ..Default::default()
                })
                .await
                .unwrap();
            assert_eq!(
                result.iter().map(|event| event.id).collect::<Vec<_>>(),
                vec![Uuid::from_u128(2), Uuid::from_u128(1)]
            );
        }
    }

    #[tokio::test]
    async fn visitor_ranking_precedes_pagination_without_changing_owner_state() {
        let store = MemoryStore::demo();
        let ids;
        let before;
        {
            let mut state = store.state.write().await;
            state.events.truncate(2);
            for (index, event) in state.events.iter_mut().enumerate() {
                event.topics = vec![
                    if index == 0 {
                        "心理与认知"
                    } else {
                        "AI 编程"
                    }
                    .into(),
                ];
                event.primary_topic = event.topics[0].clone();
                event.event_type = "blog".into();
                event.score.total = 50.0;
                event.evidence.truncate(1);
                event.evidence[0].url = format!("https://example.com/visitor-fixture-{index}");
                event.evidence[0].original_published_at = Some(Utc::now() - Duration::hours(1));
                event.freshness_at = event.evidence[0].original_published_at;
                event.editorial.as_mut().unwrap().brief_eligible = true;
            }
            state.events[0].saved = true;
            state.events[0].read = true;
            state.events[0].seen = true;
            state.events[0].opened = true;
            state.events[0].not_interested = true;
            state.topics[0].label = "OWNER_INTEREST_SENTINEL".into();
            ids = [state.events[0].id, state.events[1].id];
            before = serde_json::json!([state.events, state.topics, state.briefs]);
        }
        let psychology = VisitorInterests::try_from("psychology:100".to_owned()).unwrap();
        let coding = VisitorInterests::try_from("coding:100".to_owned()).unwrap();
        for (profile, first) in [(&psychology, ids[0]), (&coding, ids[1])] {
            let query = EventQuery {
                interests: Some(profile.clone()),
                limit: Some(1),
                sort: Some("recommended".into()),
                ..Default::default()
            };
            let items = store.list_events(&query).await.unwrap();
            assert_eq!(items[0].id, first);
            let next = store
                .list_events(&EventQuery {
                    offset: Some(1),
                    ..query
                })
                .await
                .unwrap();
            assert_ne!(next[0].id, first);
            let event = store.visitor_event(ids[0], profile).await.unwrap().unwrap();
            assert!(
                !event.saved
                    && !event.read
                    && !event.seen
                    && !event.opened
                    && !event.not_interested
            );
            assert!(!event.personal_reason.contains("OWNER_INTEREST_SENTINEL"));
            assert!(
                !store
                    .visitor_brief(Utc::now(), profile)
                    .await
                    .unwrap()
                    .is_snapshot
            );
        }
        let state = store.state.read().await;
        assert_eq!(
            serde_json::json!([state.events, state.topics, state.briefs]),
            before
        );
    }
}

#[async_trait]
impl Store for MemoryStore {
    async fn list_events(&self, query: &EventQuery) -> Result<Vec<Event>> {
        let state = self.state.read().await;
        let q = query.q.as_deref().unwrap_or_default().to_lowercase();
        let mut candidates = state.events.clone();
        if let Some(interests) = &query.interests {
            for event in &mut candidates {
                Self::apply_visitor(event, interests);
            }
        }
        let mut items: Vec<_> = candidates
            .into_iter()
            .filter(|event| {
                query.topic.as_ref().is_none_or(|topic| {
                    event.topics.iter().any(|item| {
                        crate::reader::topic_alias(item)
                            .eq_ignore_ascii_case(crate::reader::topic_alias(topic))
                    })
                }) && event.not_interested == query.not_interested.unwrap_or(false)
                    && query
                        .facet
                        .as_ref()
                        .is_none_or(|facet| event.topics.contains(facet))
                    && (query.include_engineering.unwrap_or(false)
                        || query.saved == Some(true)
                        || query.not_interested == Some(true)
                        || !crate::reader::is_opaque_engineering_release(event))
                    && query.kind.as_ref().is_none_or(|kind| {
                        &event.event_type == kind
                            || event
                                .editorial
                                .as_ref()
                                .is_some_and(|p| &p.content_kind == kind)
                    })
                    && (query.tier.is_none() && query.source.is_none() && query.technical.is_none()
                        || event.evidence.iter().any(|item| {
                            query
                                .tier
                                .as_ref()
                                .is_none_or(|tier| &item.source_tier == tier)
                                && query.technical.is_none_or(|technical| {
                                    item.technical_basis.is_some() == technical
                                })
                                && query.source.is_none_or(|id| {
                                    state.sources.iter().any(|source| {
                                        source.id == id && source.name == item.source_name
                                    })
                                })
                        }))
                    && query
                        .opened
                        .is_none_or(|opened| (event.opened && event.seen) == opened)
                    && query.hours.filter(|hours| *hours > 0).is_none_or(|hours| {
                        event.published_at.is_some_and(|date| {
                            date >= query.as_of.unwrap_or_else(Utc::now) - Duration::hours(hours)
                                && date <= query.as_of.unwrap_or_else(Utc::now)
                        })
                    })
                    && query.saved.is_none_or(|saved| event.saved == saved)
                    && query.read.is_none_or(|read| event.read == read)
                    && query.later.is_none_or(|later| event.later == later)
                    && (q.is_empty()
                        || event.title.to_lowercase().contains(&q)
                        || event
                            .display_title
                            .as_ref()
                            .is_some_and(|title| title.to_lowercase().contains(&q))
                        || event.summary.to_lowercase().contains(&q)
                        || event
                            .topics
                            .iter()
                            .any(|topic| topic.to_lowercase().contains(&q)))
            })
            .collect();
        for event in &mut items {
            (event.personal_relevance, event.personal_reason) = crate::reader::relevance(
                event,
                query
                    .interests
                    .as_ref()
                    .map_or(state.topics.as_slice(), VisitorInterests::topics),
            );
        }
        if query.sort.as_deref() == Some("newest") {
            items.sort_by(|a, b| b.published_at.cmp(&a.published_at).then(a.id.cmp(&b.id)));
        } else if query.sort.as_deref() == Some("score") {
            items.sort_by(|a, b| {
                b.score
                    .total
                    .total_cmp(&a.score.total)
                    .then(b.published_at.cmp(&a.published_at))
                    .then(a.id.cmp(&b.id))
            });
        } else {
            crate::reader::sort_candidates(&mut items, query.as_of.unwrap_or_else(Utc::now));
        }
        if query.coverage.unwrap_or(false) {
            items = crate::coverage::rollup_events(items, query.as_of.unwrap_or_else(Utc::now));
        }
        Ok(items
            .into_iter()
            .skip(query.offset.unwrap_or(0) as usize)
            .take(query.limit.unwrap_or(50) as usize)
            .collect())
    }

    async fn visitor_event(&self, id: Uuid, interests: &VisitorInterests) -> Result<Option<Event>> {
        let state = self.state.read().await;
        let mut events = state.events.clone();
        for event in &mut events {
            Self::apply_visitor(event, interests);
        }
        let mut event = events.iter().find(|event| event.id == id).cloned();
        if let Some(event) = &mut event {
            let records: Vec<_> = events
                .iter()
                .map(crate::coverage::Record::from_event)
                .collect();
            if let Some(group) = crate::coverage::groups(&records, &[id], Utc::now())
                .into_iter()
                .next()
            {
                crate::coverage::apply(event, group.bundle);
            }
        }
        Ok(event)
    }

    async fn get_event(&self, id: Uuid) -> Result<Option<Event>> {
        let state = self.state.read().await;
        let mut event = state.events.iter().find(|event| event.id == id).cloned();
        if let Some(event) = &mut event {
            (event.personal_relevance, event.personal_reason) =
                crate::reader::relevance(event, &state.topics);
            let records: Vec<_> = state
                .events
                .iter()
                .filter(|e| !e.not_interested)
                .map(crate::coverage::Record::from_event)
                .collect();
            if let Some(group) = crate::coverage::groups(&records, &[id], Utc::now())
                .into_iter()
                .next()
            {
                crate::coverage::apply(event, group.bundle);
            }
        }
        Ok(event)
    }

    async fn update_event_state(&self, id: Uuid, input: EventStateInput) -> Result<Option<Event>> {
        let mut state = self.state.write().await;
        let Some(event) = state.events.iter_mut().find(|event| event.id == id) else {
            return Ok(None);
        };
        if let Some(saved) = input.saved {
            event.saved = saved;
        }
        if let Some(read) = input.read {
            event.read = read;
        }
        if let Some(later) = input.later {
            event.later = later;
        }
        if let Some(value) = input.not_interested {
            event.not_interested = value;
            event.not_interested_reason = if value {
                input.not_interested_reason
            } else {
                None
            };
            if value {
                event.saved = false;
            }
        }
        if input.saved == Some(true) {
            event.not_interested = false;
            event.not_interested_reason = None;
        }
        if input.opened == Some(true) {
            event.opened = true;
            event.seen = true;
        }
        Ok(Some(event.clone()))
    }

    async fn record_exposures(&self, items: Vec<crate::models::Exposure>) -> Result<u64> {
        let mut state = self.state.write().await;
        let mut count = 0;
        for item in items {
            if let Some(event) = state
                .events
                .iter_mut()
                .find(|e| e.id == item.event_id && e.content_version == item.content_version)
            {
                event.seen = true;
                count += 1;
            }
        }
        Ok(count)
    }

    async fn latest_brief(&self) -> Result<DailyBrief> {
        let mut events = self.state.read().await.events.clone();
        events.retain(|e| crate::reader::brief_qualified(e, Utc::now()));
        crate::reader::sort_candidates(&mut events, Utc::now());
        Ok(crate::reader::select_brief(
            crate::coverage::rollup_events(events, Utc::now()),
            Utc::now(),
        ))
    }

    async fn visitor_brief(
        &self,
        cutoff: DateTime<Utc>,
        interests: &VisitorInterests,
    ) -> Result<DailyBrief> {
        let mut events = self.state.read().await.events.clone();
        for event in &mut events {
            Self::apply_visitor(event, interests);
        }
        events.retain(|event| crate::reader::brief_qualified(event, cutoff));
        crate::reader::sort_candidates(&mut events, cutoff);
        Ok(crate::reader::select_brief(
            crate::coverage::rollup_events(events, cutoff),
            cutoff,
        ))
    }
    async fn brief(&self, date: NaiveDate, persist: bool) -> Result<Option<DailyBrief>> {
        let mut state = self.state.write().await;
        if let Some(brief) = state.briefs.get(&date) {
            let mut brief = brief.clone();
            for item in &mut brief.items {
                if let Some(current) = state.events.iter().find(|event| event.id == item.id) {
                    item.saved = current.saved;
                    item.read = current.read;
                    item.later = current.later;
                    item.not_interested = current.not_interested;
                    item.not_interested_reason = current.not_interested_reason;
                }
            }
            brief.items.retain(|item| !item.not_interested);
            brief.items =
                crate::coverage::rollup_release_snapshots(brief.items, brief.generated_at);
            for section in &mut brief.sections {
                section
                    .event_ids
                    .retain(|id| brief.items.iter().any(|e| e.id == *id));
            }
            brief.sections.retain(|s| !s.event_ids.is_empty());
            return Ok(Some(brief));
        }
        if date != crate::reader::local_date(Utc::now()) {
            return Ok(None);
        }
        let mut events = state.events.clone();
        events.retain(|e| crate::reader::brief_qualified(e, Utc::now()));
        crate::reader::sort_candidates(&mut events, Utc::now());
        let mut brief = crate::reader::select_brief(
            crate::coverage::rollup_events(events, Utc::now()),
            Utc::now(),
        );
        if persist {
            brief.is_snapshot = true;
            state.briefs.insert(date, brief.clone());
        }
        Ok(Some(brief))
    }

    async fn brief_history(&self) -> Result<Vec<BriefHistory>> {
        let state = self.state.read().await;
        let mut items: Vec<_> = state
            .briefs
            .iter()
            .map(|(date, brief)| BriefHistory {
                local_date: *date,
                generated_at: brief.generated_at,
                item_count: brief.items.len() as i64,
            })
            .collect();
        items.sort_by(|a, b| b.local_date.cmp(&a.local_date));
        Ok(items)
    }

    async fn topics(&self) -> Result<Vec<Topic>> {
        Ok(self.state.read().await.topics.clone())
    }

    async fn replace_topics(&self, topics: Vec<Topic>) -> Result<Vec<Topic>> {
        self.state.write().await.topics = topics.clone();
        Ok(topics)
    }

    async fn sources(&self) -> Result<Vec<Source>> {
        Ok(self.state.read().await.sources.clone())
    }

    async fn create_source(&self, _input: SourceInput) -> Result<Source> {
        anyhow::bail!("Demo mode cannot manage real sources")
    }
    async fn update_source(&self, _id: Uuid, _input: SourceUpdate) -> Result<Option<Source>> {
        anyhow::bail!("Demo mode cannot manage real sources")
    }
    async fn save_summary(
        &self,
        _id: Uuid,
        _summary: GeneratedSummary,
        _model: &str,
        _expected_version: i64,
        _reasoning_effort: Option<&str>,
    ) -> Result<Option<Event>> {
        anyhow::bail!("Demo mode cannot generate real summaries")
    }
    async fn summary_attempts(&self) -> Result<i64> {
        anyhow::bail!("Demo mode does not use Copilot")
    }
    async fn record_summary_attempt(
        &self,
        _id: Uuid,
        _model: &str,
        _automatic: bool,
    ) -> Result<()> {
        anyhow::bail!("Demo mode does not use Copilot")
    }
    async fn provider_auth_mode(&self) -> Result<String> {
        Ok(self.state.read().await.provider_auth_mode.clone())
    }
    async fn set_provider_auth_mode(&self, mode: &str) -> Result<()> {
        self.state.write().await.provider_auth_mode = mode.to_owned();
        Ok(())
    }
}

fn score(total: f32, explanation: &str) -> ScoreBreakdown {
    ScoreBreakdown {
        source_quality: 94.0,
        corroboration: 72.0,
        freshness: 88.0,
        relevance: 96.0,
        novelty: 84.0,
        engagement: 58.0,
        editorial_boost: 0.0,
        total,
        explanation: explanation.into(),
    }
}

fn evidence(
    source: &str,
    tier: &str,
    title: &str,
    url: &str,
    official: bool,
    hours: i64,
) -> Evidence {
    Evidence {
        id: Uuid::new_v4(),
        source_name: source.into(),
        source_tier: tier.into(),
        title: title.into(),
        url: url.into(),
        is_official: official,
        published_at: Utc::now() - Duration::hours(hours),
        original_published_at: Some(Utc::now() - Duration::hours(hours)),
        publication_precision: Some("time".into()),
        collected_at: Some(Utc::now() - Duration::hours(hours)),
        excerpt: "演示样本，不代表实际新闻或原文内容。".into(),
        technical_basis: Some("演示技术条目，不代表真实分类".into()),
        aggregation: None,
        reading_context: None,
    }
}

fn event(
    title: &str,
    summary: &str,
    importance: &str,
    topic: &str,
    topics: &[&str],
    kind: &str,
    total: f32,
    reason: &str,
    evidence: Vec<Evidence>,
    hours: i64,
) -> Event {
    Event {
        editorial: Some(crate::models::Editorial {
            policy_version: "demo-article-value-v1".into(),
            content_kind: match kind {
                "paper" => "research",
                "model" | "repository" => "metadata",
                "release" => "release",
                "discussion" => "discussion",
                _ => "analysis",
            }
            .into(),
            value_score: if matches!(kind, "model" | "repository") {
                0.0
            } else {
                75.0
            },
            reason: "演示选文规则样本，不代表真实文章分类或价值判断。".into(),
            brief_eligible: !matches!(kind, "model" | "repository"),
            significance: None,
            source_role: None,
            significance_basis: None,
        }),
        display_title: None,
        not_interested_reason: None,
        editorial_publishers: vec![],
        editorial_community: false,
        coverage: None,
        id: Uuid::new_v4(),
        title: title.into(),
        summary: summary.into(),
        importance: importance.into(),
        primary_topic: crate::reader::topic_alias(topic).into(),
        topics: topics
            .iter()
            .map(|value| crate::reader::topic_alias(value).to_string())
            .collect(),
        event_type: kind.into(),
        first_seen_at: Utc::now() - Duration::hours(hours),
        updated_at: Utc::now() - Duration::hours(hours / 2),
        published_at: Some(Utc::now() - Duration::hours(hours / 2)),
        publication_precision: Some("time".into()),
        collected_at: Some(Utc::now() - Duration::hours(hours / 2)),
        evidence,
        score: score(total, reason),
        personal_relevance: if topics.contains(&"Microsoft Agent Framework") {
            98.0
        } else {
            88.0
        },
        personal_reason: format!("你的长期兴趣：{}", topic),
        saved: false,
        read: false,
        later: false,
        summary_kind: "demo".into(),
        summary_model: None,
        summarized_at: None,
        summary_evidence_ids: vec![],
        content_version: 0,
        summary_status: None,
        summary_error: None,
        summary_next_attempt_at: None,
        summary_format_version: 2,
        freshness_at: None,
        summary_points: vec![],
        summary_material_limit: None,
        summary_limitations: vec![],
        summary_reasoning_effort: None,
        not_interested: false,
        seen: false,
        opened: false,
        recommendation: None,
    }
}

fn seed_state() -> MemoryState {
    let events = vec![
        event(
            "Microsoft Agent Framework 发布新的稳定版本",
            "框架更新了 Agent 编排、Memory 与工具调用能力，并给出迁移说明。",
            "它直接影响当前 Agent 项目的依赖选择和升级计划。",
            "Agent",
            &["Agent", "Memory", "Microsoft Agent Framework"],
            "release",
            91.0,
            "官方 Release · 当前项目高相关 · 近 4 小时",
            vec![evidence(
                "Microsoft Agent Framework",
                "T1",
                "GitHub Release",
                "https://github.com/microsoft/agent-framework/releases",
                true,
                4,
            )],
            4,
        ),
        event(
            "开源模型生态出现高关注模型更新",
            "Hugging Face 上的模型 revision、许可与下载趋势发生显著变化，已进入观察候选。",
            "这可能影响本地推理与开放权重模型的技术选型。",
            "开源模型",
            &["开源模型", "Hugging Face", "推理"],
            "model",
            84.0,
            "模型仓库更新 · Trending 快照 · 待多源核验",
            vec![evidence(
                "Hugging Face",
                "T1",
                "Model repository",
                "https://huggingface.co/models",
                true,
                7,
            )],
            7,
        ),
        event(
            "Agent Memory 研究发布新的评测方法",
            "一篇新论文提出长期 Agent Memory 的任务集和可复现实验设置。",
            "它将记忆能力从产品描述推进到可比较的工程指标。",
            "Memory",
            &["Agent", "Memory", "Paper"],
            "paper",
            82.0,
            "arXiv 原文 · 与长期兴趣匹配 · 新评测",
            vec![evidence(
                "arXiv",
                "T1",
                "Agent Memory evaluation paper",
                "https://arxiv.org/",
                true,
                10,
            )],
            10,
        ),
        event(
            "Rust 生态发布语言与工具链进展",
            "Rust 官方渠道汇总 compiler、Cargo 与生态工具更新。",
            "对以 Rust 构建 ScoutNews 后端的兼容性和工程实践有直接影响。",
            "Rust",
            &["Rust", "编程语言", "Developer"],
            "release",
            78.0,
            "官方 Feed · 工作技术栈相关",
            vec![evidence(
                "Rust Blog",
                "T1",
                "Rust language update",
                "https://blog.rust-lang.org/",
                true,
                13,
            )],
            13,
        ),
        event(
            "AI 创业者长访谈发布",
            "中文商业访谈节目发布了与 AI 公司创始人的长对谈，讨论产品路径与组织判断。",
            "Podcast 提供了公告和短新闻难以覆盖的决策背景。",
            "Podcast",
            &["Podcast", "Founder", "AI 产品"],
            "podcast",
            75.0,
            "节目官方 Feed · 创始人访谈 · 中文信号",
            vec![evidence(
                "张小珺Jùn｜商业访谈录",
                "T1.5",
                "最新一期节目",
                "https://www.listennotes.com/podcasts/%E5%BC%A0%E5%B0%8F%E7%8F%BAj%C3%B9n%E5%95%86%E4%B8%9A%E8%AE%BF%E8%B0%88%E5%BD%95-%E5%BC%A0%E5%B0%8F%E7%8F%BA-ROQVaAvwFhB/",
                true,
                18,
            )],
            18,
        ),
    ];
    let topics = vec![
        Topic {
            id: "agent".into(),
            label: "Agent".into(),
            group: "长期兴趣".into(),
            weight: 100,
            context: "long_term".into(),
            enabled: true,
        },
        Topic {
            id: "memory".into(),
            label: "Memory".into(),
            group: "长期兴趣".into(),
            weight: 95,
            context: "long_term".into(),
            enabled: true,
        },
        Topic {
            id: "maf".into(),
            label: "Microsoft Agent Framework".into(),
            group: "当前项目".into(),
            weight: 100,
            context: "current_project".into(),
            enabled: true,
        },
        Topic {
            id: "rust".into(),
            label: "Rust".into(),
            group: "工作领域".into(),
            weight: 90,
            context: "work".into(),
            enabled: true,
        },
        Topic {
            id: "open-models".into(),
            label: "开源模型".into(),
            group: "长期兴趣".into(),
            weight: 90,
            context: "long_term".into(),
            enabled: true,
        },
        Topic {
            id: "hci".into(),
            label: "HCI".into(),
            group: "邻接领域".into(),
            weight: 65,
            context: "long_term".into(),
            enabled: true,
        },
        Topic {
            id: "context".into(),
            label: "Context".into(),
            group: "Agent 工程".into(),
            weight: 90,
            context: "long_term".into(),
            enabled: true,
        },
        Topic {
            id: "mcp-a2a".into(),
            label: "MCP / A2A".into(),
            group: "Agent 工程".into(),
            weight: 90,
            context: "long_term".into(),
            enabled: true,
        },
        Topic {
            id: "ai-coding".into(),
            label: "AI Coding".into(),
            group: "Developer".into(),
            weight: 90,
            context: "work".into(),
            enabled: true,
        },
        Topic {
            id: "languages".into(),
            label: "编程语言".into(),
            group: "Developer".into(),
            weight: 75,
            context: "work".into(),
            enabled: true,
        },
        Topic {
            id: "psychology".into(),
            label: "心理学".into(),
            group: "邻接领域".into(),
            weight: 55,
            context: "long_term".into(),
            enabled: true,
        },
        Topic {
            id: "design".into(),
            label: "Design".into(),
            group: "邻接领域".into(),
            weight: 60,
            context: "long_term".into(),
            enabled: true,
        },
        Topic {
            id: "podcast".into(),
            label: "中文 / 英文 Podcast".into(),
            group: "内容形态".into(),
            weight: 75,
            context: "long_term".into(),
            enabled: true,
        },
        Topic {
            id: "founder".into(),
            label: "AI 公司创始人访谈".into(),
            group: "内容形态".into(),
            weight: 85,
            context: "long_term".into(),
            enabled: true,
        },
    ];
    let source = |name: &str,
                  publisher: &str,
                  content: &str,
                  adapter: &str,
                  endpoint: &str,
                  tier: &str,
                  topics: &[&str],
                  minutes: i32| Source {
        id: Uuid::new_v4(),
        name: name.into(),
        publisher: publisher.into(),
        content_type: content.into(),
        adapter: adapter.into(),
        endpoint: endpoint.into(),
        tier: tier.into(),
        lifecycle_status: "stable".into(),
        topics: topics.iter().map(|v| v.to_string()).collect(),
        last_success_at: Some(Utc::now() - Duration::minutes(8)),
        schedule_minutes: minutes,
        consecutive_failures: 0,
        last_error: None,
    };
    let sources = vec![
        source(
            "OpenAI News",
            "OpenAI",
            "blog",
            "rss",
            "https://openai.com/news/rss.xml",
            "T1",
            &["AGI", "Agent"],
            30,
        ),
        source(
            "Google DeepMind",
            "Google DeepMind",
            "blog",
            "rss",
            "https://deepmind.google/blog/rss.xml",
            "T1",
            &["AGI", "Paper"],
            30,
        ),
        source(
            "Agent Framework Releases",
            "Microsoft",
            "release",
            "github_release_atom",
            "https://github.com/microsoft/agent-framework/releases.atom",
            "T1",
            &["Agent", "Microsoft Agent Framework"],
            15,
        ),
        source(
            "Rust Blog",
            "Rust Project",
            "blog",
            "rss",
            "https://blog.rust-lang.org/feed.xml",
            "T1",
            &["Rust"],
            60,
        ),
        source(
            "Agent papers",
            "arXiv",
            "paper",
            "arxiv",
            "cat:cs.AI AND all:agent",
            "T1",
            &["Agent", "Memory"],
            720,
        ),
        source(
            "张小珺Jùn｜商业访谈录",
            "张小珺",
            "podcast",
            "podcast_rss",
            "discovered-via-listen-notes",
            "T1.5",
            &["Podcast", "Founder"],
            120,
        ),
    ];
    MemoryState {
        events,
        topics,
        sources,
        briefs: HashMap::new(),
        provider_auth_mode: "local".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn searches_reading_title_without_replacing_original_identity() {
        let store = MemoryStore::demo();
        let (id, original);
        {
            let mut state = store.state.write().await;
            let event = &mut state.events[0];
            id = event.id;
            original = event.title.clone();
            event.display_title = Some("独立中文阅读标题".into());
        }
        let items = store
            .list_events(&EventQuery {
                q: Some("独立中文阅读标题".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, id);
        assert_eq!(items[0].title, original);
    }

    #[tokio::test]
    async fn engineering_artifacts_require_opt_in_except_saved_items() {
        let store = MemoryStore::demo();
        let artifact_id;
        {
            let mut state = store.state.write().await;
            let artifact = &mut state.events[0];
            artifact.event_type = "release".into();
            artifact.title = "handoff-runtime-59939c003f6b3eb8add709e5897f7bfbe3e9f4d8".into();
            artifact_id = artifact.id;
        }

        assert!(
            !store
                .list_events(&EventQuery::default())
                .await
                .unwrap()
                .iter()
                .any(|event| event.id == artifact_id)
        );
        assert!(
            store
                .list_events(&EventQuery {
                    include_engineering: Some(true),
                    ..Default::default()
                })
                .await
                .unwrap()
                .iter()
                .any(|event| event.id == artifact_id)
        );

        {
            let mut state = store.state.write().await;
            state
                .events
                .iter_mut()
                .find(|event| event.id == artifact_id)
                .unwrap()
                .saved = true;
        }
        assert!(
            store
                .list_events(&EventQuery {
                    saved: Some(true),
                    ..Default::default()
                })
                .await
                .unwrap()
                .iter()
                .any(|event| event.id == artifact_id)
        );
        {
            let mut state = store.state.write().await;
            let artifact = state
                .events
                .iter_mut()
                .find(|event| event.id == artifact_id)
                .unwrap();
            artifact.saved = false;
            artifact.not_interested = true;
        }
        assert!(
            store
                .list_events(&EventQuery {
                    not_interested: Some(true),
                    ..Default::default()
                })
                .await
                .unwrap()
                .iter()
                .any(|event| event.id == artifact_id)
        );
        assert_eq!(
            store.get_event(artifact_id).await.unwrap().unwrap().id,
            artifact_id
        );
    }
}
