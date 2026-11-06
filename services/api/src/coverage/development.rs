use std::collections::BTreeMap;

use chrono::{DateTime, Duration, Utc};

use super::{Record, source_title};

pub const WINDOW_HOURS: i64 = 24;

pub struct Cohort<'a> {
    pub key: String,
    pub title: String,
    pub members: Vec<&'a Record>,
}

pub fn candidate(title: &str, value: &str) -> Option<String> {
    if !crate::reader::is_development_release("release", title) {
        return None;
    }
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "https"
        || url.host_str()? != "github.com"
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let parts: Vec<_> = url.path_segments()?.collect();
    match parts.as_slice() {
        [owner, repository, "releases", "tag", rest @ ..]
            if !owner.is_empty()
                && !repository.is_empty()
                && rest.iter().any(|part| !part.is_empty()) =>
        {
            Some(format!(
                "development:{}/{}",
                owner.to_ascii_lowercase(),
                repository.to_ascii_lowercase()
            ))
        }
        _ => None,
    }
}

pub fn cohorts(records: &[Record], cutoff: DateTime<Utc>) -> Vec<Cohort<'_>> {
    let mut buckets = BTreeMap::<String, Vec<&Record>>::new();
    for record in records {
        if record.member.event_type != "release"
            || !record.freshness_at.is_some_and(|date| date <= cutoff)
        {
            continue;
        }
        let title = source_title(record);
        if let Some(key) = record
            .member
            .evidence
            .iter()
            .find_map(|evidence| candidate(&title, &evidence.url))
        {
            buckets.entry(key).or_default().push(record);
        }
    }
    let mut result = Vec::new();
    for (key, mut candidates) in buckets {
        candidates.sort_by_key(|record| (record.freshness_at, record.member.event_id));
        let mut start = 0;
        while start < candidates.len() {
            let end = candidates[start..]
                .iter()
                .take_while(|candidate| {
                    candidate.freshness_at.unwrap() - candidates[start].freshness_at.unwrap()
                        <= Duration::hours(WINDOW_HOURS)
                })
                .count()
                + start;
            if end - start > 1 {
                result.push(Cohort {
                    title: format!("{} · 开发动态", key.trim_start_matches("development:")),
                    key: key.clone(),
                    members: candidates[start..end].to_vec(),
                });
            }
            start = end;
        }
    }
    result
}
