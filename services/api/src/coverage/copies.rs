use std::collections::{BTreeMap, BTreeSet};

use super::{Record, source_title};
use chrono::{DateTime, Duration, Utc};

pub const WINDOW_HOURS: i64 = 36;
pub const MAX_CANDIDATES: usize = 64;
const MAX_MEMBERS: usize = 24;

pub struct Cohort<'a> {
    pub key: String,
    pub title: String,
    pub members: Vec<&'a Record>,
}

fn normalized(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn numbers(value: &str) -> Vec<String> {
    value
        .split(|ch: char| !ch.is_ascii_digit() && ch != '.')
        .map(|part| part.trim_matches('.'))
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect()
}

/// This is only a retrieval key. Neither a matching title nor publisher URL IDs
/// establish article identity; grouping must also inspect original source text.
pub fn candidate(title: &str) -> Option<String> {
    let text = normalized(title);
    let length = text.chars().count();
    ((24..=240).contains(&length))
        .then(|| format!("article-copy:{text}:{}", numbers(title).join(",")))
}

fn material(record: &Record) -> Option<String> {
    let text = record.original_material.as_deref().or_else(|| {
        record
            .member
            .evidence
            .iter()
            .filter(|evidence| evidence.aggregation.is_none())
            .map(|evidence| evidence.excerpt.trim())
            .max_by_key(|text| text.chars().count())
    })?;
    let title = normalized(&source_title(record));
    let timestamps: Vec<_> = record
        .member
        .evidence
        .iter()
        .filter_map(|evidence| evidence.original_published_at)
        .flat_map(|date| [date, date + Duration::hours(8)])
        .map(|date| date.format("%Y-%m-%d %H:%M:%S").to_string())
        .collect();
    // Drop only leading publisher chrome with the actual publication timestamp.
    // Dates, corrections and negations in the article itself remain evidence.
    let mut blocks: Vec<_> = text
        .split("\n\n")
        .skip_while(|block| {
            let block = block.trim();
            normalized(block) == title
                || block.starts_with("来源：")
                || block.starts_with("Source:")
                || block.chars().count() <= 100
                    && timestamps.iter().any(|stamp| block.ends_with(stamp))
        })
        .collect();
    while blocks.last().is_some_and(|block| {
        let line = block.trim();
        line.is_empty()
            || line.chars().count() <= 100 && line.starts_with("版权所有") && line.contains("转载")
    }) {
        blocks.pop();
    }
    let cleaned = blocks.join("\n\n");
    (cleaned.chars().count() >= 100).then_some(cleaned)
}

fn negations(text: &str) -> Vec<usize> {
    let lower = text.to_lowercase();
    let words: Vec<_> = lower.split(|ch: char| !ch.is_alphabetic()).collect();
    let mut counts: Vec<_> = [
        "no",
        "not",
        "never",
        "cancelled",
        "canceled",
        "withdrawn",
        "retracted",
        "denied",
        "postponed",
    ]
    .iter()
    .map(|marker| words.iter().filter(|word| *word == marker).count())
    .collect();
    counts.extend(
        ["不", "未", "取消", "撤回", "否认", "推迟", "更正", "辟谣"]
            .iter()
            .map(|marker| lower.matches(marker).count()),
    );
    counts
}

fn shingles(normalized_text: &str) -> BTreeSet<String> {
    let chars: Vec<_> = normalized_text.chars().collect();
    chars
        .windows(5)
        .map(|window| window.iter().collect())
        .collect()
}

struct Material {
    text: String,
    numbers: Vec<String>,
    negations: Vec<usize>,
    grams: BTreeSet<String>,
}

impl Material {
    fn new(record: &Record) -> Option<Self> {
        let text = material(record)?;
        let normalized_text = normalized(&text);
        Some(Self {
            numbers: numbers(&text),
            negations: negations(&text),
            grams: shingles(&normalized_text),
            text: normalized_text,
        })
    }
}

fn same_copy(a: &Material, b: &Material) -> bool {
    // Tiny edits to a number or a negation can reverse the story despite near-
    // identical prose. Abstain rather than folding a correction into its original.
    if a.numbers != b.numbers || a.negations != b.negations {
        return false;
    }
    // Similarity alone misses changed actions and moved negation. Retain a
    // verbatim normalized core; publisher introductions may surround it.
    if !a.text.contains(&b.text) && !b.text.contains(&a.text) {
        return false;
    }
    let common = a.grams.intersection(&b.grams).count();
    let union = a.grams.len() + b.grams.len() - common;
    common >= 60
        && common as f32 / a.grams.len().min(b.grams.len()).max(1) as f32 >= 0.90
        && common as f32 / union.max(1) as f32 >= 0.75
}

pub fn cohorts(records: &[Record], cutoff: DateTime<Utc>) -> Vec<Cohort<'_>> {
    let mut buckets = BTreeMap::<String, Vec<&Record>>::new();
    for record in records {
        if record.release.is_some()
            || record.announcement.is_some()
            || !record.event_references.is_empty()
            || record.member.material_kind == "community"
            || record.member.event_type == "release"
            || !record.freshness_at.is_some_and(|date| date <= cutoff)
        {
            continue;
        }
        if let Some(key) = candidate(&source_title(record)) {
            buckets.entry(key).or_default().push(record);
        }
    }
    let mut result = Vec::new();
    for (key, mut candidates) in buckets {
        if candidates.len() > MAX_CANDIDATES {
            continue;
        }
        candidates.sort_by_key(|record| (record.freshness_at, record.member.event_id));
        let materials: Vec<_> = candidates
            .into_iter()
            .filter_map(|record| Material::new(record).map(|material| (record, material)))
            .collect();
        let mut cohorts: Vec<Vec<usize>> = Vec::new();
        for (index, (candidate, material)) in materials.iter().enumerate() {
            let existing = cohorts.iter_mut().find(|cohort| {
                cohort.len() < MAX_MEMBERS
                    && candidate.freshness_at.unwrap() - materials[cohort[0]].0.freshness_at.unwrap()
                        <= Duration::hours(WINDOW_HOURS)
                    // Complete-link, not transitive similarity: a bridge article
                    // cannot silently pull two different stories into one group.
                    && cohort.iter().all(|other| same_copy(material, &materials[*other].1))
            });
            if let Some(cohort) = existing {
                cohort.push(index);
            } else {
                cohorts.push(vec![index]);
            }
        }
        result.extend(
            cohorts
                .into_iter()
                .filter(|members| members.len() > 1)
                .map(|indices| {
                    let members: Vec<_> = indices
                        .into_iter()
                        .map(|index| materials[index].0)
                        .collect();
                    Cohort {
                        key: format!("{key}:{}", members[0].member.event_id),
                        title: source_title(members[0]),
                        members,
                    }
                }),
        );
    }
    result
}
