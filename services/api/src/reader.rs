use chrono::{DateTime, Duration, NaiveDate, Utc};
use std::collections::HashMap;

use crate::models::{BriefSection, DailyBrief, Event, Evidence, Topic};

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
    select_edition(events, now, limit, false)
}

pub fn select_weekly(events: Vec<Event>, now: DateTime<Utc>, limit: usize) -> DailyBrief {
    select_edition(events, now, limit, true)
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
        && event.editorial.as_ref().is_some_and(|policy| policy.brief_eligible)
        && event.event_type != "repository"
        && !is_opaque_engineering_release(event)
        && event.freshness_at.or(event.published_at)
            .is_some_and(|date| date >= start && date <= now)
        && event.evidence.iter().all(|item| item.aggregation.is_none())
        && event.evidence.iter().any(|item| item.original_published_at
            .is_some_and(|date| date >= start && date <= now))
}

fn publishers(event: &Event) -> Vec<String> {
    if !event.editorial_publishers.is_empty() {
        return event.editorial_publishers.clone();
    }
    let mut keys: Vec<_> = event.evidence.iter().map(|item| {
        crate::processing::publisher_domain(&item.url).unwrap_or_else(|| item.source_name.clone())
    }).collect();
    keys.sort();
    keys.dedup();
    if keys.is_empty() { keys.push(format!("unknown:{}", event.id)); }
    keys
}

fn community(event: &Event) -> bool {
    event.editorial_community || event.evidence.iter().all(|e| {
        url::Url::parse(&e.url).ok().and_then(|u| u.host_str().map(str::to_owned))
            .is_some_and(|host| host == "reddit.com" || host.ends_with(".reddit.com")
                || host == "news.ycombinator.com")
    })
}

fn select_edition(
    mut events: Vec<Event>,
    now: DateTime<Utc>,
    limit: usize,
    weekly: bool,
) -> DailyBrief {
    let start = now - Duration::days(7);
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
    let mut counts = HashMap::<String, usize>::new();
    let mut topics = HashMap::<String, usize>::new();
    let mut community_count = 0usize;
    let mut selected = Vec::new();
    let mut sections = Vec::new();
    let pools: Vec<(&str, &str, &str, usize)> = if weekly {
        vec![("weekly", "topic", "每周主题回顾", limit)]
    } else {
        vec![("essential", "essential", "今日重点", 8.min(limit)),
            ("catch_up", "catch_up", "值得补读", 4.min(limit)),
            ("more", "more", "更多值得读", limit)]
    };
    for (key, kind, title, capacity) in pools {
        let mut event_ids = Vec::new();
        for event in &events {
            if selected.len() >= limit || event_ids.len() >= capacity { break; }
            if selected.iter().any(|e: &Event| e.id == event.id) { continue; }
            let recent = event.freshness_at.or(event.published_at)
                .is_some_and(|at| at >= now - Duration::hours(24));
            let older_value = event.editorial.as_ref().is_some_and(|p| p.value_score >= 68.0);
            if !weekly && (key == "catch_up" && (recent || !older_value)
                || key != "catch_up" && !recent) { continue; }
            let source_keys = publishers(event);
            // No overflow refill: every selected lead consumes all its publishers,
            // including across sections. Grouping has already happened.
            if source_keys.iter().any(|key| counts.get(key).copied().unwrap_or(0) >= 3)
                || community(event) && community_count >= 2
                || topics.get(&event.primary_topic).copied().unwrap_or(0) >= 5 { continue; }
            for source in source_keys { *counts.entry(source).or_default() += 1; }
            *topics.entry(event.primary_topic.clone()).or_default() += 1;
            if community(event) { community_count += 1; }
            event_ids.push(event.id);
            selected.push(event.clone());
        }
        if !event_ids.is_empty() {
            sections.push(BriefSection {
                key: key.into(), kind: kind.into(), title: title.into(),
                description: if key == "catch_up" {
                    "过去一周仍值得了解的研究、分析与实践。"
                } else if key == "more" {
                    "更多近期更新，按兴趣继续阅读。"
                } else {
                    "近24小时的重点更新，优先关注实质变化。"
                }.into(),
                event_ids,
            });
        }
    }
    if weekly {
        sections.clear();
        let mut ordered = Vec::new();
        for event in &selected {
            if sections.iter().any(|s: &BriefSection| s.title == event.primary_topic) { continue; }
            let items: Vec<_> = selected.iter().filter(|e| e.primary_topic == event.primary_topic).cloned().collect();
            sections.push(BriefSection {
                key: format!("topic-{}", sections.len()), kind: "topic".into(), title: event.primary_topic.clone(),
                description: "本周这一主题下值得回顾的进展。".into(),
                event_ids: items.iter().map(|e| e.id).collect(),
            });
            ordered.extend(items);
        }
        selected = ordered;
    }
    DailyBrief {
        sections,
        local_date: local_date(now).to_string(),
        generated_at: now,
        estimated_minutes: (selected.len() as i32 + 1) / 2,
        items: selected,
        is_snapshot: false,
        window_start: start,
        window_end: now,
        primary_window_start: (!weekly).then_some(now - Duration::hours(24)),
        selection_note: Some(format!("article-value-v1 确定性保守选文，不是 AI 核验的重要性。价值30% + 来源质量25% + 兴趣20% + 分类型时效15% + 主动反馈5% + 独立来源覆盖5%；每发布者最多3篇、社区最多2篇、每主题最多5篇。目标最多{limit}篇，合格或多样性不足时宁缺毋滥。{}",
            if weekly { "周报使用7日时效尺度，不计重复曝光；历史日期回顾不冒充当时存档。" }
            else { "今日重点约8篇；近7日高价值补读最多4篇，独立候选池；打开/曝光仅有衰减小幅降权。" })),
        eligibility: None,
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

    async fn candidate(now: DateTime<Utc>, hours: i64, publisher: &str, kind: &str, value: f32) -> Event {
        let mut event = MemoryStore::demo().list_events(&EventQuery::default()).await.unwrap().remove(0);
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
            policy_version: "article-value-v1".into(), content_kind: kind.into(),
            value_score: value, brief_eligible: value >= 60.0 && !matches!(kind,"question"|"promotion"|"metadata"),
            reason: "Deterministic test fixture; not model judgement".into(),
        });
        event
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
    async fn quotas_span_sections_and_never_refill_with_publisher_or_community_floods() {
        let now = Utc::now();
        let mut events = Vec::new();
        for n in 0..15 {
            let mut article = candidate(now, if n % 2 == 0 { 2 } else { 48 }, "one-publisher", "analysis", 88.0).await;
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
        assert_eq!(brief.items.len(), 5);
        assert_eq!(brief.items.iter().filter(|e| e.editorial_community).count(), 2);
        assert_eq!(brief.items.iter().filter(|e| publishers(e) == ["one-publisher"]).count(), 3);
        assert_eq!(brief.sections.iter().flat_map(|s| s.event_ids.clone()).collect::<Vec<_>>(),
            brief.items.iter().map(|e| e.id).collect::<Vec<_>>());
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
        let grouped = crate::coverage::rollup_events(vec![duplicate,second,dismissed], now);
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
            material_penalty: 0.0, score: 70.0, freshness: 50.0, affinity: 50.0,
            novelty_penalty: 6.0, facets: seen.topics.clone(), source_confirmed: true, explanation: String::new(),
        });
        let seen_id = seen.id;
        let mut another = candidate(now, 1, "another", "analysis", 80.0).await;
        another.primary_topic = "产业与商业".into();
        let weekly = select_weekly(vec![seen, another], now, 20);
        let selected = weekly.items.iter().find(|e| e.id == seen_id).unwrap();
        assert_eq!(selected.recommendation.as_ref().unwrap().score, 76.0);
        assert_eq!(selected.recommendation.as_ref().unwrap().novelty_penalty, 0.0);
        assert_eq!(weekly.sections.len(), 2);
        assert!(weekly.sections.iter().all(|s| s.kind == "topic"));
        assert_eq!(weekly.sections.iter().flat_map(|s| s.event_ids.clone()).collect::<Vec<_>>(),
            weekly.items.iter().map(|e| e.id).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn legacy_snapshot_optional_fields_default_without_changing_original_data() {
        let now = Utc::now();
        let event = candidate(now, 1, "legacy", "analysis", 80.0).await;
        let mut stored = serde_json::to_value(select_brief(vec![event], now)).unwrap();
        stored.as_object_mut().unwrap().remove("sections");
        for event in stored["items"].as_array_mut().unwrap() {
            for key in ["editorial","displayTitle","notInterestedReason"] {
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
        let event = store.list_events(&Default::default()).await.unwrap().remove(0);
        let dismissed = store.update_event_state(event.id, EventStateInput {
            not_interested: Some(true), not_interested_reason: Some(NotInterestedReason::Old),
            ..Default::default()
        }).await.unwrap().unwrap();
        assert_eq!(dismissed.not_interested_reason, Some(NotInterestedReason::Old));
        let restored = store.update_event_state(event.id, EventStateInput {
            saved: Some(true), ..Default::default()
        }).await.unwrap().unwrap();
        assert!(!restored.not_interested);
        assert_eq!(restored.not_interested_reason, None);
        assert!(store.list_events(&EventQuery { topic: Some("Agent".into()), ..Default::default() })
            .await.unwrap().iter().any(|e| e.id == event.id));
        assert!(serde_json::from_str::<EventStateInput>(r#"{"notInterested":true,"notInterestedReason":"arbitrary"}"#).is_err());
    }
}
