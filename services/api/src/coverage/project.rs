//! One reader row per official GitHub project and bounded day. A shared
//! repository is presentation identity only: never a shared change, one event
//! or corroboration.
use std::collections::BTreeMap;

use chrono::{DateTime, Duration, Utc};

use super::Record;
use crate::models::CoverageMember;

pub(super) const WINDOW_HOURS: i64 = 24;
const MAX_DISPLAY_CHARS: usize = 80;

#[derive(Clone)]
pub(super) struct ProjectRelease {
    pub key: String,
    pub product: String,
    pub target: String,
    pub version: String,
}

pub(super) struct Cohort<'a> {
    pub members: Vec<&'a Record>,
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// First explicit dotted version token, e.g. `2.59.1`, `v0.9.0`, `v1.4.0rc3`.
/// A bare number, a build counter or a digit inside a name ("Qwen3.8") is not one.
fn version_span(text: &str) -> Option<(usize, usize)> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    for (position, &(start, character)) in chars.iter().enumerate() {
        if position > 0 && chars[position - 1].1.is_alphanumeric() {
            continue;
        }
        let digits_from = if matches!(character, 'v' | 'V') { position + 1 } else { position };
        if !chars.get(digits_from).is_some_and(|(_, c)| c.is_ascii_digit()) {
            continue;
        }
        let mut end = digits_from;
        let mut dotted = false;
        while let Some(&(_, c)) = chars.get(end) {
            if c.is_ascii_digit() {
                end += 1;
            } else if c == '.' && chars.get(end + 1).is_some_and(|(_, next)| next.is_ascii_digit()) {
                dotted = true;
                end += 1;
            } else {
                break;
            }
        }
        if !dotted {
            continue;
        }
        // Keep a directly attached pre-release or build suffix, never the following words.
        while let Some(&(_, c)) = chars.get(end) {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+') {
                end += 1;
            } else {
                break;
            }
        }
        while end > digits_from && matches!(chars[end - 1].1, '.' | '-' | '+') {
            end -= 1;
        }
        let end_byte = chars.get(end).map_or(text.len(), |(index, _)| *index);
        return Some((start, end_byte));
    }
    None
}

fn display(title: &str, repository: &str) -> (String, String) {
    let title = title.trim();
    // "v1.4.0rc3: [perf] Add ..." names the release before its first commit note.
    let head = title
        .split_once(':')
        .map(|(head, _)| head.trim())
        .filter(|head| version_span(head).is_some())
        .unwrap_or(title);
    let head: String = head.chars().take(MAX_DISPLAY_CHARS).collect();
    let Some((start, end)) = version_span(&head) else {
        let target = if head.is_empty() { repository.to_owned() } else { head };
        return (target, String::new());
    };
    let version = head[start..end].to_owned();
    // Remove only the separators that attached the version, e.g. "Ray-", "cli==" or "(v1)".
    let before = head[..start]
        .trim_end_matches(|c: char| c.is_whitespace() || matches!(c, '-' | '_' | '=' | '@' | '(' | '/' | ':' | ','));
    let after = head[end..].trim_start_matches(|c: char| c.is_whitespace() || matches!(c, ')' | ':' | ','));
    let target = format!("{before} {after}")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let generic = ["", "release", "version", "v", "版本", "发布"]
        .contains(&target.to_lowercase().as_str());
    (if generic { repository.to_owned() } else { target }, version)
}

/// Every evidence item must be an official, exactly timed release page of the
/// same GitHub repository. Machine build tags have their own development rows.
pub(super) fn parse(member: &CoverageMember) -> Option<ProjectRelease> {
    if member.event_type != "release"
        || member.material_kind != "official"
        || member.publication_precision.as_deref() != Some("time")
        || crate::reader::is_development_release("release", &member.title)
    {
        return None;
    }
    let mut result: Option<ProjectRelease> = None;
    for evidence in &member.evidence {
        if !evidence.is_official
            || evidence.original_published_at.is_none()
            || crate::reader::is_development_release("release", &evidence.title)
        {
            return None;
        }
        let url = url::Url::parse(&evidence.url).ok()?;
        if url.scheme() != "https"
            || url.host_str() != Some("github.com")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.as_str() != evidence.url
        {
            return None;
        }
        let segments: Vec<_> = url.path_segments()?.collect();
        let [owner, repository, "releases", "tag", tag] = segments.as_slice() else {
            return None;
        };
        if !identifier(owner) || !identifier(repository) || tag.is_empty() {
            return None;
        }
        let key = format!("github.com/{owner}/{repository}").to_ascii_lowercase();
        if let Some(previous) = &result {
            if previous.key != key {
                return None;
            }
            continue;
        }
        let (target, version) = display(&evidence.title, repository);
        result = Some(ProjectRelease {
            key,
            product: (*repository).to_owned(),
            target,
            version,
        });
    }
    result
}

/// Fixed newest-first windows independent of reader ranking: a release can
/// never move between rows because a reader changes sort, interests or page.
pub(super) fn cohorts(records: &[Record], cutoff: DateTime<Utc>) -> Vec<Cohort<'_>> {
    let mut by_project = BTreeMap::<&str, Vec<&Record>>::new();
    for record in records {
        if let Some(project) = &record.project {
            if record.freshness_at.is_some_and(|date| date <= cutoff) {
                by_project.entry(project.key.as_str()).or_default().push(record);
            }
        }
    }
    let mut result = Vec::new();
    for mut records in by_project.into_values() {
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
                result.push(Cohort {
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
    fn release_names_keep_their_own_target_and_version() {
        for (title, target, version) in [
            ("Ray-2.59.1", "Ray", "2.59.1"),
            ("langgraph-cli==0.4.42", "langgraph-cli", "0.4.42"),
            ("v0.9.0", "llama.cpp", "v0.9.0"),
            ("v1.4.0rc3: [None][perf] Add opt-in tiled QKV preprocessing (#21198)", "llama.cpp", "v1.4.0rc3"),
            ("Mem0 Pi Agent Plugin (v0.3.0)", "Mem0 Pi Agent Plugin", "v0.3.0"),
            ("@modelcontextprotocol/server@2.2.0", "@modelcontextprotocol/server", "2.2.0"),
            ("Release 2.3.0", "llama.cpp", "2.3.0"),
            ("vLLM v0.6.0: 2.7x Throughput", "vLLM", "v0.6.0"),
            ("python-1.21.0-rc.1", "python", "1.21.0-rc.1"),
            ("Qwen3.8 weights", "Qwen3.8 weights", ""),
            ("Spring update 2026", "Spring update 2026", ""),
            ("Atlas 1.2.0 (stable)", "Atlas (stable)", "1.2.0"),
        ] {
            assert_eq!(display(title, "llama.cpp"), (target.into(), version.into()), "{title}");
        }
        let long = format!("{} 1.0.0", "x".repeat(200));
        assert!(display(&long, "repo").0.chars().count() <= MAX_DISPLAY_CHARS);
    }

    #[test]
    fn repository_identifiers_reject_traversal_and_unexpected_bytes() {
        for value in ["ray-project", "llama.cpp", "TensorRT-LLM", "a_b"] {
            assert!(identifier(value), "{value}");
        }
        for value in ["", ".", "..", "a b", "a/b", "a%2Fb", "ä"] {
            assert!(!identifier(value), "{value}");
        }
    }
}
