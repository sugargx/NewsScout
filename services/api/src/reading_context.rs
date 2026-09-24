use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use quick_xml::{Reader, events::Event};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use url::Url;

use crate::processing::{excerpt, reading_text, validate_public_https};

pub const VERSION: u8 = 1;
pub const MAX_RETAINED_BODY_CHARS: usize = 16_000;
const MAX_CHAPTERS: usize = 100;
pub const STRATECHERY_PAYWALL_MARKER: &str = "Subscribe to Stratechery Plus for full access.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadingContextKind {
    Article,
    Post,
    Podcast,
    Release,
    Feed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadingContextOrigin {
    Feed,
    PublisherPage,
    AuthorizedApi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadingContextStatus {
    Available,
    Partial,
    Unavailable,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommentsStatus {
    NotApplicable,
    RequiresAuthorization,
    NotFetched,
    Available,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    pub start_seconds: u64,
    pub title: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingComment {
    pub id: String,
    pub body: String,
    pub score: Option<i64>,
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingContext {
    pub version: u8,
    pub kind: ReadingContextKind,
    pub origin: ReadingContextOrigin,
    pub status: ReadingContextStatus,
    pub source_url: String,
    pub body: String,
    pub truncated: bool,
    pub duration_seconds: Option<u64>,
    #[serde(default)]
    pub chapters: Vec<Chapter>,
    pub transcript_url: Option<String>,
    #[serde(default)]
    pub comments: Vec<ReadingComment>,
    pub comments_status: CommentsStatus,
    pub fetched_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_limit: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FeedContextReferences {
    pub chapters_url: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FeedContext {
    pub external_id: Option<String>,
    pub url: Option<String>,
    pub title: Option<String>,
    pub body: String,
    pub truncated: bool,
    pub duration_seconds: Option<u64>,
    pub chapters: Vec<Chapter>,
    pub transcript_url: Option<String>,
    pub references: FeedContextReferences,
}

#[derive(Debug)]
struct CapturedField {
    name: String,
    depth: usize,
    content: String,
}

impl ReadingContext {
    pub fn from_feed(
        kind: ReadingContextKind,
        source_url: String,
        feed: FeedContext,
        fetched_at: DateTime<Utc>,
    ) -> Self {
        let comments_status = if kind == ReadingContextKind::Post {
            CommentsStatus::RequiresAuthorization
        } else {
            CommentsStatus::NotApplicable
        };
        let status = if feed.body.is_empty() {
            ReadingContextStatus::Unavailable
        } else if feed.truncated || kind == ReadingContextKind::Post {
            ReadingContextStatus::Partial
        } else {
            ReadingContextStatus::Available
        };
        Self {
            version: VERSION,
            kind,
            origin: ReadingContextOrigin::Feed,
            status,
            source_url,
            body: feed.body,
            truncated: feed.truncated,
            duration_seconds: feed.duration_seconds,
            chapters: feed.chapters,
            transcript_url: feed.transcript_url,
            comments: Vec::new(),
            comments_status,
            fetched_at: Some(fetched_at),
            access_limit: None,
        }
        .respect_publisher_access()
    }

    pub fn publisher_page(
        source_url: String,
        body: String,
        truncated: bool,
        fetched_at: DateTime<Utc>,
    ) -> Self {
        let status = if body.is_empty() {
            ReadingContextStatus::Unavailable
        } else if truncated {
            ReadingContextStatus::Partial
        } else {
            ReadingContextStatus::Available
        };
        Self {
            version: VERSION,
            kind: ReadingContextKind::Article,
            origin: ReadingContextOrigin::PublisherPage,
            status,
            source_url,
            body,
            truncated,
            duration_seconds: None,
            chapters: Vec::new(),
            transcript_url: None,
            comments: Vec::new(),
            comments_status: CommentsStatus::NotApplicable,
            fetched_at: Some(fetched_at),
            access_limit: None,
        }
        .respect_publisher_access()
    }

    pub fn retained_excerpt_article(
        source_url: String,
        body: String,
        truncated: bool,
        fetched_at: DateTime<Utc>,
    ) -> Self {
        let status = if body.is_empty() {
            ReadingContextStatus::Unavailable
        } else {
            ReadingContextStatus::Partial
        };
        Self {
            version: VERSION,
            kind: ReadingContextKind::Article,
            origin: ReadingContextOrigin::Feed,
            status,
            source_url,
            body,
            truncated,
            duration_seconds: None,
            chapters: Vec::new(),
            transcript_url: None,
            comments: Vec::new(),
            comments_status: CommentsStatus::NotApplicable,
            fetched_at: Some(fetched_at),
            access_limit: None,
        }
        .respect_publisher_access()
    }

    pub fn respect_publisher_access(mut self) -> Self {
        let stratechery = Url::parse(&self.source_url).ok().is_some_and(|url| {
            url.scheme() == "https"
                && matches!(
                    url.host_str(),
                    Some("stratechery.com" | "www.stratechery.com")
                )
                && url.port_or_known_default() == Some(443)
                && url.username().is_empty()
                && url.password().is_none()
        });
        if stratechery {
            if let Some(boundary) = self.body.find(STRATECHERY_PAYWALL_MARKER) {
                self.body = self.body[..boundary].trim().to_owned();
                self.status = if self.body.is_empty() {
                    ReadingContextStatus::Unavailable
                } else {
                    ReadingContextStatus::Partial
                };
                self.truncated = true;
                self.access_limit = Some("paywall".into());
            }
        }
        self
    }

    pub fn blocked_from_feed(mut self) -> Self {
        self.status = ReadingContextStatus::Blocked;
        self
    }

    pub fn fingerprint(&self) -> String {
        let mut material = serde_json::json!({
            "version": self.version,
            "kind": self.kind,
            "origin": self.origin,
            "status": self.status,
            "sourceUrl": self.source_url,
            "body": self.body,
            "truncated": self.truncated,
            "durationSeconds": self.duration_seconds,
            "chapters": self.chapters,
            "transcriptUrl": self.transcript_url,
            "comments": self.comments,
            "commentsStatus": self.comments_status,
        });
        if let Some(limit) = &self.access_limit {
            material["accessLimit"] = serde_json::json!(limit);
        }
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&material).expect("serializable reading context"))
        )
    }

    pub fn has_material(&self) -> bool {
        !self.body.is_empty()
            || self.duration_seconds.is_some()
            || !self.chapters.is_empty()
            || !self.comments.is_empty()
    }

    pub fn material_fingerprint(&self) -> Option<String> {
        self.has_material().then(|| {
            material_hash(
                &self.body,
                self.duration_seconds,
                &self.chapters,
                &self.comments,
            )
        })
    }
}

pub fn text_material_fingerprint(body: &str) -> Option<String> {
    (!body.is_empty()).then(|| material_hash(body, None, &[], &[]))
}

fn material_hash(
    body: &str,
    duration_seconds: Option<u64>,
    chapters: &[Chapter],
    comments: &[ReadingComment],
) -> String {
    let mut comments: Vec<_> = comments
        .iter()
        .map(|comment| (&comment.id, &comment.body, &comment.url))
        .collect();
    // Ranking and vote changes are presentation updates, not new source material.
    comments.sort_by(|left, right| left.0.cmp(right.0));
    let material = serde_json::json!({
        "body": body,
        "durationSeconds": duration_seconds,
        "chapters": chapters,
        "comments": comments,
    });
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&material).expect("serializable reading material"))
    )
}

pub fn parse_feed_contexts(bytes: &[u8], endpoint: &Url) -> Result<Vec<FeedContext>> {
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    let mut contexts = Vec::new();
    let mut current: Option<FeedContext> = None;
    let mut capture: Option<CapturedField> = None;
    let mut depth = 0usize;

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(element)) => {
                depth += 1;
                let name = local_name(element.name().as_ref());
                if matches!(name.as_str(), "item" | "entry") && current.is_none() {
                    current = Some(FeedContext::default());
                } else if let Some(capture) = capture.as_mut() {
                    append_start_tag(&mut capture.content, &name);
                } else if let Some(context) = current.as_mut() {
                    if name == "link" {
                        let rel = attribute(&element, "rel").unwrap_or_else(|| "alternate".into());
                        if rel == "alternate" {
                            if let Some(href) = attribute(&element, "href") {
                                context.url = resolve_url(endpoint, &href);
                            } else {
                                capture = Some(CapturedField {
                                    name,
                                    depth,
                                    content: String::new(),
                                });
                            }
                        }
                    } else if name == "chapters" {
                        context.references.chapters_url =
                            attribute(&element, "url").and_then(|url| resolve_url(endpoint, &url));
                    } else if name == "transcript" {
                        context.transcript_url =
                            attribute(&element, "url").and_then(|url| resolve_url(endpoint, &url));
                    } else if matches!(
                        name.as_str(),
                        "guid"
                            | "id"
                            | "title"
                            | "description"
                            | "summary"
                            | "encoded"
                            | "content"
                            | "duration"
                    ) {
                        capture = Some(CapturedField {
                            name,
                            depth,
                            content: String::new(),
                        });
                    }
                }
            }
            Ok(Event::Empty(element)) => {
                let name = local_name(element.name().as_ref());
                if let Some(capture) = capture.as_mut() {
                    append_empty_tag(&mut capture.content, &name);
                } else if let Some(context) = current.as_mut() {
                    if name == "link" {
                        let rel = attribute(&element, "rel").unwrap_or_else(|| "alternate".into());
                        if rel == "alternate" {
                            context.url = attribute(&element, "href")
                                .and_then(|href| resolve_url(endpoint, &href));
                        }
                    } else if name == "chapters" {
                        context.references.chapters_url =
                            attribute(&element, "url").and_then(|url| resolve_url(endpoint, &url));
                    } else if name == "transcript" {
                        context.transcript_url =
                            attribute(&element, "url").and_then(|url| resolve_url(endpoint, &url));
                    }
                }
            }
            Ok(Event::Text(text)) => {
                if let Some(capture) = capture.as_mut() {
                    capture
                        .content
                        .push_str(&String::from_utf8_lossy(text.as_ref()));
                }
            }
            Ok(Event::CData(text)) => {
                if let Some(capture) = capture.as_mut() {
                    capture
                        .content
                        .push_str(&String::from_utf8_lossy(text.as_ref()));
                }
            }
            Ok(Event::End(element)) => {
                let name = local_name(element.name().as_ref());
                if let Some(captured) = capture.as_mut() {
                    if captured.depth == depth && captured.name == name {
                        let captured = capture.take().expect("capture checked");
                        if let Some(context) = current.as_mut() {
                            append_field(context, &captured.name, &captured.content, endpoint);
                        }
                    } else if captured.depth < depth {
                        append_end_tag(&mut captured.content, &name);
                    }
                }
                if matches!(name.as_str(), "item" | "entry") {
                    if let Some(mut context) = current.take() {
                        context.body = bound_body(&context.body, &mut context.truncated);
                        context.chapters = chapters_from_notes(&context.body);
                        contexts.push(context);
                    }
                }
                if depth == 0 {
                    bail!("invalid XML close tag without an open element");
                }
                depth -= 1;
            }
            Ok(Event::Eof) => {
                if depth != 0 || current.is_some() || capture.is_some() {
                    bail!("invalid XML ended before all elements were closed");
                }
                break;
            }
            Err(error) => return Err(error).context("invalid XML while retaining reading context"),
            _ => {}
        }
        buffer.clear();
    }
    Ok(contexts)
}

pub fn context_for_item(
    contexts: &[FeedContext],
    external_id: &str,
    canonical_url: &str,
    title: &str,
) -> Option<FeedContext> {
    contexts
        .iter()
        .find(|context| context.external_id.as_deref() == Some(external_id))
        .or_else(|| {
            contexts
                .iter()
                .find(|context| context.url.as_deref() == Some(canonical_url))
        })
        .map(Clone::clone)
        .or_else(|| {
            let mut matches = contexts
                .iter()
                .filter(|context| context.title.as_deref() == Some(title));
            let first = matches.next()?;
            matches.next().is_none().then(|| first.clone())
        })
}

pub fn normalize_podcast_context(mut context: FeedContext) -> FeedContext {
    context.body = bound_body(&context.body, &mut context.truncated);
    context.chapters = chapters_from_notes(&context.body);
    context
}

#[cfg(test)]
mod podcast_retention_tests {
    use super::*;

    #[test]
    fn retained_notes_do_not_discard_chapters_after_a_sponsor_section() {
        let context = normalize_podcast_context(FeedContext {
            body: "Introduction\n\nSPONSORS:\nSponsor information\n\n00:00 Introduction\n12:30 Technical discussion\n\nPractical finding: use x < n for the upper bound.".into(),
            ..Default::default()
        });
        assert!(context.body.contains("Technical discussion"));
        assert!(context.body.contains("x < n"));
        assert_eq!(context.chapters.len(), 2);
        assert_eq!(context.chapters[1].start_seconds, 750);
    }
}

pub fn extract_publisher_article(html: &str) -> Option<(String, bool)> {
    let candidate = extract_element(html, "article").or_else(|| extract_element(html, "main"))?;
    let mut truncated = false;
    let body = bound_body(&reading_text(candidate), &mut truncated);
    (body.chars().count() >= 240 && !looks_like_access_challenge(&body))
        .then_some((body, truncated))
}

fn local_name(name: &[u8]) -> String {
    let name = String::from_utf8_lossy(name);
    name.rsplit(':')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn attribute(element: &quick_xml::events::BytesStart<'_>, wanted: &str) -> Option<String> {
    element
        .attributes()
        .with_checks(false)
        .flatten()
        .find_map(|attribute| {
            (local_name(attribute.key.as_ref()) == wanted)
                .then(|| String::from_utf8_lossy(attribute.value.as_ref()).into_owned())
        })
}

fn resolve_url(endpoint: &Url, value: &str) -> Option<String> {
    endpoint
        .join(value.trim())
        .ok()
        .and_then(|url| validate_public_https(url.as_str()).ok())
        .map(|url| url.to_string())
}

fn append_field(context: &mut FeedContext, field: &str, value: &str, endpoint: &Url) {
    match field {
        "guid" | "id" => {
            if context.external_id.is_none() {
                context.external_id = Some(reading_text(value));
            }
        }
        "title" => {
            if context.title.is_none() {
                context.title = Some(excerpt(value, 300));
            }
        }
        "link" => {
            if context.url.is_none() {
                context.url = resolve_url(endpoint, &reading_text(value));
            }
        }
        "duration" => {
            if context.duration_seconds.is_none() {
                context.duration_seconds = parse_duration(&reading_text(value));
            }
        }
        "description" | "summary" | "encoded" | "content" => {
            let value = reading_text(value);
            if value.chars().count() > context.body.chars().count() {
                context.body = value;
            }
        }
        _ => {}
    }
}

fn append_start_tag(output: &mut String, name: &str) {
    output.push('<');
    output.push_str(name);
    output.push('>');
}

fn append_empty_tag(output: &mut String, name: &str) {
    output.push('<');
    output.push_str(name);
    output.push_str("/>");
}

fn append_end_tag(output: &mut String, name: &str) {
    output.push_str("</");
    output.push_str(name);
    output.push('>');
}

fn bound_body(value: &str, truncated: &mut bool) -> String {
    let body = value.trim();
    if body.chars().count() <= MAX_RETAINED_BODY_CHARS {
        return body.to_owned();
    }
    *truncated = true;
    let mut result: String = body.chars().take(MAX_RETAINED_BODY_CHARS).collect();
    result.truncate(result.trim_end().len());
    result
}

fn parse_duration(value: &str) -> Option<u64> {
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(seconds);
    }
    let numbers: Option<Vec<u64>> = value
        .split(':')
        .map(str::trim)
        .map(|part| part.parse::<u64>().ok())
        .collect();
    let numbers = numbers?;
    match numbers.as_slice() {
        [minutes, seconds] if *seconds < 60 => minutes.checked_mul(60)?.checked_add(*seconds),
        [hours, minutes, seconds] if *minutes < 60 && *seconds < 60 => hours
            .checked_mul(3600)?
            .checked_add(minutes.checked_mul(60)?)?
            .checked_add(*seconds),
        _ => None,
    }
}

fn parse_chapter_timestamp(value: &str) -> Option<u64> {
    let value = value.trim_end_matches(['-', '–', '—', ':']);
    value.contains(':').then(|| parse_duration(value)).flatten()
}

fn chapters_from_notes(body: &str) -> Vec<Chapter> {
    let mut starts = BTreeSet::new();
    body.lines()
        .filter_map(|line| {
            let line = line
                .trim()
                .trim_start_matches(['-', '–', '—', '•', '*', ' ']);
            let (timestamp, title) = line.split_once(char::is_whitespace)?;
            let start_seconds = parse_chapter_timestamp(timestamp)?;
            let title = excerpt(title.trim_matches(['-', '–', '—', ':', ' ']), 400);
            (!title.is_empty() && starts.insert(start_seconds)).then_some(Chapter {
                start_seconds,
                title,
                url: None,
            })
        })
        .take(MAX_CHAPTERS)
        .collect()
}

fn extract_element<'a>(html: &'a str, wanted: &str) -> Option<&'a str> {
    let lower = html.to_ascii_lowercase();
    let needle = format!("<{wanted}");
    let mut offset = 0;
    let start = loop {
        let found = lower[offset..].find(&needle)? + offset;
        let boundary = lower.as_bytes().get(found + needle.len()).copied();
        if matches!(boundary, Some(b'>' | b'/' | b' ' | b'\t' | b'\r' | b'\n')) {
            break found;
        }
        offset = found + needle.len();
    };
    let content_start = lower[start..].find('>').map(|offset| start + offset + 1)?;
    let end = lower[content_start..].find(&format!("</{wanted}>"))?;
    Some(&html[content_start..content_start + end])
}

fn looks_like_access_challenge(body: &str) -> bool {
    let text = body.to_ascii_lowercase();
    [
        "access denied",
        "verify you are human",
        "enable javascript",
        "just a moment",
        "captcha",
    ]
    .iter()
    .any(|marker| text.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_podcast_notes_duration_chapters_and_transcript_link() {
        let xml = br#"<rss xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:itunes="x"><channel><item>
          <guid>episode-1</guid><title>Episode</title><description><![CDATA[<h2>Notes</h2><p>Intro</p><p>00:00 Opening</p><p>12:30 Deep dive</p>]]></description>
          <itunes:duration>01:02:03</itunes:duration><podcast:chapters url="/chapters.json"/>
          <podcast:transcript url="/episode.vtt"/></item></channel></rss>"#;
        let endpoint = Url::parse("https://pod.example/feed.xml").unwrap();
        let context = parse_feed_contexts(xml, &endpoint).unwrap().remove(0);
        assert_eq!(context.external_id.as_deref(), Some("episode-1"));
        assert_eq!(context.duration_seconds, Some(3723));
        assert_eq!(context.chapters.len(), 2);
        assert_eq!(context.chapters[1].start_seconds, 750);
        assert_eq!(
            context.transcript_url.as_deref(),
            Some("https://pod.example/episode.vtt")
        );
        assert_eq!(
            context.references.chapters_url.as_deref(),
            Some("https://pod.example/chapters.json")
        );
        assert!(context.body.contains("Notes\n\nIntro"));
    }

    #[test]
    fn chapter_lines_require_colon_timestamps() {
        let chapters = chapters_from_notes(
            "2026 was a productive year\n\
             3 takeaways from the interview\n\
             3: an invalid timestamp label\n\
             01:02 First real chapter\n\
             1:02:03 Second real chapter",
        );
        assert_eq!(chapters.len(), 2);
        assert_eq!(chapters[0].start_seconds, 62);
        assert_eq!(chapters[0].title, "First real chapter");
        assert_eq!(chapters[1].start_seconds, 3723);
        assert_eq!(chapters[1].title, "Second real chapter");
    }

    #[test]
    fn duration_overflow_is_rejected() {
        assert_eq!(parse_duration("18446744073709551615:00"), None);
        assert_eq!(parse_duration("18446744073709551615:00:00"), None);
    }

    #[test]
    fn context_fingerprint_ignores_fetch_time_and_captures_material() {
        let feed = FeedContext {
            body: "Publisher supplied notes".into(),
            ..Default::default()
        };
        let first = ReadingContext::from_feed(
            ReadingContextKind::Podcast,
            "https://example.com/episode".into(),
            feed.clone(),
            DateTime::UNIX_EPOCH,
        );
        let second = ReadingContext::from_feed(
            ReadingContextKind::Podcast,
            "https://example.com/episode".into(),
            feed,
            Utc::now(),
        );
        assert_eq!(first.fingerprint(), second.fingerprint());
        assert_eq!(first.material_fingerprint(), second.material_fingerprint());
        assert_eq!(first.comments_status, CommentsStatus::NotApplicable);
    }

    #[test]
    fn acquisition_state_is_not_material() {
        let feed = FeedContext {
            body: "Publisher supplied notes".into(),
            ..Default::default()
        };
        let available = ReadingContext::from_feed(
            ReadingContextKind::Article,
            "https://example.com/article".into(),
            feed,
            Utc::now(),
        );
        let blocked = available.clone().blocked_from_feed();
        assert_ne!(available.fingerprint(), blocked.fingerprint());
        assert_eq!(
            available.material_fingerprint(),
            blocked.material_fingerprint()
        );
    }

    #[test]
    fn comment_votes_and_order_are_not_summary_material() {
        let mut first = ReadingContext::publisher_page(
            "https://www.reddit.com/r/example/comments/abc123/post/".into(),
            "Original post".into(),
            false,
            Utc::now(),
        );
        first.kind = ReadingContextKind::Post;
        first.comments_status = CommentsStatus::Available;
        first.comments = vec![
            ReadingComment {
                id: "t1_first".into(),
                body: "First actual comment".into(),
                score: Some(12),
                url: None,
                author: None,
                published_at: None,
                truncated: false,
            },
            ReadingComment {
                id: "t1_second".into(),
                body: "Second actual comment".into(),
                score: None,
                url: None,
                author: None,
                published_at: None,
                truncated: false,
            },
        ];
        let mut second = first.clone();
        second.comments[0].score = Some(24);
        second.comments.reverse();
        assert_ne!(first.fingerprint(), second.fingerprint());
        assert_eq!(first.material_fingerprint(), second.material_fingerprint());
        let serialized = serde_json::to_value(&second).unwrap();
        assert!(serialized["comments"][0]["score"].is_null());
        assert_eq!(
            serde_json::from_value::<ReadingContext>(serialized).unwrap(),
            second
        );
        second.comments[0]
            .body
            .push_str(" with a material correction");
        assert_ne!(first.material_fingerprint(), second.material_fingerprint());
    }

    #[test]
    fn post_context_requires_authorization_without_fabricating_comments() {
        let context = ReadingContext::from_feed(
            ReadingContextKind::Post,
            "https://reddit.com/post".into(),
            FeedContext {
                body: "Only supplied post text".into(),
                ..Default::default()
            },
            Utc::now(),
        );
        assert_eq!(
            context.comments_status,
            CommentsStatus::RequiresAuthorization
        );
        assert!(context.comments.is_empty());
        assert_eq!(context.status, ReadingContextStatus::Partial);
    }

    #[test]
    fn publisher_article_prefers_article_and_discards_navigation() {
        let (body, truncated) = extract_publisher_article(&format!(
            "<nav>Menu</nav><article><h2>Heading</h2><p>{}</p><script>bad()</script></article>",
            "Useful details ".repeat(20)
        ))
        .unwrap();
        assert!(!truncated);
        assert!(body.starts_with("Heading\n\nUseful details"));
    }

    #[test]
    fn exact_stratechery_paywall_boundary_preserves_intro_and_marks_partial() {
        let intro = "Pacing the Frontier, AI's Digital Limits, AI Commissars\nSeptember 15, 2026\nListen to Podcast\nDario Amodei discusses pacing AI and political control.";
        let body = format!(
            "{intro}\n\n{STRATECHERY_PAYWALL_MARKER}\n{}",
            "Login Pricing Subscribe Advertising Podcast catalogue. ".repeat(100)
        );
        let url = "https://stratechery.com/2026/pacing-the-frontier/".to_owned();
        let contexts = [
            ReadingContext::publisher_page(url.clone(), body.clone(), false, Utc::now()),
            ReadingContext::from_feed(
                ReadingContextKind::Article,
                url.clone(),
                FeedContext {
                    body: body.clone(),
                    ..Default::default()
                },
                Utc::now(),
            ),
            ReadingContext::retained_excerpt_article(url, body, false, Utc::now()),
        ];
        for context in contexts {
            assert_eq!(context.body, intro);
            assert_eq!(context.status, ReadingContextStatus::Partial);
            assert!(context.truncated);
            assert_eq!(context.access_limit.as_deref(), Some("paywall"));
            assert_eq!(context.clone().respect_publisher_access(), context);
        }
    }

    #[test]
    fn paywall_detection_is_publisher_specific_and_does_not_veto_subscribe_mentions() {
        let body = format!(
            "A substantive analysis of why readers subscribe.\n{}",
            "Original platform strategy argument and evidence. ".repeat(40)
        );
        let context = ReadingContext::publisher_page(
            "https://www.stratechery.com/2026/free-analysis/".into(),
            body.clone(),
            false,
            Utc::now(),
        );
        assert_eq!(context.body, body);
        assert_eq!(context.status, ReadingContextStatus::Available);
        assert!(context.access_limit.is_none());
        for url in [
            "https://other.example/article",
            "https://stratechery.com.other.example/article",
            "https://stratechery.com@other.example/article",
        ] {
            let text = format!("An article quoting {STRATECHERY_PAYWALL_MARKER} and its meaning.");
            let other = ReadingContext::publisher_page(url.into(), text.clone(), false, Utc::now());
            assert_eq!(other.body, text);
            assert_eq!(other.status, ReadingContextStatus::Available);
        }
        let mut legacy = serde_json::to_value(&context).unwrap();
        legacy.as_object_mut().unwrap().remove("accessLimit");
        assert!(
            serde_json::from_value::<ReadingContext>(legacy)
                .unwrap()
                .access_limit
                .is_none()
        );
    }

    #[test]
    fn publisher_article_rejects_challenge_or_non_article_pages() {
        assert!(
            extract_publisher_article("<html><body><nav>Menu</nav>Access denied</body></html>")
                .is_none()
        );
        assert!(
            extract_publisher_article("<article>Just a moment, verify you are human.</article>")
                .is_none()
        );
    }

    #[test]
    fn malformed_feed_context_fails_without_accepting_partial_xml() {
        let endpoint = Url::parse("https://pod.example/feed.xml").unwrap();
        assert!(parse_feed_contexts(b"<rss><item><title>unterminated", &endpoint).is_err());
    }

    #[test]
    fn retains_complete_xhtml_cdata_entities_and_rss_link_text() {
        let xml = br#"<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>entry-1</id><title>Entry</title>
          <link>https://example.com/original</link><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">
          <p>First &amp; second</p><p>Third<br/>fourth</p></div></content>
          <summary><![CDATA[<p>Split ]]><![CDATA[CDATA body</p>]]></summary></entry></feed>"#;
        let endpoint = Url::parse("https://example.com/feed.xml").unwrap();
        let context = parse_feed_contexts(xml, &endpoint).unwrap().remove(0);
        assert_eq!(context.url.as_deref(), Some("https://example.com/original"));
        assert_eq!(context.body, "First & second\n\nThird\n\nfourth");

        let split = br#"<rss><channel><item><guid>x</guid><description><![CDATA[<p>First ]]><![CDATA[second</p><br/><p>third</p>]]></description></item></channel></rss>"#;
        let context = parse_feed_contexts(split, &endpoint).unwrap().remove(0);
        assert_eq!(context.body, "First second\n\nthird");
    }

    #[test]
    fn ambiguous_duplicate_titles_do_not_associate_contexts() {
        let contexts = vec![
            FeedContext {
                title: Some("Same".into()),
                body: "First".into(),
                ..Default::default()
            },
            FeedContext {
                title: Some("Same".into()),
                body: "Second".into(),
                ..Default::default()
            },
        ];
        assert!(
            context_for_item(&contexts, "unknown", "https://example.com/unknown", "Same").is_none()
        );
    }

    #[test]
    fn linked_resources_reject_non_https_and_local_urls() {
        let xml = br#"<rss xmlns:podcast="x"><channel><item><guid>episode</guid>
          <podcast:chapters url="http://example.com/chapters.json"/>
          <podcast:transcript url="https://127.0.0.1/episode.vtt"/></item></channel></rss>"#;
        let endpoint = Url::parse("https://pod.example/feed.xml").unwrap();
        let context = parse_feed_contexts(xml, &endpoint).unwrap().remove(0);
        assert!(context.references.chapters_url.is_none());
        assert!(context.transcript_url.is_none());
    }
}
