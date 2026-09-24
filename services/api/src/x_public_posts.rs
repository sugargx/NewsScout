use anyhow::{Context, Result, bail, ensure};
use chrono::{DateTime, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::json;
use url::Url;

use crate::{
    ingestion::{Enclosure, FetchedItem, fingerprint},
    processing::{MAX_EXCERPT_CHARS, decode_entities, plain_text},
    reading_context::{
        CommentsStatus, ReadingContext, ReadingContextKind, ReadingContextOrigin,
        ReadingContextStatus, VERSION,
    },
};

const MAX_EMBED_HTML_BYTES: usize = 128 * 1024;
const MAX_BODY_CHARS: usize = 4_000;
const MAX_TITLE_CHARS: usize = 140;
const MAX_AUTHOR_NAME_CHARS: usize = 300;

#[derive(Deserialize)]
struct OEmbedResponse {
    url: String,
    author_name: String,
    author_url: String,
    html: String,
    #[serde(rename = "type")]
    embed_type: String,
    provider_name: String,
    provider_url: String,
    version: String,
}

#[derive(Default)]
struct EmbedText {
    paragraphs: Vec<String>,
    date_labels: Vec<String>,
}

pub fn validate_profile_endpoint(value: &str) -> Result<Url> {
    let value = require_canonical_input(value)?;
    let url = Url::parse(value).context("invalid X profile URL")?;
    let handle = url.path().strip_prefix('/').unwrap_or_default();
    ensure!(
        is_valid_handle(handle),
        "X profile URL must contain a 1-15 character ASCII handle"
    );
    let canonical = format!("https://x.com/{handle}");
    ensure!(
        url.as_str() == canonical,
        "X profile URL must be canonical https://x.com/<handle>"
    );
    Ok(url)
}

pub fn validate_post_url(value: &str, handle: &str) -> Result<Url> {
    ensure!(
        is_valid_handle(handle),
        "X handle must contain a 1-15 character ASCII handle"
    );
    let value = require_canonical_input(value)?;
    let url = Url::parse(value).context("invalid X post URL")?;
    ensure!(
        url.scheme() == "https"
            && url.host_str() == Some("x.com")
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "X post URL must use canonical https://x.com without credentials, port, query, or fragment"
    );
    let segments: Vec<_> = url
        .path_segments()
        .context("X post URL has no path")?
        .collect();
    ensure!(
        segments.len() == 3
            && segments[0] == handle
            && segments[1] == "status"
            && !segments[2].is_empty()
            && segments[2].bytes().all(|byte| byte.is_ascii_digit()),
        "X post URL must be https://x.com/<samehandle>/status/<digits>"
    );
    let canonical = format!("https://x.com/{handle}/status/{}", segments[2]);
    ensure!(
        url.as_str() == canonical,
        "X post URL must be canonical without alternate encoding or path components"
    );
    Ok(url)
}

pub fn parse_oembed(bytes: &[u8], requested_post: &Url) -> Result<FetchedItem> {
    ensure!(
        bytes.len() <= MAX_EMBED_HTML_BYTES,
        "X publisher response exceeds its size bound"
    );
    let (requested_post, handle, status_id) = requested_identity(requested_post)?;
    let response: OEmbedResponse =
        serde_json::from_slice(bytes).context("invalid X publisher oEmbed JSON")?;
    ensure!(
        response.html.len() <= MAX_EMBED_HTML_BYTES,
        "X publisher embed HTML exceeds its size bound"
    );
    ensure!(
        matches!(response.provider_name.as_str(), "X" | "Twitter")
            && response.embed_type == "rich"
            && response.version == "1.0",
        "X publisher embed has an unexpected provider, type, or version"
    );
    let provider = canonicalize_oembed_url(&response.provider_url)?;
    ensure!(
        provider.path() == "/",
        "X publisher embed has an unexpected provider URL"
    );

    let response_post = canonicalize_oembed_post_url(&response.url, &handle)
        .context("X publisher embed returned an invalid post URL")?;
    ensure!(
        response_post == requested_post,
        "X publisher embed returned a different post"
    );
    let author = canonicalize_oembed_profile_url(&response.author_url)
        .context("X publisher embed returned an invalid author URL")?;
    ensure!(
        author.path().trim_start_matches('/') == handle,
        "X publisher embed returned a different author"
    );
    let author_name = bounded_required_text(
        &response.author_name,
        MAX_AUTHOR_NAME_CHARS,
        "X publisher embed is missing a bounded author name",
    )?;

    let extracted = extract_embed_text(&response.html, &requested_post)?;
    let body = bounded_text(
        &extracted.paragraphs.join("\n\n"),
        MAX_BODY_CHARS,
        "X publisher embed has no first-party post preview text",
    )?;
    let published_date_display = extracted
        .date_labels
        .into_iter()
        .next()
        .context("X publisher embed has no date attribution for the requested post")?;
    let published = parse_calendar_day(&published_date_display)?;
    ensure!(
        published.date_naive() <= Utc::now().date_naive(),
        "X publisher embed date is in the future"
    );

    let title_source = body
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .context("X publisher embed has no source-text title line")?;
    let title = truncate_chars(&format!("@{handle}: {title_source}"), MAX_TITLE_CHARS);
    let summary = truncate_chars(&body, MAX_EXCERPT_CHARS);
    let url = requested_post.to_string();
    let content_hash = fingerprint(
        &url,
        &title,
        Some(summary.as_str()),
        Some(published),
        &[] as &[Enclosure],
    )?;
    let reading_context = ReadingContext {
        version: VERSION,
        kind: ReadingContextKind::Post,
        origin: ReadingContextOrigin::PublisherPage,
        status: ReadingContextStatus::Partial,
        source_url: url.clone(),
        body,
        truncated: true,
        duration_seconds: None,
        chapters: Vec::new(),
        transcript_url: None,
        comments: Vec::new(),
        comments_status: CommentsStatus::NotFetched,
        fetched_at: None,
        access_limit: None,
    };

    Ok(FetchedItem {
        external_id: format!("x:{status_id}"),
        title,
        url,
        published_at: Some(published),
        summary: Some(summary),
        content_hash,
        enclosures: Vec::new(),
        source_metadata: json!({
            "kind": "x_public_preview",
            "coverage": "registered_original_links_not_full_timeline",
            "authorHandle": handle,
            "authorName": author_name,
            "provenance": "x-publish-oembed",
            "textComplete": false,
            "publicationPrecision": "day",
            "datePrecision": "day",
            "publishedDateDisplay": published_date_display,
            "dateBasis": "publisher_embed_calendar_day",
        }),
        reading_context: Some(reading_context),
        reading_context_resources: json!({}),
    })
}

fn require_canonical_input(value: &str) -> Result<&str> {
    ensure!(
        value == value.trim(),
        "X URL must not contain surrounding whitespace"
    );
    ensure!(
        value.starts_with("https://x.com/"),
        "X URL must use canonical https://x.com"
    );
    Ok(value)
}

fn is_valid_handle(handle: &str) -> bool {
    (1..=15).contains(&handle.len())
        && handle
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn requested_identity(requested_post: &Url) -> Result<(Url, String, String)> {
    let segments: Vec<_> = requested_post
        .path_segments()
        .context("requested X post URL has no path")?
        .collect();
    let handle = segments
        .first()
        .context("requested X post URL is missing its handle")?
        .to_string();
    let post = validate_post_url(requested_post.as_str(), &handle)?;
    let status_id = segments
        .get(2)
        .context("requested X post URL is missing its status ID")?
        .to_string();
    Ok((post, handle, status_id))
}

fn canonicalize_oembed_profile_url(value: &str) -> Result<Url> {
    let url = canonicalize_oembed_url(value)?;
    validate_profile_endpoint(url.as_str())
}

fn canonicalize_oembed_post_url(value: &str, handle: &str) -> Result<Url> {
    let url = canonicalize_oembed_url(value)?;
    validate_post_url(url.as_str(), handle)
}

fn canonicalize_oembed_url(value: &str) -> Result<Url> {
    ensure!(
        value == value.trim(),
        "X publisher embed URL must not contain surrounding whitespace"
    );
    let mut url = Url::parse(value).context("invalid X publisher embed URL")?;
    ensure!(
        url.scheme() == "https"
            && matches!(url.host_str(), Some("x.com" | "twitter.com"))
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "X publisher embed URL must use documented x.com or twitter.com aliases without credentials, port, query, or fragment"
    );
    if url.host_str() == Some("twitter.com") {
        url.set_host(Some("x.com"))
            .context("could not canonicalize legacy twitter.com host")?;
    }
    Ok(url)
}

fn extract_embed_text(html: &str, requested_post: &Url) -> Result<EmbedText> {
    let mut result = EmbedText::default();
    let mut stack: Vec<String> = Vec::new();
    let mut provider_depth = None;
    let mut provider_seen = false;
    let mut nested_quote_depth = 0usize;
    let mut suppressed_depth = 0usize;
    let mut paragraph: Option<(usize, String)> = None;
    let mut date_anchor: Option<(usize, String)> = None;
    let mut cursor = 0;

    while let Some(relative_start) = html[cursor..].find('<') {
        let start = cursor + relative_start;
        append_text(
            &html[cursor..start],
            suppressed_depth,
            nested_quote_depth,
            paragraph.as_mut(),
            date_anchor.as_mut(),
        );
        let (end, tag) = parse_tag(html, start)?;
        if tag.closing {
            let closes_provider = tag.name == "blockquote" && provider_depth == Some(stack.len());
            close_tag(
                &tag,
                &mut stack,
                provider_depth,
                &mut nested_quote_depth,
                &mut suppressed_depth,
                &mut paragraph,
                &mut date_anchor,
                &mut result,
            )?;
            if closes_provider {
                provider_depth = None;
            }
        } else if !is_void_tag(&tag.name) {
            stack.push(tag.name.clone());
            let depth = stack.len();
            if provider_depth.is_none()
                && tag.name == "blockquote"
                && attribute(&tag.attributes, "class").is_some_and(|class| {
                    class
                        .split_ascii_whitespace()
                        .any(|value| value == "twitter-tweet")
                })
            {
                ensure!(
                    !provider_seen,
                    "X publisher embed has multiple provider blocks"
                );
                provider_seen = true;
                provider_depth = Some(depth);
            } else if provider_depth
                .is_some_and(|provider| tag.name == "blockquote" && depth > provider)
            {
                nested_quote_depth += 1;
            }
            if matches!(
                tag.name.as_str(),
                "script" | "style" | "template" | "noscript"
            ) {
                suppressed_depth += 1;
            }
            if provider_depth.is_some_and(|provider| {
                depth == provider + 1 && nested_quote_depth == 0 && suppressed_depth == 0
            }) {
                if tag.name == "p" {
                    ensure!(
                        paragraph.is_none(),
                        "X publisher embed has overlapping post paragraphs"
                    );
                    paragraph = Some((depth, String::new()));
                } else if tag.name == "a"
                    && attribute(&tag.attributes, "href")
                        .is_some_and(|href| href_matches_requested_post(&href, requested_post))
                {
                    ensure!(
                        date_anchor.is_none(),
                        "X publisher embed has ambiguous date attribution"
                    );
                    date_anchor = Some((depth, String::new()));
                }
            }
            if tag.self_closing {
                close_tag(
                    &tag,
                    &mut stack,
                    provider_depth,
                    &mut nested_quote_depth,
                    &mut suppressed_depth,
                    &mut paragraph,
                    &mut date_anchor,
                    &mut result,
                )?;
            }
        } else if tag.name == "br" {
            if let Some((_, text)) = paragraph.as_mut()
                && suppressed_depth == 0
                && nested_quote_depth == 0
            {
                text.push('\n');
            }
        }
        cursor = end;
    }
    append_text(
        &html[cursor..],
        suppressed_depth,
        nested_quote_depth,
        paragraph.as_mut(),
        date_anchor.as_mut(),
    );

    ensure!(
        provider_seen,
        "X publisher embed has no provider blockquote"
    );
    ensure!(stack.is_empty(), "X publisher embed has unclosed markup");
    ensure!(
        paragraph.is_none(),
        "X publisher embed has an unclosed post paragraph"
    );
    ensure!(
        date_anchor.is_none(),
        "X publisher embed has an unclosed date attribution"
    );
    ensure!(
        !result.paragraphs.is_empty(),
        "X publisher embed has no first-party post paragraphs"
    );
    ensure!(
        result.date_labels.len() == 1,
        "X publisher embed must have exactly one requested-post date attribution"
    );
    Ok(result)
}

fn append_text(
    value: &str,
    suppressed_depth: usize,
    nested_quote_depth: usize,
    paragraph: Option<&mut (usize, String)>,
    date_anchor: Option<&mut (usize, String)>,
) {
    if suppressed_depth != 0 || nested_quote_depth != 0 {
        return;
    }
    if let Some((_, text)) = paragraph {
        text.push_str(value);
    }
    if let Some((_, text)) = date_anchor {
        text.push_str(value);
    }
}

fn close_tag(
    tag: &Tag,
    stack: &mut Vec<String>,
    provider_depth: Option<usize>,
    nested_quote_depth: &mut usize,
    suppressed_depth: &mut usize,
    paragraph: &mut Option<(usize, String)>,
    date_anchor: &mut Option<(usize, String)>,
    result: &mut EmbedText,
) -> Result<()> {
    let depth = stack.len();
    ensure!(
        stack.last().is_some_and(|open| open == &tag.name),
        "X publisher embed has malformed markup"
    );
    if paragraph
        .as_ref()
        .is_some_and(|(active_depth, _)| *active_depth == depth)
    {
        let (_, text) = paragraph.take().expect("checked above");
        let text = decode_entities(&text)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if !text.is_empty() {
            result.paragraphs.push(text);
        }
    }
    if date_anchor
        .as_ref()
        .is_some_and(|(active_depth, _)| *active_depth == depth)
    {
        let (_, text) = date_anchor.take().expect("checked above");
        let text = decode_entities(&text)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if !text.is_empty() {
            result.date_labels.push(text);
        }
    }
    if matches!(
        tag.name.as_str(),
        "script" | "style" | "template" | "noscript"
    ) {
        *suppressed_depth = suppressed_depth
            .checked_sub(1)
            .context("X publisher embed has malformed suppressed markup")?;
    }
    if tag.name == "blockquote" && provider_depth.is_some_and(|provider| depth > provider) {
        *nested_quote_depth = nested_quote_depth
            .checked_sub(1)
            .context("X publisher embed has malformed nested quote markup")?;
    }
    stack.pop();
    Ok(())
}

struct Tag {
    name: String,
    attributes: String,
    closing: bool,
    self_closing: bool,
}

fn parse_tag(input: &str, start: usize) -> Result<(usize, Tag)> {
    let bytes = input.as_bytes();
    let mut end = start + 1;
    let mut quote = None;
    while end < bytes.len() {
        match (quote, bytes[end]) {
            (Some(expected), byte) if expected == byte => quote = None,
            (None, b'\'' | b'"') => quote = Some(bytes[end]),
            (None, b'>') => break,
            _ => {}
        }
        end += 1;
    }
    ensure!(end < bytes.len(), "X publisher embed has an unclosed tag");
    let raw = input[start + 1..end].trim();
    ensure!(
        !raw.starts_with('!') && !raw.starts_with('?'),
        "X publisher embed has unsupported markup"
    );
    let closing = raw.starts_with('/');
    let raw = raw.trim_start_matches('/').trim();
    let name_end = raw
        .find(|character: char| character.is_ascii_whitespace() || character == '/')
        .unwrap_or(raw.len());
    let name = raw[..name_end].to_ascii_lowercase();
    ensure!(
        !name.is_empty()
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'),
        "X publisher embed has an invalid tag name"
    );
    Ok((
        end + 1,
        Tag {
            name,
            attributes: raw[name_end..]
                .trim()
                .trim_end_matches('/')
                .trim()
                .to_string(),
            closing,
            self_closing: !closing && raw.ends_with('/'),
        },
    ))
}

fn attribute(attributes: &str, expected_name: &str) -> Option<String> {
    let bytes = attributes.as_bytes();
    let mut cursor = 0;
    while cursor < bytes.len() {
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        let start = cursor;
        while bytes
            .get(cursor)
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
        {
            cursor += 1;
        }
        if start == cursor {
            break;
        }
        let name = &attributes[start..cursor];
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        let value = if bytes.get(cursor) == Some(&b'=') {
            cursor += 1;
            while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
                cursor += 1;
            }
            match bytes.get(cursor).copied() {
                Some(b'\'' | b'"') => {
                    let quote = bytes[cursor];
                    cursor += 1;
                    let value_start = cursor;
                    while bytes.get(cursor) != Some(&quote) {
                        if cursor == bytes.len() {
                            return None;
                        }
                        cursor += 1;
                    }
                    let value = attributes[value_start..cursor].to_string();
                    cursor += 1;
                    value
                }
                Some(_) => {
                    let value_start = cursor;
                    while bytes
                        .get(cursor)
                        .is_some_and(|byte| !byte.is_ascii_whitespace())
                    {
                        cursor += 1;
                    }
                    attributes[value_start..cursor].to_string()
                }
                None => return None,
            }
        } else {
            String::new()
        };
        if name.eq_ignore_ascii_case(expected_name) {
            return Some(value);
        }
    }
    None
}

fn is_void_tag(name: &str) -> bool {
    matches!(
        name,
        "br" | "hr" | "img" | "meta" | "link" | "input" | "source" | "wbr"
    )
}

fn href_matches_requested_post(value: &str, requested_post: &Url) -> bool {
    let value = plain_text(value);
    let Ok(mut link) = Url::parse(&value) else {
        return false;
    };
    if link.fragment().is_some() || link.query_pairs().any(|(key, _)| key.as_ref() != "ref_src") {
        return false;
    }
    link.set_query(None);
    if !matches!(link.host_str(), Some("x.com" | "twitter.com"))
        || link.set_host(Some("x.com")).is_err()
    {
        return false;
    }
    let Some(handle) = link
        .path_segments()
        .and_then(|mut segments| segments.next())
    else {
        return false;
    };
    validate_post_url(link.as_str(), handle).is_ok_and(|canonical| canonical == *requested_post)
}

fn parse_calendar_day(value: &str) -> Result<DateTime<Utc>> {
    let value = value.trim();
    let (month_and_day, year) = value
        .split_once(',')
        .context("X publisher embed date must be a calendar day")?;
    ensure!(
        !year.contains(','),
        "X publisher embed date must contain exactly one comma"
    );
    let mut pieces = month_and_day.split_whitespace();
    let month = pieces
        .next()
        .context("X publisher embed date is missing its month")?;
    let day = pieces
        .next()
        .context("X publisher embed date is missing its day")?;
    ensure!(
        pieces.next().is_none()
            && day.bytes().all(|byte| byte.is_ascii_digit())
            && year.trim().bytes().all(|byte| byte.is_ascii_digit()),
        "X publisher embed date is invalid"
    );
    let month = match month {
        "January" => 1,
        "February" => 2,
        "March" => 3,
        "April" => 4,
        "May" => 5,
        "June" => 6,
        "July" => 7,
        "August" => 8,
        "September" => 9,
        "October" => 10,
        "November" => 11,
        "December" => 12,
        _ => bail!("X publisher embed date has an invalid month"),
    };
    let day = day
        .parse::<u32>()
        .context("X publisher embed date has an invalid day")?;
    let year = year
        .trim()
        .parse::<i32>()
        .context("X publisher embed date has an invalid year")?;
    NaiveDate::from_ymd_opt(year, month, day)
        .context("X publisher embed date is not a real calendar day")?
        .and_hms_opt(0, 0, 0)
        .context("X publisher embed date has no midnight UTC representation")
        .map(|date| date.and_utc())
}

fn bounded_required_text(value: &str, limit: usize, message: &str) -> Result<String> {
    let value = plain_text(value);
    ensure!(
        !value.is_empty() && value.chars().count() <= limit,
        "{message}"
    );
    Ok(value)
}

fn bounded_text(value: &str, limit: usize, message: &str) -> Result<String> {
    let value = value.trim();
    ensure!(!value.is_empty(), "{message}");
    Ok(truncate_chars(value, limit))
}

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    value
        .chars()
        .take(limit.saturating_sub(3))
        .collect::<String>()
        + "..."
}

#[cfg(test)]
mod tests {
    use super::*;

    const POST_URL: &str = "https://x.com/karpathy/status/2083749667410727319";

    fn fixture() -> serde_json::Value {
        json!({
            "url": POST_URL,
            "author_name": "Andrej Karpathy",
            "author_url": "https://x.com/karpathy",
            "html": "<blockquote class=\"twitter-tweet\"><p lang=\"en\">First &amp; second<br>source paragraph.<script>never include this</script></p><blockquote><p>Nested quoted post must not be attributed.</p></blockquote>&mdash; Andrej Karpathy (@karpathy) <a href=\"https://x.com/karpathy/status/2083749667410727319?ref_src=twsrc%5Etfw\">August 2, 2026</a></blockquote>",
            "width": 550,
            "height": null,
            "type": "rich",
            "provider_name": "X",
            "provider_url": "https://x.com",
            "version": "1.0"
        })
    }

    fn parse(value: serde_json::Value) -> Result<FetchedItem> {
        parse_oembed(&serde_json::to_vec(&value)?, &Url::parse(POST_URL)?)
    }

    #[test]
    fn validates_canonical_profile_and_post_urls() {
        assert_eq!(
            validate_profile_endpoint("https://x.com/karpathy")
                .unwrap()
                .as_str(),
            "https://x.com/karpathy"
        );
        assert_eq!(
            validate_post_url(POST_URL, "karpathy").unwrap().as_str(),
            POST_URL
        );
        for invalid in [
            "https://www.x.com/karpathy",
            "https://x.com/karpathy/",
            "https://x.com/karpathy?tab=posts",
            "https://x.com/karpathy/status/1",
        ] {
            assert!(validate_profile_endpoint(invalid).is_err(), "{invalid}");
        }
        for invalid in [
            "https://x.com/Karpathy/status/2083749667410727319",
            "https://x.com/karpathy/status/2083749667410727319?ref_src=twsrc",
            "https://x.com/karpathy/status/2083749667410727319/extra",
            "https://user@x.com/karpathy/status/2083749667410727319",
            "https://x.com:443/karpathy/status/2083749667410727319",
        ] {
            assert!(validate_post_url(invalid, "karpathy").is_err(), "{invalid}");
        }
    }

    #[test]
    fn parses_a_bounded_date_only_public_preview_without_quote_or_script_text() {
        let item = parse(fixture()).unwrap();
        assert_eq!(item.external_id, "x:2083749667410727319");
        assert_eq!(item.url, POST_URL);
        assert_eq!(item.title, "@karpathy: First & second source paragraph.");
        assert_eq!(
            item.summary.as_deref(),
            Some("First & second source paragraph.")
        );
        assert_eq!(
            item.published_at,
            Some(
                NaiveDate::from_ymd_opt(2026, 8, 2)
                    .unwrap()
                    .and_hms_opt(0, 0, 0)
                    .unwrap()
                    .and_utc()
            )
        );
        let context = item.reading_context.as_ref().unwrap();
        assert_eq!(context.kind, ReadingContextKind::Post);
        assert_eq!(context.origin, ReadingContextOrigin::PublisherPage);
        assert_eq!(context.status, ReadingContextStatus::Partial);
        assert!(context.truncated);
        assert!(context.fetched_at.is_none());
        assert_eq!(context.comments_status, CommentsStatus::NotFetched);
        assert!(context.comments.is_empty());
        assert!(!context.body.contains("Nested quoted"));
        assert!(!context.body.contains("never include this"));
        assert_eq!(item.source_metadata["publicationPrecision"], "day");
        assert_eq!(item.source_metadata["datePrecision"], "day");
        assert_eq!(
            item.source_metadata["publishedDateDisplay"],
            "August 2, 2026"
        );
        assert_eq!(
            item.source_metadata["dateBasis"],
            "publisher_embed_calendar_day"
        );
        assert_eq!(item.source_metadata["textComplete"], false);
        assert_eq!(
            item.source_metadata["coverage"],
            "registered_original_links_not_full_timeline"
        );
    }

    #[test]
    fn ignores_text_outside_the_provider_and_rejects_multiple_provider_blocks() {
        let mut outer = fixture();
        let html = outer["html"].as_str().unwrap().to_owned();
        outer["html"] = json!(format!("{html}<div><p>Unattributed outside text</p></div>"));
        assert!(
            !parse(outer)
                .unwrap()
                .reading_context
                .unwrap()
                .body
                .contains("Unattributed")
        );
        let mut multiple = fixture();
        multiple["html"] = json!(format!(
            "{html}<blockquote class=\"twitter-tweet\"><p>Different post</p></blockquote>"
        ));
        assert!(parse(multiple).is_err());
        let mut provider = fixture();
        provider["provider_url"] = json!("https://unrelated.example");
        assert!(parse(provider).is_err());
    }

    #[test]
    fn preserves_escaped_source_code_as_passive_text_not_markup() {
        let mut source = fixture();
        source["html"] = json!(source["html"].as_str().unwrap().replace(
            "First &amp; second",
            "&lt;svg&gt;literal source&lt;/svg&gt; &amp; text"
        ));
        let body = parse(source).unwrap().reading_context.unwrap().body;
        assert!(body.contains("<svg>literal source</svg> & text"));
        assert!(!body.contains("never include this"));
    }

    #[test]
    fn rejects_unknown_or_future_embed_dates() {
        let mut unknown = fixture();
        unknown["html"] = serde_json::Value::String(
            unknown["html"]
                .as_str()
                .unwrap()
                .replace("August 2, 2026", "Unknown date"),
        );
        assert!(parse(unknown).is_err());

        let mut future = fixture();
        future["html"] = serde_json::Value::String(
            future["html"]
                .as_str()
                .unwrap()
                .replace("August 2, 2026", "January 1, 2999"),
        );
        assert!(parse(future).is_err());
    }

    #[test]
    fn rejects_cross_author_and_cross_post_oembed_responses() {
        let mut cross_author = fixture();
        cross_author["author_url"] = json!("https://x.com/other");
        assert!(parse(cross_author).is_err());

        let mut cross_post = fixture();
        cross_post["url"] = json!("https://x.com/karpathy/status/2079610838143623371");
        assert!(parse(cross_post).is_err());
    }

    #[test]
    fn rejects_invalid_provider_contracts_and_oversized_embed_html() {
        let mut wrong_provider = fixture();
        wrong_provider["provider_name"] = json!("Other");
        assert!(parse(wrong_provider).is_err());

        let mut oversized = fixture();
        oversized["html"] = json!(format!(
            "<blockquote class=\"twitter-tweet\"><p>{}</p><a href=\"{POST_URL}\">August 2, 2026</a></blockquote>",
            "x".repeat(MAX_EMBED_HTML_BYTES)
        ));
        assert!(parse(oversized).is_err());
    }

    #[test]
    fn long_posts_have_compact_titles_without_discarding_retained_body() {
        let mut value = fixture();
        value["html"] = json!(format!(
            "<blockquote class=\"twitter-tweet\"><p>{}</p><a href=\"{POST_URL}\">August 2, 2026</a></blockquote>",
            "source text ".repeat(500)
        ));
        let item = parse(value).unwrap();
        assert_eq!(item.title.chars().count(), MAX_TITLE_CHARS);
        assert_eq!(
            item.reading_context.unwrap().body.chars().count(),
            MAX_BODY_CHARS
        );
    }

    #[test]
    fn canonicalizes_documented_legacy_twitter_embed_aliases_only() {
        let mut legacy = fixture();
        legacy["url"] = json!("https://twitter.com/karpathy/status/2083749667410727319");
        legacy["author_url"] = json!("https://twitter.com/karpathy");
        legacy["provider_name"] = json!("Twitter");
        legacy["html"] = serde_json::Value::String(legacy["html"].as_str().unwrap().replace(
            "https://x.com/karpathy/status/",
            "https://twitter.com/karpathy/status/",
        ));
        let item = parse(legacy).unwrap();
        assert_eq!(item.url, POST_URL);
        assert_eq!(item.source_metadata["authorHandle"], "karpathy");

        let mut unapproved = fixture();
        unapproved["author_url"] = json!("https://www.twitter.com/karpathy");
        assert!(parse(unapproved).is_err());
    }

    #[test]
    fn produces_idempotent_hashes_without_a_fetch_time() {
        let first = parse(fixture()).unwrap();
        let second = parse(fixture()).unwrap();
        assert_eq!(first.content_hash, second.content_hash);
        assert_eq!(
            first.reading_context.as_ref().unwrap().fetched_at,
            second.reading_context.as_ref().unwrap().fetched_at
        );
    }
}
