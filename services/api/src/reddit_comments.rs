use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use quick_xml::{Reader, events::Event};
use serde::Serialize;
use std::collections::BTreeSet;
use url::Url;

use crate::processing::{reading_text, validate_public_https};

pub const MAX_COMMENT_RSS_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_RETAINED_COMMENTS: usize = 10;
pub const MAX_RETAINED_COMMENT_BODY_CHARS: usize = 4_000;

const REDDIT_HOST: &str = "www.reddit.com";

/// This is only the ordering requested from Reddit. Atom comment feeds omit vote
/// values, so the client cannot verify the returned ranking or claim vote totals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RedditCommentOrdering {
    ServerRequestedTopUnverified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedditAuthor {
    pub name: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedditPost {
    pub id: String,
    pub published_at: DateTime<Utc>,
    pub updated_at: Option<DateTime<Utc>>,
    pub permalink: String,
    pub author: Option<RedditAuthor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedditComment {
    pub id: String,
    pub body: String,
    pub truncated: bool,
    pub score: Option<i32>,
    pub published_at: DateTime<Utc>,
    pub updated_at: Option<DateTime<Utc>>,
    pub permalink: String,
    pub author: Option<RedditAuthor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedditCommentFeed {
    pub source_url: String,
    pub ordering: RedditCommentOrdering,
    pub post: RedditPost,
    pub comments: Vec<RedditComment>,
    pub skipped_empty_or_removed_or_deleted: usize,
    pub skipped_duplicate_comments: usize,
    pub skipped_due_to_limit: usize,
}

#[derive(Debug, Default)]
struct AtomEntry {
    id: Option<String>,
    content: Option<String>,
    published_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
    permalink: Option<String>,
    author: Option<RedditAuthor>,
    pending_author_url: Option<String>,
    author_depth: Option<usize>,
}

#[derive(Debug)]
struct CapturedField {
    name: String,
    depth: usize,
    content: String,
}

/// Builds the explicit public syndication endpoint for one Reddit post.
///
/// The supplied URL must be a canonical `www.reddit.com/r/<subreddit>/comments/<post>/...`
/// permalink. The returned endpoint always requests `sort=top`, but no RSS score is inferred.
pub fn public_top_comment_rss_url(post_permalink: &str) -> Result<Url> {
    let mut url = validate_reddit_post_permalink(post_permalink)?;
    let path = url.path().trim_end_matches('/');
    url.set_path(&format!("{path}/.rss"));
    url.set_query(Some("sort=top"));
    url.set_fragment(None);
    Ok(url)
}

/// Parses the narrowly defined Atom contract returned by `public_top_comment_rss_url`.
///
/// This intentionally accepts only the post's `t3_` entry and comment `t1_` entries. It rejects
/// unexpected item identities and missing required fields instead of accepting a changed source
/// contract as an empty comment list. `FeedAdapter::fetch_public_comment_feed` owns retrieval,
/// response policy, and the source's bounded HTTPS/DNS/redirect controls.
pub fn parse_public_top_comment_feed(bytes: &[u8], endpoint: &Url) -> Result<RedditCommentFeed> {
    if bytes.len() > MAX_COMMENT_RSS_BYTES {
        bail!("Reddit public comment RSS exceeds the bounded fetch limit");
    }
    let expected_post_id = validate_comment_rss_endpoint(endpoint)?;
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    let mut depth = 0usize;
    let mut current: Option<AtomEntry> = None;
    let mut capture: Option<CapturedField> = None;
    let mut post: Option<RedditPost> = None;
    let mut comments = Vec::new();
    let mut comment_ids = BTreeSet::new();
    let mut skipped_empty_or_removed_or_deleted = 0;
    let mut skipped_duplicate_comments = 0;
    let mut skipped_due_to_limit = 0;

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(element)) => {
                depth += 1;
                let name = local_name(element.name().as_ref());
                if depth == 1
                    && (name != "feed"
                        || !element.attributes().flatten().any(|attr| {
                            attr.key.as_ref().starts_with(b"xmlns")
                                && attr.value.as_ref() == b"http://www.w3.org/2005/Atom"
                        }))
                {
                    bail!("Reddit comment response is not an Atom feed");
                }
                if name == "entry" && depth != 2 {
                    bail!("Reddit Atom entries must be direct feed children");
                }
                if name == "entry" && current.is_none() {
                    current = Some(AtomEntry::default());
                } else if let Some(capture) = capture.as_mut() {
                    append_start_tag(&mut capture.content, &name);
                } else if let Some(entry) = current.as_mut() {
                    if name == "link" {
                        append_link(entry, &element, endpoint, &expected_post_id)?;
                    } else if name == "author" {
                        entry.author_depth = Some(depth);
                    } else if entry
                        .author_depth
                        .is_some_and(|author_depth| author_depth.checked_add(1) == Some(depth))
                        && matches!(name.as_str(), "name" | "uri")
                    {
                        capture = Some(CapturedField {
                            name,
                            depth,
                            content: String::new(),
                        });
                    } else if matches!(name.as_str(), "id" | "content" | "published" | "updated") {
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
                } else if name == "link" {
                    if let Some(entry) = current.as_mut() {
                        append_link(entry, &element, endpoint, &expected_post_id)?;
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
                        if let Some(entry) = current.as_mut() {
                            append_field(entry, &captured.name, &captured.content)?;
                        }
                    } else if captured.depth < depth {
                        append_end_tag(&mut captured.content, &name);
                    }
                }
                if let Some(entry) = current.as_mut()
                    && name == "author"
                    && entry.author_depth == Some(depth)
                {
                    entry.author_depth = None;
                }
                if name == "entry" {
                    let entry = current
                        .take()
                        .context("Reddit Atom closed an entry without opening one")?;
                    match entry_kind(entry.id.as_deref())? {
                        "t3" => {
                            if post.is_some() {
                                bail!("Reddit comment RSS contained more than one post entry");
                            }
                            post = Some(post_from_entry(entry, &expected_post_id)?);
                        }
                        "t1" => {
                            let id = entry.id.clone().expect("entry kind requires an ID");
                            if !comment_ids.insert(id) {
                                skipped_duplicate_comments += 1;
                            } else if let Some(comment) =
                                comment_from_entry(entry, &expected_post_id)?
                            {
                                if comments.len() == MAX_RETAINED_COMMENTS {
                                    skipped_due_to_limit += 1;
                                } else {
                                    comments.push(comment);
                                }
                            } else {
                                skipped_empty_or_removed_or_deleted += 1;
                            }
                        }
                        _ => unreachable!("entry_kind validates known Reddit thing types"),
                    }
                }
                if depth == 0 {
                    bail!("invalid Reddit Atom close tag without an open element");
                }
                depth -= 1;
            }
            Ok(Event::Eof) => {
                if depth != 0 || current.is_some() || capture.is_some() {
                    bail!("Reddit Atom ended before all elements were closed");
                }
                break;
            }
            Err(error) => return Err(error).context("invalid Reddit public comment RSS XML"),
            _ => {}
        }
        buffer.clear();
    }

    Ok(RedditCommentFeed {
        source_url: endpoint.to_string(),
        ordering: RedditCommentOrdering::ServerRequestedTopUnverified,
        post: post.context("Reddit comment RSS did not contain the expected t3 post entry")?,
        comments,
        skipped_empty_or_removed_or_deleted,
        skipped_duplicate_comments,
        skipped_due_to_limit,
    })
}

fn validate_reddit_post_permalink(value: &str) -> Result<Url> {
    let url = validate_public_https(value)?;
    if url.host_str() != Some(REDDIT_HOST) || url.port().is_some() || url.query().is_some() {
        bail!("Reddit post permalink must use the canonical www.reddit.com HTTPS URL");
    }
    if url.fragment().is_some() {
        bail!("Reddit post permalink must not contain a fragment");
    }
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    if !(4..=5).contains(&parts.len())
        || parts[0] != "r"
        || !valid_path_segment(parts[1])
        || parts[2] != "comments"
        || !valid_reddit_base36_id(parts[3])
        || !parts[4..].iter().all(|part| valid_path_segment(part))
    {
        bail!("URL is not a Reddit post permalink");
    }
    Ok(url)
}

pub fn validate_comment_rss_endpoint(endpoint: &Url) -> Result<String> {
    validate_public_https(endpoint.as_str())?;
    if endpoint.host_str() != Some(REDDIT_HOST)
        || endpoint.port().is_some()
        || endpoint.fragment().is_some()
    {
        bail!("Reddit comment RSS endpoint must use canonical www.reddit.com HTTPS");
    }
    let query: Vec<_> = endpoint.query_pairs().collect();
    if query.len() != 1 || query[0].0 != "sort" || query[0].1 != "top" {
        bail!("Reddit comment RSS endpoint must request sort=top exactly once");
    }
    let parts: Vec<_> = endpoint.path().trim_matches('/').split('/').collect();
    if !(5..=6).contains(&parts.len())
        || parts[0] != "r"
        || !valid_path_segment(parts[1])
        || parts[2] != "comments"
        || !valid_reddit_base36_id(parts[3])
        || parts.last() != Some(&".rss")
        || !parts[4..parts.len() - 1]
            .iter()
            .all(|part| valid_path_segment(part))
    {
        bail!("URL is not a Reddit post comment RSS endpoint");
    }
    Ok(parts[3].to_owned())
}

fn append_link(
    entry: &mut AtomEntry,
    element: &quick_xml::events::BytesStart<'_>,
    endpoint: &Url,
    expected_post_id: &str,
) -> Result<()> {
    let rel = attribute(element, "rel").unwrap_or_else(|| "alternate".into());
    if rel != "alternate" || entry.permalink.is_some() {
        return Ok(());
    }
    let href = attribute(element, "href").context("Reddit Atom alternate link lacks href")?;
    entry.permalink = Some(validate_reddit_permalink(
        endpoint,
        expected_post_id,
        &href,
    )?);
    Ok(())
}

fn append_field(entry: &mut AtomEntry, field: &str, value: &str) -> Result<()> {
    match field {
        "id" if entry.id.is_none() => entry.id = Some(value.trim().to_owned()),
        "content" if entry.content.is_none() => entry.content = Some(value.to_owned()),
        "published" if entry.published_at.is_none() => {
            entry.published_at = Some(parse_atom_time(value, "published")?)
        }
        "updated" if entry.updated_at.is_none() => {
            entry.updated_at = Some(parse_atom_time(value, "updated")?)
        }
        "name" if entry.author_depth.is_some() && entry.author.is_none() => {
            let name = reading_text(value);
            if !name.is_empty() && name.chars().count() <= 100 {
                entry.author = Some(RedditAuthor {
                    name,
                    url: entry.pending_author_url.take(),
                });
            }
        }
        "uri" if entry.author_depth.is_some() => {
            let url = optional_reddit_author_url(value);
            if let Some(author) = entry.author.as_mut() {
                author.url = url;
            } else {
                entry.pending_author_url = url;
            }
        }
        _ => {}
    }
    Ok(())
}

fn post_from_entry(entry: AtomEntry, expected_post_id: &str) -> Result<RedditPost> {
    let id = entry.id.context("Reddit post entry lacks an ID")?;
    if id.strip_prefix("t3_") != Some(expected_post_id) {
        bail!("Reddit post entry does not match the requested post permalink");
    }
    let permalink = entry
        .permalink
        .context("Reddit post entry lacks an alternate permalink")?;
    validate_reddit_post_permalink(&permalink)?;
    Ok(RedditPost {
        id,
        published_at: entry
            .published_at
            .context("Reddit post entry lacks a published timestamp")?,
        updated_at: entry.updated_at,
        permalink,
        author: entry.author,
    })
}

fn comment_from_entry(entry: AtomEntry, expected_post_id: &str) -> Result<Option<RedditComment>> {
    let id = entry.id.context("Reddit comment entry lacks an ID")?;
    let content = entry
        .content
        .context("Reddit comment entry lacks content")?;
    let (body, truncated) = bound_comment_body(&reading_text(&content));
    if body.is_empty() || is_removed_or_deleted(&body) {
        return Ok(None);
    }
    let permalink = entry
        .permalink
        .context("Reddit comment entry lacks an alternate permalink")?;
    if !is_comment_permalink(&permalink, expected_post_id)
        || Url::parse(&permalink)?
            .path()
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            != id.strip_prefix("t1_")
    {
        bail!("Reddit comment permalink does not belong to the requested post");
    }
    Ok(Some(RedditComment {
        id,
        body,
        truncated,
        // The public Atom contract does not expose a score. None is intentional.
        score: None,
        published_at: entry
            .published_at
            .context("Reddit comment entry lacks a published timestamp")?,
        updated_at: entry.updated_at,
        permalink,
        author: entry.author,
    }))
}

fn entry_kind(id: Option<&str>) -> Result<&'static str> {
    let id = id.context("Reddit Atom entry lacks an ID")?;
    if let Some(value) = id.strip_prefix("t3_")
        && valid_reddit_base36_id(value)
    {
        return Ok("t3");
    }
    if let Some(value) = id.strip_prefix("t1_")
        && valid_reddit_base36_id(value)
    {
        return Ok("t1");
    }
    bail!("Reddit Atom entry has an unsupported thing ID: {id}")
}

fn parse_atom_time(value: &str, field: &str) -> Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value.trim())
        .map(|time| time.with_timezone(&Utc))
        .with_context(|| format!("Reddit Atom {field} timestamp is invalid"))
}

fn validate_reddit_permalink(endpoint: &Url, expected_post_id: &str, href: &str) -> Result<String> {
    let url = endpoint
        .join(href.trim())
        .context("invalid Reddit Atom permalink")?;
    let url = validate_public_https(url.as_str())?;
    if url.host_str() != Some(REDDIT_HOST) || url.port().is_some() || url.fragment().is_some() {
        bail!("Reddit Atom permalink is not a canonical public Reddit URL");
    }
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    if parts.len() < 4
        || parts[0] != "r"
        || !valid_path_segment(parts[1])
        || parts[2] != "comments"
        || parts[3] != expected_post_id
    {
        bail!("Reddit Atom permalink does not belong to the requested post");
    }
    Ok(url.to_string())
}

fn optional_reddit_author_url(value: &str) -> Option<String> {
    let url = validate_public_https(value.trim()).ok()?;
    (url.host_str() == Some(REDDIT_HOST) && url.port().is_none() && url.fragment().is_none())
        .then(|| url.to_string())
}

fn is_comment_permalink(permalink: &str, expected_post_id: &str) -> bool {
    let Ok(url) = Url::parse(permalink) else {
        return false;
    };
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    parts.len() == 6
        && parts[0] == "r"
        && parts[2] == "comments"
        && parts[3] == expected_post_id
        && valid_path_segment(parts[parts.len() - 1])
}

fn bound_comment_body(value: &str) -> (String, bool) {
    let value = value.trim();
    if value.chars().count() <= MAX_RETAINED_COMMENT_BODY_CHARS {
        return (value.to_owned(), false);
    }
    let mut body: String = value
        .chars()
        .take(MAX_RETAINED_COMMENT_BODY_CHARS)
        .collect();
    body.truncate(body.trim_end().len());
    (body, true)
}

fn is_removed_or_deleted(body: &str) -> bool {
    let body = body.trim().to_ascii_lowercase();
    body == "[deleted]" || body.starts_with("[removed")
}

fn valid_reddit_base36_id(value: &str) -> bool {
    (1..=20).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn valid_path_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 300
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
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

#[cfg(test)]
mod tests {
    use super::*;

    const ENDPOINT: &str =
        "https://www.reddit.com/r/test/comments/abc123/a_test_post/.rss?sort=top";

    #[test]
    fn parses_t1_comments_without_inventing_scores() {
        let xml = br#"<feed xmlns="http://www.w3.org/2005/Atom">
          <entry><id>t3_abc123</id><published>2026-09-10T12:00:00+00:00</published>
          <updated>2026-09-10T13:00:00+00:00</updated>
          <author><name>post_author</name><uri>https://www.reddit.com/user/post_author</uri></author>
          <link rel="alternate" href="https://www.reddit.com/r/test/comments/abc123/a_test_post/"/></entry>
          <entry><id>t1_comment1</id><published>2026-09-10T12:01:00+00:00</published>
          <author><name>comment_author</name><uri>https://www.reddit.com/user/comment_author</uri></author>
          <content type="html"><![CDATA[<div class="md"><p>Useful &amp; sourced comment.</p></div>]]></content>
          <link rel="alternate" href="https://www.reddit.com/r/test/comments/abc123/a_test_post/comment1/"/></entry>
          <entry><id>t1_comment1</id><published>2026-09-10T12:01:00+00:00</published>
          <content type="html">duplicate</content>
          <link rel="alternate" href="https://www.reddit.com/r/test/comments/abc123/a_test_post/comment1/"/></entry>
          <entry><id>t1_comment2</id><published>2026-09-10T12:02:00+00:00</published>
          <content type="html">[removed by Reddit]</content>
          <link rel="alternate" href="https://www.reddit.com/r/test/comments/abc123/a_test_post/comment2/"/></entry>
        </feed>"#;

        let feed = parse_public_top_comment_feed(xml, &Url::parse(ENDPOINT).unwrap()).unwrap();

        assert_eq!(
            feed.ordering,
            RedditCommentOrdering::ServerRequestedTopUnverified
        );
        assert_eq!(feed.post.id, "t3_abc123");
        assert_eq!(
            feed.post.author,
            Some(RedditAuthor {
                name: "post_author".into(),
                url: Some("https://www.reddit.com/user/post_author".into()),
            })
        );
        assert_eq!(feed.comments.len(), 1);
        assert_eq!(feed.comments[0].id, "t1_comment1");
        assert_eq!(feed.comments[0].body, "Useful & sourced comment.");
        assert_eq!(feed.comments[0].score, None);
        assert_eq!(
            feed.comments[0].author,
            Some(RedditAuthor {
                name: "comment_author".into(),
                url: Some("https://www.reddit.com/user/comment_author".into()),
            })
        );
        assert!(!feed.comments[0].truncated);
        assert_eq!(feed.skipped_duplicate_comments, 1);
        assert_eq!(feed.skipped_empty_or_removed_or_deleted, 1);
    }

    #[test]
    fn rejects_an_atom_contract_without_the_expected_post() {
        let xml = br#"<feed xmlns="http://www.w3.org/2005/Atom"><entry>
          <id>t1_comment1</id><published>2026-09-10T12:01:00+00:00</published>
          <content type="html">A comment without its post.</content>
          <link rel="alternate" href="https://www.reddit.com/r/test/comments/abc123/a_test_post/comment1/"/>
        </entry></feed>"#;

        assert!(parse_public_top_comment_feed(xml, &Url::parse(ENDPOINT).unwrap()).is_err());
    }

    #[test]
    fn comment_endpoint_is_canonical_and_explicitly_requests_top() {
        assert_eq!(
            public_top_comment_rss_url(
                "https://www.reddit.com/r/test/comments/abc123/a_test_post/"
            )
            .unwrap()
            .as_str(),
            ENDPOINT
        );
        assert!(
            public_top_comment_rss_url(
                "https://www.reddit.com/r/test/comments/abc123/a_test_post/?sort=new"
            )
            .is_err()
        );
        for endpoint in [
            "http://www.reddit.com/r/test/comments/abc123/title/.rss?sort=top",
            "https://www.reddit.com/r/test/comments/abc123/title/comment1/.rss?sort=top",
            "https://www.reddit.com/r/test/comments/abc123/title/.rss?sort=new",
            "https://www.reddit.com/r/test/comments/abc123/title/.rss?sort=top&sort=top",
        ] {
            assert!(validate_comment_rss_endpoint(&Url::parse(endpoint).unwrap()).is_err());
        }
    }

    #[test]
    fn parser_checks_exact_comment_identity_and_feed_root() {
        let xml = r#"<feed xmlns="http://www.w3.org/2005/Atom">
          <entry><id>t3_abc123</id><published>2026-09-10T12:00:00Z</published>
          <link href="https://www.reddit.com/r/test/comments/abc123/a_test_post/"/></entry>
          <entry><id>t1_comment1</id><published>2026-09-10T12:01:00Z</published>
          <content type="html">&lt;p&gt;A &amp; B&lt;/p&gt;</content>
          <link href="https://www.reddit.com/r/test/comments/abc123/a_test_post/comment1/"/></entry>
        </feed>"#;
        let endpoint = Url::parse(ENDPOINT).unwrap();
        assert_eq!(
            parse_public_top_comment_feed(xml.as_bytes(), &endpoint)
                .unwrap()
                .comments[0]
                .body,
            "A & B"
        );
        assert!(
            parse_public_top_comment_feed(
                xml.replace("t1_comment1", "t1_other").as_bytes(),
                &endpoint
            )
            .is_err()
        );
        assert!(
            parse_public_top_comment_feed(
                xml.replace("<feed ", "<html ")
                    .replace("</feed>", "</html>")
                    .as_bytes(),
                &endpoint
            )
            .is_err()
        );
    }
}
