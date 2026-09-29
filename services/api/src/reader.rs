use chrono::{DateTime, Duration, NaiveDate, Utc};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

use crate::models::{BriefSection, DailyBrief, Event, Evidence, Topic};

pub const DAILY_SELECTION_RULE: &str = "editorial-significance-v1-ranked-v2";
const ESSENTIAL_COUNT: usize = 5;
const CATCH_UP_LIMIT: usize = 3;
const STORY_WINDOW_HOURS: i64 = 96;
const MODEL_FAMILIES: &[&str] = &[
    "chatgpt", "gpt", "claude", "opus", "sonnet", "haiku", "gemini", "gemma", "llama", "grok",
    "mistral", "mixtral", "deepseek", "qwen", "kimi", "glm", "minimax", "mimo", "phi", "sora",
    "veo", "imagen",
];

pub fn topic_alias(label: &str) -> &str {
    match label.to_ascii_lowercase().as_str() {
        "agent" | "microsoft agent framework" => "Agent 与工具",
        "memory" | "rag" => "记忆与检索",
        "ai coding" => "AI 编程",
        "rust" | "推理" => "工程与开源",
        "开源模型" => "模型与多模态",
        "hardware" => "芯片与硬件",
        "industry" => "产业与商业",
        "governance" => "治理与政策",
        _ => label,
    }
}

pub fn publication_context(evidence: &[Evidence]) -> (Option<DateTime<Utc>>, Option<String>) {
    let published_at = evidence
        .iter()
        .filter_map(|item| item.original_published_at)
        .max();
    let precision = published_at.map(|date| {
        if evidence
            .iter()
            .filter(|item| item.original_published_at == Some(date))
            .all(|item| item.publication_precision.as_deref() == Some("day"))
        {
            "day"
        } else {
            "time"
        }
        .to_owned()
    });
    (published_at, precision)
}

pub fn local_date(now: DateTime<Utc>) -> NaiveDate {
    (now + Duration::hours(8)).date_naive()
}

pub fn relevance(event: &Event, topics: &[Topic]) -> (f32, String) {
    let matched = topics
        .iter()
        .filter(|topic| {
            topic.enabled
                && event
                    .topics
                    .iter()
                    .chain(std::iter::once(&event.primary_topic))
                    .any(|label| topic_alias(label).eq_ignore_ascii_case(topic_alias(&topic.label)))
        })
        .max_by_key(|topic| topic.weight);
    match matched {
        Some(topic) => (
            topic.weight as f32,
            format!("显式兴趣：{} · 权重 {}", topic.label, topic.weight),
        ),
        None => (0.0, "未匹配已启用的兴趣；不影响全局热点排序".into()),
    }
}

pub fn select_brief(events: Vec<Event>, now: DateTime<Utc>) -> DailyBrief {
    select_brief_limit(events, now, 20)
}

pub fn select_brief_limit(events: Vec<Event>, now: DateTime<Utc>, limit: usize) -> DailyBrief {
    select_daily(events, now, limit, &HashSet::new())
}

/// `featured` holds events already chosen by earlier saved editions; they never
/// return as catch-up reading.
pub fn select_daily(
    events: Vec<Event>,
    now: DateTime<Utc>,
    limit: usize,
    featured: &HashSet<Uuid>,
) -> DailyBrief {
    select_edition(events, now, limit, false, featured)
}

pub fn select_weekly(events: Vec<Event>, now: DateTime<Utc>, limit: usize) -> DailyBrief {
    select_edition(events, now, limit, true, &HashSet::new())
}

/// Same-story key for a named model version, e.g. "GPT-6 Sol" and "用 GPT‑6 写代码"
/// both give `gpt6`, "Claude Opus 5.5" gives `opus5.5`. Titles without a named
/// model version have no key; there is deliberately no fuzzy topic matching.
pub fn model_story_key(title: &str) -> Option<String> {
    let text: Vec<char> = title
        .to_lowercase()
        .chars()
        .map(|c| match c {
            '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
            _ => c,
        })
        .collect();
    for start in 0..text.len() {
        if start > 0 && text[start - 1].is_ascii_alphanumeric() {
            continue;
        }
        for family in MODEL_FAMILIES {
            let name: Vec<char> = family.chars().collect();
            if !text[start..].starts_with(&name) {
                continue;
            }
            let mut at = start + name.len();
            if matches!(text.get(at), Some('-' | ' ')) {
                at += 1;
            }
            if text.get(at) == Some(&'v') {
                at += 1;
            }
            let digits = at;
            while text.get(at).is_some_and(char::is_ascii_digit) {
                at += 1;
            }
            if at == digits {
                continue;
            }
            let mut version: String = text[digits..at].iter().collect();
            if text.get(at) == Some(&'.') && text.get(at + 1).is_some_and(char::is_ascii_digit) {
                let minor = at + 1;
                let mut end = minor;
                while text.get(end).is_some_and(char::is_ascii_digit) {
                    end += 1;
                }
                let minor: String = text[minor..end].iter().collect();
                if minor.trim_start_matches('0').is_empty() {
                    // "GPT-6.0" is the same model as "GPT-6".
                } else {
                    version = format!("{version}.{minor}");
                }
            }
            let family = if *family == "chatgpt" { "gpt" } else { family };
            return Some(format!("{family}{version}"));
        }
    }
    None
}

fn story_key(event: &Event) -> Option<String> {
    model_story_key(&event.title)
        .or_else(|| event.display_title.as_deref().and_then(model_story_key))
}

fn source_role(event: &Event) -> &str {
    match event
        .editorial
        .as_ref()
        .and_then(|p| p.source_role.as_deref())
    {
        Some(role) => role,
        None if community(event) => "community",
        None => "unknown",
    }
}

fn catch_up_worthy(event: &Event) -> bool {
    event
        .editorial
        .as_ref()
        .is_some_and(|policy| match policy.significance {
            Some(significance) => significance >= 60.0 && policy.value_score >= 70.0,
            // Legacy/demo material without significance keeps the article-value-v1 bar.
            None => policy.value_score >= 68.0,
        })
}

struct Quotas {
    publisher: usize,
    community: usize,
    index: usize,
    podcast: usize,
    topic: usize,
}

#[derive(Default)]
struct Selection {
    items: Vec<Event>,
    publishers: HashMap<String, usize>,
    topics: HashMap<String, usize>,
    community: usize,
    index: usize,
    podcast: usize,
    stories: Vec<(String, Option<DateTime<Utc>>)>,
}

impl Selection {
    fn repeats_story(&self, event: &Event, key: Option<&str>) -> bool {
        let Some(key) = key else {
            return false;
        };
        // Official follow-ups (pricing, caching, system cards) are separate news.
        if source_role(event) == "first_party" {
            return false;
        }
        let at = event.freshness_at.or(event.published_at);
        self.stories.iter().any(|(picked, when)| {
            picked == key
                && match (at, when) {
                    (Some(at), Some(when)) => (at - *when).num_hours().abs() <= STORY_WINDOW_HOURS,
                    _ => true,
                }
        })
    }

    /// Greedy admission in rank order; later sections never relax a quota.
    fn admit(&mut self, event: &Event, quotas: &Quotas) -> bool {
        if self.items.iter().any(|picked| picked.id == event.id) {
            return false;
        }
        let keys = publishers(event);
        let role = source_role(event);
        let is_community = community(event);
        let story = story_key(event);
        if keys
            .iter()
            .any(|key| self.publishers.get(key).copied().unwrap_or(0) >= quotas.publisher)
            || is_community && self.community >= quotas.community
            || role == "index" && self.index >= quotas.index
            || role == "podcast" && self.podcast >= quotas.podcast
            || self.topics.get(&event.primary_topic).copied().unwrap_or(0) >= quotas.topic
            || self.repeats_story(event, story.as_deref())
        {
            return false;
        }
        for key in keys {
            *self.publishers.entry(key).or_default() += 1;
        }
        *self.topics.entry(event.primary_topic.clone()).or_default() += 1;
        self.community += usize::from(is_community);
        self.index += usize::from(role == "index");
        self.podcast += usize::from(role == "podcast");
        if let Some(story) = story {
            self.stories
                .push((story, event.freshness_at.or(event.published_at)));
        }
        self.items.push(event.clone());
        true
    }
}

pub fn is_opaque_engineering_release(event: &Event) -> bool {
    if event.event_type != "release" {
        return false;
    }
    let title = event.title.trim().to_ascii_lowercase();
    if title.len() < 1
        || !title
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return false;
    }
    let parts: Vec<_> = title.split(['-', '_']).collect();
    if parts.iter().any(|part| part.is_empty()) {
        return false;
    }
    let Some(last) = parts.last() else {
        return false;
    };
    let opaque_sha = |value: &str| {
        (12..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    };
    if opaque_sha(&title) {
        return true;
    }
    let marker = parts
        .iter()
        .any(|part| matches!(*part, "handoff" | "runtime" | "build" | "ci" | "nightly"));
    let starts_marker = parts
        .first()
        .is_some_and(|part| matches!(*part, "handoff" | "runtime" | "build" | "ci" | "nightly"));
    (marker && opaque_sha(last))
        || (parts.len() == 2
            && starts_marker
            && last.len() >= 5
            && last.bytes().all(|byte| byte.is_ascii_digit()))
}

pub fn brief_qualified(event: &Event, now: DateTime<Utc>) -> bool {
    let start = now - Duration::days(7);
    !event.not_interested
        && event
            .editorial
            .as_ref()
            .is_some_and(|policy| policy.brief_eligible)
        && event.event_type != "repository"
        && !is_opaque_engineering_release(event)
        && event
            .freshness_at
            .or(event.published_at)
            .is_some_and(|date| date >= start && date <= now)
        && event.evidence.iter().all(|item| item.aggregation.is_none())
        && event.evidence.iter().any(|item| {
            item.original_published_at
                .is_some_and(|date| date >= start && date <= now)
        })
}

fn publishers(event: &Event) -> Vec<String> {
    if !event.editorial_publishers.is_empty() {
        return event.editorial_publishers.clone();
    }
    let mut keys: Vec<_> = event
        .evidence
        .iter()
        .map(|item| {
            crate::processing::publisher_domain(&item.url)
                .unwrap_or_else(|| item.source_name.clone())
        })
        .collect();
    keys.sort();
    keys.dedup();
    if keys.is_empty() {
        keys.push(format!("unknown:{}", event.id));
    }
    keys
}

fn community(event: &Event) -> bool {
    event.editorial_community
        || event.evidence.iter().all(|e| {
            url::Url::parse(&e.url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_owned))
                .is_some_and(|host| {
                    host == "reddit.com"
                        || host.ends_with(".reddit.com")
                        || host == "news.ycombinator.com"
                })
        })
}

fn select_edition(
    mut events: Vec<Event>,
    now: DateTime<Utc>,
    limit: usize,
    weekly: bool,
    featured: &HashSet<Uuid>,
) -> DailyBrief {
    let start = now - Duration::days(7);
    let main_start = now - Duration::hours(24);
    events.retain(|event| brief_qualified(event, now));
    if weekly {
        for event in &mut events {
            // The SQL weekly mode already has zero repetition. This also makes
            // selection safe when called with a daily-ranked in-memory fixture.
            if let Some(rank) = &mut event.recommendation {
                rank.score += rank.novelty_penalty;
                rank.novelty_penalty = 0.0;
            }
        }
    }
    sort_candidates(&mut events, now);
    let quotas = Quotas {
        publisher: if weekly { 3 } else { 2 },
        community: 2,
        index: 2,
        podcast: 3,
        topic: 5,
    };
    let mut selection = Selection::default();
    let mut sections = Vec::new();
    if weekly {
        for event in &events {
            if selection.items.len() >= limit {
                break;
            }
            selection.admit(event, &quotas);
        }
        let mut ordered: Vec<Event> = Vec::new();
        for event in &selection.items {
            if sections
                .iter()
                .any(|s: &BriefSection| s.title == event.primary_topic)
            {
                continue;
            }
            let items: Vec<_> = selection
                .items
                .iter()
                .filter(|e| e.primary_topic == event.primary_topic)
                .cloned()
                .collect();
            sections.push(BriefSection {
                key: format!("topic-{}", sections.len()),
                kind: "topic".into(),
                title: event.primary_topic.clone(),
                description: "本周这一主题下值得回顾的进展。".into(),
                event_ids: items.iter().map(|e| e.id).collect(),
            });
            ordered.extend(items);
        }
        selection.items = ordered;
    } else {
        let fresh = |event: &Event| {
            event
                .freshness_at
                .or(event.published_at)
                .is_some_and(|at| at >= main_start)
        };
        // The main list is one strictly ranked pool: no same-day reservations and
        // no section may promote a lower-ranked item above a higher-ranked one.
        let mut main = Vec::new();
        for event in events.iter().filter(|event| fresh(event)) {
            if selection.items.len() >= limit {
                break;
            }
            if selection.admit(event, &quotas) {
                main.push(event.id);
            }
        }
        let mut catch_up = Vec::new();
        for event in events.iter().filter(|event| !fresh(event)) {
            if catch_up.len() >= CATCH_UP_LIMIT || selection.items.len() >= limit {
                break;
            }
            if featured.contains(&event.id) || !catch_up_worthy(event) {
                continue;
            }
            if selection.admit(event, &quotas) {
                catch_up.push(event.id);
            }
        }
        let more = main.split_off(main.len().min(ESSENTIAL_COUNT));
        for (key, title, description, event_ids) in [
            (
                "essential",
                "今日重点",
                "选文截止前 24 小时内价值最高的内容",
                main,
            ),
            ("more", "更多值得读", "同一时段内其余值得读的内容", more),
            (
                "catch_up",
                "值得补读",
                "过去 7 天发布、此前未入选的高价值内容",
                catch_up,
            ),
        ] {
            if !event_ids.is_empty() {
                sections.push(BriefSection {
                    key: key.into(),
                    kind: key.into(),
                    title: title.into(),
                    description: description.into(),
                    event_ids,
                });
            }
        }
    }
    let selected = selection.items;
    DailyBrief {
        sections,
        local_date: local_date(now).to_string(),
        generated_at: now,
        estimated_minutes: (selected.len() as i32 + 1) / 2,
        items: selected,
        is_snapshot: false,
        window_start: start,
        window_end: now,
        primary_window_start: (!weekly).then_some(main_start),
        selection_note: Some(format!(
            "editorial-significance-v1 确定性规则选文，不是 AI 核验的重要性。综合分 = 事件重要性35% + 原文价值20% + 显式兴趣15% + 分类型时效15% + 来源质量10% + 主动反馈5%；重要性来自发布者角色、内容类型、明确发布动作与多家独立报道。每发布者最多{}篇、社区最多2篇、论文索引最多2篇、播客最多3篇、每主题最多5篇；同一模型版本的二手报道只保留排名最高的一篇，第一方后续公告除外。目标最多{limit}篇，合格内容不足时宁缺毋滥。{}",
            quotas.publisher,
            if weekly {
                "周报使用7日时效尺度，不计重复曝光；历史日期回顾不冒充当时存档。"
            } else {
                "主列表只收截止前24小时的合格内容，严格按综合分从高到低；前5篇为今日重点。补读最多3篇，只收过去7天内未入选往期精选的高价值内容。打开/曝光仅有衰减小幅降权。"
            }
        )),
        eligibility: None,
        next_refresh_at: None,
        refresh_pending: false,
    }
}
pub fn sort_candidates(events: &mut [Event], _now: DateTime<Utc>) {
    events.sort_by(|a, b| {
        b.recommendation
            .as_ref()
            .map(|r| r.score)
            .unwrap_or(b.score.total)
            .total_cmp(
                &a.recommendation
                    .as_ref()
                    .map(|r| r.score)
                    .unwrap_or(a.score.total),
            )
            .then(b.published_at.cmp(&a.published_at))
            .then(a.id.cmp(&b.id))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        models::EventQuery,
        store::{MemoryStore, Store},
    };

    #[test]
    fn shanghai_date_crosses_utc_midnight() {
        let now = "2026-09-06T17:00:00Z".parse().unwrap();
        assert_eq!(local_date(now).to_string(), "2026-09-07");
    }

    #[tokio::test]
    async fn brief_filters_old_and_future_events() {
        let mut events = MemoryStore::demo()
            .list_events(&EventQuery::default())
            .await
            .unwrap();
        let now = Utc::now();
        events[0].published_at = Some(now - Duration::days(8));
        events[1].published_at = Some(now + Duration::hours(1));
        assert_eq!(select_brief(events, now).items.len(), 3);
    }

    #[tokio::test]
    async fn brief_supplements_recent_days_without_displacing_today() {
        let mut events = MemoryStore::demo()
            .list_events(&EventQuery::default())
            .await
            .unwrap();
        let now = Utc::now();
        for event in events.iter_mut().skip(1) {
            event.published_at = Some(now - Duration::days(2));
            for evidence in &mut event.evidence {
                evidence.original_published_at = event.published_at;
            }
        }
        let current = events[0].id;
        let brief = select_brief(events, now);
        assert_eq!(brief.items.len(), 4);
        assert_eq!(brief.items[0].id, current);
        assert_eq!(brief.window_start, now - Duration::days(7));
        assert_eq!(brief.primary_window_start, Some(now - Duration::hours(24)));
    }

    #[tokio::test]
    async fn disabled_interests_do_not_match() {
        let store = MemoryStore::demo();
        let event = store
            .list_events(&EventQuery::default())
            .await
            .unwrap()
            .remove(0);
        let topics = vec![Topic {
            id: "x".into(),
            label: event.primary_topic.clone(),
            group: "test".into(),
            weight: 100,
            context: "long_term".into(),
            enabled: false,
        }];
        assert_eq!(relevance(&event, &topics).0, 0.0);
    }

    #[tokio::test]
    async fn publication_precision_belongs_to_the_displayed_source_date() {
        let mut events = MemoryStore::demo()
            .list_events(&EventQuery::default())
            .await
            .unwrap();
        let mut evidence = events.remove(0).evidence;
        let now = Utc::now();
        evidence[0].original_published_at = Some(now);
        evidence[0].publication_precision = Some("day".into());
        let mut older = evidence[0].clone();
        older.original_published_at = Some(now - Duration::days(3));
        older.publication_precision = Some("time".into());
        let items = vec![evidence[0].clone(), older];
        assert_eq!(publication_context(&items), (Some(now), Some("day".into())));
    }

    #[tokio::test]
    async fn later_evidence_does_not_promote_an_old_event_and_seen_is_not_a_hard_priority() {
        let mut events = MemoryStore::demo()
            .list_events(&EventQuery::default())
            .await
            .unwrap();
        let now = Utc::now();
        let old = events[0].id;
        events[0].freshness_at = Some(now - Duration::days(8));
        events[0].published_at = Some(now);
        let seen = events[2].id;
        events[2].seen = true;
        events[2].score.total = 1000.0;
        let brief = select_brief(events, now);
        assert!(!brief.items.iter().any(|event| event.id == old));
        assert_eq!(brief.items[0].id, seen);
    }

    #[tokio::test]
    async fn opaque_engineering_release_is_not_selected_for_a_brief() {
        let mut events = MemoryStore::demo()
            .list_events(&EventQuery::default())
            .await
            .unwrap();
        let now = Utc::now();
        events[0].event_type = "release".into();
        events[0].title = "handoff-runtime-59939c003f6b3eb8add709e5897f7bfbe3e9f4d8".into();
        events[0].published_at = Some(now);
        events[0].freshness_at = Some(now);
        events[0].evidence[0].original_published_at = Some(now);
        assert!(is_opaque_engineering_release(&events[0]));
        assert!(
            !select_brief(events.clone(), now)
                .items
                .iter()
                .any(|event| event.id == events[0].id)
        );

        events[0].title = "Mem0 Pi Agent Plugin (v0.3.0)".into();
        assert!(!is_opaque_engineering_release(&events[0]));

        events[0].title = "v1.2.3-nightly-59939c003f6b3eb8add709e5897f7bfbe3e9f4d8".into();
        assert!(!is_opaque_engineering_release(&events[0]));
        events[0].title = "handoff--59939c003f6b3eb8add709e5897f7bfbe3e9f4d8".into();
        assert!(!is_opaque_engineering_release(&events[0]));
    }

    async fn candidate(
        now: DateTime<Utc>,
        hours: i64,
        publisher: &str,
        kind: &str,
        value: f32,
    ) -> Event {
        let mut event = MemoryStore::demo()
            .list_events(&EventQuery::default())
            .await
            .unwrap()
            .remove(0);
        event.id = uuid::Uuid::new_v4();
        event.title = format!("{publisher} independent article {}", event.id);
        event.event_type = "blog".into();
        event.editorial_publishers = vec![publisher.into()];
        event.published_at = Some(now - Duration::hours(hours));
        event.freshness_at = event.published_at;
        event.evidence[0].id = uuid::Uuid::new_v4();
        event.evidence[0].url = format!("https://{publisher}.example/articles/{}", event.id);
        event.evidence[0].original_published_at = event.published_at;
        event.editorial = Some(crate::models::Editorial {
            policy_version: "article-value-v1".into(),
            content_kind: kind.into(),
            value_score: value,
            brief_eligible: value >= 60.0 && !matches!(kind, "question" | "promotion" | "metadata"),
            reason: "Deterministic test fixture; not model judgement".into(),
            significance: None,
            source_role: None,
            significance_basis: None,
        });
        event
    }

    fn ranked(event: &mut Event, score: f32) {
        event.recommendation = None;
        event.score.total = score;
    }

    fn role(event: &mut Event, role: &str, significance: f32) {
        let policy = event.editorial.as_mut().unwrap();
        policy.source_role = Some(role.into());
        policy.significance = Some(significance);
    }

    #[test]
    fn model_story_key_normalises_named_model_versions() {
        for (title, key) in [
            ("Introducing GPT-6 Sol and Luna", Some("gpt6")),
            ("Better prompt caching for GPT‑6", Some("gpt6")),
            ("刚刚，GPT-6 Astra取得哥德巴赫猜想重大突破！", Some("gpt6")),
            ("ChatGPT 6 is here", Some("gpt6")),
            ("刚刚，Opus 5.5跨级偷袭！直扑GPT-6", Some("opus5.5")),
            ("Claude Opus 5.5 system card", Some("opus5.5")),
            ("[AINews] Xiaomi MiMo-V2.6-Pro 1T-A42B", Some("mimo2.6")),
            ("About Mimo 2.6 Architecture", Some("mimo2.6")),
            ("Qwen3.8-27B in native 8-bit", Some("qwen3.8")),
            ("GPT-6.0 pricing", Some("gpt6")),
            ("Ollama 0.12 released", None),
            ("gpt-oss launch notes", None),
            ("Philosophy of agents 2", None),
            ("Transformers now runs llama.cpp quants", None),
        ] {
            assert_eq!(model_story_key(title).as_deref(), key, "{title}");
        }
    }

    #[tokio::test]
    async fn one_secondary_report_per_model_story_but_first_party_follow_ups_stay() {
        let now = Utc::now();
        let mut launch = candidate(now, 2, "openai", "release", 62.0).await;
        launch.title = "Introducing GPT-6 Sol and Luna".into();
        role(&mut launch, "first_party", 95.0);
        ranked(&mut launch, 90.0);
        let mut hype = candidate(now, 3, "media", "news", 60.0).await;
        hype.title = "刚刚，GPT-6 Astra取得哥德巴赫猜想重大突破！".into();
        role(&mut hype, "editorial", 60.0);
        ranked(&mut hype, 80.0);
        let mut follow_up = candidate(now, 4, "openai", "news", 60.0).await;
        follow_up.title = "Better prompt caching for GPT-6".into();
        role(&mut follow_up, "first_party", 65.0);
        ranked(&mut follow_up, 75.0);
        let mut other = candidate(now, 5, "media", "news", 60.0).await;
        other.title = "刚刚，Opus 5.5跨级偷袭！".into();
        role(&mut other, "editorial", 60.0);
        ranked(&mut other, 70.0);
        let mut later_week = candidate(now, 150, "other-media", "analysis", 90.0).await;
        later_week.title = "A week with GPT-6".into();
        role(&mut later_week, "editorial", 65.0);
        ranked(&mut later_week, 99.0);
        let ids = [launch.id, hype.id, follow_up.id, other.id];
        let brief = select_brief(
            vec![hype, other, follow_up, launch, later_week.clone()],
            now,
        );
        let selected: Vec<_> = brief.items.iter().map(|e| e.id).collect();
        assert_eq!(selected[..3], [ids[0], ids[2], ids[3]]);
        assert!(!selected.contains(&ids[1]));
        // Outside the four-day story window a report is a new story again.
        assert_eq!(selected[3], later_week.id);
        assert_eq!(brief.sections.last().unwrap().kind, "catch_up");
    }

    #[tokio::test]
    async fn catch_up_skips_featured_events_and_needs_significance_when_known() {
        let now = Utc::now();
        let fresh = candidate(now, 1, "fresh", "analysis", 80.0).await;
        let mut featured = candidate(now, 50, "featured", "research", 95.0).await;
        role(&mut featured, "first_party", 72.0);
        let mut minor = candidate(now, 50, "minor", "research", 95.0).await;
        role(&mut minor, "index", 35.0);
        let mut worthy = candidate(now, 60, "worthy", "research", 90.0).await;
        role(&mut worthy, "first_party", 72.0);
        let seen = HashSet::from([featured.id]);
        let brief = select_daily(
            vec![
                fresh.clone(),
                featured.clone(),
                minor.clone(),
                worthy.clone(),
            ],
            now,
            20,
            &seen,
        );
        let catch_up = brief
            .sections
            .iter()
            .find(|s| s.kind == "catch_up")
            .unwrap();
        assert_eq!(catch_up.event_ids, vec![worthy.id]);
        assert_eq!(brief.items.first().unwrap().id, fresh.id);
        assert_eq!(brief.items.len(), 2);
    }

    #[tokio::test]
    async fn index_and_podcast_roles_have_their_own_caps() {
        let now = Utc::now();
        let mut events = Vec::new();
        for n in 0..4 {
            let mut paper = candidate(now, 1, &format!("arxiv-{n}"), "research", 95.0).await;
            role(&mut paper, "index", 45.0);
            paper.primary_topic = format!("paper-{n}");
            ranked(&mut paper, 100.0 - n as f32);
            events.push(paper);
        }
        for n in 0..5 {
            let mut episode = candidate(now, 1, &format!("show-{n}"), "analysis", 85.0).await;
            role(&mut episode, "podcast", 55.0);
            episode.primary_topic = format!("episode-{n}");
            ranked(&mut episode, 90.0 - n as f32);
            events.push(episode);
        }
        let brief = select_brief(events, now);
        let count = |wanted: &str| {
            brief
                .items
                .iter()
                .filter(|e| source_role(e) == wanted)
                .count()
        };
        assert_eq!((count("index"), count("podcast")), (2, 3));
    }

    #[tokio::test]
    async fn older_substantive_material_competes_even_with_twenty_recent_questions() {
        let now = Utc::now();
        let mut events = Vec::new();
        for n in 0..20 {
            let mut question = candidate(now, 1, &format!("community-{n}"), "question", 5.0).await;
            question.score.total = 100.0;
            question.editorial_community = true;
            events.push(question);
        }
        let older = candidate(now, 48, "research", "research", 92.0).await;
        let older_id = older.id;
        events.push(older);
        let brief = select_brief(events, now);
        assert_eq!(brief.items.len(), 1);
        assert_eq!(brief.items[0].id, older_id);
        assert_eq!(brief.sections[0].kind, "catch_up");
    }

    #[tokio::test]
    async fn main_list_is_strictly_ranked_without_same_day_reservations() {
        let now = "2026-09-22T08:00:00Z".parse().unwrap();
        let mut events = Vec::new();
        for n in 0..8 {
            let mut event = candidate(now, 21, &format!("yesterday-{n}"), "analysis", 90.0).await;
            event.primary_topic = format!("yesterday-topic-{n}");
            ranked(&mut event, 100.0 - n as f32);
            events.push(event);
        }
        let yesterday: Vec<_> = events.iter().map(|e| e.id).collect();
        for n in 0..4 {
            let mut event = candidate(now, n + 1, &format!("today-{n}"), "analysis", 70.0).await;
            event.primary_topic = format!("today-topic-{n}");
            ranked(&mut event, 70.0 - n as f32);
            events.push(event);
        }
        let brief = select_brief(events.clone(), now);
        assert_eq!(brief.sections[0].kind, "essential");
        assert_eq!(brief.sections[0].event_ids, yesterday[..5]);
        assert_eq!(brief.sections[1].kind, "more");
        let scores: Vec<_> = brief.items.iter().map(|e| e.score.total).collect();
        assert!(
            scores.windows(2).all(|pair| pair[0] >= pair[1]),
            "{scores:?}"
        );
        assert_eq!(brief.items.len(), 12);
        assert_eq!(
            select_brief_limit(events.clone(), now, 1).items[0].id,
            yesterday[0]
        );
        assert_eq!(select_weekly(events, now, 20).items[0].id, yesterday[0]);
    }

    #[tokio::test]
    async fn ranked_main_list_ignores_calendar_day_and_never_renews_an_old_event() {
        let now = "2026-09-21T16:30:00Z".parse().unwrap();
        let mut yesterday = candidate(now, 1, "yesterday", "analysis", 90.0).await;
        ranked(&mut yesterday, 100.0);
        let yesterday_id = yesterday.id;
        let mut today = candidate(now, 0, "today", "analysis", 70.0).await;
        ranked(&mut today, 60.0);
        let today_id = today.id;
        let mut old = candidate(now, 48, "old", "analysis", 90.0).await;
        old.published_at = Some(now);
        old.evidence[0].original_published_at = Some(now);
        ranked(&mut old, 999.0);
        let old_id = old.id;
        let mut question = candidate(now, 0, "question", "question", 100.0).await;
        question.score.total = 1000.0;
        let question_id = question.id;
        let brief = select_brief(vec![yesterday, old, question, today], now);
        assert_eq!(brief.sections[0].event_ids, vec![yesterday_id, today_id]);
        assert!(
            brief
                .sections
                .iter()
                .any(|section| section.kind == "catch_up" && section.event_ids.contains(&old_id))
        );
        assert!(brief.items.iter().all(|event| event.id != question_id));
        assert_eq!(brief.window_end, now);
    }

    #[tokio::test]
    async fn primary_window_includes_its_exact_boundary_but_not_an_older_high_score() {
        let now = "2026-09-22T08:00:00Z".parse().unwrap();
        let boundary = candidate(now, 24, "boundary", "analysis", 80.0).await;
        let boundary_id = boundary.id;
        let mut older = candidate(now, 24, "older", "analysis", 90.0).await;
        let at = now - Duration::hours(24) - Duration::milliseconds(1);
        older.freshness_at = Some(at);
        older.published_at = Some(at);
        older.evidence[0].original_published_at = Some(at);
        older.recommendation = None;
        older.score.total = 999.0;
        let older_id = older.id;
        let brief = select_brief(vec![older, boundary], now);
        assert_eq!(brief.sections[0].kind, "essential");
        assert_eq!(brief.sections[0].event_ids, vec![boundary_id]);
        assert_eq!(brief.sections[1].kind, "catch_up");
        assert_eq!(brief.sections[1].event_ids, vec![older_id]);
    }

    #[tokio::test]
    async fn quotas_span_sections_and_never_refill_with_publisher_or_community_floods() {
        let now = Utc::now();
        let mut events = Vec::new();
        for n in 0..15 {
            let mut article = candidate(
                now,
                if n % 2 == 0 { 2 } else { 48 },
                "one-publisher",
                "analysis",
                88.0,
            )
            .await;
            article.primary_topic = format!("topic-{n}");
            events.push(article);
        }
        for n in 0..8 {
            let mut article = candidate(now, 2, &format!("community-{n}"), "analysis", 85.0).await;
            article.editorial_community = true;
            article.primary_topic = format!("community-topic-{n}");
            events.push(article);
        }
        let mut promotion = candidate(now, 1, "official-promotion", "promotion", 8.0).await;
        promotion.score.total = 999.0;
        events.push(promotion);
        let brief = select_brief(events, now);
        assert_eq!(brief.items.len(), 4);
        assert_eq!(
            brief.items.iter().filter(|e| e.editorial_community).count(),
            2
        );
        assert_eq!(
            brief
                .items
                .iter()
                .filter(|e| publishers(e) == ["one-publisher"])
                .count(),
            2
        );
        assert_eq!(
            brief
                .sections
                .iter()
                .flat_map(|s| s.event_ids.clone())
                .collect::<Vec<_>>(),
            brief.items.iter().map(|e| e.id).collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn grouping_precedes_quotas_and_a_dismissed_item_never_fills_a_slot() {
        let now = Utc::now();
        let mut duplicate = candidate(now, 1, "project", "release", 85.0).await;
        duplicate.event_type = "release".into();
        duplicate.title = "Project v1.2.3".into();
        duplicate.evidence[0].url = "https://github.com/policy/project/releases/tag/v1.2.3".into();
        let mut second = duplicate.clone();
        second.id = uuid::Uuid::new_v4();
        second.evidence[0].id = uuid::Uuid::new_v4();
        let mut dismissed = candidate(now, 1, "dismissed", "research", 99.0).await;
        dismissed.not_interested = true;
        let dismissed_id = dismissed.id;
        let grouped = crate::coverage::rollup_events(vec![duplicate, second, dismissed], now);
        let brief = select_brief(grouped, now);
        assert_eq!(brief.items.len(), 1);
        assert_eq!(brief.items[0].coverage.as_ref().unwrap().members.len(), 2);
        assert!(brief.items.iter().all(|e| e.id != dismissed_id));
    }

    #[tokio::test]
    async fn weekly_restores_repeat_penalty_and_groups_by_article_topic() {
        let now = Utc::now();
        let mut seen = candidate(now, 72, "seen", "research", 90.0).await;
        seen.primary_topic = "记忆与检索".into();
        seen.seen = true;
        seen.opened = true;
        seen.recommendation = Some(crate::models::Recommendation {
            material_penalty: 0.0,
            score: 70.0,
            freshness: 50.0,
            affinity: 50.0,
            novelty_penalty: 6.0,
            facets: seen.topics.clone(),
            source_confirmed: true,
            explanation: String::new(),
        });
        let seen_id = seen.id;
        let mut another = candidate(now, 1, "another", "analysis", 80.0).await;
        another.primary_topic = "产业与商业".into();
        let weekly = select_weekly(vec![seen, another], now, 20);
        let selected = weekly.items.iter().find(|e| e.id == seen_id).unwrap();
        assert_eq!(selected.recommendation.as_ref().unwrap().score, 76.0);
        assert_eq!(
            selected.recommendation.as_ref().unwrap().novelty_penalty,
            0.0
        );
        assert_eq!(weekly.sections.len(), 2);
        assert!(weekly.sections.iter().all(|s| s.kind == "topic"));
        assert_eq!(
            weekly
                .sections
                .iter()
                .flat_map(|s| s.event_ids.clone())
                .collect::<Vec<_>>(),
            weekly.items.iter().map(|e| e.id).collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn legacy_snapshot_optional_fields_default_without_changing_original_data() {
        let now = Utc::now();
        let event = candidate(now, 1, "legacy", "analysis", 80.0).await;
        let mut stored = serde_json::to_value(select_brief(vec![event], now)).unwrap();
        stored.as_object_mut().unwrap().remove("sections");
        for event in stored["items"].as_array_mut().unwrap() {
            for key in ["editorial", "displayTitle", "notInterestedReason"] {
                event.as_object_mut().unwrap().remove(key);
            }
        }
        let original = stored.clone();
        let parsed: DailyBrief = serde_json::from_value(stored.clone()).unwrap();
        assert!(parsed.sections.is_empty());
        assert!(parsed.items[0].editorial.is_none());
        assert!(parsed.items[0].display_title.is_none());
        assert_eq!(stored, original);
        assert_eq!(parsed.items[0].title, original["items"][0]["title"]);
    }

    #[tokio::test]
    async fn dismissal_reasons_clear_on_undo_and_save_and_aliases_preserve_interests() {
        use crate::models::{EventStateInput, NotInterestedReason};
        let store = MemoryStore::demo();
        let event = store
            .list_events(&Default::default())
            .await
            .unwrap()
            .remove(0);
        let dismissed = store
            .update_event_state(
                event.id,
                EventStateInput {
                    not_interested: Some(true),
                    not_interested_reason: Some(NotInterestedReason::Old),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            dismissed.not_interested_reason,
            Some(NotInterestedReason::Old)
        );
        let restored = store
            .update_event_state(
                event.id,
                EventStateInput {
                    saved: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert!(!restored.not_interested);
        assert_eq!(restored.not_interested_reason, None);
        assert!(
            store
                .list_events(&EventQuery {
                    topic: Some("Agent".into()),
                    ..Default::default()
                })
                .await
                .unwrap()
                .iter()
                .any(|e| e.id == event.id)
        );
        assert!(
            serde_json::from_str::<EventStateInput>(
                r#"{"notInterested":true,"notInterestedReason":"arbitrary"}"#
            )
            .is_err()
        );
    }
}
