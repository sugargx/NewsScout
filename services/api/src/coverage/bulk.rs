//! One account's machine-generated batch, rolled up for presentation only.
//! Siblings keep their own titles, evidence and summaries; a batch is never
//! corroboration, ingestion deduplication or a merged model summary.
use std::collections::BTreeMap;

use chrono::{DateTime, Duration, Utc};

use super::{Record, SourceIdentity};
use crate::models::CoverageMember;

pub(super) const WINDOW_HOURS: i64 = 24;
/// Short numbers are ordinary version or model names, not generated serials.
const MIN_SERIAL_DIGITS: usize = 4;
const MIN_TEMPLATE_LETTERS: usize = 3;

/// Path prefixes that address other people's items, so they are not an account.
const SHARED_PREFIXES: &[&str] = &[
    "r",
    "u",
    "c",
    "s",
    "t",
    "p",
    "user",
    "users",
    "profile",
    "people",
    "post",
    "posts",
    "comments",
    "status",
    "item",
    "items",
    "article",
    "articles",
    "blog",
    "news",
    "story",
    "stories",
    "topic",
    "topics",
    "tag",
    "tags",
    "search",
    "watch",
    "video",
    "videos",
    "wiki",
    "docs",
    "download",
    "downloads",
    "abs",
    "pdf",
];

#[derive(Clone)]
pub(super) struct Batch {
    pub key: String,
    account: String,
}

pub(super) struct Cohort<'a> {
    pub key: String,
    pub label: String,
    pub members: Vec<&'a Record>,
}

/// `https://github.com/Example-Org/Item-42` gives the comparable account key
/// `github.com/example-org` and the displayed name `Example-Org`.
fn account(value: &str) -> Option<(String, String)> {
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url
        .host_str()?
        .trim_end_matches('.')
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    let mut segments = url.path_segments()?.filter(|part| !part.is_empty());
    let owner = segments.next()?;
    // An account page by itself is not one of its items.
    segments.next()?;
    let comparable = owner.to_ascii_lowercase();
    if owner.chars().count() < 2
        || !owner.chars().any(char::is_alphabetic)
        || SHARED_PREFIXES.contains(&comparable.as_str())
    {
        return None;
    }
    Some((format!("{host}/{comparable}"), owner.to_owned()))
}

/// Collapse generated serial numbers so siblings share one identity. Any
/// difference in words still keeps two items apart.
fn template(title: &str) -> Option<String> {
    let mut result = String::new();
    let mut run = 0usize;
    let mut serial = 0usize;
    let mut letters = 0usize;
    for character in title.trim().to_lowercase().chars() {
        if character.is_ascii_digit() {
            run += 1;
            serial = serial.max(run);
            if !result.ends_with('#') {
                result.push('#');
            }
            continue;
        }
        run = 0;
        if character.is_alphanumeric() {
            letters += 1;
            result.push(character);
        } else if !result.is_empty() && !result.ends_with('-') {
            result.push('-');
        }
    }
    (serial >= MIN_SERIAL_DIGITS && letters >= MIN_TEMPLATE_LETTERS)
        .then(|| result.trim_end_matches('-').to_owned())
}

/// Cheap discovery key; cohorts still verify community-only material and a
/// single account across every piece of evidence before collapsing records.
pub(super) fn candidate(title: &str, url: &str) -> Option<String> {
    Some(format!("batch:{}:{}", account(url)?.0, template(title)?))
}

pub(super) fn parse(member: &CoverageMember, sources: &[SourceIdentity]) -> Option<Batch> {
    if super::material_kind(sources) != "community" {
        return None;
    }
    let template = template(&member.title)?;
    let mut accounts = member
        .evidence
        .iter()
        .filter(|evidence| evidence.aggregation.is_none())
        .map(|evidence| account(&evidence.url));
    let first = accounts.next()??;
    // Material republished elsewhere is not one account's batch.
    if accounts.any(|other| other.as_ref() != Some(&first)) {
        return None;
    }
    Some(Batch {
        key: format!("{}:{template}", first.0),
        account: first.1,
    })
}

pub(super) fn cohorts(records: &[Record], cutoff: DateTime<Utc>) -> Vec<Cohort<'_>> {
    let mut by_batch = BTreeMap::<&str, Vec<&Record>>::new();
    for record in records {
        // Official releases and announcements keep their own stronger identity.
        if record.release.is_none()
            && record.announcement.is_none()
            && record.freshness_at.is_some_and(|date| date <= cutoff)
        {
            if let Some(batch) = &record.batch {
                by_batch.entry(batch.key.as_str()).or_default().push(record);
            }
        }
    }
    let mut result = Vec::new();
    for (key, mut records) in by_batch {
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
            if members.len() > 1 {
                let account = newest
                    .batch
                    .as_ref()
                    .map(|batch| batch.account.as_str())
                    .unwrap_or_default();
                result.push(Cohort {
                    key: key.to_owned(),
                    label: format!("{account}：同一账号同期发布的 {} 个同模板条目", members.len()),
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
    fn account_keys_require_an_item_under_a_real_account() {
        assert_eq!(
            account("https://github.com/Ukraine-Territorial-MCP/UA61020150010042611"),
            Some((
                "github.com/ukraine-territorial-mcp".into(),
                "Ukraine-Territorial-MCP".into()
            ))
        );
        assert_eq!(
            account("https://www.example.com/Studio/item-1001"),
            Some(("example.com/studio".into(), "Studio".into()))
        );
        for value in [
            "https://github.com/Ukraine-Territorial-MCP",
            "https://www.reddit.com/r/LocalLLaMA/comments/1abc2de/title/",
            "https://news.ycombinator.com/item?id=46012345",
            "https://arxiv.org/abs/2609.12345",
            "http://github.com/owner/repository",
        ] {
            assert!(account(value).is_none(), "{value}");
        }
    }

    #[test]
    fn templates_collapse_generated_serials_but_keep_words_apart() {
        assert_eq!(
            template("Ukraine-Territorial-MCP/UA61020150010042611"),
            template("Ukraine-Territorial-MCP/UA61020130010032621")
        );
        assert_eq!(
            template("Ukraine-Territorial-MCP/UA61020150010042611").as_deref(),
            Some("ukraine-territorial-mcp-ua#")
        );
        assert_ne!(
            template("mcp-directory/kyiv-10042611"),
            template("mcp-directory/lviv-10032621")
        );
        for title in [
            "openai/gpt-4",
            "Ternary Bonsai 2 Family: 2B, 4B, & 9B based on Qwen 3.5",
            "9910229301",
        ] {
            assert!(template(title).is_none(), "{title}");
        }
    }
}
