use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Duration, Utc};

use super::{Record, SourceIdentity, WINDOW_HOURS};
use crate::models::CoverageMember;

#[derive(Clone)]
pub(super) struct Announcement {
    subject: String,
    anchor: Option<(String, String)>,
}

pub(super) struct Cohort<'a> {
    pub reference: String,
    pub title: String,
    pub members: Vec<&'a Record>,
}

fn headline(value: &str) -> (String, bool) {
    let mut text = crate::processing::plain_text(value).to_lowercase().replace(
        [
            '\u{2010}', '\u{2011}', '\u{2012}', '\u{2013}', '\u{2014}', '\u{2212}',
        ],
        "-",
    );
    let mut launch = false;
    for prefix in [
        "introducing ",
        "announcing ",
        "introducing: ",
        "announcing: ",
        "meet ",
        "推出",
        "发布",
        "介绍",
        "宣布",
    ] {
        if let Some(rest) = text.strip_prefix(prefix) {
            text = rest.trim_start_matches([' ', ':', '：']).to_owned();
            launch = true;
            break;
        }
    }
    for suffix in [
        " is now available",
        " is here",
        " released",
        " 发布",
        " 上线",
    ] {
        if let Some(rest) = text.strip_suffix(suffix) {
            text = rest.trim().to_owned();
            launch = true;
            break;
        }
    }
    (text, launch)
}

// A discovery key, not proof by itself. Preserve the entire source headline so
// model sizes, variants, comparisons and separate use cases cannot collapse.
pub(super) fn subject(title: &str) -> Option<String> {
    if title.chars().count() > 200 {
        return None;
    }
    let (text, _) = headline(title);
    let model = crate::reader::model_story_key(&text)?;
    let identity: String = text
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '.')
        .collect();
    Some(format!("{model}:{identity}"))
}

fn primary_url(title: &str, value: &str) -> Option<String> {
    let mut url = url::Url::parse(value).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || matches!(url.host_str()?, "github.com" | "arxiv.org")
    {
        return None;
    }
    let leaf = url.path_segments()?.rfind(|part| !part.is_empty())?;
    if matches!(
        leaf,
        "news" | "blog" | "research" | "models" | "announcements" | "index.html"
    ) {
        return None;
    }
    let (text, launch) = headline(title);
    let compact = |value: &str| {
        value
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .collect::<String>()
            .to_ascii_lowercase()
    };
    if !launch && compact(leaf) != compact(&text) {
        return None;
    }
    url.set_fragment(None);
    crate::processing::canonical_url(url.as_str()).ok()
}

pub(super) fn parse(member: &CoverageMember, sources: &[SourceIdentity]) -> Option<Announcement> {
    if member.material_kind == "community"
        || !matches!(
            member.event_type.as_str(),
            "blog" | "news" | "model" | "release"
        )
        || member.evidence.is_empty()
    {
        return None;
    }
    let subjects = member
        .evidence
        .iter()
        .map(|evidence| subject(&evidence.title))
        .collect::<Option<BTreeSet<_>>>()?;
    if subjects.len() != 1 {
        return None;
    }
    let anchors: BTreeMap<_, _> = member
        .evidence
        .iter()
        .filter(|evidence| {
            evidence.is_official
                && evidence.source_tier == "T1"
                && sources
                    .iter()
                    .any(|source| source.evidence_id == evidence.id && source.kind == "official")
        })
        .filter_map(|evidence| {
            Some((
                primary_url(&evidence.title, &evidence.url)?,
                evidence.title.clone(),
            ))
        })
        .collect();
    if anchors.len() > 1 {
        return None;
    }
    Some(Announcement {
        subject: subjects.into_iter().next()?,
        anchor: anchors.into_iter().next(),
    })
}

pub(super) fn cohorts(records: &[Record], cutoff: DateTime<Utc>) -> Vec<Cohort<'_>> {
    let mut by_subject = BTreeMap::<&str, Vec<&Record>>::new();
    for record in records {
        if record.release.is_none() && record.freshness_at.is_some_and(|date| date <= cutoff) {
            if let Some(announcement) = &record.announcement {
                by_subject
                    .entry(&announcement.subject)
                    .or_default()
                    .push(record);
            }
        }
    }
    let mut result = Vec::new();
    for mut records in by_subject.into_values() {
        records.sort_by(|a, b| {
            b.freshness_at
                .cmp(&a.freshness_at)
                .then(a.member.event_id.cmp(&b.member.event_id))
        });
        let mut remaining = records.as_slice();
        while let Some(newest) = remaining.first() {
            let start = newest.freshness_at.unwrap() - Duration::hours(WINDOW_HOURS);
            let count = remaining
                .partition_point(|record| record.freshness_at.is_some_and(|date| date >= start));
            let (members, rest) = remaining.split_at(count);
            let anchors: BTreeMap<_, _> = members
                .iter()
                .filter_map(|record| record.announcement.as_ref()?.anchor.clone())
                .collect();
            // Multiple official articles with the same title are ambiguous. Do not
            // infer which one a secondary article is about or bridge them together.
            if anchors.len() == 1 && members.len() > 1 {
                let (reference, title) = anchors.into_iter().next().unwrap();
                result.push(Cohort {
                    reference,
                    title,
                    members: members.to_vec(),
                });
            }
            remaining = rest;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_headline_keys_normalize_launch_phrasing_but_preserve_full_identity() {
        let key = subject("Introducing Claude Haiku 5.5");
        assert_eq!(key, subject("Claude Haiku 5.5"));
        assert_eq!(key, subject("推出 Claude Haiku 5.5"));
        assert_eq!(
            subject("GPT-6 Sol is here"),
            subject("Introducing GPT‑6 Sol")
        );
        for title in [
            "Claude Sonnet 5.5",
            "Claude Haiku 55",
            "Claude Haiku 5.5 pricing",
            "Claude Haiku 5.5 for finance",
            "Claude Haiku 5.5 vs GPT-6 Luna",
        ] {
            assert_ne!(key, subject(title), "{title}");
        }
        for title in [
            "Introducing ChatGPT for Financial Services",
            "2026 in LLMs (so far)",
            "Grok Bot",
        ] {
            assert!(subject(title).is_none(), "{title}");
        }
    }
}
