//! Read-time topic rollups, never ingestion deduplication or merged model summaries.
use std::collections::{BTreeSet, HashMap, HashSet};

use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;

use crate::models::{CoverageBundle, CoverageMember, Event};

mod announcement;
mod bulk;
mod copies;
mod development;
mod project;
mod release_family;

pub const WINDOW_HOURS: i64 = 168;
pub(crate) const MAX_COPY_CANDIDATES: usize = copies::MAX_CANDIDATES;

#[derive(Clone)]
pub struct SourceIdentity {
    pub evidence_id: Uuid,
    pub publisher: String,
    pub kind: String,
}

#[derive(Clone)]
pub struct Record {
    pub member: CoverageMember,
    pub sources: Vec<SourceIdentity>,
    freshness_at: Option<DateTime<Utc>>,
    event_references: BTreeSet<String>,
    release: Option<release_family::Release>,
    identity: Option<release_family::Release>,
    project: Option<project::ProjectRelease>,
    announcement: Option<announcement::Announcement>,
    batch: Option<bulk::Batch>,
    original_material: Option<String>,
}

impl Record {
    pub fn new(mut member: CoverageMember, sources: Vec<SourceIdentity>) -> Self {
        let release = release_family::parse(&member);
        let identity = release.clone().or_else(|| release_family::identity(&member));
        let project = project::parse(&member)
            .or_else(|| identity.as_ref().map(release_family::Release::project));
        let announcement = announcement::parse(&member, &sources);
        let batch = bulk::parse(&member, &sources);
        member.release_target = identity
            .as_ref()
            .map(|r| r.target.clone())
            .or_else(|| project.as_ref().map(|p| p.target.clone()));
        member.release_version = identity
            .as_ref()
            .map(|r| r.version.clone())
            .or_else(|| project.as_ref().map(|p| p.version.clone()))
            .filter(|version| !version.is_empty());
        // Artifact references stay separate from official announcement identities;
        // repository links in prose and sponsors are never event references.
        let event_references = member
            .evidence
            .iter()
            .filter_map(|evidence| event_reference(&evidence.url))
            .collect();
        let freshness_at = member
            .evidence
            .iter()
            .filter_map(|e| e.original_published_at)
            .min()
            .or(member.published_at);
        let original_material = member.evidence.iter().filter(|evidence| evidence.aggregation.is_none())
            .filter_map(|evidence| evidence.reading_context.as_ref())
            .map(|context| context.body.clone()).max_by_key(String::len);
        Self {
            member,
            sources,
            freshness_at,
            event_references,
            release,
            identity,
            project,
            announcement,
            batch,
            original_material,
        }
    }

    pub(crate) fn use_original_material(&mut self, title: &str, body: String) {
        if self.release.is_some() || self.announcement.is_some() || !self.event_references.is_empty() {
            return;
        }
        if copies::candidate(title).is_some_and(|key| Some(key) == copies::candidate(&source_title(self)))
            && body.len() > self.original_material.as_ref().map_or(0, String::len)
        {
            self.original_material = Some(body);
        }
    }

    pub fn from_event(event: &Event) -> Self {
        let sources: Vec<_> = event
            .evidence
            .iter()
            .filter(|e| e.aggregation.is_none())
            .map(|e| SourceIdentity {
                evidence_id: e.id,
                publisher: crate::processing::publisher_domain(&e.url)
                    .unwrap_or_else(|| e.source_name.clone()),
                kind: if event.event_type == "repository" {
                    "community"
                } else if e.is_official && e.source_tier == "T1" {
                    "official"
                } else {
                    "editorial"
                }
                .into(),
            })
            .collect();
        let kind = material_kind(&sources);
        let mut record = Self::new(
            CoverageMember {
                event_id: event.id,
                content_version: event.content_version,
                title: event.title.clone(),
                display_title: event.display_title.clone(),
                event_type: event.event_type.clone(),
                published_at: event.published_at,
                publication_precision: event.publication_precision.clone(),
                summary_kind: event.summary_kind.clone(),
                summary: event.summary.clone(),
                summary_points: event.summary_points.clone(),
                summary_material_limit: event.summary_material_limit.clone(),
                summary_limitations: event.summary_limitations.clone(),
                summary_visual: event.summary_visual.clone(),
                summary_model: event.summary_model.clone(),
                summarized_at: event.summarized_at,
                evidence: event.evidence.clone(),
                relationship: "unrelated".into(),
                material_kind: kind,
                matches_filters: true,
                release_target: None,
                release_version: None,
            },
            sources,
        );
        record.freshness_at = event.freshness_at.or(event.published_at);
        record
    }
}

pub fn material_kind(sources: &[SourceIdentity]) -> String {
    if sources.iter().any(|s| s.kind == "editorial") {
        "editorial"
    } else if sources.iter().any(|s| s.kind == "official") {
        "official"
    } else {
        "community"
    }
    .into()
}

pub(crate) fn event_reference(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let path: Vec<_> = url.path_segments()?.filter(|p| !p.is_empty()).collect();
    match (host.as_str(), path.as_slice()) {
        ("github.com", [owner, repository, "releases", "tag", tag]) if !tag.is_empty() => {
            Some(format!(
                "github-release:{}/{}/{}",
                owner.to_ascii_lowercase(),
                repository.to_ascii_lowercase(),
                tag
            ))
        }
        ("github.com", [owner, repository, "pull", number])
            if !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            Some(format!(
                "github-pull:{}/{}/{}",
                owner.to_ascii_lowercase(),
                repository.to_ascii_lowercase(),
                number
            ))
        }
        ("github.com", [owner, repository, "issues", number])
            if !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            Some(format!(
                "github-issue:{}/{}/{}",
                owner.to_ascii_lowercase(),
                repository.to_ascii_lowercase(),
                number
            ))
        }
        ("arxiv.org", ["abs", id]) if !id.is_empty() => {
            Some(format!("arxiv:{}", id.to_ascii_lowercase()))
        }
        _ => None,
    }
}

/// Cheap candidate discovery only; full records still establish the relation.
pub(crate) fn candidate_reference(title: &str, url: &str) -> Option<String> {
    development::candidate(title, url)
        .or_else(|| event_reference(url))
        .or_else(|| {
            announcement::subject(title).map(|subject| format!("announcement-subject:{subject}"))
        })
        .or_else(|| bulk::candidate(title, url))
        .or_else(|| copies::candidate(title))
}

fn source_title(record: &Record) -> String {
    record
        .member
        .evidence
        .iter()
        .filter(|evidence| evidence.is_official)
        .chain(record.member.evidence.iter())
        .map(|evidence| evidence.title.trim())
        .find(|title| !title.is_empty())
        .unwrap_or(record.member.title.as_str())
        .to_owned()
}

pub struct Group {
    pub lead: Uuid,
    pub bundle: Option<CoverageBundle>,
}

/// Leaders are already sorted by the caller. Verify the common event or project
/// release window independently of ranking before collapsing presentation items.
pub fn groups(records: &[Record], leaders: &[Uuid], cutoff: DateTime<Utc>) -> Vec<Group> {
    let by_id: HashMap<_, _> = records.iter().map(|r| (r.member.event_id, r)).collect();
    let mut by_reference = HashMap::<&str, Vec<&Record>>::new();
    for record in records {
        // Official project releases are grouped by repository window below,
        // never through a shared upstream link.
        if record.release.is_none() && record.project.is_none() {
            for reference in &record.event_references {
                by_reference
                    .entry(reference.as_str())
                    .or_default()
                    .push(record);
            }
        }
    }
    // Fix repository windows before ranking picks a lead; a release must not
    // move between rows merely because a reader changes sort or interests.
    let project_cohorts = project::cohorts(records, cutoff);
    let project_membership: HashMap<_, _> = project_cohorts
        .iter()
        .enumerate()
        .flat_map(|(index, cohort)| {
            cohort
                .members
                .iter()
                .map(move |record| (record.member.event_id, index))
        })
        .collect();
    let batch_cohorts = bulk::cohorts(records, cutoff);
    let batch_membership: HashMap<_, _> = batch_cohorts
        .iter()
        .enumerate()
        .flat_map(|(index, cohort)| {
            cohort
                .members
                .iter()
                .map(move |record| (record.member.event_id, index))
        })
        .collect();
    let announcement_cohorts = announcement::cohorts(records, cutoff);
    let announcement_membership: HashMap<_, _> = announcement_cohorts
        .iter()
        .enumerate()
        .flat_map(|(index, cohort)| {
            cohort
                .members
                .iter()
                .map(move |record| (record.member.event_id, index))
        })
        .collect();
    let copy_cohorts = copies::cohorts(records, cutoff);
    let copy_membership: HashMap<_, _> = copy_cohorts.iter().enumerate()
        .flat_map(|(index, cohort)| cohort.members.iter().map(move |record| (record.member.event_id, index)))
        .collect();
    let development_cohorts = development::cohorts(records, cutoff);
    let development_membership: HashMap<_, _> = development_cohorts.iter().enumerate()
        .flat_map(|(index, cohort)| cohort.members.iter().map(move |record| (record.member.event_id, index)))
        .collect();
    let leader_set: HashSet<_> = leaders.iter().copied().collect();
    let mut assigned = HashSet::new();
    let mut result = Vec::new();
    for id in leaders {
        if assigned.contains(id) {
            continue;
        }
        let Some(lead) = by_id.get(id) else {
            result.push(Group {
                lead: *id,
                bundle: None,
            });
            continue;
        };
        let Some(date) = lead.freshness_at.filter(|date| *date <= cutoff) else {
            result.push(Group {
                lead: *id,
                bundle: None,
            });
            continue;
        };
        let mut choices: Vec<(String, String, Vec<&Record>, String, String)> =
            if let Some(index) = development_membership.get(id) {
                let cohort = &development_cohorts[*index];
                vec![(cohort.key.clone(), cohort.title.clone(), cohort.members.clone(),
                    "development_activity".into(), "development-window-v1".into())]
            } else if let Some(index) = copy_membership.get(id) {
                let cohort = &copy_cohorts[*index];
                vec![(cohort.key.clone(), cohort.title.clone(), cohort.members.clone(),
                    "same_article".into(), "original-copy-v1".into())]
            } else if lead.project.is_some() || lead.release.is_some() {
                let members: Vec<_> = project_membership
                    .get(id)
                    .map(|index| {
                        project_cohorts[*index]
                            .members
                            .iter()
                            .copied()
                            .filter(|record| {
                                record.member.event_id == *id
                                    || !assigned.contains(&record.member.event_id)
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                if members.len() > 1 {
                    let (key, label, method) = release_family::window(&members, cutoff);
                    vec![(key, label, members, "release_family".into(), method.into())]
                } else {
                    Vec::new()
                }
            } else if let Some(index) = announcement_membership.get(id) {
                let cohort = &announcement_cohorts[*index];
                vec![(
                    cohort.reference.clone(),
                    cohort.title.clone(),
                    cohort.members.clone(),
                    "same_event_evidence".into(),
                    "official-announcement-v1".into(),
                )]
            } else {
                lead.event_references
                    .iter()
                    .filter_map(|reference| {
                        let members: Vec<_> = by_reference
                            .get(reference.as_str())
                            .into_iter()
                            .flatten()
                            .copied()
                            .filter(|candidate| {
                                !assigned.contains(&candidate.member.event_id)
                                    && candidate.freshness_at.is_some_and(|other| {
                                        other <= cutoff
                                            && (date - other).num_seconds().abs()
                                                <= Duration::hours(WINDOW_HOURS).num_seconds()
                                    })
                            })
                            .collect();
                        (members.len() > 1).then_some((
                            reference.clone(),
                            source_title(lead),
                            members,
                            "same_event_evidence".into(),
                            "exact-event-reference-v1".into(),
                        ))
                    })
                    .collect()
            };
        // Weakest identity last: a batch only explains items that no release,
        // announcement or exact upstream event already accounts for.
        if choices.is_empty() {
            if let Some(cohort) = batch_membership.get(id).map(|index| &batch_cohorts[*index]) {
                let members: Vec<_> = cohort
                    .members
                    .iter()
                    .copied()
                    .filter(|record| {
                        record.member.event_id == *id
                            || !assigned.contains(&record.member.event_id)
                    })
                    .collect();
                if members.len() > 1 {
                    choices.push((
                        cohort.key.clone(),
                        cohort.label.clone(),
                        members,
                        "bulk_publication".into(),
                        "bulk-template-v1".into(),
                    ));
                }
            }
        }
        choices.sort_by(|a, b| b.2.len().cmp(&a.2.len()).then(a.0.cmp(&b.0)));
        let Some((key, label, mut members, relation, method)) = choices.into_iter().next() else {
            assigned.insert(*id);
            result.push(Group {
                lead: *id,
                bundle: None,
            });
            continue;
        };
        let window_hours = match relation.as_str() {
            "release_family" => release_family::WINDOW_HOURS,
            "bulk_publication" => bulk::WINDOW_HOURS,
            "same_article" => copies::WINDOW_HOURS,
            "development_activity" => development::WINDOW_HOURS,
            _ => WINDOW_HOURS,
        };
        // A later syndication cannot replace the original's time or ranking.
        // Detail callers can still explicitly select any individual member.
        let group_lead = if relation == "same_article" {
            members.iter().filter(|member| leader_set.contains(&member.member.event_id))
                .min_by_key(|member| (member.freshness_at, member.member.event_id))
                .map(|member| member.member.event_id).unwrap_or(*id)
        } else { *id };
        members.sort_by(|a, b| {
            (a.member.event_id != group_lead)
                .cmp(&(b.member.event_id != group_lead))
                .then(b.member.published_at.cmp(&a.member.published_at))
                .then(a.member.event_id.cmp(&b.member.event_id))
        });
        // Prevent a 14-day span around a middle article. Keep a fixed seven-day cohort.
        let earliest = members.iter().filter_map(|r| r.freshness_at).min().unwrap();
        members.retain(|r| {
            r.freshness_at
                .is_some_and(|d| d <= earliest + Duration::hours(window_hours))
        });
        if members.len() < 2 || !members.iter().any(|r| r.member.event_id == *id) {
            assigned.insert(*id);
            result.push(Group {
                lead: *id,
                bundle: None,
            });
            continue;
        }
        let mut editorial = BTreeSet::new();
        let mut official = BTreeSet::new();
        let mut news = BTreeSet::new();
        let mut community = BTreeSet::new();
        let mut all = BTreeSet::new();
        let mut bundle_members = Vec::new();
        let news_date = members
            .iter()
            .filter(|r| r.member.material_kind != "community")
            .filter_map(|r| r.freshness_at)
            .min();
        for record in members {
            assigned.insert(record.member.event_id);
            for source in &record.sources {
                all.insert(source.evidence_id);
                match source.kind.as_str() {
                    "editorial" => {
                        editorial.insert(source.publisher.clone());
                        news.insert(source.evidence_id);
                    }
                    "official" => {
                        official.insert(source.publisher.clone());
                        news.insert(source.evidence_id);
                    }
                    _ => {
                        community.insert(source.evidence_id);
                    }
                }
            }
            let mut member = record.member.clone();
            member.matches_filters = leader_set.contains(&member.event_id);
            if member.event_id == group_lead {
                member.relationship = "lead".into();
            } else {
                member.relationship = relation.clone();
            }
            bundle_members.push(member);
        }
        // Editorial source diversity only, at most three points, decaying like news freshness.
        // Repository activity and official project metadata cannot increase this term.
        let freshness = news_date
            .map(|d| 2f32.powf(-(cutoff - d).num_seconds().max(0) as f32 / 86400.0))
            .unwrap_or(0.0);
        let boost = if matches!(relation.as_str(), "same_article" | "development_activity") {
            0.0
        } else {
            (editorial.len().saturating_sub(1).min(3) as f32) * freshness
        };
        result.push(Group {
            lead: group_lead,
            bundle: Some(CoverageBundle {
                key: format!("{method}:{key}:{}", earliest.format("%Y-%m-%dT%H:%M:%SZ")),
                topic: label,
                relation,
                method,
                window_hours,
                material_count: all.len(),
                news_material_count: news.len(),
                editorial_source_count: editorial.len(),
                official_source_count: official.len(),
                community_material_count: community.len(),
                popularity_boost: boost,
                members: bundle_members,
            }),
        });
    }
    result
}

pub fn apply(event: &mut Event, bundle: Option<CoverageBundle>) {
    if let Some(bundle) = &bundle {
        if let Some(recommendation) = &mut event.recommendation {
            if event.editorial.is_none() {
                recommendation.score += bundle.popularity_boost;
            }
            recommendation.explanation.push_str(&if bundle.relation=="release_family" {
                if bundle.method=="project-release-window-v1" {
                    " 同一官方项目24小时内的不同语言版本汇总展示；各自改动独立，不表示同一事件、共同改动或多来源互证，不增加热度。".into()
                } else if bundle.method==release_family::PROJECT_WINDOW_METHOD {
                    format!(" 同一官方仓库24小时内的{}个发布汇总为一行；各发布保留自己的版本、改动和摘要，不表示同一事件、共同改动或多来源互证，也不增加热度。",bundle.members.len())
                } else {
                    " 同一官方项目的集中组件发布按一组展示；各组件保留自己的版本和改动，不作为多来源互证，也不因拆成多个发布条目增加热度。".into()
                }
            } else if bundle.method=="official-announcement-v1" {
                " 原始标题中的完整模型版本主体一致，并有唯一官方发布作为依据；公告与解读合并展示，保留各自内容，不表示观点已获互证。".into()
            } else if bundle.relation=="bulk_publication" {
                format!(" 同一账号24小时内批量发布的{}个同模板条目按一组展示；各条目保留自己的标题与内容，不表示同一事件或多来源互证，也不增加热度。",bundle.members.len())
            } else if bundle.relation=="same_article" {
                " 原始标题与原始材料高度重合，折叠重复刊载；不当作独立互证，不增加热度，也不因较晚转载提升排序。".into()
            } else if bundle.relation=="development_activity" {
                " 同一仓库24小时内的内部开发记录汇总展示，保留各条改动；不是同一事件或面向用户的正式发布，不增加热度。".into()
            } else if event.editorial.is_some() {
                " 精确上游事件引用一致，按一组展示；独立覆盖已在5%上限内计分，分组不再叠加热度。".into()
            } else { format!(
                " 精确上游事件引用一致，按一组展示；{}个编辑来源的覆盖热度加分{:.1}（最多3分且随新闻时间衰减），社区项目不加分。",
                bundle.editorial_source_count,bundle.popularity_boost) });
        }
    }
    event.coverage = bundle;
}

pub fn rollup_events(events: Vec<Event>, cutoff: DateTime<Utc>) -> Vec<Event> {
    let records: Vec<_> = events.iter().map(Record::from_event).collect();
    let mut leaders: Vec<_> = events.iter().map(|e| e.id).collect();
    let positions: HashMap<_, _> = leaders.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    let community: HashSet<_> = records
        .iter()
        .filter(|r| r.member.material_kind == "community")
        .map(|r| r.member.event_id)
        .collect();
    leaders.sort_by_key(|id| community.contains(id));
    let mut groups = groups(&records, &leaders, cutoff);
    groups.sort_by_key(|g| positions[&g.lead]);
    let mut by_id: HashMap<_, _> = events.into_iter().map(|e| (e.id, e)).collect();
    groups
        .into_iter()
        .filter_map(|group| {
            let mut event = by_id.remove(&group.lead)?;
            apply(&mut event, group.bundle);
            Some(event)
        })
        .collect()
}

fn bundle_is_current_or_archived(bundle: &CoverageBundle) -> bool {
    matches!(
        (bundle.relation.as_str(), bundle.method.as_str()),
        ("release_family", "release-family-v1")
            | ("release_family", "release-family-v2")
            | ("release_family", "project-release-window-v1")
            | ("release_family", "project-release-window-v2")
            | ("same_event_evidence", "exact-event-reference-v1")
            | ("same_event_evidence", "official-announcement-v1")
            | ("bulk_publication", "bulk-template-v1")
            | ("same_article", "original-copy-v1")
            | ("development_activity", "development-window-v1")
            | ("archived_materials", "archived-materials-v1")
    )
}

fn archived_materials(bundle: &CoverageBundle) -> Option<CoverageBundle> {
    (bundle.members.len() >= 2).then(|| CoverageBundle {
        key: format!("archived-materials-v1:{}", bundle.key),
        topic: format!("历史版 · {} 篇独立文章", bundle.members.len()),
        relation: "archived_materials".into(),
        method: "archived-materials-v1".into(),
        window_hours: bundle.window_hours,
        material_count: bundle.material_count,
        news_material_count: bundle.news_material_count,
        editorial_source_count: bundle.editorial_source_count,
        official_source_count: bundle.official_source_count,
        community_material_count: bundle.community_material_count,
        popularity_boost: 0.0,
        members: bundle
            .members
            .iter()
            .cloned()
            .map(|mut member| {
                member.relationship = "archived_material".into();
                member
            })
            .collect(),
    })
}

/// Presentation-only grouping of captured items. Legacy weak bundles become an
/// explicitly non-associative archive collection without modifying persisted JSON.
pub fn rollup_release_snapshots(mut events: Vec<Event>, cutoff: DateTime<Utc>) -> Vec<Event> {
    for event in &mut events {
        if let Some(bundle) = event.coverage.as_ref() {
            if !bundle_is_current_or_archived(bundle) {
                event.coverage = archived_materials(bundle);
            }
        }
    }
    let records: Vec<_> = events
        .iter()
        .filter(|e| e.coverage.is_none() && !e.not_interested)
        .map(Record::from_event)
        .filter(|r| r.release.is_some() || r.project.is_some())
        .collect();
    let leaders: Vec<_> = records.iter().map(|r| r.member.event_id).collect();
    let mut bundles: HashMap<_, _> = groups(&records, &leaders, cutoff)
        .into_iter()
        .filter_map(|g| g.bundle.map(|bundle| (g.lead, bundle)))
        .collect();
    let children: HashSet<_> = bundles
        .iter()
        .flat_map(|(lead, b)| {
            b.members
                .iter()
                .filter(|m| m.event_id != *lead)
                .map(|m| m.event_id)
        })
        .collect();
    events
        .into_iter()
        .filter(|e| !children.contains(&e.id))
        .map(|mut event| {
            if let Some(bundle) = bundles.remove(&event.id) {
                event.coverage = Some(bundle);
            }
            event
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        models::EventQuery,
        store::{MemoryStore, Store},
    };

    #[test]
    fn only_immutable_upstream_artifacts_are_event_references() {
        assert_eq!(
            event_reference("https://github.com/owner/project/releases/tag/v1.2.3"),
            Some("github-release:owner/project/v1.2.3".into())
        );
        assert_eq!(
            event_reference("https://github.com/owner/project/pull/42"),
            Some("github-pull:owner/project/42".into())
        );
        assert_eq!(
            event_reference("https://arxiv.org/abs/2609.12345"),
            Some("arxiv:2609.12345".into())
        );
        assert!(event_reference("https://github.com/owner/project").is_none());
        assert!(event_reference("https://github.com/owner/project/sponsors").is_none());
    }

    #[test]
    fn unloaded_non_groupable_materials_keep_all_singleton_positions() {
        let ids = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
        let result = groups(&[], &ids, Utc::now());
        assert_eq!(
            result.iter().map(|group| group.lead).collect::<Vec<_>>(),
            ids
        );
        assert!(result.iter().all(|group| group.bundle.is_none()));
    }

    async fn fixtures() -> (Vec<Event>, DateTime<Utc>) {
        let now = Utc::now();
        let mut events = MemoryStore::demo()
            .list_events(&EventQuery::default())
            .await
            .unwrap();
        for (i, event) in events.iter_mut().enumerate() {
            event.title = "Grok Bot".into();
            event.freshness_at = Some(now - Duration::hours(i as i64));
            event.published_at = event.freshness_at;
            for evidence in &mut event.evidence {
                evidence.title = event.title.clone();
                evidence.original_published_at = event.freshness_at;
                evidence.is_official = false;
                evidence.url = format!("https://publisher{i}.example/story");
            }
        }
        (events, now)
    }

    const COPY_TITLE: &str = "从“言传身教”到“触类旁通”：AI既需要“名师指引”，也需要“自我修行”";
    const COPY_BODY: &str = "这是一份合成的去重测试材料，并非真实研究报道。本文讨论两种训练方法之间的互补关系：一种依靠教师提供示例与反馈，另一种通过自主探索积累可迁移的经验。作者逐项比较了训练数据的组织方式、推理时的学习过程和评估任务，强调应区分记住答案与学会解决问题。结尾说明实验条件与适用范围，并保留原始资料链接，供读者独立核查论述。";

    async fn copy_fixtures() -> (Vec<Event>, DateTime<Utc>) {
        let (mut events, now) = fixtures().await;
        events.truncate(2);
        for event in &mut events {
            event.title = COPY_TITLE.into();
            event.event_type = "blog".into();
            event.evidence.truncate(1);
            event.evidence[0].title = event.title.clone();
            event.evidence[0].excerpt = COPY_BODY.into();
        }
        events[0].evidence[0].url = "https://first.example/2026/10/505443".into();
        events[1].evidence[0].url = "https://second.example/2026/10/120702".into();
        (events, now)
    }

    #[tokio::test]
    async fn original_chinese_copy_ignores_publisher_ids_and_never_promotes_a_repost() {
        let (mut events, now) = copy_fixtures().await;
        events[0].evidence[0].title = COPY_TITLE.replace(['“', '”'], "\"");
        let original = events[1].clone();
        let result = rollup_events(events.clone(), now);
        assert_eq!(result.len(), 1);
        let bundle = result[0].coverage.as_ref().unwrap();
        assert_eq!(result[0].id, original.id, "oldest matching article owns the position");
        assert_eq!(result[0].published_at, original.published_at);
        assert_eq!(result[0].summary, original.summary);
        assert_eq!(result[0].content_version, original.content_version);
        assert_eq!(bundle.relation, "same_article");
        assert_eq!(bundle.popularity_boost, 0.0);
        assert_eq!(bundle.members.len(), 2);
        let reversed = rollup_events(events.into_iter().rev().collect(), now);
        assert_eq!(reversed[0].id, original.id);
        assert_eq!(reversed[0].coverage.as_ref().unwrap().key, bundle.key);
    }

    #[tokio::test]
    async fn copied_titles_do_not_override_missing_material_or_semantic_conflicts() {
        let (base, now) = copy_fixtures().await;
        for change in ["missing", "summary-only", "body-number", "body-negation", "title-version", "old", "different-topic"] {
            let mut events = base.clone();
            match change {
                "missing" => events[0].evidence[0].excerpt.clear(),
                "summary-only" => {
                    for event in &mut events {
                        event.evidence[0].excerpt = "只有标题，尚无原始材料".into();
                        event.summary = COPY_BODY.into();
                    }
                }
                "body-number" => events[0].evidence[0].excerpt.push_str("共招募 200 人。"),
                "body-negation" => events[0].evidence[0].excerpt.push_str("这项结论已被撤回。"),
                "title-version" => {
                    events[0].evidence[0].title.push_str(" v1.2");
                    events[1].evidence[0].title.push_str(" v12");
                }
                "old" => {
                    events[1].freshness_at = Some(now - Duration::days(5));
                    events[1].published_at = events[1].freshness_at;
                    events[1].evidence[0].original_published_at = events[1].freshness_at;
                }
                _ => events[0].evidence[0].excerpt = "这是另一份合成资料，介绍如何在金融服务中使用模型处理企业报表，而非模型训练研究。数据来自经过授权的结构化记录，处理流程覆盖查询、核对和人工审批。作者分别列出数据访问策略、审计要求和风险控制方法，讨论部署架构与业务流程之间的对应关系。文章没有公布训练实验，也没有声称自主学习效果有所提升，所描述的是另一项独立的产品应用。".into(),
            }
            assert_eq!(rollup_events(events, now).len(), 2, "{change}");
        }
    }

    #[tokio::test]
    async fn publisher_rights_footer_is_not_a_news_negation() {
        let (mut events, now) = copy_fixtures().await;
        events[0].evidence[0].excerpt.push_str("\n\n版权所有，未经授权不得以任何形式转载及使用，违者必究。");
        assert_eq!(rollup_events(events.clone(), now).len(), 1);
        events[0].evidence[0].excerpt.push_str("\n\n更正：本文提到的发布已经取消。");
        assert_eq!(rollup_events(events, now).len(), 2, "a correction after the footer still changes the story");
    }

    #[tokio::test]
    async fn copied_articles_reject_tiny_action_changes_and_relocated_negation() {
        let (base, now) = copy_fixtures().await;
        for (first, second) in [
            ("团队开放服务。", "团队关闭服务。"),
            ("模型不支持金融业务，支持生物研究。", "模型支持金融业务，不支持生物研究。"),
            ("Alpha acquired Beta.", "Beta acquired Alpha."),
        ] {
            let mut events = base.clone();
            events[0].evidence[0].excerpt = format!("{COPY_BODY}\n\n{first}\n\n{COPY_BODY}");
            events[1].evidence[0].excerpt = format!("{COPY_BODY}\n\n{second}\n\n{COPY_BODY}");
            assert_eq!(rollup_events(events, now).len(), 2, "{first} / {second}");
        }
    }

    #[tokio::test]
    async fn copied_title_buckets_are_bounded_and_distinct_material_has_distinct_keys() {
        let (base, now) = copy_fixtures().await;
        let mut events = Vec::new();
        for index in 0..4 {
            let mut event = base[index % 2].clone();
            event.id = Uuid::new_v4();
            event.freshness_at = Some(now);
            event.published_at = Some(now);
            event.evidence[0].original_published_at = Some(now);
            if index >= 2 {
                event.evidence[0].excerpt = "这是另一份合成资料，介绍如何在金融服务中使用模型处理企业报表，而非模型训练研究。数据来自经过授权的结构化记录，处理流程覆盖查询、核对和人工审批。作者分别列出数据访问策略、审计要求和风险控制方法，讨论部署架构与业务流程之间的对应关系。文章没有公布训练实验，也没有声称自主学习效果有所提升，所描述的是另一项独立的产品应用。".into();
            }
            events.push(event);
        }
        let result = rollup_events(events.clone(), now);
        assert_eq!(result.len(), 2);
        let keys: BTreeSet<_> = result.iter().map(|event| event.coverage.as_ref().unwrap().key.clone()).collect();
        assert_eq!(keys.len(), 2);
        assert_eq!(keys, rollup_events(events.into_iter().rev().collect(), now).iter()
            .map(|event| event.coverage.as_ref().unwrap().key.clone()).collect());
        let flood: Vec<_> = (0..=MAX_COPY_CANDIDATES).map(|_| {
            let mut event = base[0].clone();
            event.id = Uuid::new_v4();
            event
        }).collect();
        assert_eq!(rollup_events(flood, now).len(), MAX_COPY_CANDIDATES + 1);
    }

    #[tokio::test]
    async fn development_batches_are_not_versions_or_multi_source_news() {
        let (mut events, now) = fixtures().await;
        events.truncate(2);
        for (index, event) in events.iter_mut().enumerate() {
            event.event_type = "release".into();
            event.title = format!("ciflow/xpu/{}: Internal test update", 202109 + index);
            event.evidence.truncate(1);
            event.evidence[0].title = event.title.clone();
            event.evidence[0].url = format!("https://github.com/pytorch/pytorch/releases/tag/ciflow%2Fxpu%2F{}", 202109 + index);
        }
        let result = rollup_events(events.clone(), now);
        assert_eq!(result.len(), 1);
        let bundle = result[0].coverage.as_ref().unwrap();
        assert_eq!(bundle.relation, "development_activity");
        assert_eq!(bundle.popularity_boost, 0.0);
        assert!(bundle.topic.contains("pytorch/pytorch"));
        events[1].evidence[0].url = "https://github.com/another/project/releases/tag/ciflow%2Fxpu%2F202110".into();
        assert_eq!(rollup_events(events.clone(), now).len(), 2);
        events[1].title = "PyTorch 2.9".into();
        events[1].evidence[0].title = events[1].title.clone();
        events[1].evidence[0].url = "https://github.com/pytorch/pytorch/releases/tag/v2.9.0".into();
        assert_eq!(rollup_events(events, now).len(), 2);
    }

    #[tokio::test]
    #[ignore = "uses the explicitly downloaded public HTML pair, never network or a database"]
    async fn reported_public_copy_uses_the_real_article_parser() {
        let directory = std::path::PathBuf::from(std::env::var("SCOUTNEWS_COPY_FIXTURE_DIR").unwrap());
        let (mut events, mut now) = copy_fixtures().await;
        for (event, name) in events.iter_mut().zip(["qbitai", "aiera"]) {
            let source: serde_json::Value = serde_json::from_slice(
                &std::fs::read(directory.join(format!("reported-{name}.json"))).unwrap()).unwrap();
            let published: DateTime<Utc> = source["publishedAt"].as_str().unwrap().parse().unwrap();
            event.freshness_at = Some(published);
            event.published_at = Some(published);
            event.evidence[0].original_published_at = Some(published);
            now = now.max(published);
            let html = std::fs::read_to_string(directory.join(format!("reported-{name}.html"))).unwrap();
            let (body, _) = crate::reading_context::extract_publisher_article(&html).or_else(|| {
                let page = url::Url::parse("https://aiera.com.cn/asi-post.html?id=120702").unwrap();
                let endpoint = crate::reading_context::public_article_endpoint(&page, &html)?;
                let bytes = std::fs::read(directory.join("reported-aiera-post.json")).unwrap();
                crate::reading_context::extract_public_article_json(&bytes, &endpoint, COPY_TITLE)
            })
                .unwrap_or_else(|| panic!("{name} article extraction failed"));
            println!("{name}: {} original body characters", body.chars().count());
            std::fs::write(directory.join(format!("reported-{name}.body.txt")), &body).unwrap();
            event.evidence[0].excerpt = crate::processing::reading_text(&body.chars().take(3000).collect::<String>());
            event.evidence[0].reading_context = Some(crate::reading_context::ReadingContext::publisher_page(
                event.evidence[0].url.clone(), body, false, now));
        }
        assert_eq!(rollup_events(events, now).len(), 1, "the reported originals must be verified, not title-only guesses");
    }

    #[tokio::test]
    async fn community_is_related_not_corroboration_or_a_summary_merge() {
        let (mut events, now) = fixtures().await;
        events.truncate(2);
        events[1].event_type = "repository".into();
        events[1].title = "tiagovilasboas/grok-bot-architecture".into();
        let original = events[0].clone();
        let result = rollup_events(events, now);
        assert_eq!(result.len(), 2);
        assert!(result.iter().all(|event| event.coverage.is_none()));
        assert_eq!(result[0].evidence.len(), original.evidence.len());
        assert_eq!(result[0].summary, original.summary);
        assert_eq!(result[0].content_version, original.content_version);
    }

    async fn batch_fixtures() -> (Vec<Event>, DateTime<Utc>) {
        let (mut events, now) = fixtures().await;
        events.truncate(2);
        for (index, event) in events.iter_mut().enumerate() {
            let name = format!("Ukraine-Territorial-MCP/UA6102015001004261{index}");
            event.event_type = "repository".into();
            event.title = name.clone();
            event.freshness_at = Some(now - Duration::minutes(index as i64));
            event.published_at = event.freshness_at;
            event.evidence.truncate(1);
            for evidence in &mut event.evidence {
                evidence.title = name.clone();
                evidence.url = format!("https://github.com/{name}");
                evidence.original_published_at = event.freshness_at;
            }
        }
        (events, now)
    }

    #[tokio::test]
    async fn one_accounts_templated_batch_becomes_a_single_row_without_popularity() {
        let (events, now) = batch_fixtures().await;
        let members: BTreeSet<_> = events.iter().map(|event| event.id).collect();
        let result = rollup_events(events.clone(), now);
        assert_eq!(result.len(), 1);
        let bundle = result[0].coverage.as_ref().unwrap();
        assert_eq!(bundle.relation, "bulk_publication");
        assert_eq!(bundle.method, "bulk-template-v1");
        assert_eq!(bundle.window_hours, bulk::WINDOW_HOURS);
        assert_eq!(bundle.popularity_boost, 0.0);
        assert_eq!(bundle.news_material_count, 0);
        assert_eq!(bundle.community_material_count, 2);
        assert!(bundle.topic.contains("Ukraine-Territorial-MCP"), "{}", bundle.topic);
        assert_eq!(bundle.members[0].relationship, "lead");
        assert_eq!(bundle.members[1].relationship, "bulk_publication");
        // Each item keeps its own title and material; nothing is merged away.
        assert_eq!(
            bundle
                .members
                .iter()
                .map(|member| member.event_id)
                .collect::<BTreeSet<_>>(),
            members
        );
        assert!(bundle.members.iter().all(|member| member.title.starts_with(
            "Ukraine-Territorial-MCP/UA"
        )));
        let reversed = rollup_events(events.into_iter().rev().collect(), now);
        assert_eq!(reversed.len(), 1);
        assert_eq!(
            reversed[0]
                .coverage
                .as_ref()
                .unwrap()
                .members
                .iter()
                .map(|member| member.event_id)
                .collect::<BTreeSet<_>>(),
            members
        );
    }

    #[tokio::test]
    async fn batches_need_one_account_a_shared_template_and_community_material() {
        let (events, now) = batch_fixtures().await;
        assert_eq!(rollup_events(events.clone(), now).len(), 1);
        let retitled = |mut events: Vec<Event>, title: &str, url: &str| {
            events[1].title = title.into();
            events[1].evidence[0].title = title.into();
            events[1].evidence[0].url = url.into();
            events
        };
        for (case, pair) in [
            (
                "another account",
                retitled(
                    events.clone(),
                    "Other-Territorial-MCP/UA61020130010032621",
                    "https://github.com/Other-Territorial-MCP/UA61020130010032621",
                ),
            ),
            (
                "another template",
                retitled(
                    events.clone(),
                    "Ukraine-Territorial-MCP/katottg-61020130010032621",
                    "https://github.com/Ukraine-Territorial-MCP/katottg-61020130010032621",
                ),
            ),
            (
                "another host",
                retitled(
                    events.clone(),
                    "Ukraine-Territorial-MCP/UA61020130010032621",
                    "https://gitlab.example/Ukraine-Territorial-MCP/UA61020130010032621",
                ),
            ),
        ] {
            assert_eq!(rollup_events(pair, now).len(), 2, "{case}");
        }
        let mut versions = events.clone();
        for (event, name) in versions.iter_mut().zip(["openai/gpt-4", "openai/gpt-5"]) {
            event.title = name.into();
            event.evidence[0].title = name.into();
            event.evidence[0].url = format!("https://github.com/{name}");
        }
        assert_eq!(rollup_events(versions, now).len(), 2);
        let mut community_prefix = events.clone();
        for (event, path) in community_prefix
            .iter_mut()
            .zip(["1ab2cd3", "1ab2cd4"])
        {
            event.evidence[0].url =
                format!("https://www.reddit.com/r/LocalLLaMA/comments/{path}/ua61020150010042611/");
        }
        assert_eq!(rollup_events(community_prefix, now).len(), 2);
        let mut editorial = events.clone();
        editorial[1].event_type = "blog".into();
        editorial[1].evidence[0].is_official = true;
        editorial[1].evidence[0].source_tier = "T1".into();
        assert_eq!(rollup_events(editorial, now).len(), 2);
        let mut older = events.clone();
        older[1].freshness_at = Some(now - Duration::hours(bulk::WINDOW_HOURS) - Duration::minutes(1));
        older[1].published_at = older[1].freshness_at;
        older[1].evidence[0].original_published_at = older[1].freshness_at;
        assert_eq!(rollup_events(older, now).len(), 2);
    }

    #[tokio::test]
    async fn ubiquitous_names_and_domain_conflicts_never_create_a_bundle() {
        let (mut events, now) = fixtures().await;
        events.truncate(2);
        for (event, (title, url)) in events.iter_mut().zip([
            (
                "How a researcher uses Codex and ChatGPT to search for new antimicrobial molecules",
                "https://openai.example/research/antimicrobials",
            ),
            (
                "Introducing ChatGPT for Financial Services",
                "https://openai.example/business/financial-services",
            ),
        ]) {
            event.title = title.into();
            event.evidence[0].title = title.into();
            event.evidence[0].url = url.into();
        }
        let result = rollup_events(events, now);
        assert_eq!(result.len(), 2);
        assert!(result.iter().all(|event| event.coverage.is_none()));
    }

    async fn announcement_fixtures() -> (Vec<Event>, DateTime<Utc>) {
        let (mut events, now) = fixtures().await;
        events.truncate(2);
        for (event, (title, url, tier, official)) in events.iter_mut().zip([
            (
                "Introducing Claude Haiku 5.5",
                "https://www.anthropic.com/claude-haiku-5-5",
                "T1",
                true,
            ),
            (
                "Claude Haiku 5.5",
                "https://simonwillison.net/2026/Oct/7/claude-haiku-5-5/",
                "T2",
                true,
            ),
        ]) {
            event.event_type = "blog".into();
            event.title = title.into();
            event.evidence.truncate(1);
            event.evidence[0].title = title.into();
            event.evidence[0].url = url.into();
            event.evidence[0].source_tier = tier.into();
            event.evidence[0].is_official = official;
        }
        events[0].publication_precision = Some("day".into());
        (events, now)
    }

    #[tokio::test]
    async fn radar_announcement_groups_official_launch_and_exact_version_commentary() {
        let (events, now) = announcement_fixtures().await;
        let original = events.clone();
        let result = rollup_events(events, now);
        assert_eq!(result.len(), 1);
        let bundle = result[0].coverage.as_ref().unwrap();
        assert_eq!(bundle.method, "official-announcement-v1");
        assert_eq!(bundle.topic, "Introducing Claude Haiku 5.5");
        assert_eq!(bundle.relation, "same_event_evidence");
        assert_eq!(bundle.official_source_count, 1);
        assert_eq!(bundle.editorial_source_count, 1);
        assert_eq!(bundle.popularity_boost, 0.0);
        for (member, event) in bundle.members.iter().zip(&original) {
            assert_eq!(member.event_id, event.id);
            assert_eq!(member.summary, event.summary);
            assert_eq!(member.title, event.title);
            assert_eq!(member.published_at, event.published_at);
            assert_eq!(member.publication_precision, event.publication_precision);
            assert_eq!(member.evidence[0].url, event.evidence[0].url);
        }
        let mut reversed = original;
        reversed.reverse();
        let other = rollup_events(reversed, now);
        assert_eq!(other.len(), 1);
        assert_eq!(other[0].coverage.as_ref().unwrap().key, bundle.key);
        assert_eq!(other[0].coverage.as_ref().unwrap().topic, bundle.topic);
    }

    #[tokio::test]
    async fn radar_announcement_requires_official_anchor_and_exact_source_headline() {
        let (events, now) = announcement_fixtures().await;
        for headline in [
            "Claude Haiku 4.5",
            "Claude Sonnet 5.5",
            "Using Claude Haiku 5.5 for financial services",
            "Claude Haiku 5.5 vs GPT-6 Luna",
            "Claude Haiku 5.5 pricing changes",
        ] {
            let mut changed = events.clone();
            changed[1].title = headline.into();
            changed[1].evidence[0].title = headline.into();
            changed[1].display_title = Some("Claude Haiku 5.5".into());
            assert_eq!(rollup_events(changed, now).len(), 2, "{headline}");
        }
        let mut no_anchor = events.clone();
        no_anchor[0].evidence[0].source_tier = "T2".into();
        assert_eq!(rollup_events(no_anchor, now).len(), 2);
        let mut root_page = events.clone();
        root_page[0].evidence[0].url = "https://www.anthropic.com/".into();
        assert_eq!(rollup_events(root_page, now).len(), 2);
        let mut sponsor = events.clone();
        sponsor[1].title = "A different article".into();
        sponsor[1].evidence[0].title = "A different article".into();
        sponsor[1].evidence[0].excerpt =
            "Sponsor: Introducing Claude Haiku 5.5 https://www.anthropic.com/claude-haiku-5-5"
                .into();
        assert_eq!(rollup_events(sponsor, now).len(), 2);
        let mut community = events.clone();
        community[1].event_type = "repository".into();
        assert_eq!(rollup_events(community, now).len(), 2);
        let mut old = events;
        old[1].freshness_at = Some(now - Duration::days(8));
        assert_eq!(rollup_events(old, now).len(), 2);
    }

    #[tokio::test]
    async fn radar_announcement_requires_known_past_dates_and_never_bridges_a_week() {
        let (events, now) = announcement_fixtures().await;
        let mut future = events.clone();
        future[0].freshness_at = Some(now + Duration::seconds(1));
        assert_eq!(rollup_events(future, now).len(), 2);
        let mut unknown = events.clone();
        unknown[0].freshness_at = None;
        unknown[0].published_at = None;
        assert_eq!(rollup_events(unknown, now).len(), 2);
        let mut spread = events.clone();
        let mut earlier = events[1].clone();
        earlier.id = Uuid::new_v4();
        earlier.evidence[0].id = Uuid::new_v4();
        earlier.freshness_at = Some(now - Duration::days(8));
        spread[0].freshness_at = Some(now - Duration::days(4));
        spread.push(earlier.clone());
        let result = rollup_events(spread, now);
        assert_eq!(result.len(), 2);
        assert!(
            result
                .iter()
                .any(|event| event.id == earlier.id && event.coverage.is_none())
        );
        for event in result {
            if let Some(bundle) = event.coverage {
                assert_eq!(bundle.members.len(), 2);
            }
        }
    }

    #[tokio::test]
    async fn radar_announcement_never_conflates_model_variants_or_ambiguous_launches() {
        let (events, now) = announcement_fixtures().await;
        for (official, commentary) in [
            ("Introducing GPT-6 Sol", "GPT-6 Luna"),
            ("Introducing Gemini 3.5 Pro", "Gemini 3.5 Flash"),
            ("Introducing Qwen3.8-27B", "Qwen3.8-35B"),
            ("Introducing Claude Haiku 5.5", "Claude Haiku 55"),
        ] {
            let mut changed = events.clone();
            changed[0].evidence[0].title = official.into();
            changed[1].evidence[0].title = commentary.into();
            assert_eq!(rollup_events(changed, now).len(), 2, "{official}");
        }
        let mut ambiguous = events.clone();
        let mut second_official = events[0].clone();
        second_official.id = Uuid::new_v4();
        second_official.evidence[0].id = Uuid::new_v4();
        second_official.evidence[0].url = "https://other.example/claude-haiku-5-5".into();
        ambiguous.push(second_official);
        assert_eq!(rollup_events(ambiguous, now).len(), 3);
    }

    async fn language_release_fixtures() -> (Vec<Event>, DateTime<Utc>) {
        let (mut events, now) = fixtures().await;
        events.truncate(2);
        for (index, (event, (title, notes))) in events
            .iter_mut()
            .zip([
                (
                    "python-1.21.0",
                    "Python tool-result guidance and Purview evaluation (#8784).",
                ),
                (
                    "dotnet-1.24.0",
                    ".NET session state and release solution corrections (#9012, #9140).",
                ),
            ])
            .enumerate()
        {
            event.event_type = "release".into();
            event.title = title.into();
            event.freshness_at = Some(now - Duration::hours(1 + 21 * index as i64));
            event.published_at = event.freshness_at;
            event.publication_precision = Some("time".into());
            event.evidence.truncate(1);
            let evidence = &mut event.evidence[0];
            evidence.title = title.into();
            evidence.url =
                format!("https://github.com/microsoft/agent-framework/releases/tag/{title}");
            evidence.is_official = true;
            evidence.source_tier = "T1".into();
            evidence.original_published_at = event.published_at;
            evidence.excerpt = notes.into();
        }
        (events, now)
    }

    #[tokio::test]
    async fn radar_language_releases_form_a_project_roundup_not_a_shared_change_claim() {
        let (events, now) = language_release_fixtures().await;
        let original = events.clone();
        let result = rollup_events(events, now);
        assert_eq!(result.len(), 1);
        let bundle = result[0].coverage.as_ref().unwrap();
        assert_eq!(bundle.method, "project-release-window-v1");
        assert_eq!(bundle.relation, "release_family");
        assert_eq!(
            bundle.topic,
            "agent-framework 多语言更新：Python 1.21.0 / .NET 1.24.0"
        );
        assert_eq!(bundle.window_hours, 24);
        assert_eq!(bundle.official_source_count, 1);
        assert_eq!(bundle.popularity_boost, 0.0);
        assert_eq!(bundle.members[0].release_target.as_deref(), Some("Python"));
        assert_eq!(bundle.members[0].release_version.as_deref(), Some("1.21.0"));
        assert_eq!(bundle.members[1].release_target.as_deref(), Some(".NET"));
        assert_eq!(bundle.members[1].release_version.as_deref(), Some("1.24.0"));
        for (member, event) in bundle.members.iter().zip(&original) {
            assert_eq!(member.summary, event.summary);
            assert_eq!(member.evidence[0].excerpt, event.evidence[0].excerpt);
        }
        let mut reversed = original;
        reversed.reverse();
        let other = rollup_events(reversed, now);
        assert_eq!(other[0].coverage.as_ref().unwrap().key, bundle.key);
        assert_eq!(other[0].coverage.as_ref().unwrap().topic, bundle.topic);
    }

    #[tokio::test]
    async fn radar_language_releases_need_one_official_repository_and_day() {
        let (events, now) = language_release_fixtures().await;
        for url in [
            "https://github.com/fork/agent-framework/releases/tag/dotnet-1.24.0",
            "https://github.com/microsoft/other/releases/tag/dotnet-1.24.0",
        ] {
            let mut changed = events.clone();
            changed[1].evidence[0].url = url.into();
            assert_eq!(rollup_events(changed, now).len(), 2, "{url}");
        }
        // The repository is the row identity; unverifiable language pairs stay a neutral roundup.
        for (title, tag, topic) in [
            ("dotnet-1.24.0", "dotnet-1.23.0", "agent-framework 版本更新：Python 1.21.0 / dotnet 1.24.0"),
            ("python-1.20.0", "python-1.20.0", "agent-framework Python 版本更新：1.21.0 / 1.20.0"),
            ("unrelated-1.24.0", "unrelated-1.24.0", "agent-framework 版本更新：Python 1.21.0 / unrelated 1.24.0"),
        ] {
            let mut changed = events.clone();
            changed[1].title = title.into();
            changed[1].evidence[0].title = title.into();
            changed[1].evidence[0].url =
                format!("https://github.com/microsoft/agent-framework/releases/tag/{tag}");
            let grouped = rollup_events(changed, now);
            assert_eq!(grouped.len(), 1, "{tag}");
            let bundle = grouped[0].coverage.as_ref().unwrap();
            assert_eq!(bundle.method, "project-release-window-v2", "{tag}");
            assert_eq!(bundle.topic, topic, "{tag}");
            assert_eq!(bundle.popularity_boost, 0.0);
        }
        let mut old = events.clone();
        old[1].freshness_at = Some(now - Duration::hours(26));
        assert_eq!(rollup_events(old, now).len(), 2);
        let mut imprecise = events.clone();
        imprecise[1].publication_precision = Some("day".into());
        assert_eq!(rollup_events(imprecise, now).len(), 2);
        let mut no_notes = events;
        no_notes[1].evidence[0].excerpt.clear();
        let grouped = rollup_events(no_notes, now);
        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped[0].coverage.as_ref().unwrap().method, "project-release-window-v2");
    }

    #[tokio::test]
    async fn radar_language_windows_keep_the_time_boundary_and_mark_mixed_channels_as_roundups() {
        let (events, now) = language_release_fixtures().await;
        let mut boundary = events.clone();
        boundary[1].freshness_at = Some(now - Duration::hours(25));
        assert_eq!(rollup_events(boundary.clone(), now).len(), 1);
        boundary[1].freshness_at = Some(now - Duration::hours(25) - Duration::seconds(1));
        assert_eq!(rollup_events(boundary, now).len(), 2);
        for (first, second) in [
            ("python-1.21.0-rc.1", "dotnet-1.24.0"),
            ("python-1.21.0", "py-1.20.0"),
            ("javascript-1.21.0", "node-1.24.0"),
            ("python-01.21.0", "dotnet-1.24.0"),
        ] {
            let mut changed = events.clone();
            for (event, title) in changed.iter_mut().zip([first, second]) {
                event.title = title.into();
                event.evidence[0].title = title.into();
                event.evidence[0].url =
                    format!("https://github.com/microsoft/agent-framework/releases/tag/{title}");
            }
            // Channels and aliases are not a verified multi-language batch, but one project day is one row.
            let grouped = rollup_events(changed, now);
            assert_eq!(grouped.len(), 1, "{first} / {second}");
            let bundle = grouped[0].coverage.as_ref().unwrap();
            assert_eq!(bundle.method, "project-release-window-v2", "{first} / {second}");
            assert!(!bundle.topic.contains("同批"), "{}", bundle.topic);
        }
    }

    #[tokio::test]
    async fn radar_new_grouping_methods_preserve_already_captured_snapshot_content() {
        for (events, now) in [
            announcement_fixtures().await,
            language_release_fixtures().await,
        ] {
            let mut captured = rollup_events(events, now);
            captured[0].coverage.as_mut().unwrap().topic = "Captured group heading".into();
            let before = serde_json::to_value(&captured).unwrap();
            let after = rollup_release_snapshots(captured, now + Duration::days(20));
            assert_eq!(serde_json::to_value(&after).unwrap(), before);
        }
    }

    #[tokio::test]
    async fn casing_and_incidental_references_do_not_prove_an_event() {
        let (mut events, now) = fixtures().await;
        events.truncate(2);
        for (event, (title, url)) in events.iter_mut().zip([
            (
                "Get ready for iPhone Duo",
                "https://developer.apple.example/news/iphone-duo",
            ),
            (
                "The iPhone Duo, The Intelligent Personal Hub",
                "https://stratechery.example/iphone-duo-analysis",
            ),
        ]) {
            event.title = title.into();
            event.evidence[0].title = title.into();
            event.evidence[0].url = url.into();
            event.evidence[0].excerpt =
                "Sponsor: https://github.com/example/project/pull/42".into();
        }
        let result = rollup_events(events, now);
        assert_eq!(result.len(), 2);
        assert!(result.iter().all(|event| event.coverage.is_none()));
        assert_eq!(result[0].title, "Get ready for iPhone Duo");
    }

    #[tokio::test]
    async fn popularity_is_bounded_freshness_decayed_and_publishers_unique() {
        let (mut events, now) = fixtures().await;
        events.truncate(2);
        for event in &mut events {
            event.evidence[0].url = "https://github.com/example/project/releases/tag/v1.2.3".into();
        }
        let mut records: Vec<_> = events.iter().map(Record::from_event).collect();
        records[0].sources[0].publisher = "publisher-a".into();
        records[1].sources[0].publisher = "publisher-b".into();
        let first = groups(
            &records,
            &events.iter().map(|event| event.id).collect::<Vec<_>>(),
            now,
        );
        let boost = first[0].bundle.as_ref().unwrap().popularity_boost;
        assert!(boost > 0.0 && boost <= 3.0);
        let older = groups(
            &records,
            &events.iter().map(|event| event.id).collect::<Vec<_>>(),
            now + Duration::days(3),
        );
        assert!(older[0].bundle.as_ref().unwrap().popularity_boost <= boost / 7.9);
    }

    #[tokio::test]
    async fn old_unknown_future_and_different_versions_stay_separate() {
        let (mut events, now) = fixtures().await;
        events[1].freshness_at = Some(now - Duration::days(8));
        events[2].freshness_at = None;
        events[2].published_at = None;
        events[3].freshness_at = Some(now + Duration::days(1));
        events[4].title = "Grok Bot 2".into();
        events[4]
            .evidence
            .iter_mut()
            .for_each(|e| e.title = "Grok Bot 2".into());
        assert_eq!(rollup_events(events, now).len(), 5);
    }

    #[tokio::test]
    async fn related_only_repo_cannot_lead_or_refresh_news() {
        let (mut events, now) = fixtures().await;
        events.truncate(2);
        events[0].freshness_at = Some(now - Duration::days(6));
        events[1].event_type = "repository".into();
        let records: Vec<_> = events.iter().map(Record::from_event).collect();
        let groups = groups(&records, &[events[0].id], now);
        assert_eq!(groups[0].lead, events[0].id);
        assert!(groups[0].bundle.is_none());
        events.reverse();
        let result = rollup_events(events, now);
        assert_eq!(result.len(), 2);
    }

    #[tokio::test]
    async fn explicit_homonyms_do_not_bridge_through_an_unqualified_article() {
        let (mut events, now) = fixtures().await;
        events.truncate(3);
        for (event, title) in
            events
                .iter_mut()
                .zip(["Nova Studio", "Nova Studio (Acme)", "Nova Studio (Other)"])
        {
            event.title = title.into();
            for e in &mut event.evidence {
                e.title = title.into();
                e.excerpt = String::new();
            }
        }
        assert_eq!(rollup_events(events, now).len(), 3);
    }

    #[tokio::test]
    async fn shared_immutable_reference_is_explicit_and_same_publisher_has_no_extra_boost() {
        let (mut events, now) = fixtures().await;
        events.truncate(2);
        for event in &mut events {
            for evidence in &mut event.evidence {
                evidence.url = "https://github.com/example/grok-bot/releases/tag/v1.2.3".into();
                evidence.excerpt.clear();
            }
        }
        let result = rollup_events(events, now);
        let bundle = result[0].coverage.as_ref().unwrap();
        assert_eq!(bundle.relation, "same_event_evidence");
        assert_eq!(bundle.editorial_source_count, 1);
        assert_eq!(bundle.popularity_boost, 0.0);
        assert_eq!(bundle.members[1].relationship, "same_event_evidence");
    }

    #[tokio::test]
    async fn a_shared_secondary_name_cannot_chain_unrelated_topics() {
        let (mut events, now) = fixtures().await;
        events.truncate(3);
        for (event, title) in
            events
                .iter_mut()
                .zip(["Nova Studio", "Nova Studio / Lunar Kit", "Lunar Kit"])
        {
            event.title = title.into();
            for e in &mut event.evidence {
                e.title = title.into();
                e.excerpt = String::new();
            }
        }
        let result = rollup_events(events, now);
        assert_eq!(result.len(), 3);
        assert!(result.iter().all(|event| event.coverage.is_none()));
    }

    #[tokio::test]
    async fn time_cohorts_never_chain_past_seven_days_and_pagination_is_stable() {
        let (mut events, now) = fixtures().await;
        for (i, event) in events.iter_mut().enumerate() {
            event.freshness_at = Some(now - Duration::days(i as i64 * 3));
            event.published_at = event.freshness_at;
        }
        let first = rollup_events(events.clone(), now);
        let second = rollup_events(events, now);
        assert_eq!(
            first.iter().map(|e| e.id).collect::<Vec<_>>(),
            second.iter().map(|e| e.id).collect::<Vec<_>>()
        );
        let mut ids = HashSet::new();
        for event in first {
            if let Some(bundle) = event.coverage {
                let dates: Vec<_> = bundle
                    .members
                    .iter()
                    .filter_map(|m| m.published_at)
                    .collect();
                assert!(
                    *dates.iter().max().unwrap() - *dates.iter().min().unwrap()
                        <= Duration::hours(WINDOW_HOURS)
                );
                for member in bundle.members {
                    assert!(ids.insert(member.event_id));
                }
            } else {
                assert!(ids.insert(event.id));
            }
        }
        assert_eq!(ids.len(), 5);
    }

    #[tokio::test]
    async fn publication_and_precision_are_preserved_separately_from_grouping_freshness() {
        let (mut events, now) = fixtures().await;
        events.truncate(2);
        events[0].published_at = Some(now);
        events[0].publication_precision = Some("day".into());
        events[0].freshness_at = Some(now - Duration::days(3));
        for event in &mut events {
            event.evidence[0].url = "https://arxiv.org/abs/2609.12345".into();
        }
        let expected = events[0].clone();
        let result = rollup_events(events, now);
        let member = &result[0].coverage.as_ref().unwrap().members[0];
        assert_eq!(member.published_at, expected.published_at);
        assert_eq!(member.publication_precision, expected.publication_precision);
        assert_eq!(result[0].freshness_at, expected.freshness_at);
        assert!(result[0].coverage.as_ref().unwrap().popularity_boost <= 0.125);
    }

    async fn plugin_fixtures() -> (Vec<Event>, DateTime<Utc>) {
        let (mut events, now) = fixtures().await;
        events.truncate(4);
        for (event, (target, tag)) in events.iter_mut().zip([
            ("Pi Agent", "pi-agent-v0.3.0"),
            ("OpenCode", "opencode-v0.3.0"),
            ("DeepSeek", "deepseek-plugin-v0.3.0"),
            ("OpenClaw", "openclaw-v1.1.0"),
        ]) {
            let version = tag.rsplit_once("-v").unwrap().1;
            event.title = format!("Mem0 {target} Plugin (v{version})");
            event.event_type = "release".into();
            event.publication_precision = Some("time".into());
            event.evidence.truncate(1);
            for evidence in &mut event.evidence {
                evidence.title = event.title.clone();
                evidence.url = format!("https://github.com/mem0ai/mem0/releases/tag/{tag}");
                evidence.is_official = true;
                evidence.source_tier = "T1".into();
                evidence.excerpt = "Shared infrastructure update. #7203".into();
            }
        }
        (events, now)
    }

    #[tokio::test]
    async fn release_family_groups_distinct_plugins_with_independent_versions_into_one_brief_slot()
    {
        let (events, now) = plugin_fixtures().await;
        let originals = events.clone();
        let grouped = rollup_events(events, now);
        assert_eq!(grouped.len(), 1);
        let bundle = grouped[0].coverage.as_ref().unwrap();
        assert_eq!(bundle.topic, "Mem0 插件更新：DeepSeek / OpenClaw 等4项");
        assert_eq!(bundle.relation, "release_family");
        assert_eq!(bundle.method, "release-family-v2");
        assert_eq!(bundle.window_hours, 24);
        assert_eq!(bundle.material_count, 4);
        assert_eq!(bundle.official_source_count, 1);
        assert_eq!(bundle.editorial_source_count, 0);
        assert_eq!(bundle.popularity_boost, 0.0);
        assert_eq!(
            bundle
                .members
                .iter()
                .filter(|m| m.release_version.as_deref() == Some("v0.3.0"))
                .count(),
            3
        );
        assert_eq!(bundle.members[3].release_version.as_deref(), Some("v1.1.0"));
        for (member, original) in bundle.members.iter().zip(&originals) {
            assert_eq!(member.event_id, original.id);
            assert_eq!(member.content_version, original.content_version);
            assert_eq!(member.summary, original.summary);
            assert_eq!(member.published_at, original.published_at);
        }
        assert_eq!(crate::reader::select_brief(grouped, now).items.len(), 1);
    }

    #[tokio::test]
    async fn release_family_rule_is_not_specific_to_mem0() {
        let (mut events, now) = plugin_fixtures().await;
        for event in &mut events {
            event.title = event.title.replace("Mem0", "Acme Memory");
            for evidence in &mut event.evidence {
                evidence.title = event.title.clone();
                evidence.url = evidence.url.replace("mem0ai/mem0", "acme/acme-memory");
            }
        }
        let grouped = rollup_events(events, now);
        assert_eq!(grouped.len(), 1);
        assert_eq!(
            grouped[0].coverage.as_ref().unwrap().topic,
            "Acme Memory 插件更新：DeepSeek / OpenClaw 等4项"
        );
    }

    async fn client_fixtures() -> (Vec<Event>, DateTime<Utc>) {
        let (base, now) = plugin_fixtures().await;
        let releases = [
            ("Mem0 Node CLI (v0.2.14)", "cli-node-v0.2.14"),
            ("Mem0 Python CLI (v0.2.13)", "cli-v0.2.13"),
            ("Mem0 Node SDK (v3.2.0)", "ts-v3.2.0"),
            ("Mem0 Python SDK (v2.1.0)", "v2.1.0"),
            ("Vercel AI SDK Provider (v3.0.3)", "vercel-ai-v3.0.3"),
        ];
        let events = releases
            .into_iter()
            .enumerate()
            .map(|(index, (title, tag))| {
                let mut event = base[0].clone();
                event.id = Uuid::new_v4();
                event.title = title.into();
                event.freshness_at = Some(now - Duration::minutes(index as i64));
                event.published_at = event.freshness_at;
                let evidence = &mut event.evidence[0];
                evidence.id = Uuid::new_v4();
                evidence.title = title.into();
                evidence.url = format!("https://github.com/mem0ai/mem0/releases/tag/{tag}");
                evidence.original_published_at = event.freshness_at;
                evidence.excerpt = "Client: Forward surface-identity headers. #7326".into();
                event
            })
            .collect();
        (events, now)
    }

    #[tokio::test]
    async fn release_family_clients_share_a_change_without_losing_component_identity() {
        let (events, now) = client_fixtures().await;
        let originals: HashMap<_, _> = events
            .iter()
            .map(|event| (event.id, event.clone()))
            .collect();
        let grouped = rollup_events(events, now);
        assert_eq!(grouped.len(), 1);
        let bundle = grouped[0].coverage.as_ref().unwrap();
        assert_eq!(bundle.topic, "Mem0 客户端更新：调用来源标识");
        assert_eq!(bundle.method, "release-family-v2");
        assert_eq!(bundle.members.len(), 5);
        let targets: BTreeSet<_> = bundle
            .members
            .iter()
            .map(|member| member.release_target.as_deref().unwrap())
            .collect();
        assert_eq!(
            targets,
            BTreeSet::from([
                "Node CLI",
                "Python CLI",
                "Node SDK",
                "Python SDK",
                "Vercel AI SDK Provider",
            ])
        );
        assert_eq!(bundle.popularity_boost, 0.0);
        for member in &bundle.members {
            assert_eq!(member.summary, originals[&member.event_id].summary);
            assert_eq!(member.title, originals[&member.event_id].title);
            assert_eq!(
                member.published_at,
                originals[&member.event_id].published_at
            );
        }
        let mut provider_first: Vec<_> = originals.into_values().collect();
        provider_first.sort_by_key(|event| !event.title.starts_with("Vercel"));
        assert_eq!(
            rollup_events(provider_first, now)[0]
                .coverage
                .as_ref()
                .unwrap()
                .topic,
            bundle.topic
        );
    }

    #[tokio::test]
    async fn release_family_clients_without_a_shared_change_are_only_a_project_roundup() {
        let (events, now) = client_fixtures().await;
        for case in 0..7 {
            let mut pair = events[..2].to_vec();
            let other = &mut pair[1];
            let separate = match case {
                0 => {
                    other.evidence[0].excerpt.clear();
                    false
                }
                1 => {
                    other.evidence[0].excerpt = "Other client change #9999".into();
                    false
                }
                2 => {
                    other.evidence[0].url = other.evidence[0].url.replace("mem0ai", "fork");
                    true
                }
                3 => {
                    other.evidence[0].title = "Other Product Python CLI (v0.2.13)".into();
                    false
                }
                4 => {
                    other.evidence[0].url = other.evidence[0].url.replace("cli-v", "other-v");
                    false
                }
                5 => {
                    other.publication_precision = Some("day".into());
                    true
                }
                _ => {
                    other.evidence[0].is_official = false;
                    true
                }
            };
            let grouped = rollup_events(pair, now);
            assert_eq!(grouped.len(), if separate { 2 } else { 1 }, "case {case}");
            if let Some(bundle) = grouped[0].coverage.as_ref().filter(|_| !separate) {
                assert_eq!(bundle.method, "project-release-window-v2", "case {case}");
                assert!(!bundle.topic.contains("调用来源标识"), "case {case}: {}", bundle.topic);
                assert_eq!(bundle.popularity_boost, 0.0);
            }
        }
        let mut same_component = vec![events[2].clone(), events[2].clone()];
        same_component[1].id = Uuid::new_v4();
        same_component[1].evidence[0].title = "Mem0 TypeScript SDK (v3.2.1)".into();
        same_component[1].evidence[0].url =
            "https://github.com/mem0ai/mem0/releases/tag/typescript-v3.2.1".into();
        let grouped = rollup_events(same_component, now);
        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped[0].coverage.as_ref().unwrap().method, "project-release-window-v2");
    }

    #[tokio::test]
    async fn release_family_client_rule_and_fallback_labels_are_project_independent() {
        let (mut events, now) = client_fixtures().await;
        events.truncate(4);
        for event in &mut events {
            event.title = event.title.replace("Mem0", "Acme Memory");
            event.evidence[0].title = event.title.clone();
            event.evidence[0].url = event.evidence[0]
                .url
                .replace("mem0ai/mem0", "acme/acme-memory");
            event.evidence[0].excerpt = "Shared request update #1200".into();
        }
        let grouped = rollup_events(events, now);
        assert_eq!(grouped.len(), 1);
        assert_eq!(
            grouped[0].coverage.as_ref().unwrap().topic,
            "Acme Memory 客户端更新：Node CLI / Node SDK 等4项"
        );
    }

    async fn package_fixtures() -> (Vec<Event>, DateTime<Utc>) {
        let (mut events, _) = plugin_fixtures().await;
        events.truncate(2);
        for (index, (event, (title, tag, published, excerpt))) in events
            .iter_mut()
            .zip([
                (
                    "langgraph==1.2.12",
                    "1.2.12",
                    "2026-09-21T14:43:40Z",
                    "feat(langgraph): add response_schema to interrupt() #8886 \
                     release(langgraph) #8987 dependency batch #8779 \
                     #8569 #8596 #8782 #8783 #8792 #8804 #8958",
                ),
                (
                    "langgraph-sdk==0.4.5",
                    "sdk%3D%3D0.4.5",
                    "2026-09-21T14:43:09Z",
                    "feat(langgraph): add response_schema to interrupt() #8886 \
                     release(langgraph) #8987 dependency batch #8779 \
                     #8781 #8988 #8994 #8997 #8998",
                ),
            ])
            .enumerate()
        {
            event.id = Uuid::from_u128(100 + index as u128);
            event.title = title.into();
            event.published_at = Some(published.parse().unwrap());
            event.freshness_at = event.published_at;
            let evidence = &mut event.evidence[0];
            evidence.id = Uuid::from_u128(200 + index as u128);
            evidence.title = title.into();
            evidence.url = format!("https://github.com/langchain-ai/langgraph/releases/tag/{tag}");
            evidence.original_published_at = event.published_at;
            evidence.excerpt = excerpt.into();
        }
        let cutoff = events[0].published_at.unwrap() + Duration::hours(1);
        (events, cutoff)
    }

    async fn scoped_package_fixtures() -> (Vec<Event>, DateTime<Utc>) {
        let (mut events, _) = plugin_fixtures().await;
        events.truncate(4);
        for (index, (event, (title, tag, published, excerpt))) in events
            .iter_mut()
            .zip([
                (
                    "@modelcontextprotocol/server@2.2.0",
                    "%40modelcontextprotocol%2Fserver%402.2.0",
                    "2026-09-29T03:07:55Z",
                    "Patch Changes #2885 9dd722f Thanks @claude!",
                ),
                (
                    "@modelcontextprotocol/core@2.2.0",
                    "%40modelcontextprotocol%2Fcore%402.2.0",
                    "2026-09-29T03:07:52Z",
                    "Minor Changes #2887 edd12e2 Thanks @maxisbey!",
                ),
                (
                    "@modelcontextprotocol/codemod@2.2.0",
                    "%40modelcontextprotocol%2Fcodemod%402.2.0",
                    "2026-09-29T03:07:49Z",
                    "Patch Changes #2582 f091897 Thanks @axits-lab!",
                ),
                (
                    "@modelcontextprotocol/client@2.2.0",
                    "%40modelcontextprotocol%2Fclient%402.2.0",
                    "2026-09-29T03:07:46Z",
                    "Minor Changes #2887 edd12e2 Thanks @maxisbey!",
                ),
            ])
            .enumerate()
        {
            event.id = Uuid::from_u128(300 + index as u128);
            event.title = title.into();
            event.published_at = Some(published.parse().unwrap());
            event.freshness_at = event.published_at;
            let evidence = &mut event.evidence[0];
            evidence.id = Uuid::from_u128(400 + index as u128);
            evidence.title = title.into();
            evidence.url = format!(
                "https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/{tag}"
            );
            evidence.original_published_at = event.published_at;
            evidence.excerpt = excerpt.into();
        }
        let cutoff = events[0].published_at.unwrap() + Duration::hours(1);
        (events, cutoff)
    }

    #[tokio::test]
    async fn coordinated_scoped_packages_group_same_repo_scope_and_version() {
        let (events, cutoff) = scoped_package_fixtures().await;
        let originals = events.clone();
        let grouped = rollup_events(events, cutoff);
        assert_eq!(grouped.len(), 1);
        let bundle = grouped[0].coverage.as_ref().unwrap();
        assert_eq!(
            bundle.topic,
            "@modelcontextprotocol 2.2.0 同批发布：server / core / codemod 等4项"
        );
        assert_eq!(bundle.relation, "release_family");
        assert_eq!(bundle.method, "release-family-v2");
        assert_eq!(bundle.window_hours, 24);
        assert_eq!(bundle.material_count, 4);
        assert_eq!(bundle.official_source_count, 1);
        assert_eq!(bundle.popularity_boost, 0.0);
        assert_eq!(
            bundle
                .members
                .iter()
                .map(|member| (
                    member.release_target.as_deref().unwrap(),
                    member.release_version.as_deref().unwrap()
                ))
                .collect::<Vec<_>>(),
            vec![
                ("server", "2.2.0"),
                ("core", "2.2.0"),
                ("codemod", "2.2.0"),
                ("client", "2.2.0"),
            ]
        );
        for (member, original) in bundle.members.iter().zip(originals) {
            assert_eq!(member.event_id, original.id);
            assert_eq!(member.title, original.title);
            assert_eq!(member.summary, original.summary);
            assert_eq!(
                serde_json::to_value(&member.evidence).unwrap(),
                serde_json::to_value(&original.evidence).unwrap()
            );
        }
    }

    #[tokio::test]
    async fn scoped_package_batch_titles_need_exact_identity_and_projects_stay_bounded() {
        let (events, cutoff) = scoped_package_fixtures().await;
        for case in 0..7 {
            let mut pair = events[..2].to_vec();
            let lead_published_at = pair[0].published_at.unwrap();
            let other = &mut pair[1];
            match case {
                0 => {
                    other.evidence[0].title = "@modelcontextprotocol/core@2.2.1".into();
                    other.evidence[0].url = other.evidence[0].url.replace("2.2.0", "2.2.1");
                }
                1 => {
                    other.evidence[0].title = "@another-scope/core@2.2.0".into();
                    other.evidence[0].url = other.evidence[0]
                        .url
                        .replace("modelcontextprotocol%2Fcore", "another-scope%2Fcore");
                }
                2 => {
                    other.evidence[0].url = other.evidence[0].url.replace(
                        "modelcontextprotocol/typescript-sdk",
                        "another/typescript-sdk",
                    );
                }
                3 => {
                    other.evidence[0].url = other.evidence[0].url.replace("%2F", "%252F");
                }
                4 => {
                    other.evidence[0].title = "@modelcontextprotocol/server@2.2.0".into();
                    other.evidence[0].url = other.evidence[0].url.replace("core", "server");
                }
                5 => {
                    let old = lead_published_at - Duration::hours(25);
                    other.published_at = Some(old);
                    other.freshness_at = Some(old);
                    other.evidence[0].original_published_at = Some(old);
                }
                _ => other.evidence[0].excerpt = "Release notes without a change reference".into(),
            }
            let grouped = rollup_events(pair, cutoff);
            if matches!(case, 2 | 5) {
                assert_eq!(grouped.len(), 2, "case {case}");
                continue;
            }
            // Same repository and day: one row, but never the exact same-version batch title.
            assert_eq!(grouped.len(), 1, "case {case}");
            let bundle = grouped[0].coverage.as_ref().unwrap();
            assert_eq!(bundle.method, "project-release-window-v2", "case {case}");
            assert!(!bundle.topic.contains("同批"), "case {case}: {}", bundle.topic);
        }
    }

    #[tokio::test]
    async fn release_family_packages_preserve_langgraph_core_and_sdk_materials() {
        let (events, cutoff) = package_fixtures().await;
        let originals = events.clone();
        let grouped = rollup_events(events, cutoff);
        assert_eq!(grouped.len(), 1);
        let bundle = grouped[0].coverage.as_ref().unwrap();
        assert_eq!(
            bundle.topic,
            "langgraph 同批更新：核心包 1.2.12 / SDK 0.4.5"
        );
        assert_eq!(bundle.relation, "release_family");
        assert_eq!(bundle.method, "release-family-v2");
        assert!(
            bundle
                .key
                .contains("github.com/langchain-ai/langgraph:package:")
        );
        assert_eq!(bundle.window_hours, 24);
        assert_eq!(bundle.material_count, 2);
        assert_eq!(bundle.official_source_count, 1);
        assert_eq!(bundle.editorial_source_count, 0);
        assert_eq!(bundle.popularity_boost, 0.0);
        assert_eq!(bundle.members.len(), 2);
        for ((member, original), (target, version)) in bundle
            .members
            .iter()
            .zip(&originals)
            .zip([("核心包", "1.2.12"), ("SDK", "0.4.5")])
        {
            assert_eq!(member.release_target.as_deref(), Some(target));
            assert_eq!(member.release_version.as_deref(), Some(version));
            assert_eq!(member.title, original.title);
            assert_eq!(member.summary, original.summary);
            assert_eq!(member.content_version, original.content_version);
            assert_eq!(member.published_at, original.published_at);
            assert_eq!(member.publication_precision, original.publication_precision);
            assert_eq!(
                serde_json::to_value(&member.evidence).unwrap(),
                serde_json::to_value(&original.evidence).unwrap()
            );
        }
        assert_eq!(bundle.members[1].relationship, "release_family");
        assert_eq!(grouped[0].freshness_at, originals[0].freshness_at);
        let mut reversed = originals;
        reversed.reverse();
        assert_eq!(
            rollup_events(reversed, cutoff)[0]
                .coverage
                .as_ref()
                .unwrap()
                .topic,
            bundle.topic
        );
    }

    #[tokio::test]
    async fn release_family_package_batch_titles_need_shared_changes_in_the_same_repository() {
        let (events, cutoff) = package_fixtures().await;
        for case in 0..8 {
            let mut pair = events.clone();
            let other = &mut pair[1].evidence[0];
            match case {
                0 => other.excerpt.clear(),
                1 => other.excerpt = "Separate SDK change #8998".into(),
                2 => other.excerpt = "LangGraph SDK response_schema release telemetry".into(),
                3 => other.url = other.url.replace("langchain-ai", "another-owner"),
                4 => {
                    other.title = "another-sdk==0.4.5".into();
                    other.url = other.url.replace("/langgraph/", "/another/");
                }
                5 => other.excerpt = "https://github.com/another-owner/langgraph/pull/8886".into(),
                6 => other.excerpt = "https://github.com/langchain-ai/another/pull/8886".into(),
                _ => {
                    other.excerpt =
                        "https://untrusted@github.com/langchain-ai/langgraph/pull/8886".into()
                }
            }
            let grouped = rollup_events(pair, cutoff);
            if matches!(case, 3 | 4) {
                assert_eq!(grouped.len(), 2, "case {case}");
                continue;
            }
            // Unrelated notes in the same repository share one row, never the "同批" title.
            assert_eq!(grouped.len(), 1, "case {case}");
            let bundle = grouped[0].coverage.as_ref().unwrap();
            assert_eq!(bundle.method, "project-release-window-v2", "case {case}");
            assert_eq!(bundle.topic, "langgraph 组件更新：核心包 1.2.12 / SDK 0.4.5", "case {case}");
        }
        let mut pair = events;
        pair[1].evidence[0].excerpt = "https://github.com/langchain-ai/langgraph/pull/8886".into();
        let grouped = rollup_events(pair, cutoff);
        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped[0].coverage.as_ref().unwrap().method, "release-family-v2");
        assert_eq!(
            grouped[0].coverage.as_ref().unwrap().topic,
            "langgraph 同批更新：核心包 1.2.12 / SDK 0.4.5"
        );
    }

    #[tokio::test]
    async fn release_family_packages_verify_package_component_and_version_identity() {
        let (events, _) = package_fixtures().await;
        for (title, tag) in [
            ("langgraph-sdk==0.4.5", "cli==0.4.5"),
            ("langgraph-cli==0.4.5", "sdk==0.4.5"),
            ("other-sdk==0.4.5", "sdk==0.4.5"),
            ("langgraph_sdk==0.4.5", "sdk==0.4.5"),
            ("lang-graph-sdk==0.4.5", "sdk==0.4.5"),
            ("langgraph-sdk==0.4.6", "sdk==0.4.5"),
            ("langgraph-sdk==0.4.5", "langgraph-sdk==0.4.5"),
            ("langgraph-sdk==0.4.5", "0.4.5"),
            ("langgraph==0.4.5", "sdk==0.4.5"),
            ("langgraph==1.2.12", "v1.2.12"),
            ("langgraph==1.2.12", "1.2.13"),
            ("langgraph-sdk ==0.4.5", "sdk==0.4.5"),
            ("langgraph-sdk==0.4.5 release", "sdk==0.4.5"),
            ("langgraph-sdk==v0.4.5", "sdk==v0.4.5"),
            ("langgraph-sdk==0.4", "sdk==0.4"),
            ("langgraph-sdk==00.4.5", "sdk==00.4.5"),
            ("langgraph-sdk==0.4.5-01", "sdk==0.4.5-01"),
            ("langgraph-sdk==0.4.5-a..b", "sdk==0.4.5-a..b"),
            ("langgraph-sdk==0.4.5+a+b", "sdk==0.4.5+a+b"),
        ] {
            let mut event = events[1].clone();
            event.evidence[0].title = title.into();
            event.evidence[0].url =
                format!("https://github.com/langchain-ai/langgraph/releases/tag/{tag}");
            assert!(
                Record::from_event(&event).release.is_none(),
                "{title} / {tag}"
            );
        }
        let mut prerelease = events[1].clone();
        prerelease.evidence[0].title = "langgraph-sdk==0.5.0-rc.1+build.02".into();
        prerelease.evidence[0].url =
            "https://github.com/langchain-ai/langgraph/releases/tag/sdk%3D%3D0.5.0-rc.1+build.02"
                .into();
        assert_eq!(
            Record::from_event(&prerelease)
                .member
                .release_version
                .as_deref(),
            Some("0.5.0-rc.1+build.02")
        );
    }

    #[tokio::test]
    async fn release_family_packages_decode_only_safe_equals_delimiters_once() {
        let (events, cutoff) = package_fixtures().await;
        for tag in [
            "sdk==0.4.5",
            "sdk%3D%3D0.4.5",
            "sdk%3d%3d0.4.5",
            "sdk=%3D0.4.5",
        ] {
            let mut pair = events.clone();
            pair[1].evidence[0].url =
                format!("https://github.com/langchain-ai/langgraph/releases/tag/{tag}");
            assert_eq!(rollup_events(pair, cutoff).len(), 1, "{tag}");
        }
        for url in [
            "https://github.com/langchain-ai/langgraph/releases/tag/sdk%253D%253D0.4.5",
            "https://github.com/langchain-ai/langgraph/releases/tag/sdk%3D%3D0.4.5%2Fextra",
            "https://github.com/langchain-ai/langgraph/releases/tag/sdk%3D%3D0.4.5%00",
            "https://github.com/langchain-ai/langgraph/releases/tag/sdk%3D%3D0.4.5%",
            "https://github.com/langchain-ai/langgraph/releases/tag/sdk%3G%3D0.4.5",
            "https://github.com/langchain-ai/langgraph/releases/tag/%73dk%3D%3D0.4.5",
            "https://github.com/langchain-ai/langgraph/releases/tag/sdk%3D%3D0.4.5/extra",
            "https://github.com/langchain-ai/langgraph/releases/tag/../tag/sdk==0.4.5",
            "https://github.com/langchain-ai/langgraph/releases/tag/%2e%2e/tag/sdk==0.4.5",
            "https://github.com/langchain-ai/langgraph/releases/tag/sdk==0.4.\n5",
            "https://github.com.evil.test/langchain-ai/langgraph/releases/tag/sdk==0.4.5",
            "https://evil.test@github.com/langchain-ai/langgraph/releases/tag/sdk==0.4.5",
            "https://github.com:8443/langchain-ai/langgraph/releases/tag/sdk==0.4.5",
            "http://github.com/langchain-ai/langgraph/releases/tag/sdk==0.4.5",
        ] {
            let mut event = events[1].clone();
            event.evidence[0].url = url.into();
            assert!(Record::from_event(&event).release.is_none(), "{url}");
        }
    }

    #[tokio::test]
    async fn release_family_packages_reject_day_unofficial_and_mixed_evidence() {
        let (events, cutoff) = package_fixtures().await;
        for case in 0..11 {
            let mut pair = events.clone();
            let other = &mut pair[1];
            match case {
                0 => other.publication_precision = Some("day".into()),
                1 => other.publication_precision = None,
                2 => other.event_type = "blog".into(),
                3 => other.evidence[0].is_official = false,
                4 => other.evidence[0].source_tier = "T2".into(),
                5 => other.evidence[0].original_published_at = None,
                6 => other.evidence.clear(),
                _ => {
                    let mut mixed = other.evidence[0].clone();
                    mixed.id = Uuid::from_u128(999);
                    match case {
                        7 => mixed.is_official = false,
                        8 => mixed.url = mixed.url.replace("langchain-ai", "another-owner"),
                        9 => {
                            mixed.title = "langgraph-sdk==0.4.6".into();
                            mixed.url = mixed.url.replace("0.4.5", "0.4.6");
                        }
                        _ => mixed.excerpt = "Unrelated SDK change #9999".into(),
                    }
                    other.evidence.push(mixed);
                }
            }
            let record = Record::from_event(other);
            assert!(record.release.is_none(), "case {case}");
            let grouped = rollup_events(pair, cutoff);
            if case < 9 {
                assert!(record.project.is_none(), "case {case}");
                assert_eq!(grouped.len(), 2, "case {case}");
            } else {
                // Two official notes from the same repository still belong to its day row.
                assert_eq!(grouped.len(), 1, "case {case}");
                let bundle = grouped[0].coverage.as_ref().unwrap();
                assert_eq!(bundle.method, "project-release-window-v2", "case {case}");
            }
        }
    }

    #[tokio::test]
    async fn release_family_packages_and_legacy_families_of_one_repository_share_one_row() {
        let (mut events, cutoff) = package_fixtures().await;
        for (event, version) in events.iter_mut().zip(["2.0.0", "0.9.1"]) {
            let evidence = &mut event.evidence[0];
            let old_version = evidence.title.split_once("==").unwrap().1.to_owned();
            evidence.title = evidence
                .title
                .replace("langgraph", "acme-memory")
                .replace(&old_version, version);
            event.title = evidence.title.clone();
            evidence.url = evidence
                .url
                .replace("langchain-ai/langgraph", "acme/acme-memory")
                .replace(&old_version, version);
        }
        let package_events = events.clone();
        let (plugins, _) = plugin_fixtures().await;
        let (clients, _) = client_fixtures().await;
        for mut event in plugins
            .into_iter()
            .take(2)
            .chain(clients.into_iter().take(2))
        {
            event.title = event.title.replace("Mem0", "Acme Memory");
            event.published_at = events[0].published_at;
            event.freshness_at = event.published_at;
            let evidence = &mut event.evidence[0];
            evidence.title = event.title.clone();
            evidence.url = evidence.url.replace("mem0ai/mem0", "acme/acme-memory");
            evidence.original_published_at = event.published_at;
            evidence.excerpt = "Shared change #8886".into();
            events.push(event);
        }
        let package_only = rollup_events(package_events.clone(), cutoff);
        assert_eq!(
            package_only[0].coverage.as_ref().unwrap().topic,
            "acme-memory 同批更新：核心包 2.0.0 / SDK 0.9.1"
        );
        // Packages, plugins and clients from one repository and day are one row,
        // titled neutrally because they do not form one verified batch.
        let grouped = rollup_events(events.clone(), cutoff);
        assert_eq!(grouped.len(), 1);
        let bundle = grouped[0].coverage.as_ref().unwrap();
        assert_eq!(bundle.method, "project-release-window-v2");
        assert_eq!(bundle.members.len(), events.len());
        assert!(bundle.topic.starts_with("Acme Memory 版本更新："), "{}", bundle.topic);
        assert!(bundle.topic.ends_with("等6项"), "{}", bundle.topic);
        assert_eq!(bundle.popularity_boost, 0.0);
        for member in &bundle.members {
            if let Some(event) = package_events.iter().find(|event| event.id == member.event_id) {
                let expected = if event.title.contains("-sdk==") { "SDK" } else { "核心包" };
                assert_eq!(member.release_target.as_deref(), Some(expected));
            }
        }
    }

    async fn project_release(
        repository: &str,
        tag: &str,
        title: &str,
        published: &str,
        excerpt: &str,
    ) -> Event {
        let (mut events, _) = fixtures().await;
        let mut event = events.remove(0);
        event.id = Uuid::new_v4();
        event.event_type = "release".into();
        event.title = title.into();
        event.published_at = Some(published.parse().unwrap());
        event.freshness_at = event.published_at;
        event.publication_precision = Some("time".into());
        event.evidence.truncate(1);
        let evidence = &mut event.evidence[0];
        evidence.id = Uuid::new_v4();
        evidence.title = title.into();
        evidence.url = format!("https://github.com/{repository}/releases/tag/{tag}");
        evidence.is_official = true;
        evidence.source_tier = "T1".into();
        evidence.original_published_at = event.published_at;
        evidence.excerpt = excerpt.into();
        event
    }

    #[tokio::test]
    async fn reported_langgraph_cli_and_sdk_releases_share_one_row() {
        // Shape of the reported 2026-11-06 pair: same repository, minutes apart, no shared change.
        let events = vec![
            project_release("langchain-ai/langgraph", "cli%3D%3D0.4.42", "langgraph-cli==0.4.42",
                "2026-11-06T03:04:13Z", "release(cli): 0.4.42 (#9611) feat(cli): add deploy metrics command (#9479)").await,
            project_release("langchain-ai/langgraph", "sdk%3D%3D0.4.14", "langgraph-sdk==0.4.14",
                "2026-11-06T03:03:54Z", "release(sdk-py): 0.4.14 (#9610) feat(sdk-py): add strict_resume (#9599)").await,
        ];
        let originals = events.clone();
        let cutoff: DateTime<Utc> = "2026-11-06T08:00:00Z".parse().unwrap();
        let grouped = rollup_events(events, cutoff);
        assert_eq!(grouped.len(), 1);
        let bundle = grouped[0].coverage.as_ref().unwrap();
        assert_eq!(bundle.topic, "langgraph 组件更新：CLI 0.4.42 / SDK 0.4.14");
        assert_eq!(bundle.method, "project-release-window-v2");
        assert_eq!(bundle.relation, "release_family");
        assert_eq!(bundle.popularity_boost, 0.0);
        assert!(bundle.key.starts_with("project-release-window-v2:github.com/langchain-ai/langgraph:"));
        for (member, original) in bundle.members.iter().zip(&originals) {
            assert_eq!(member.event_id, original.id);
            assert_eq!(member.summary, original.summary);
            assert_eq!(member.title, original.title);
        }
        assert_eq!(
            bundle.members.iter().map(|m| (m.release_target.clone().unwrap(), m.release_version.clone().unwrap())).collect::<Vec<_>>(),
            [("CLI".to_owned(), "0.4.42".to_owned()), ("SDK".to_owned(), "0.4.14".to_owned())]
        );
        let mut event = grouped[0].clone();
        event.editorial = None;
        event.recommendation = Some(crate::models::Recommendation {
            material_penalty: 0.0,
            score: 10.0,
            freshness: 0.0,
            affinity: 0.0,
            novelty_penalty: 0.0,
            facets: Vec::new(),
            source_confirmed: true,
            explanation: String::new(),
        });
        apply(&mut event, Some(bundle.clone()));
        assert_eq!(event.recommendation.as_ref().unwrap().score, 10.0);
        let explanation = event.recommendation.as_ref().unwrap().explanation.clone();
        assert!(explanation.contains("不表示同一事件、共同改动或多来源互证"), "{explanation}");
        assert_eq!(crate::reader::select_brief(grouped, cutoff).items.len(), 1);
    }

    #[tokio::test]
    async fn generic_same_day_versions_and_snapshots_share_a_row_but_builds_do_not() {
        let mut events = vec![
            project_release("ray-project/ray", "ray-2.59.1", "Ray-2.59.1", "2026-11-04T08:13:00Z", "Bug fixes").await,
            project_release("ray-project/ray", "ray-2.60.0", "Ray-2.60.0", "2026-11-04T02:08:00Z", "Highlights").await,
        ];
        let cutoff: DateTime<Utc> = "2026-11-04T12:00:00Z".parse().unwrap();
        let grouped = rollup_events(events.clone(), cutoff);
        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped[0].coverage.as_ref().unwrap().topic, "Ray 版本更新：2.59.1 / 2.60.0");
        // Captured separately in an older edition: grouped for display, source items unchanged.
        let stored = serde_json::to_value(&events).unwrap();
        let projected = rollup_release_snapshots(events.clone(), cutoff);
        assert_eq!(projected.len(), 1);
        assert_eq!(serde_json::to_value(&events).unwrap(), stored);
        // Machine build tags keep their own development grouping, never a release row.
        for (index, sha) in ["0bcfbeeed87d201bf80d4fcd826dc4f4209b8be9", "625eb586c435ba098adb78741ceb2a173debca4c"].iter().enumerate() {
            let mut build = project_release("ray-project/ray", &format!("trunk%2F{sha}"),
                &format!("trunk/{sha}: Internal test update"), "2026-11-04T09:00:00Z", "").await;
            build.evidence[0].url = format!("https://github.com/ray-project/ray/releases/tag/trunk%2F{sha}");
            build.published_at = Some(build.published_at.unwrap() + Duration::minutes(index as i64));
            build.freshness_at = build.published_at;
            assert!(Record::from_event(&build).project.is_none());
            events.push(build);
        }
        let grouped = rollup_events(events, cutoff);
        assert_eq!(grouped.len(), 2);
        let relations: BTreeSet<_> = grouped.iter()
            .map(|event| (event.coverage.as_ref().unwrap().relation.clone(), event.coverage.as_ref().unwrap().members.len()))
            .collect();
        assert_eq!(relations, BTreeSet::from([("development_activity".into(), 2), ("release_family".into(), 2)]));
        let fork = project_release("someone/ray", "ray-2.60.0", "Ray-2.60.0", "2026-11-04T02:08:00Z", "Fork").await;
        let ray = project_release("ray-project/ray", "ray-2.59.1", "Ray-2.59.1", "2026-11-04T08:13:00Z", "Fixes").await;
        assert_eq!(rollup_events(vec![ray, fork], cutoff).len(), 2);
    }

    #[tokio::test]
    async fn release_family_package_versions_share_one_stable_project_row() {
        let (events, cutoff) = package_fixtures().await;
        let mut next_version = events[1].clone();
        next_version.id = Uuid::from_u128(102);
        next_version.evidence[0].id = Uuid::from_u128(202);
        next_version.evidence[0].title = "langgraph-sdk==0.4.6".into();
        next_version.title = next_version.evidence[0].title.clone();
        next_version.evidence[0].url = next_version.evidence[0].url.replace("0.4.5", "0.4.6");
        let pair = rollup_events(vec![next_version.clone(), events[1].clone()], cutoff);
        assert_eq!(pair.len(), 1);
        assert_eq!(
            pair[0].coverage.as_ref().unwrap().topic,
            "langgraph SDK 版本更新：0.4.5 / 0.4.6"
        );
        // Equal publication times resolve by ID, not input order or requested detail seed.
        let mut records = vec![Record::from_event(&next_version)];
        records.extend(events.iter().map(Record::from_event));
        let expected = BTreeSet::from([events[0].id, events[1].id, next_version.id]);
        let mut keys = BTreeSet::new();
        for _ in 0..records.len() {
            records.rotate_left(1);
            for record in &records {
                let grouped = groups(&records, &[record.member.event_id], cutoff);
                let bundle = grouped[0].bundle.as_ref().unwrap();
                keys.insert((bundle.key.clone(), bundle.topic.clone()));
                assert_eq!(
                    bundle.members.iter().map(|member| member.event_id).collect::<BTreeSet<_>>(),
                    expected
                );
            }
        }
        assert_eq!(
            keys.into_iter().map(|(_, topic)| topic).collect::<Vec<_>>(),
            ["langgraph 组件更新：核心包 1.2.12 / SDK 0.4.5 等3项"]
        );
    }

    #[tokio::test]
    async fn release_family_project_windows_bound_span_without_chaining_days() {
        let (events, cutoff) = package_fixtures().await;
        for shared_changes in [true, false] {
            let mut candidates = events.clone();
            let mut cli = events[1].clone();
            cli.id = Uuid::from_u128(102);
            cli.evidence[0].id = Uuid::from_u128(202);
            cli.title = "langgraph-cli==0.4.5".into();
            cli.evidence[0].title = cli.title.clone();
            cli.evidence[0].url = cli.evidence[0].url.replace("sdk", "cli");
            candidates.push(cli);
            let newest = events[0].published_at.unwrap();
            for (index, event) in candidates.iter_mut().enumerate() {
                event.published_at = Some(
                    newest - Duration::hours(index as i64 * if shared_changes { 20 } else { 1 }),
                );
                event.freshness_at = event.published_at;
                event.evidence[0].original_published_at = event.published_at;
                event.evidence[0].excerpt = if shared_changes || index == 0 {
                    "Shared change #8886"
                } else if index == 1 {
                    "Bridge entry #8886 #8779"
                } else {
                    "Other batch #8779"
                }
                .into();
            }
            // 20-hour gaps: a day window never chains to the third release. One-hour
            // gaps: bridge notes are irrelevant because the repository day is one row.
            let expected: BTreeSet<_> = if shared_changes {
                BTreeSet::from([candidates[0].id, candidates[1].id])
            } else {
                candidates.iter().map(|event| event.id).collect()
            };
            let mut records: Vec<_> = candidates.iter().map(Record::from_event).collect();
            for _ in 0..records.len() {
                records.rotate_left(1);
                let leaders: Vec<_> = records
                    .iter()
                    .map(|record| record.member.event_id)
                    .collect();
                let listed = groups(&records, &leaders, cutoff);
                assert_eq!(listed.len(), if shared_changes { 2 } else { 1 });
                for record in &records {
                    let detail = groups(&records, &[record.member.event_id], cutoff);
                    if expected.contains(&record.member.event_id) {
                        let bundle = detail[0].bundle.as_ref().unwrap();
                        assert_eq!(
                            bundle
                                .members
                                .iter()
                                .map(|member| member.event_id)
                                .collect::<BTreeSet<_>>(),
                            expected
                        );
                        let dates: Vec<_> = bundle
                            .members
                            .iter()
                            .filter_map(|member| member.published_at)
                            .collect();
                        assert!(
                            *dates.iter().max().unwrap() - *dates.iter().min().unwrap()
                                <= Duration::hours(24)
                        );
                    } else {
                        assert!(detail[0].bundle.is_none());
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn release_family_package_snapshots_preserve_captured_content_and_bundles() {
        let (events, cutoff) = package_fixtures().await;
        let original = serde_json::to_value(&events).unwrap();
        let mut projected = rollup_release_snapshots(events.clone(), cutoff);
        assert_eq!(projected.len(), 1);
        let bundle = projected[0].coverage.take().unwrap();
        assert_eq!(serde_json::to_value(&projected[0]).unwrap(), original[0]);
        assert_eq!(serde_json::to_value(&events).unwrap(), original);
        projected[0].coverage = Some(bundle);
        projected[0].coverage.as_mut().unwrap().topic = "Captured package batch label".into();
        let captured = serde_json::to_value(&projected).unwrap();
        assert_eq!(
            serde_json::to_value(rollup_release_snapshots(projected, cutoff)).unwrap(),
            captured
        );
    }

    #[tokio::test]
    async fn release_family_plugin_subjects_do_not_split_one_project_day() {
        let (mut events, now) = plugin_fixtures().await;
        events[0].evidence[0].excerpt =
            "Telemetry: Correct event delivery. (#7323, #7324, #7358)".into();
        events[1].evidence[0].excerpt =
            "Telemetry: Change source tag. #7322 Config: Use keyFingerprint for install counting. #7325".into();
        events[2].evidence[0].excerpt = events[0].evidence[0].excerpt.clone();
        events[3].evidence[0].excerpt =
            "Config: Use keyFingerprint for install counting. #7325 Telemetry: Correct events. (#7323, #7324, #7358)".into();
        // The original notes were published OpenClaw, OpenCode, Pi, DeepSeek
        // from newest to oldest; ranking must not change that row partition.
        for (event, minutes) in events.iter_mut().zip([2, 1, 3, 0]) {
            event.freshness_at = Some(now - Duration::minutes(minutes));
            event.published_at = event.freshness_at;
            event.evidence[0].original_published_at = event.freshness_at;
        }
        let telemetry = rollup_events(vec![events[0].clone(), events[2].clone()], now);
        assert_eq!(telemetry[0].coverage.as_ref().unwrap().topic, "Mem0 插件更新：遥测");
        // Two subjects in four minutes are still one project's plugin release day.
        let grouped = rollup_events(events.clone(), now);
        assert_eq!(grouped.len(), 1);
        let bundle = grouped[0].coverage.as_ref().unwrap();
        assert_eq!(bundle.method, "project-release-window-v2");
        assert_eq!(bundle.topic, "Mem0 插件更新：OpenClaw v1.1.0 / OpenCode v0.3.0 等4项");
        assert_eq!(bundle.members.len(), 4);
        let memberships = |events: Vec<Event>| -> BTreeSet<BTreeSet<Uuid>> {
            events
                .into_iter()
                .map(|event| {
                    event
                        .coverage
                        .unwrap()
                        .members
                        .into_iter()
                        .map(|member| member.event_id)
                        .collect()
                })
                .collect()
        };
        let expected = memberships(grouped);
        for _ in 0..4 {
            events.rotate_left(1);
            assert_eq!(memberships(rollup_events(events.clone(), now)), expected);
            let mut reversed = events.clone();
            reversed.reverse();
            assert_eq!(memberships(rollup_events(reversed, now)), expected);
        }
    }

    #[tokio::test]
    async fn release_family_v1_snapshot_titles_are_not_rewritten_by_v2() {
        let (events, now) = plugin_fixtures().await;
        let mut snapshot = rollup_events(events, now);
        let bundle = snapshot[0].coverage.as_mut().unwrap();
        bundle.method = "release-family-v1".into();
        bundle.topic = "Mem0 插件集中更新".into();
        let before = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(
            serde_json::to_value(rollup_release_snapshots(snapshot, now)).unwrap(),
            before
        );
    }

    #[tokio::test]
    async fn release_family_windows_reject_forks_nonofficial_and_imprecise_releases() {
        let (events, now) = plugin_fixtures().await;
        for case in 0..6 {
            let mut pair = events[..2].to_vec();
            let other = &mut pair[1];
            match case {
                0 => other.evidence[0].url = other.evidence[0].url.replace("mem0ai", "fork-owner"),
                1 => other.evidence[0].is_official = false,
                2 => other.evidence[0].excerpt = "Unrelated release #9999".into(),
                3 => {
                    other.title = "Mem0 OpenCode SDK (v0.3.0)".into();
                    other.evidence[0].title = other.title.clone();
                }
                4 => other.publication_precision = Some("day".into()),
                _ => {
                    other.evidence[0].url = other.evidence[0]
                        .url
                        .replace("opencode-v0.3.0", "other-host-v0.3.0")
                }
            }
            let grouped = rollup_events(pair, now);
            if matches!(case, 0 | 1 | 4) {
                assert_eq!(grouped.len(), 2, "case {case}");
            } else {
                assert_eq!(grouped.len(), 1, "case {case}");
                let bundle = grouped[0].coverage.as_ref().unwrap();
                assert_eq!(bundle.method, "project-release-window-v2", "case {case}");
            }
        }
    }

    #[tokio::test]
    async fn release_family_versions_of_one_target_share_a_row_without_a_batch_title() {
        let (events, now) = plugin_fixtures().await;
        let mut pair = events[..2].to_vec();
        pair[1].title = "Mem0 Pi Agent Plugin (v0.4.0)".into();
        pair[1].evidence[0].title = pair[1].title.clone();
        pair[1].evidence[0].url =
            "https://github.com/mem0ai/mem0/releases/tag/pi-agent-v0.4.0".into();
        let grouped = rollup_events(pair, now);
        assert_eq!(grouped.len(), 1);
        let bundle = grouped[0].coverage.as_ref().unwrap();
        assert_eq!(bundle.method, "project-release-window-v2");
        assert_eq!(bundle.topic, "Mem0 Pi Agent 版本更新：v0.3.0 / v0.4.0");
        let mut batches = events[..3].to_vec();
        batches[0].evidence[0].excerpt.clear();
        batches[2].evidence[0].excerpt = "Other batch #9999".into();
        let grouped = rollup_events(batches, now);
        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped[0].coverage.as_ref().unwrap().members.len(), 3);
    }

    #[tokio::test]
    async fn release_family_window_is_bounded_and_filtered_members_do_not_leak_in() {
        let (mut events, now) = plugin_fixtures().await;
        for (event, hours) in events.iter_mut().zip([0, 20, 40, 60]) {
            event.freshness_at = Some(now - Duration::hours(hours));
            event.published_at = event.freshness_at;
            event.evidence[0].original_published_at = event.freshness_at;
            event.evidence[0].excerpt.clear();
        }
        let first = rollup_events(events.clone(), now);
        let repeated = rollup_events(events.clone(), now);
        assert_eq!(first.len(), 2);
        assert_eq!(
            first.iter().map(|e| e.id).collect::<Vec<_>>(),
            repeated.iter().map(|e| e.id).collect::<Vec<_>>()
        );
        for event in &first {
            let dates: Vec<_> = event
                .coverage
                .as_ref()
                .unwrap()
                .members
                .iter()
                .filter_map(|m| m.published_at)
                .collect();
            assert!(
                *dates.iter().max().unwrap() - *dates.iter().min().unwrap() <= Duration::hours(24)
            );
        }
        assert!(
            rollup_events(events[..1].to_vec(), now)[0]
                .coverage
                .is_none()
        );
    }

    #[tokio::test]
    async fn release_snapshot_layout_preserves_original_content_scores_and_existing_bundles() {
        let (events, now) = plugin_fixtures().await;
        let original = serde_json::to_value(&events).unwrap();
        let mut grouped = rollup_release_snapshots(events.clone(), now);
        assert_eq!(grouped.len(), 1);
        let group = grouped[0].coverage.as_ref().unwrap().clone();
        assert_eq!(group.members.len(), 4);
        grouped[0].coverage = None;
        assert_eq!(serde_json::to_value(&grouped[0]).unwrap(), original[0]);
        assert_eq!(serde_json::to_value(events).unwrap(), original);
        grouped[0].coverage = Some(group.clone());
        let unchanged = rollup_release_snapshots(grouped, now);
        assert_eq!(
            serde_json::to_value(unchanged[0].coverage.as_ref().unwrap()).unwrap(),
            serde_json::to_value(group).unwrap()
        );
    }

    #[tokio::test]
    async fn legacy_name_snapshots_are_unbundled_in_memory_without_rewriting_source_data() {
        let (mut events, now) = fixtures().await;
        events.truncate(1);
        let member = Record::from_event(&events[0]).member;
        events[0].coverage = Some(CoverageBundle {
            key: "name-v1:grok-bot:2026-09-11T00:00:00Z".into(),
            topic: "Grok Bot".into(),
            relation: "same_named_topic".into(),
            method: "deterministic-name-v1".into(),
            window_hours: WINDOW_HOURS,
            material_count: 1,
            news_material_count: 1,
            editorial_source_count: 1,
            official_source_count: 0,
            community_material_count: 0,
            popularity_boost: 0.0,
            members: vec![member],
        });
        let stored = serde_json::to_value(&events).unwrap();
        let projected = rollup_release_snapshots(events, now);
        assert!(projected[0].coverage.is_none());
        assert_eq!(stored[0]["coverage"]["relation"], "same_named_topic");
    }

    #[tokio::test]
    async fn multi_member_legacy_snapshot_preserves_captured_materials_as_archive_collection() {
        let (mut events, now) = fixtures().await;
        let members: Vec<_> = events[..2]
            .iter()
            .map(Record::from_event)
            .map(|record| record.member)
            .collect();
        let captured: Vec<_> = members
            .iter()
            .map(|member| {
                (
                    member.event_id,
                    member.title.clone(),
                    member.summary.clone(),
                    serde_json::to_value(&member.evidence).unwrap(),
                )
            })
            .collect();
        events.truncate(1);
        events[0].coverage = Some(CoverageBundle {
            key: "name-v1:grok-bot:2026-09-11T00:00:00Z".into(),
            topic: "Grok Bot".into(),
            relation: "same_named_topic".into(),
            method: "deterministic-name-v1".into(),
            window_hours: WINDOW_HOURS,
            material_count: 2,
            news_material_count: 2,
            editorial_source_count: 2,
            official_source_count: 0,
            community_material_count: 0,
            popularity_boost: 2.0,
            members,
        });
        let stored = serde_json::to_value(&events).unwrap();
        let projected = rollup_release_snapshots(events, now);
        let archive = projected[0].coverage.as_ref().unwrap();
        assert_eq!(archive.relation, "archived_materials");
        assert_eq!(archive.method, "archived-materials-v1");
        assert_eq!(archive.topic, "历史版 · 2 篇独立文章");
        assert_eq!(archive.popularity_boost, 0.0);
        for (member, (id, title, summary, evidence)) in archive.members.iter().zip(captured) {
            assert_eq!(member.event_id, id);
            assert_eq!(member.title, title);
            assert_eq!(member.summary, summary);
            assert_eq!(serde_json::to_value(&member.evidence).unwrap(), evidence);
            assert_eq!(member.relationship, "archived_material");
        }
        let repeated = rollup_release_snapshots(projected.clone(), now);
        assert_eq!(
            serde_json::to_value(repeated).unwrap(),
            serde_json::to_value(projected).unwrap()
        );
        assert_eq!(stored[0]["coverage"]["relation"], "same_named_topic");
        assert_eq!(
            stored[0]["coverage"]["members"].as_array().unwrap().len(),
            2
        );
    }
}
