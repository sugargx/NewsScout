use crate::scoped_db::ScopedDb;
use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use feed_rs::{model::Entry, parser};
use reqwest::{
    Client, StatusCode,
    header::{ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED, LOCATION},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Row, Transaction, postgres::PgRow};
use std::{
    collections::{BTreeMap, BTreeSet},
    net::SocketAddr,
    sync::Arc,
    time::Duration,
};
use url::Url;
use uuid::Uuid;

#[path = "source_adapters.rs"]
mod source_adapters;
#[path = "source_catalog.rs"]
pub mod source_catalog;
pub use source_adapters::{supported_adapters, validate_adapter_endpoint};

pub fn validate_x_post_urls(profile: &str, urls: &[String]) -> Result<Vec<String>> {
    let profile = crate::x_public_posts::validate_profile_endpoint(profile)?;
    if !(1..=20).contains(&urls.len()) {
        bail!("X 公开预览需要1–20条原帖链接，不会自动扫描账户时间线");
    }
    let handle = profile.path().trim_matches('/');
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    for value in urls {
        if value.len() > 2048 {
            bail!("X 原帖链接不能超过2048字节");
        }
        let mut input = Url::parse(value.trim())?;
        if input
            .query_pairs()
            .any(|(key, _)| !matches!(key.as_ref(), "s" | "t" | "ref_src" | "ref_url"))
        {
            bail!("X 原帖链接包含不支持的参数");
        }
        input.set_query(None);
        let url = crate::x_public_posts::validate_post_url(input.as_str(), handle)?;
        if seen.insert(url.to_string()) {
            result.push(url.to_string());
        }
    }
    Ok(result)
}

use crate::{
    models::Evidence,
    processing::{
        MAX_EXCERPT_CHARS, PUBLICATION_SKEW_MINUTES, canonical_url, excerpt, is_public_ip,
        plain_text, podcast_excerpt, publisher_domain, score_event,
    },
    reading_context::{
        CommentsStatus, FeedContext, ReadingComment, ReadingContext, ReadingContextKind,
        ReadingContextStatus, context_for_item, extract_publisher_article,
        normalize_podcast_context, parse_feed_contexts, text_material_fingerprint,
    },
};

const MAX_FEED_BYTES: usize = 4 * 1024 * 1024;
const MAX_PODCAST_FEED_BYTES: usize = 16 * 1024 * 1024;
const MAX_FEED_ENTRIES: usize = 200;
const MAX_REDIRECTS: usize = 5;
const FETCH_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_PAGE_ENRICHMENTS_PER_SOURCE: usize = 3;
const CONTEXT_EXTRACTOR_VERSION: u64 = 2;
const ROBOTS_USER_AGENT: &str = "ScoutNews";

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestionReport {
    pub attempted: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub ingested: usize,
    pub updated: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

#[derive(Debug, Default, PartialEq)]
struct ItemCounts {
    ingested: usize,
    updated: usize,
}

impl ItemCounts {
    fn for_item(is_new: bool, changed: bool) -> Self {
        Self {
            ingested: usize::from(is_new),
            updated: usize::from(!is_new && changed),
        }
    }

    fn add(&mut self, counts: Self) {
        self.ingested += counts.ingested;
        self.updated += counts.updated;
    }
}

#[derive(Debug, Clone)]
pub struct AdapterSource {
    pub endpoint: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Enclosure {
    pub url: String,
    pub media_type: Option<String>,
    pub length: Option<u64>,
    pub duration_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedItem {
    pub external_id: String,
    pub title: String,
    pub url: String,
    pub published_at: Option<DateTime<Utc>>,
    pub summary: Option<String>,
    pub content_hash: String,
    #[serde(default)]
    pub enclosures: Vec<Enclosure>,
    #[serde(default)]
    pub source_metadata: serde_json::Value,
    #[serde(default)]
    pub reading_context: Option<ReadingContext>,
    #[serde(default)]
    pub reading_context_resources: serde_json::Value,
}

pub enum FetchOutcome {
    NotModified,
    Items {
        items: Vec<FetchedItem>,
        etag: Option<String>,
        last_modified: Option<String>,
    },
}

#[async_trait]
pub trait SourceAdapter: Send + Sync {
    async fn fetch(&self, source: &AdapterSource) -> Result<FetchOutcome>;
}

pub struct FeedAdapter;

enum BoundedResponse {
    NotModified,
    Body {
        bytes: Vec<u8>,
        endpoint: Url,
        etag: Option<String>,
        last_modified: Option<String>,
        content_type: Option<String>,
    },
}

#[derive(Debug)]
struct FetchBackoff {
    status: StatusCode,
    until: DateTime<Utc>,
}

impl std::fmt::Display for FetchBackoff {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "source returned HTTP {}; retry after {}",
            self.status, self.until
        )
    }
}

impl std::error::Error for FetchBackoff {}

#[derive(Debug)]
struct CommentPolicyBlocked;

impl std::fmt::Display for CommentPolicyBlocked {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Reddit robots policy does not permit comment acquisition; an authorized comment API is required")
    }
}

impl std::error::Error for CommentPolicyBlocked {}

impl FeedAdapter {
    pub fn new(_client: Client) -> Self {
        // An injected client may follow redirects before they can be validated.
        // Create policy-controlled clients below instead, preserving system TLS defaults.
        Self
    }

    pub async fn fetch_with_adapter(
        &self,
        source: &AdapterSource,
        adapter: &str,
    ) -> Result<FetchOutcome> {
        validate_adapter_endpoint(adapter, &source.endpoint)?;
        tokio::time::timeout(FETCH_TIMEOUT, async {
            if matches!(
                adapter,
                "anthropic_news" | "anthropic_research" | "anthropic_engineering"
            ) {
                let robots = AdapterSource {
                    endpoint: "https://www.anthropic.com/robots.txt".into(),
                    etag: None,
                    last_modified: None,
                };
                let BoundedResponse::Body {
                    bytes, endpoint, ..
                } = self.fetch_bounded(&robots, "rss").await?
                else {
                    bail!("Anthropic robots policy could not be checked");
                };
                if endpoint.as_str() != robots.endpoint
                    || !source_adapters::anthropic_robots_allows(&bytes)
                {
                    bail!("Anthropic robots policy does not explicitly permit this adapter");
                }
            }
            match self.fetch_bounded(source, adapter).await? {
                BoundedResponse::NotModified => Ok(FetchOutcome::NotModified),
                BoundedResponse::Body {
                    bytes,
                    endpoint,
                    etag,
                    last_modified,
                    ..
                } => {
                    let items = match adapter {
                        "huggingface_models"
                        | "github_repository"
                        | "github_search"
                        | "anthropic_news"
                        | "anthropic_research"
                        | "anthropic_engineering" => {
                            source_adapters::parse(adapter, &bytes, &endpoint)?
                        }
                        _ => parse_items(&bytes, &endpoint, adapter)?,
                    };
                    Ok(FetchOutcome::Items {
                        items,
                        etag,
                        last_modified,
                    })
                }
            }
        })
        .await
        .context("source fetch timed out")?
    }

    async fn fetch_bounded(
        &self,
        source: &AdapterSource,
        adapter: &str,
    ) -> Result<BoundedResponse> {
        let max_bytes = feed_byte_limit(adapter);
        let mut endpoint = validate_adapter_endpoint(adapter, &source.endpoint)?;
        let mut visited = BTreeSet::new();
        for hop in 0..=MAX_REDIRECTS {
            if !visited.insert(endpoint.to_string()) {
                bail!("feed redirect loop");
            }
            let host = endpoint.host_str().context("endpoint has no host")?;
            let host = host.trim_start_matches('[').trim_end_matches(']');
            if matches!(host, "arxiv.org" | "export.arxiv.org") {
                source_adapters::pace_arxiv().await;
            }
            let port = endpoint
                .port_or_known_default()
                .context("endpoint has no port")?;
            let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
                .await
                .context("feed DNS lookup failed")?
                .collect();
            if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
                bail!("feed endpoint resolves to a non-public address");
            }
            let client = Client::builder()
                // A proxy resolves CONNECT hosts itself, bypassing our pinned public DNS
                // answers. Direct requests keep validation and connection on the same IPs.
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(12))
                .timeout(FETCH_TIMEOUT)
                .resolve_to_addrs(host, &addresses)
                .build()
                .context("cannot construct feed HTTP client")?;
            let mut request = client
                .get(endpoint.clone())
                .header("User-Agent", "ScoutNews/0.2 (+local personal reader)")
                .header(
                    "Accept",
                    match adapter {
                        "huggingface_models" | "github_repository" | "github_search" | "x_oembed" => "application/json",
                        "anthropic_news" | "anthropic_research" | "anthropic_engineering" => "text/html",
                        "publisher_page" => "text/html, application/xhtml+xml;q=0.9, text/plain;q=0.5",
                        _ => "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9",
                    },
                )
                .header("Accept-Encoding", "identity");
            if let Some(etag) = &source.etag {
                request = request.header(IF_NONE_MATCH, etag);
            }
            if let Some(last_modified) = &source.last_modified {
                request = request.header(IF_MODIFIED_SINCE, last_modified);
            }
            let mut response = request.send().await.context("feed request failed")?;
            if matches!(
                adapter,
                "publisher_page" | "reddit_comment_atom" | "x_oembed"
            ) && response.status().is_redirection()
            {
                bail!("publisher-page redirects are not followed");
            }
            if response.status().is_redirection() && response.status() != StatusCode::NOT_MODIFIED {
                if hop == MAX_REDIRECTS {
                    bail!("feed exceeded {MAX_REDIRECTS} redirects");
                }
                let location = response
                    .headers()
                    .get(LOCATION)
                    .context("feed redirect has no Location")?
                    .to_str()?;
                let target = endpoint.join(location).context("invalid feed redirect")?;
                endpoint = validate_adapter_endpoint(adapter, target.as_str())?;
                continue;
            }
            if response.status() == StatusCode::NOT_MODIFIED {
                if source.etag.is_none() && source.last_modified.is_none() {
                    bail!("feed returned 304 without a cached validator");
                }
                return Ok(BoundedResponse::NotModified);
            }
            if response.status().is_client_error() || response.status().is_server_error() {
                let now = Utc::now();
                let retry_after = response
                    .headers()
                    .get("retry-after")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| {
                        value
                            .parse::<i64>()
                            .ok()
                            .and_then(|seconds| chrono::Duration::try_seconds(seconds.max(0)))
                            .and_then(|duration| now.checked_add_signed(duration))
                            .or_else(|| {
                                DateTime::parse_from_rfc2822(value)
                                    .ok()
                                    .map(|date| date.with_timezone(&Utc))
                            })
                    });
                let reset = response
                    .headers()
                    .get("x-ratelimit-reset")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<i64>().ok())
                    .and_then(|seconds| DateTime::from_timestamp(seconds, 0));
                if retry_after.is_some()
                    || response.status() == StatusCode::TOO_MANY_REQUESTS
                    || (response.status() == StatusCode::FORBIDDEN && reset.is_some())
                {
                    return Err(FetchBackoff {
                        status: response.status(),
                        until: retry_after
                            .into_iter()
                            .chain(reset)
                            .max()
                            .unwrap_or(now + chrono::Duration::hours(1))
                            .max(now + chrono::Duration::minutes(1)),
                    }
                    .into());
                }
            }
            response
                .error_for_status_ref()
                .context("feed returned an HTTP error")?;
            if response
                .content_length()
                .is_some_and(|length| length > max_bytes as u64)
            {
                bail!("feed exceeds the {max_bytes}-byte limit");
            }
            let etag = response
                .headers()
                .get(ETAG)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let last_modified = response
                .headers()
                .get(LAST_MODIFIED)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.context("cannot read feed body")? {
                if bytes.len().saturating_add(chunk.len()) > max_bytes {
                    bail!("feed exceeds the {max_bytes}-byte limit");
                }
                bytes.extend_from_slice(&chunk);
            }
            return Ok(BoundedResponse::Body {
                bytes,
                endpoint,
                etag,
                last_modified,
                content_type,
            });
        }
        bail!("feed redirect limit exceeded")
    }

    async fn fetch_public_comment_feed(&self, endpoint: &Url) -> Result<Vec<u8>> {
        crate::reddit_comments::validate_comment_rss_endpoint(endpoint)?;
        tokio::time::timeout(FETCH_TIMEOUT, async {
            let robots = AdapterSource {
                endpoint: "https://www.reddit.com/robots.txt".into(),
                etag: None,
                last_modified: None,
            };
            let BoundedResponse::Body {
                bytes,
                content_type,
                ..
            } = self.fetch_bounded(&robots, "publisher_page").await?
            else {
                bail!("Reddit robots policy could not be checked");
            };
            Self::require_comment_policy(&bytes, content_type.as_deref(), endpoint)?;
            tokio::time::sleep(Duration::from_secs(2)).await;
            let source = AdapterSource {
                endpoint: endpoint.to_string(),
                etag: None,
                last_modified: None,
            };
            let BoundedResponse::Body {
                bytes,
                content_type,
                ..
            } = self.fetch_bounded(&source, "reddit_comment_atom").await?
            else {
                bail!("Reddit comment feed did not return a body");
            };
            if !content_type.as_deref().is_some_and(|value| {
                matches!(
                    value.split(';').next().unwrap_or_default().trim(),
                    "application/atom+xml" | "application/xml" | "text/xml"
                )
            }) {
                bail!("Reddit comment feed returned a non-Atom content type");
            }
            Ok(bytes)
        })
        .await
        .context("Reddit comment acquisition timed out")?
    }

    async fn fetch_x_registered_posts(
        &self,
        profile: &str,
        urls: &[String],
    ) -> Result<FetchOutcome> {
        let urls = validate_x_post_urls(profile, urls)?;
        tokio::time::timeout(Duration::from_secs(90), async {
            let mut items = Vec::new();
            for original in &urls {
                let mut endpoint = Url::parse("https://publish.x.com/oembed")?;
                endpoint
                    .query_pairs_mut()
                    .append_pair("url", original)
                    .append_pair("omit_script", "true")
                    .append_pair("hide_thread", "true")
                    .append_pair("lang", "en");
                let source = AdapterSource {
                    endpoint: endpoint.to_string(),
                    etag: None,
                    last_modified: None,
                };
                let BoundedResponse::Body {
                    bytes,
                    content_type,
                    ..
                } = self.fetch_bounded(&source, "x_oembed").await?
                else {
                    bail!("X oEmbed did not return a response body");
                };
                if !content_type.as_deref().is_some_and(|value| {
                    value.split(';').next().unwrap_or_default().trim() == "application/json"
                }) {
                    bail!("X oEmbed returned a non-JSON response for {original}");
                }
                items.push(crate::x_public_posts::parse_oembed(
                    &bytes,
                    &Url::parse(original)?,
                )?);
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            Ok(FetchOutcome::Items {
                items,
                etag: None,
                last_modified: None,
            })
        })
        .await
        .context("registered X post preview batch timed out")?
    }

    fn require_comment_policy(
        bytes: &[u8],
        content_type: Option<&str>,
        endpoint: &Url,
    ) -> Result<()> {
        let policy = std::str::from_utf8(bytes).context("Reddit robots policy is not UTF-8")?;
        if !content_type
            .is_some_and(|value| value.split(';').next().unwrap_or_default().trim() == "text/plain")
            || !policy
                .lines()
                .any(|line| line.trim().to_ascii_lowercase().starts_with("user-agent:"))
        {
            bail!("Reddit did not provide a recognizable robots policy");
        }
        if !Self::publisher_robots_allows(bytes, endpoint.as_str()) {
            return Err(CommentPolicyBlocked.into());
        }
        Ok(())
    }

    async fn fetch_reddit_comment_context(
        &self,
        source_url: &str,
        context: &ReadingContext,
    ) -> Result<Option<ReadingContext>> {
        let endpoint = crate::reddit_comments::public_top_comment_rss_url(source_url)?;
        let bytes = self.fetch_public_comment_feed(&endpoint).await?;
        let feed = crate::reddit_comments::parse_public_top_comment_feed(&bytes, &endpoint)?;
        let mut updated = context.clone();
        updated.comments = feed
            .comments
            .iter()
            .map(|comment| ReadingComment {
                id: comment.id.clone(),
                body: comment.body.clone(),
                score: comment.score.map(i64::from),
                url: Some(comment.permalink.clone()),
                author: comment.author.as_ref().map(|author| author.name.clone()),
                published_at: Some(comment.published_at),
                truncated: comment.truncated,
            })
            .collect();
        updated.comments_status = CommentsStatus::Available;
        updated.fetched_at = Some(Utc::now());
        Ok(Some(updated))
    }

    async fn fetch_publisher_page_context(
        &self,
        source_url: &str,
        feed_context: &ReadingContext,
        title: &str,
        browser: bool,
    ) -> Result<Option<ReadingContext>> {
        let page = validate_adapter_endpoint("publisher_page", source_url)?;
        let mut robots_url = page.clone();
        robots_url.set_path("/robots.txt");
        robots_url.set_query(None);
        robots_url.set_fragment(None);
        let robots = AdapterSource {
            endpoint: robots_url.to_string(),
            etag: None,
            last_modified: None,
        };
        let BoundedResponse::Body { bytes, .. } =
            self.fetch_bounded(&robots, "publisher_page").await?
        else {
            return Ok(Some(feed_context.clone().blocked_from_feed()));
        };
        if !Self::publisher_robots_allows(&bytes, page.as_str()) {
            return Ok(Some(feed_context.clone().blocked_from_feed()));
        }
        if browser {
            return Ok(Some(
                crate::browser_articles::capture(source_url, title).await?,
            ));
        }
        let source = AdapterSource {
            endpoint: page.to_string(),
            etag: None,
            last_modified: None,
        };
        let BoundedResponse::Body {
            bytes,
            content_type,
            ..
        } = self.fetch_bounded(&source, "publisher_page").await?
        else {
            return Ok(None);
        };
        if !content_type
            .as_deref()
            .is_some_and(Self::is_article_content_type)
        {
            return Ok(Some(feed_context.clone().blocked_from_feed()));
        }
        let html = std::str::from_utf8(&bytes).context("publisher page is not UTF-8")?;
        let Some((body, truncated)) = extract_publisher_article(html) else {
            return Ok(Some(feed_context.clone().blocked_from_feed()));
        };
        Ok(Some(ReadingContext::publisher_page(
            page.to_string(),
            body,
            truncated,
            Utc::now(),
        )))
    }

    fn publisher_robots_allows(bytes: &[u8], target: &str) -> bool {
        let Ok(robots) = std::str::from_utf8(bytes) else {
            return false;
        };
        let mut matcher = robotstxt::DefaultMatcher::default();
        matcher.one_agent_allowed_by_robots(robots, ROBOTS_USER_AGENT, target)
    }

    fn is_article_content_type(value: &str) -> bool {
        matches!(
            value
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
                .as_str(),
            "text/html" | "application/xhtml+xml" | "text/plain"
        )
    }

    fn enrichment_retry_after(error: &anyhow::Error) -> Option<DateTime<Utc>> {
        error
            .downcast_ref::<FetchBackoff>()
            .map(|backoff| backoff.until)
            .or_else(|| {
                error
                    .downcast_ref::<reqwest::Error>()
                    .and_then(reqwest::Error::status)
                    .filter(|status| matches!(status.as_u16(), 401 | 403))
                    .and_then(|_| Utc::now().checked_add_signed(chrono::Duration::hours(6)))
            })
    }
}

#[async_trait]
impl SourceAdapter for FeedAdapter {
    async fn fetch(&self, source: &AdapterSource) -> Result<FetchOutcome> {
        self.fetch_with_adapter(source, "rss").await
    }
}

fn resolve_content_url(base: &Url, value: &str) -> Option<String> {
    let mut url = base.join(value.trim()).ok()?;
    if url.scheme() == "http" && url.host_str() == Some("arxiv.org") {
        url.set_scheme("https").ok()?;
    }
    canonical_url(url.as_str()).ok()?;
    Some(url.into())
}

fn feed_byte_limit(adapter: &str) -> usize {
    if adapter == "x_oembed" {
        128 * 1024
    } else if adapter == "podcast_rss" {
        MAX_PODCAST_FEED_BYTES
    } else {
        MAX_FEED_BYTES
    }
}

fn parse_items(bytes: &[u8], endpoint: &Url, adapter: &str) -> Result<Vec<FetchedItem>> {
    if bytes.len() > feed_byte_limit(adapter) {
        bail!("feed body too large");
    }
    let contexts = parse_feed_contexts(bytes, endpoint)?;
    let feed = parser::Builder::new()
        .base_uri(Some(endpoint.as_str()))
        .sanitize_content(false)
        .build()
        .parse(bytes)
        .context("invalid RSS/Atom feed")?;
    let had_entries = !feed.entries.is_empty();
    let mut entries = feed.entries;
    let now = Utc::now();
    entries.sort_by_key(|entry| {
        std::cmp::Reverse(valid_publication(entry.published.or(entry.updated), now))
    });
    let mut items = Vec::new();
    for entry in entries.into_iter().take(MAX_FEED_ENTRIES) {
        if let Some(item) = normalize_entry(entry, endpoint, adapter, &contexts)? {
            items.push(item);
        }
    }
    if had_entries && items.is_empty() {
        bail!("feed contains entries, but none has readable text and a usable content URL");
    }
    Ok(items)
}

fn normalize_entry(
    entry: Entry,
    endpoint: &Url,
    adapter: &str,
    contexts: &[FeedContext],
) -> Result<Option<FetchedItem>> {
    let base = entry
        .base
        .as_deref()
        .and_then(|value| endpoint.join(value).ok())
        .unwrap_or_else(|| endpoint.clone());
    let is_podcast = entry.links.iter().any(|link| {
        link.rel.as_deref() == Some("enclosure")
            && link
                .media_type
                .as_deref()
                .is_some_and(|value| value.starts_with("audio/"))
    }) || entry
        .media
        .iter()
        .flat_map(|media| &media.content)
        .any(|content| {
            content
                .content_type
                .as_ref()
                .is_some_and(|value| value.to_string().starts_with("audio/"))
        });
    let summary = entry
        .summary
        .as_ref()
        .map(|text| text.content.as_str())
        .into_iter()
        .chain(
            entry
                .content
                .as_ref()
                .and_then(|content| content.body.as_deref()),
        )
        .chain(
            entry
                .media
                .iter()
                .filter_map(|media| media.description.as_ref().map(|text| text.content.as_str())),
        )
        .max_by_key(|text| plain_text(text).chars().count())
        .map(|text| {
            if is_podcast {
                podcast_excerpt(text, MAX_EXCERPT_CHARS)
            } else {
                excerpt(text, MAX_EXCERPT_CHARS)
            }
        })
        .filter(|text| !text.is_empty());
    let title = entry
        .title
        .as_ref()
        .map(|text| excerpt(&text.content, 300))
        .filter(|text| !text.is_empty())
        .or_else(|| summary.as_deref().map(|text| excerpt(text, 160)));
    let Some(title) = title else { return Ok(None) };
    let mut enclosures = Vec::new();
    for link in &entry.links {
        if link.rel.as_deref() == Some("enclosure")
            && let Some(url) = resolve_content_url(&base, &link.href)
        {
            enclosures.push(Enclosure {
                url,
                media_type: link.media_type.clone(),
                length: link.length,
                duration_seconds: None,
            });
        }
    }
    for media in &entry.media {
        for content in &media.content {
            if let Some(url) = content
                .url
                .as_ref()
                .and_then(|url| resolve_content_url(&base, url.as_str()))
            {
                let enclosure = Enclosure {
                    url,
                    media_type: content.content_type.as_ref().map(ToString::to_string),
                    length: content.size,
                    duration_seconds: content
                        .duration
                        .or(media.duration)
                        .map(|duration| duration.as_secs()),
                };
                if !enclosures
                    .iter()
                    .any(|existing| existing.url == enclosure.url)
                {
                    enclosures.push(enclosure);
                }
            }
        }
    }
    let mut links: Vec<_> = entry
        .links
        .iter()
        .filter_map(|link| {
            let rel = link.rel.as_deref().unwrap_or("alternate");
            let media = link
                .media_type
                .as_deref()
                .unwrap_or("")
                .split(';')
                .next()
                .unwrap_or("")
                .trim();
            if rel != "alternate" || !matches!(media, "" | "text/html" | "application/xhtml+xml") {
                return None;
            }
            let rank = if media.is_empty() { 1 } else { 0 };
            Some((rank, resolve_content_url(&base, &link.href)?))
        })
        .collect();
    links.sort_by_key(|(rank, _)| *rank);
    let url = links
        .into_iter()
        .next()
        .map(|(_, url)| url)
        .or_else(|| {
            Url::parse(&entry.id)
                .ok()
                .and_then(|url| resolve_content_url(&base, url.as_str()))
        })
        .or_else(|| enclosures.first().map(|enclosure| enclosure.url.clone()));
    let Some(url) = url else { return Ok(None) };
    let canonical = canonical_url(&url)?;
    let external_id = if entry.id.trim().is_empty() || entry.id.len() > 2_048 {
        canonical.clone()
    } else {
        entry.id.trim().to_owned()
    };
    let published_at = entry.published.or(entry.updated);
    if published_at
        .is_some_and(|date| date > Utc::now() + chrono::Duration::minutes(PUBLICATION_SKEW_MINUTES))
    {
        tracing::warn!("skipping future-dated feed entry");
        return Ok(None);
    }
    let content_hash = fingerprint(
        &canonical,
        &title,
        summary.as_deref(),
        published_at,
        &enclosures,
    )?;
    let mut context =
        context_for_item(&contexts, &external_id, &canonical, &title).unwrap_or_default();
    let kind = if adapter == "podcast_rss" {
        ReadingContextKind::Podcast
    } else if endpoint.host_str() == Some("www.reddit.com") {
        ReadingContextKind::Post
    } else if adapter == "github_release_atom" {
        ReadingContextKind::Release
    } else if context.body.is_empty() {
        ReadingContextKind::Feed
    } else {
        ReadingContextKind::Article
    };
    if kind == ReadingContextKind::Podcast {
        context = normalize_podcast_context(context);
    }
    let reading_context =
        ReadingContext::from_feed(kind, canonical.clone(), context.clone(), Utc::now());
    let reading_context_resources = serde_json::json!({
        "chaptersUrl": context.references.chapters_url,
    });
    Ok(Some(FetchedItem {
        external_id,
        title,
        url,
        published_at,
        summary,
        content_hash,
        enclosures,
        source_metadata: if matches!(endpoint.host_str(), Some("arxiv.org" | "export.arxiv.org")) {
            serde_json::json!({
                "kind":"preprint", "arxivId":entry.id, "updatedAt":entry.updated,
                "authors":entry.authors.iter().map(|author| &author.name).collect::<Vec<_>>(),
                "peerReviewVerified":false
            })
        } else {
            serde_json::json!({"feedCategories":entry.categories.iter().map(|category|&category.term).collect::<Vec<_>>()})
        },
        reading_context: Some(reading_context),
        reading_context_resources,
    }))
}

pub(crate) fn fingerprint(
    url: &str,
    title: &str,
    summary: Option<&str>,
    published: Option<DateTime<Utc>>,
    enclosures: &[Enclosure],
) -> Result<String> {
    let data = serde_json::to_vec(&(
        url,
        title,
        summary.unwrap_or_default(),
        published,
        enclosures,
    ))?;
    Ok(format!("{:x}", Sha256::digest(data)))
}

fn valid_publication(
    published: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    published
        .filter(|date| *date <= now + chrono::Duration::minutes(PUBLICATION_SKEW_MINUTES))
        .map(|date| date.min(now))
}

fn official_url(url: &str, domains: &serde_json::Value) -> bool {
    let Some(host) = Url::parse(url).ok().and_then(|url| {
        url.host_str()
            .map(|host| host.trim_end_matches('.').to_ascii_lowercase())
    }) else {
        return false;
    };
    domains.as_array().is_some_and(|domains| {
        domains
            .iter()
            .filter_map(|domain| domain.as_str())
            .any(|domain| {
                let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
                !domain.is_empty() && (host == domain || host.ends_with(&format!(".{domain}")))
            })
    })
}

fn title_tokens(title: &str) -> BTreeSet<String> {
    title
        .to_lowercase()
        .split(|ch: char| !ch.is_alphanumeric() && ch != '.' && ch != '-')
        .map(|token| token.trim_matches(['.', '-']))
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .collect()
}

fn number_tokens(value: &str) -> BTreeSet<String> {
    title_tokens(value)
        .into_iter()
        .filter(|token| token.chars().any(|ch| ch.is_ascii_digit()))
        .map(|token| {
            if token.starts_with('v') && token.as_bytes().get(1).is_some_and(u8::is_ascii_digit) {
                token[1..].to_owned()
            } else {
                token
            }
        })
        .collect()
}

fn near_duplicate(
    left: &str,
    left_date: DateTime<Utc>,
    right: &str,
    right_date: DateTime<Utc>,
) -> bool {
    if (left_date - right_date).num_seconds().unsigned_abs() > 36 * 3600
        || left.chars().count().min(right.chars().count()) < 55
        || number_tokens(left) != number_tokens(right)
    {
        return false;
    }
    let left = title_tokens(left);
    let right = title_tokens(right);
    if left.len().min(right.len()) < 8 {
        return false;
    }
    let distinctive = |tokens: &BTreeSet<String>| {
        tokens
            .iter()
            .filter(|token| {
                !matches!(
                    token.as_str(),
                    "a" | "an"
                        | "the"
                        | "and"
                        | "or"
                        | "to"
                        | "for"
                        | "with"
                        | "of"
                        | "in"
                        | "new"
                        | "release"
                        | "releases"
                        | "released"
                        | "notes"
                        | "update"
                        | "updates"
                        | "version"
                        | "features"
                        | "improvements"
                        | "fixes"
                        | "bug"
                        | "stable"
                        | "weekly"
                        | "latest"
                        | "available"
                ) && !token.chars().any(|ch| ch.is_ascii_digit())
            })
            .count()
    };
    if distinctive(&left).min(distinctive(&right)) < 4 {
        return false;
    }
    let common = left.intersection(&right).count();
    common >= 8 && common as f64 / left.union(&right).count() as f64 >= 0.88
}

#[derive(Clone)]
pub struct FeedWorker {
    pool: ScopedDb,
    adapter: Arc<FeedAdapter>,
    run_lock: Arc<tokio::sync::Mutex<()>>,
    #[cfg(test)]
    test_adapter: Option<Arc<dyn SourceAdapter>>,
}

#[derive(Debug, thiserror::Error)]
#[error("source authorization changed during refresh")]
struct SourceAuthorizationChanged;

struct ArticleContextUpdate {
    content_item_id: Uuid,
    source_id: Uuid,
    metadata: serde_json::Value,
    canonical_url: String,
    title: String,
    context: ReadingContext,
    method: &'static str,
}

impl FeedWorker {
    pub fn new(pool: impl Into<ScopedDb>, client: Client) -> Self {
        Self {
            pool: pool.into(),
            adapter: Arc::new(FeedAdapter::new(client)),
            run_lock: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            test_adapter: None,
        }
    }

    pub fn scoped(&self, pool: ScopedDb) -> Self {
        Self {
            pool,
            adapter: self.adapter.clone(),
            run_lock: self.run_lock.clone(),
            #[cfg(test)]
            test_adapter: self.test_adapter.clone(),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_test_adapter(mut self, adapter: Arc<dyn SourceAdapter>) -> Self {
        self.test_adapter = Some(adapter);
        self
    }

    pub async fn run_due(&self) -> Result<IngestionReport> {
        self.run(false, None, None, false).await
    }
    pub async fn run_all(&self) -> Result<IngestionReport> {
        self.run(true, None, None, false).await
    }
    pub async fn run_source(&self, id: Uuid) -> Result<IngestionReport> {
        self.run(true, Some(id), None, false).await
    }

    pub async fn run_authorized_source(&self, id: Uuid, actor: &str) -> Result<IngestionReport> {
        let _guard = self.run_lock.lock().await;
        let source = sqlx::query("SELECT s.*,COALESCE(p.official_domains,'[]'::jsonb) AS official_domains
            FROM sources s LEFT JOIN publishers p ON p.id=s.publisher_id
            LEFT JOIN user_source_overrides o ON o.source_id=s.id AND o.user_id=$2
            WHERE s.id=$1 AND (s.owner_user_id IS NULL OR s.owner_user_id=$2)
              AND COALESCE(o.enabled,s.lifecycle_status IN('stable','observing'))
              AND s.adapter_type=ANY($3)
              AND (s.cache_meta->>'retryAfter' IS NULL OR (s.cache_meta->>'retryAfter')::timestamptz<=now())")
            .bind(id).bind(actor).bind(supported_adapters()).fetch_optional(&self.pool).await?
            .context("source unavailable or cooling down")?;
        let counts = self.process_source(source, Some(actor)).await?;
        Ok(IngestionReport {
            attempted: 1,
            succeeded: 1,
            ingested: counts.ingested,
            updated: counts.updated,
            ..Default::default()
        })
    }

    pub async fn run_cloud_due(&self) -> Result<()> {
        self.run(false, None, None, true).await?;
        // Following schedules never mutate the shared catalog. One reader can
        // request a shorter interval without pausing collection for others.
        let rows=sqlx::query("SELECT o.user_id,o.source_id FROM user_source_overrides o
            JOIN sources s ON s.id=o.source_id JOIN app_users u ON u.id::text=o.user_id
            WHERE s.owner_user_id IS NULL AND o.enabled IS DISTINCT FROM false
              AND u.last_seen_at>now()-interval '30 days'
              AND (o.schedule_minutes IS NOT NULL OR o.enabled=true AND s.lifecycle_status='paused')
              AND NOT EXISTS(SELECT FROM fetch_runs f WHERE f.source_id=s.id
                AND f.started_at+make_interval(mins=>GREATEST(COALESCE(o.schedule_minutes,s.schedule_minutes),15))>now())
            ORDER BY o.updated_at,o.source_id LIMIT 100").fetch_all(&self.pool).await?;
        for row in rows {
            let id: Uuid = row.try_get("source_id")?;
            let actor: String = row.try_get("user_id")?;
            if self.run_authorized_source(id, &actor).await.is_err() {
                tracing::warn!(source_id=%id,"following schedule collection failed");
            }
        }
        Ok(())
    }

    pub async fn x_post_urls(&self, id: Uuid) -> Result<Vec<String>> {
        let id = self.x_registry_source(id).await?;
        let row = sqlx::query("SELECT endpoint,compliance FROM sources WHERE id=$1 AND adapter_type='x_public_preview'")
            .bind(id).fetch_optional(&self.pool).await?.context("X preview source not found")?;
        let compliance: serde_json::Value = row.try_get("compliance")?;
        let urls: Vec<String> = serde_json::from_value(
            compliance
                .get("originalPostUrls")
                .cloned()
                .context("X post registry is missing")?,
        )?;
        validate_x_post_urls(&row.try_get::<String, _>("endpoint")?, &urls)
    }

    pub async fn x_registry_source(&self, id: Uuid) -> Result<Uuid> {
        sqlx::query_scalar(
            "SELECT COALESCE((
            SELECT own.id FROM sources own WHERE own.owner_user_id=scoutnews_actor()
              AND own.adapter_type=s.adapter_type AND own.endpoint=s.endpoint),s.id)
            FROM sources s WHERE s.id=$1 AND s.adapter_type='x_public_preview'",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .context("X preview source not found")
    }

    pub async fn save_x_post_urls(&self, id: Uuid, urls: &[String]) -> Result<Vec<String>> {
        let original = id;
        let mut id = self.x_registry_source(id).await?;
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query("SELECT endpoint,compliance,owner_user_id FROM sources WHERE id=$1 AND adapter_type='x_public_preview'")
            .bind(id).fetch_optional(&mut *tx).await?.context("X preview source not found")?;
        let urls = validate_x_post_urls(&row.try_get::<String, _>("endpoint")?, urls)?;
        let before: serde_json::Value = row.try_get("compliance")?;
        if self.pool.actor() != "local"
            && row.try_get::<Option<String>, _>("owner_user_id")?.is_none()
        {
            // Registering personal posts against a catalog profile creates a
            // private collection realm, never private evidence on public events.
            sqlx::query("SELECT pg_advisory_xact_lock(hashtext('source-cap:'||scoutnews_actor()))")
                .execute(&mut *tx)
                .await?;
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM sources WHERE owner_user_id=scoutnews_actor()",
            )
            .fetch_one(&mut *tx)
            .await?;
            anyhow::ensure!(count < 100, "custom source limit reached");
            id=sqlx::query_scalar("INSERT INTO sources(id,name,endpoint,content_type,adapter_type,tier,
                lifecycle_status,schedule_minutes,compliance,owner_user_id)
                SELECT $2,name||' · 个人原帖',endpoint,content_type,adapter_type,tier,'observing',schedule_minutes,
                  jsonb_build_object('coverage','registered_posts_only','observationRequired',true,'originalPostUrls',$3::jsonb),scoutnews_actor()
                FROM sources WHERE id=$1
                ON CONFLICT(owner_user_id,adapter_type,endpoint) DO UPDATE
                SET compliance=sources.compliance||jsonb_build_object('originalPostUrls',$3::jsonb),updated_at=now() RETURNING id")
                .bind(original).bind(Uuid::new_v4()).bind(serde_json::to_value(&urls)?)
                .fetch_one(&mut *tx).await?;
            sqlx::query("INSERT INTO source_topics(source_id,taxonomy_id,relevance,origin)
                SELECT $1,taxonomy_id,relevance,'reader_following' FROM source_topics WHERE source_id=$2
                ON CONFLICT DO NOTHING").bind(id).bind(original).execute(&mut *tx).await?;
        }
        sqlx::query("UPDATE sources SET compliance=compliance || jsonb_build_object('originalPostUrls',$2::jsonb),updated_at=now() WHERE id=$1")
            .bind(id).bind(serde_json::to_value(&urls)?).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO admin_audits(id,actor,action,target_type,target_id,before_value,after_value,reason) VALUES($1,scoutnews_actor(),'x_post_registry_update','source',$2,$3,$4,'Owner registered original public X post links; not a timeline subscription')")
            .bind(Uuid::new_v4()).bind(id.to_string()).bind(before.get("originalPostUrls"))
            .bind(serde_json::to_value(&urls)?).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(urls)
    }
    /// Owner-only explicit enrichment of an existing event's exact evidence.
    /// This is intentionally not wired to public reader requests.
    pub async fn run_event_context_backfill(&self, event_id: Uuid) -> Result<IngestionReport> {
        self.run_event_context_backfill_for_sources(event_id, None)
            .await
    }

    pub async fn run_event_context_backfill_for_sources(
        &self,
        event_id: Uuid,
        allowed_sources: Option<&[Uuid]>,
    ) -> Result<IngestionReport> {
        let _guard = self.run_lock.lock().await;
        let rows = sqlx::query(r#"WITH candidates AS (
                SELECT DISTINCT ON (s.id) ci.id AS content_item_id,s.id AS source_id,ci.canonical_url,ci.title,ci.metadata,
                    s.content_type,s.adapter_type,s.endpoint,s.compliance,s.cache_meta,ee.is_official,ci.created_at,
                    COALESCE(p.official_domains,'[]'::jsonb) AS official_domains
                FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
                JOIN sources s ON s.id=ci.source_id LEFT JOIN publishers p ON p.id=s.publisher_id
                WHERE ee.event_id=$1 AND EXISTS(SELECT 1 FROM events e WHERE e.id=$1 AND e.status='published')
                  AND s.lifecycle_status IN ('stable','observing')
                  AND ($3::uuid[] IS NULL OR s.id=ANY($3))
                ORDER BY s.id,ee.is_official DESC,ci.created_at,ci.id
            ) SELECT * FROM candidates ORDER BY is_official DESC,created_at,source_id LIMIT $2"#)
            .bind(event_id)
            .bind(MAX_PAGE_ENRICHMENTS_PER_SOURCE as i64)
            .bind(allowed_sources)
            .fetch_all(&self.pool)
            .await?;
        if rows.is_empty() {
            bail!("event is missing, unpublished, or has no eligible evidence");
        }
        let mut updates = Vec::new();
        let mut retries = BTreeMap::<(Uuid, String), DateTime<Utc>>::new();
        let mut report = IngestionReport::default();
        for row in rows {
            let content_type: String = row.try_get("content_type")?;
            let canonical_url: String = row.try_get("canonical_url")?;
            let reddit = crate::reddit_comments::public_top_comment_rss_url(&canonical_url).is_ok();
            if content_type != "blog" && !reddit {
                continue;
            }
            let adapter: String = row.try_get("adapter_type")?;
            let endpoint: String = row.try_get("endpoint")?;
            let title: String = row.try_get("title")?;
            let browser = crate::browser_articles::configured_for(&canonical_url);
            let retry_key = if reddit {
                "commentsRetryAfter"
            } else {
                crate::browser_articles::retry_key(browser)
            };
            let domains: serde_json::Value = row.try_get("official_domains")?;
            let compliance: serde_json::Value = row.try_get("compliance")?;
            if !reddit
                && !source_adapters::official_evidence_url(
                    &adapter,
                    &endpoint,
                    &canonical_url,
                    &domains,
                    &compliance,
                )
            {
                continue;
            }
            report.attempted += 1;
            let metadata: serde_json::Value = row.try_get("metadata")?;
            let cache: serde_json::Value = row.try_get("cache_meta")?;
            let retry_after = cache
                .get(retry_key)
                .and_then(|value| value.as_str())
                .map(|value| {
                    DateTime::parse_from_rfc3339(value)
                        .context("invalid saved enrichment retry time")
                })
                .transpose()?
                .map(|value| value.with_timezone(&Utc));
            let feed_retry_after = cache
                .get("retryAfter")
                .and_then(|value| value.as_str())
                .map(DateTime::parse_from_rfc3339)
                .transpose()?
                .map(|value| value.with_timezone(&Utc));
            if retry_after
                .into_iter()
                .chain(feed_retry_after)
                .any(|until| until > Utc::now())
            {
                report.failed += 1;
                report
                    .errors
                    .push(format!("{canonical_url}: 来源处于采集退避期，未发起请求"));
                continue;
            }
            let context: ReadingContext = metadata
                .get("readingContext")
                .cloned()
                .map(|value| {
                    serde_json::from_value(value).context("invalid persisted reading context")
                })
                .transpose()?
                .unwrap_or_else(|| {
                    ReadingContext::from_feed(
                        if reddit {
                            ReadingContextKind::Post
                        } else {
                            ReadingContextKind::Article
                        },
                        canonical_url.clone(),
                        FeedContext {
                            body: metadata
                                .get("feedSummary")
                                .and_then(|value| value.as_str())
                                .unwrap_or_default()
                                .to_owned(),
                            ..Default::default()
                        },
                        Utc::now(),
                    )
                });
            if context.kind
                != if reddit {
                    ReadingContextKind::Post
                } else {
                    ReadingContextKind::Article
                }
            {
                report.failed += 1;
                report
                    .errors
                    .push(format!("{canonical_url}: 此材料不支持博客正文补充"));
                continue;
            }
            let result = if reddit {
                self.adapter
                    .fetch_reddit_comment_context(&canonical_url, &context)
                    .await
            } else {
                self.adapter
                    .fetch_publisher_page_context(&canonical_url, &context, &title, browser)
                    .await
            };
            match result {
                Ok(Some(updated))
                    if matches!(
                        updated.status,
                        ReadingContextStatus::Available | ReadingContextStatus::Partial
                    ) && updated.has_material() =>
                {
                    report.succeeded += 1;
                    if updated.fingerprint() != context.fingerprint() {
                        updates.push(ArticleContextUpdate {
                            content_item_id: row.try_get("content_item_id")?,
                            source_id: row.try_get("source_id")?,
                            metadata,
                            canonical_url: canonical_url.clone(),
                            title: title.clone(),
                            context: updated,
                            method: if reddit {
                                "reddit_comment_atom"
                            } else if browser {
                                "browser"
                            } else {
                                "http"
                            },
                        });
                    }
                }
                Ok(_) => {
                    report.failed += 1;
                    report
                        .errors
                        .push("原站未允许读取或未提供可提取的文章正文；保留原有材料".into());
                }
                Err(error) => {
                    report.failed += 1;
                    report
                        .errors
                        .push("Reading context acquisition failed".into());
                    if let Some(until) = article_retry_after(&error) {
                        let source_id: Uuid = row.try_get("source_id")?;
                        retries
                            .entry((source_id, retry_key.to_owned()))
                            .and_modify(|previous| *previous = (*previous).max(until))
                            .or_insert(until);
                    }
                    if let Some(until) = article_source_backoff(&error) {
                        retries.insert((row.try_get("source_id")?, "retryAfter".to_owned()), until);
                    }
                    tracing::warn!(event_id = %event_id,
                        "event context backfill skipped; retaining persisted context");
                }
            }
        }
        if report.attempted == 0 {
            bail!("此事件没有可补充的原始博客或 Reddit 帖子；播客及项目元数据不使用博客抓取");
        }
        if updates.is_empty() && retries.is_empty() {
            return Ok(report);
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(736268,1)")
            .execute(&mut *tx)
            .await?;
        let mut changed_events = BTreeSet::new();
        for ArticleContextUpdate {
            content_item_id,
            source_id,
            metadata,
            canonical_url,
            title,
            context,
            method,
        } in updates
        {
            let active: Option<bool> = sqlx::query_scalar(
                "SELECT lifecycle_status IN ('stable','observing') FROM sources WHERE id=$1 FOR UPDATE")
                .bind(source_id).fetch_optional(&mut *tx).await?;
            if active != Some(true) {
                bail!("来源在补充期间已被暂停或删除，未保存本次结果");
            }
            let previous: Option<ReadingContext> = metadata
                .get("readingContext")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .context("invalid persisted reading context")?;
            let material_hash = context.material_fingerprint();
            let material_changed = reading_context_material_changed(
                &metadata,
                previous.as_ref(),
                material_hash.as_deref(),
            );
            let patch = serde_json::json!({
                "readingContext":context,
                "readingContextHash":context.fingerprint(),
                "readingContextMaterialHash":material_hash,
                "readingContextAcquisition":{"method":method,"capturedAt":context.fetched_at},
            });
            let result = sqlx::query(
                "UPDATE content_items SET metadata=metadata||$2,updated_at=now() WHERE id=$1 AND metadata=$3 AND canonical_url=$4 AND title=$5")
                .bind(content_item_id).bind(patch).bind(metadata).bind(canonical_url).bind(title).execute(&mut *tx).await?;
            if result.rows_affected() != 1 {
                bail!("来源材料在补充期间已变化，请重新读取后再补充");
            }
            report.updated += 1;
            if material_changed {
                let ids: Vec<Uuid> = sqlx::query_scalar(
                    "SELECT ee.event_id FROM event_evidence ee
                     JOIN events e ON e.id=ee.event_id
                     JOIN content_items c ON c.id=ee.content_item_id
                     WHERE c.id=$1 AND e.owner_user_id IS NOT DISTINCT FROM c.owner_user_id",
                )
                .bind(content_item_id)
                .fetch_all(&mut *tx)
                .await?;
                changed_events.extend(ids);
            }
        }
        for ((source_id, key), until) in retries {
            sqlx::query("UPDATE sources SET cache_meta=cache_meta || jsonb_build_object($3::text,$2),updated_at=now() WHERE id=$1")
                .bind(source_id).bind(until).bind(key).execute(&mut *tx).await?;
        }
        for id in changed_events {
            refresh_event(&mut tx, id, Utc::now()).await?;
        }
        tx.commit().await?;
        Ok(report)
    }
    pub async fn run_daily(&self, since: DateTime<Utc>) -> Result<IngestionReport> {
        self.run(true, None, Some(since), false).await
    }

    async fn run(
        &self,
        force: bool,
        only_source: Option<Uuid>,
        daily_since: Option<DateTime<Utc>>,
        private_only: bool,
    ) -> Result<IngestionReport> {
        let sources = sqlx::query(r#"SELECT s.id,s.name,s.endpoint,s.content_type,s.adapter_type,s.tier,s.cache_meta,s.compliance,s.publisher_id,s.owner_user_id,
                COALESCE(p.official_domains,'[]'::jsonb) AS official_domains
            FROM sources s LEFT JOIN publishers p ON p.id=s.publisher_id
            WHERE s.lifecycle_status IN ('stable','observing')
              AND (NOT $5 OR s.owner_user_id IS NOT NULL)
              AND s.adapter_type = ANY($3)
              AND ($2::uuid IS NULL OR s.id=$2)
              AND ($4::timestamptz IS NULL OR NOT EXISTS(SELECT 1 FROM fetch_runs f
                  WHERE f.source_id=s.id AND f.started_at>=$4 AND f.status IN ('success','not_modified')))
              AND (s.cache_meta->>'retryAfter' IS NULL OR (s.cache_meta->>'retryAfter')::timestamptz <= now())
              AND ($1::boolean OR s.cache_meta->>'retryAfter' IS NOT NULL OR NOT EXISTS (
                SELECT 1 FROM fetch_runs f WHERE f.source_id=s.id
                AND f.started_at + make_interval(mins => GREATEST(s.schedule_minutes,
                    CASE s.adapter_type WHEN 'arxiv_atom' THEN 720 WHEN 'github_search' THEN 1440
                    WHEN 'github_repository' THEN 360 WHEN 'huggingface_models' THEN 60
                    WHEN 'anthropic_news' THEN 180 WHEN 'anthropic_research' THEN 180 WHEN 'anthropic_engineering' THEN 180
                    WHEN 'x_public_preview' THEN 1440 ELSE 1 END)) > now()))
            ORDER BY s.last_success_at ASC NULLS FIRST,s.name,s.id"#)
            .bind(force).bind(only_source).bind(supported_adapters()).bind(daily_since).bind(private_only).fetch_all(&self.pool).await?;
        if sources.is_empty() && only_source.is_some() {
            bail!(
                "source is missing, paused, in server-requested backoff, or has an unsupported adapter"
            );
        }
        let mut report = IngestionReport {
            attempted: sources.len(),
            ..Default::default()
        };
        for source in sources {
            // Yield between sources so a large scheduled catalog cannot hold
            // every reader's durable job behind a whole multi-hour batch.
            let _guard = self.run_lock.lock().await;
            let source_name: String = source.try_get("name")?;
            let source_id: Uuid = source.try_get("id")?;
            match self.process_source(source, None).await {
                Ok(counts) => {
                    report.ingested += counts.ingested;
                    report.updated += counts.updated;
                    report.succeeded += 1;
                }
                Err(error) => {
                    tracing::warn!(%source_id, "source ingestion failed");
                    report.failed += 1;
                    let _ = (source_name, error);
                    report
                        .errors
                        .push(format!("source {source_id}: collection failed"));
                }
            }
        }
        Ok(report)
    }

    async fn process_source(&self, row: PgRow, actor: Option<&str>) -> Result<ItemCounts> {
        let source_id: Uuid = row.try_get("id")?;
        let run_id = Uuid::new_v4();
        let result = self
            .process_source_inner(&row, source_id, run_id, actor)
            .await;
        if let Err(error) = &result {
            let error_text = "Collection failed; check source availability or retry later";
            // Deliberately outside the failed content transaction: parse and database
            // failures must both finish the run and update the source's health.
            let log = sqlx::query(r#"INSERT INTO fetch_runs(id,source_id,started_at,finished_at,status,error)
                VALUES($1,$2,now(),now(),'failed',$3)
                ON CONFLICT(id) DO UPDATE SET finished_at=now(),status='failed',error=EXCLUDED.error"#)
                .bind(run_id).bind(source_id).bind(&error_text).execute(&self.pool).await;
            let retry_after = if row.try_get::<String, _>("adapter_type")? == "x_public_preview" {
                FeedAdapter::enrichment_retry_after(error)
            } else {
                error
                    .downcast_ref::<FetchBackoff>()
                    .map(|backoff| backoff.until)
            };
            let mut backoff_meta = retry_after
                .map(|until| serde_json::json!({"retryAfter":until}))
                .unwrap_or_else(|| serde_json::json!({}));
            if row.try_get::<String, _>("adapter_type")? == "x_public_preview" {
                if let Some(backoff) = error.downcast_ref::<FetchBackoff>() {
                    backoff_meta["xProviderRetryAfter"] = serde_json::json!(backoff.until);
                }
            }
            let health = if error.is::<SourceAuthorizationChanged>() {
                // A reader withdrawing consent is not a shared source failure.
                Ok(None)
            } else {
                sqlx::query("UPDATE sources SET consecutive_failures=consecutive_failures+1,updated_at=now(),cache_meta=cache_meta || $2 WHERE id=$1")
                    .bind(source_id).bind(backoff_meta).execute(&self.pool).await.map(Some)
            };
            if let Err(log_error) = log {
                let _ = log_error;
                tracing::error!(%source_id, "could not persist failed fetch run");
            }
            if let Err(health_error) = health {
                let _ = health_error;
                tracing::error!(%source_id, "could not persist failed source health");
            }
        }
        result
    }

    async fn process_source_inner(
        &self,
        row: &PgRow,
        source_id: Uuid,
        run_id: Uuid,
        actor: Option<&str>,
    ) -> Result<ItemCounts> {
        if row.try_get::<String, _>("adapter_type")? == "x_public_preview" {
            let provider_retry: Option<DateTime<Utc>> = sqlx::query_scalar(
                "SELECT max((cache_meta->>'xProviderRetryAfter')::timestamptz) FROM sources WHERE adapter_type='x_public_preview'",
            ).fetch_one(&self.pool).await?;
            if provider_retry.is_some_and(|until| until > Utc::now()) {
                bail!("X oEmbed 服务处于退避期，未发起请求");
            }
        }
        // A server-requested cooldown gets one retry when due, not another full
        // polling interval. Consume it before fetching so failures cannot hot-loop.
        sqlx::query("UPDATE sources SET cache_meta=cache_meta-'retryAfter' WHERE id=$1")
            .bind(source_id)
            .execute(&self.pool)
            .await?;
        sqlx::query(
            "INSERT INTO fetch_runs(id,source_id,started_at,status) VALUES($1,$2,now(),'running')",
        )
        .bind(run_id)
        .bind(source_id)
        .execute(&self.pool)
        .await?;
        let endpoint: String = row.try_get("endpoint")?;
        let adapter: String = row.try_get("adapter_type")?;
        let mut cache: serde_json::Value = row.try_get("cache_meta")?;
        if let Some(cache) = cache.as_object_mut() {
            cache.remove("retryAfter");
        }
        // Re-read each public feed once when the bounded excerpt extractor changes.
        let needs_context = matches!(
            adapter.as_str(),
            "rss"
                | "atom"
                | "github_release_atom"
                | "podcast_rss"
                | "arxiv_atom"
                | "anthropic_news"
                | "anthropic_research"
                | "anthropic_engineering"
        );
        if cache.get("excerptVersion").and_then(|value| value.as_u64()) != Some(2)
            || needs_context
                && cache
                    .get("readingContextVersion")
                    .and_then(|value| value.as_u64())
                    != Some(CONTEXT_EXTRACTOR_VERSION)
        {
            if let Some(cache) = cache.as_object_mut() {
                cache.remove("etag");
                cache.remove("lastModified");
            }
        }
        let request = AdapterSource {
            endpoint,
            etag: cache
                .get("etag")
                .and_then(|value| value.as_str())
                .map(str::to_owned),
            last_modified: cache
                .get("lastModified")
                .and_then(|value| value.as_str())
                .map(str::to_owned),
        };
        let outcome = self.fetch_source(row, &request, &adapter).await?;
        let (outcome, article_backoffs) = self.enrich_feed_items(row, outcome).await?;
        let mut tx = self.pool.begin().await?;
        // Keep identity/upsert decisions atomic even if another local API process runs.
        sqlx::query("SELECT pg_advisory_xact_lock(736268,1)")
            .execute(&mut *tx)
            .await?;
        recheck_source_authorization(&mut tx, row, actor).await?;
        if adapter == "x_public_preview" {
            let current: serde_json::Value = sqlx::query_scalar(
                "SELECT compliance->'originalPostUrls' FROM sources WHERE id=$1",
            )
            .bind(source_id)
            .fetch_one(&mut *tx)
            .await?;
            let original: serde_json::Value = row.try_get("compliance")?;
            if original.get("originalPostUrls") != Some(&current) {
                bail!("X 原帖清单在读取期间已更改，请重新刷新；本次结果未保存");
            }
        }
        let (counts, status, cache_meta) = match outcome {
            FetchOutcome::NotModified => (ItemCounts::default(), "not_modified", cache),
            FetchOutcome::Items {
                items,
                etag,
                last_modified,
            } => {
                let mut counts = ItemCounts::default();
                for item in items {
                    counts.add(persist_item(&mut tx, row, &item).await?);
                }
                let mut cache_meta = cache;
                if !cache_meta.is_object() {
                    bail!("invalid source cache metadata");
                }
                cache_meta["etag"] = serde_json::json!(etag);
                cache_meta["lastModified"] = serde_json::json!(last_modified);
                cache_meta["excerptVersion"] = serde_json::json!(2);
                cache_meta["readingContextVersion"] = serde_json::json!(CONTEXT_EXTRACTOR_VERSION);
                for (key, until) in article_backoffs {
                    cache_meta[key] = serde_json::json!(until);
                }
                (counts, "success", cache_meta)
            }
        };
        sqlx::query("UPDATE sources SET cache_meta=$2,last_success_at=now(),consecutive_failures=0,updated_at=now() WHERE id=$1")
            .bind(source_id).bind(cache_meta).execute(&mut *tx).await?;
        sqlx::query("UPDATE fetch_runs SET finished_at=now(),status=$2,item_count=$3,http_meta=http_meta || jsonb_build_object('updatedItemCount',$4::integer) WHERE id=$1")
            .bind(run_id)
            .bind(status)
            .bind(counts.ingested as i32)
            .bind(counts.updated as i32)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(counts)
    }

    async fn fetch_source(
        &self,
        row: &PgRow,
        request: &AdapterSource,
        adapter: &str,
    ) -> Result<FetchOutcome> {
        #[cfg(test)]
        if let Some(adapter) = &self.test_adapter {
            return adapter.fetch(request).await;
        }
        if adapter == "x_public_preview" {
            let compliance: serde_json::Value = row.try_get("compliance")?;
            let urls: Vec<String> = serde_json::from_value(compliance.get("originalPostUrls").cloned()
                .context("X source needs registered original post URLs; automatic profile crawling is not used")?)?;
            self.adapter
                .fetch_x_registered_posts(&request.endpoint, &urls)
                .await
        } else if matches!(adapter, "rss" | "atom" | "github_release_atom") {
            self.adapter.fetch(request).await
        } else {
            self.adapter.fetch_with_adapter(request, adapter).await
        }
    }

    async fn enrich_feed_items(
        &self,
        row: &PgRow,
        outcome: FetchOutcome,
    ) -> Result<(FetchOutcome, BTreeMap<String, DateTime<Utc>>)> {
        let FetchOutcome::Items {
            mut items,
            etag,
            last_modified,
        } = outcome
        else {
            return Ok((outcome, BTreeMap::new()));
        };
        let content_type: String = row.try_get("content_type")?;
        let adapter: String = row.try_get("adapter_type")?;
        let endpoint: String = row.try_get("endpoint")?;
        let domains: serde_json::Value = row.try_get("official_domains")?;
        let compliance: serde_json::Value = row.try_get("compliance")?;
        let cache: serde_json::Value = row.try_get("cache_meta")?;
        let mut backoffs = BTreeMap::new();
        for key in ["enrichmentRetryAfter", "browserRetryAfter"] {
            if let Some(value) = cache.get(key).and_then(|value| value.as_str()) {
                let until = DateTime::parse_from_rfc3339(value)
                    .context("invalid saved article retry time")?
                    .with_timezone(&Utc);
                if until > Utc::now() {
                    backoffs.insert(key.to_owned(), until);
                }
            }
        }
        if content_type != "blog" {
            return Ok((
                FetchOutcome::Items {
                    items,
                    etag,
                    last_modified,
                },
                backoffs,
            ));
        }
        if !supports_article_enrichment(&adapter) {
            return Ok((
                FetchOutcome::Items {
                    items,
                    etag,
                    last_modified,
                },
                backoffs,
            ));
        }
        let mut enriched = 0usize;
        for item in &mut items {
            if enriched >= MAX_PAGE_ENRICHMENTS_PER_SOURCE {
                break;
            }
            let Some(context) = item
                .reading_context
                .clone()
                .or_else(|| retained_excerpt_context(item))
            else {
                continue;
            };
            if context.kind != ReadingContextKind::Article
                || !source_adapters::official_evidence_url(
                    &adapter,
                    &endpoint,
                    &item.url,
                    &domains,
                    &compliance,
                )
            {
                continue;
            }
            let browser = crate::browser_articles::configured_for(&item.url);
            let retry_key = crate::browser_articles::retry_key(browser);
            if backoffs
                .get(retry_key)
                .is_some_and(|until| *until > Utc::now())
                || backoffs
                    .get("retryAfter")
                    .is_some_and(|until| *until > Utc::now())
            {
                continue;
            }
            enriched += 1;
            match self
                .adapter
                .fetch_publisher_page_context(&item.url, &context, &item.title, browser)
                .await
            {
                Ok(Some(context)) => {
                    if context.origin == crate::reading_context::ReadingContextOrigin::PublisherPage
                    {
                        if item.reading_context_resources.is_null() {
                            item.reading_context_resources = serde_json::json!({});
                        }
                        if !item.reading_context_resources.is_object() {
                            bail!("invalid source reading resources");
                        }
                        item.reading_context_resources["articleAcquisition"] = serde_json::json!({
                            "method":if browser {"browser"} else {"http"},"capturedAt":context.fetched_at});
                    }
                    item.reading_context = Some(context);
                }
                Ok(None) => {}
                Err(error) => {
                    if let Some(until) = article_retry_after(&error) {
                        backoffs.insert(retry_key.to_owned(), until);
                        item.reading_context = Some(context.blocked_from_feed());
                    }
                    if let Some(until) = article_source_backoff(&error) {
                        backoffs.insert("retryAfter".to_owned(), until);
                    }
                    tracing::warn!("publisher-page enrichment skipped; retaining feed context")
                }
            }
        }
        Ok((
            FetchOutcome::Items {
                items,
                etag,
                last_modified,
            },
            backoffs,
        ))
    }
}

async fn recheck_source_authorization(
    tx: &mut Transaction<'_, Postgres>,
    original: &PgRow,
    actor: Option<&str>,
) -> Result<()> {
    let id: Uuid = original.try_get("id")?;
    // Lock the source before its override: this also serializes insertion of an
    // absent override through its source FK. Hold both locks through persistence.
    let Some(current) =
        sqlx::query("SELECT owner_user_id,lifecycle_status FROM sources WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?
    else {
        return Err(SourceAuthorizationChanged.into());
    };
    let owner: Option<String> = current.try_get("owner_user_id")?;
    if owner != original.try_get::<Option<String>, _>("owner_user_id")?
        || actor.is_some_and(|actor| owner.as_deref().is_some_and(|owner| owner != actor))
    {
        return Err(SourceAuthorizationChanged.into());
    }
    let enabled = if let Some(actor) = actor {
        sqlx::query_scalar::<_, Option<bool>>(
            "SELECT enabled FROM user_source_overrides WHERE source_id=$1 AND user_id=$2 FOR UPDATE",
        ).bind(id).bind(actor).fetch_optional(&mut **tx).await?.flatten()
    } else {
        None
    };
    let status: String = current.try_get("lifecycle_status")?;
    if !enabled.unwrap_or(matches!(status.as_str(), "stable" | "observing")) {
        return Err(SourceAuthorizationChanged.into());
    }
    Ok(())
}

fn article_source_backoff(error: &anyhow::Error) -> Option<DateTime<Utc>> {
    error
        .downcast_ref::<FetchBackoff>()
        .map(|backoff| backoff.until)
        .or_else(|| {
            error
                .downcast_ref::<crate::browser_articles::BrowserCaptureError>()
                .filter(|backoff| backoff.source_backoff)
                .map(|backoff| backoff.retry_at)
        })
}

fn article_retry_after(error: &anyhow::Error) -> Option<DateTime<Utc>> {
    if error.downcast_ref::<CommentPolicyBlocked>().is_some() {
        return Some(Utc::now() + chrono::Duration::hours(24));
    }
    error
        .downcast_ref::<crate::browser_articles::BrowserCaptureError>()
        .map(|error| error.retry_at)
        .or_else(|| FeedAdapter::enrichment_retry_after(error))
}

fn supports_article_enrichment(adapter: &str) -> bool {
    matches!(
        adapter,
        "rss" | "atom" | "anthropic_news" | "anthropic_research" | "anthropic_engineering"
    )
}

fn retained_excerpt_context(item: &FetchedItem) -> Option<ReadingContext> {
    let body = plain_text(item.summary.as_deref()?);
    let original_len = body.chars().count();
    let body = excerpt(&body, MAX_EXCERPT_CHARS);
    (!body.is_empty()).then(|| {
        ReadingContext::retained_excerpt_article(
            item.url.clone(),
            body.clone(),
            body.chars().count() < original_len,
            Utc::now(),
        )
    })
}

async fn persist_item(
    tx: &mut Transaction<'_, Postgres>,
    source: &PgRow,
    item: &FetchedItem,
) -> Result<ItemCounts> {
    let source_id: Uuid = source.try_get("id")?;
    let owner: Option<String> = source.try_get("owner_user_id")?;
    let content_type: String = source.try_get("content_type")?;
    let domains: serde_json::Value = source.try_get("official_domains")?;
    let publisher_id: Option<Uuid> = source.try_get("publisher_id")?;
    let canonical = canonical_url(&item.url)?;
    let now = Utc::now();
    let incoming_publication = valid_publication(item.published_at, now);
    let existing = sqlx::query(r#"SELECT ci.id,ci.content_hash,ci.published_at,ci.created_at,ci.metadata
        FROM content_items ci WHERE ci.source_id=$1 AND (
          ci.external_id=$2 OR ci.canonical_url=$3 OR EXISTS (
            SELECT 1 FROM content_item_identities identity WHERE identity.content_item_id=ci.id
              AND identity.source_id=$1 AND ((identity.kind='external' AND identity.value=$2) OR (identity.kind='url' AND identity.value=$3))))
        ORDER BY (ci.content_hash=$4) DESC,(ci.external_id=$2) DESC,ci.created_at,ci.id LIMIT 1 FOR UPDATE"#)
        .bind(source_id).bind(&item.external_id).bind(&canonical).bind(&item.content_hash).fetch_optional(&mut **tx).await?;
    let content_id = existing
        .as_ref()
        .map(|row| row.try_get::<Uuid, _>("id"))
        .transpose()?
        .unwrap_or_else(Uuid::new_v4);
    let previous_publication = existing
        .as_ref()
        .map(|row| row.try_get::<Option<DateTime<Utc>>, _>("published_at"))
        .transpose()?
        .flatten();
    let created_at = existing
        .as_ref()
        .map(|row| row.try_get::<DateTime<Utc>, _>("created_at"))
        .transpose()?
        .unwrap_or(now);
    let published = incoming_publication
        .or(previous_publication)
        .unwrap_or(created_at);
    let previous_hash = existing
        .as_ref()
        .map(|row| row.try_get::<String, _>("content_hash"))
        .transpose()?;
    let mut metadata = existing
        .as_ref()
        .map(|row| row.try_get::<serde_json::Value, _>("metadata"))
        .transpose()?
        .unwrap_or_else(|| serde_json::json!({}));
    if !metadata.is_object() {
        metadata = serde_json::json!({});
    }
    let old_summary = metadata
        .get("feedSummary")
        .and_then(|value| value.as_str())
        .map(str::to_owned);
    let source_metadata_changed = !item.source_metadata.is_null()
        && metadata.get("sourceMetadata") != Some(&item.source_metadata);
    let changed = previous_hash.as_deref() != Some(item.content_hash.as_str())
        || old_summary.as_deref() != item.summary.as_deref().or(Some(""))
        || source_metadata_changed && item.source_metadata.get("feedCategories").is_none();
    let previous_context = metadata
        .get("readingContext")
        .cloned()
        .map(serde_json::from_value::<ReadingContext>)
        .transpose()
        .context("invalid persisted reading context")?;
    let effective_context = match (previous_context.clone(), item.reading_context.clone()) {
        (Some(previous), Some(incoming))
            if (previous.origin == crate::reading_context::ReadingContextOrigin::PublisherPage
                && incoming.origin == crate::reading_context::ReadingContextOrigin::Feed
                || previous.kind == ReadingContextKind::Post
                    && previous.comments_status == CommentsStatus::Available
                    && incoming.comments_status != CommentsStatus::Available)
                && previous.source_url == incoming.source_url
                && !changed =>
        {
            Some(previous)
        }
        (_, Some(incoming)) => Some(incoming),
        (Some(previous), None) => Some(previous),
        (None, None) => None,
    };
    let context_hash = effective_context.as_ref().map(ReadingContext::fingerprint);
    let reading_context_state_changed = previous_context != effective_context;
    let material_hash = effective_context
        .as_ref()
        .and_then(ReadingContext::material_fingerprint);
    let reading_context_material_changed = reading_context_material_changed(
        &metadata,
        previous_context.as_ref(),
        material_hash.as_deref(),
    );
    metadata["feedSummary"] = serde_json::json!(item.summary.as_deref().unwrap_or_default());
    metadata["enclosures"] = serde_json::to_value(&item.enclosures)?;
    metadata["reportedPublishedAt"] = serde_json::json!(item.published_at);
    if let Some(context) = effective_context {
        if context.origin == crate::reading_context::ReadingContextOrigin::PublisherPage {
            if let Some(acquisition) = item.reading_context_resources.get("articleAcquisition") {
                metadata["readingContextAcquisition"] = acquisition.clone();
            }
        } else if !(context.kind == ReadingContextKind::Post
            && context.comments_status == CommentsStatus::Available)
        {
            if let Some(metadata) = metadata.as_object_mut() {
                metadata.remove("readingContextAcquisition");
            }
        }
        metadata["readingContext"] = serde_json::to_value(&context)?;
        metadata["readingContextHash"] = serde_json::json!(context_hash);
        if let Some(material_hash) = material_hash {
            metadata["readingContextMaterialHash"] = serde_json::json!(material_hash);
        } else if let Some(metadata) = metadata.as_object_mut() {
            metadata.remove("readingContextMaterialHash");
        }
    }
    if !item.reading_context_resources.is_null() {
        metadata["readingContextResources"] = item.reading_context_resources.clone();
    }
    if !item.source_metadata.is_null() {
        metadata["sourceMetadata"] = item.source_metadata.clone();
    }
    metadata["publicationDateKnown"] =
        serde_json::json!(incoming_publication.is_some() || previous_publication.is_some());
    if existing.is_none() {
        sqlx::query(r#"INSERT INTO content_items(id,source_id,content_type,external_id,original_url,canonical_url,title,published_at,updated_at,content_hash,metadata)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)"#)
            .bind(content_id).bind(source_id).bind(&content_type).bind(&item.external_id).bind(&item.url).bind(&canonical)
            .bind(&item.title).bind(incoming_publication).bind(now).bind(&item.content_hash).bind(metadata).execute(&mut **tx).await?;
    } else if changed || source_metadata_changed || reading_context_state_changed {
        sqlx::query(
            r#"UPDATE content_items SET external_id=$2,original_url=$3,canonical_url=$4,title=$5,
            published_at=$6,updated_at=$7,content_hash=$8,metadata=$9 WHERE id=$1"#,
        )
        .bind(content_id)
        .bind(&item.external_id)
        .bind(&item.url)
        .bind(&canonical)
        .bind(&item.title)
        .bind(incoming_publication.or(previous_publication))
        .bind(now)
        .bind(&item.content_hash)
        .bind(metadata)
        .execute(&mut **tx)
        .await?;
    }
    for (kind, value) in [("external", &item.external_id), ("url", &canonical)] {
        sqlx::query("INSERT INTO content_item_identities(source_id,kind,value,content_item_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING")
            .bind(source_id).bind(kind).bind(value).bind(content_id).execute(&mut **tx).await?;
    }
    let mut event_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT ee.event_id FROM event_evidence ee JOIN events e ON e.id=ee.event_id
         WHERE ee.content_item_id=$1 AND e.owner_user_id IS NOT DISTINCT FROM $2 ORDER BY ee.event_id",
    )
    .bind(content_id)
    .bind(&owner)
    .fetch_all(&mut **tx)
    .await?;
    let mut new_event = false;
    if event_ids.is_empty() {
        let exact: Option<Uuid> = sqlx::query_scalar(
            r#"SELECT ee.event_id FROM event_evidence ee
            JOIN content_items ci ON ci.id=ee.content_item_id
            JOIN events e ON e.id=ee.event_id
            WHERE e.owner_user_id IS NOT DISTINCT FROM $2 AND
              (ci.canonical_url=$1 OR EXISTS (SELECT 1 FROM content_item_identities identity
                WHERE identity.content_item_id=ci.id AND identity.kind='url' AND identity.value=$1))
            ORDER BY e.created_at,e.id LIMIT 1"#,
        )
        .bind(&canonical)
        .bind(&owner)
        .fetch_optional(&mut **tx)
        .await?;
        let event_id = match exact {
            Some(id) => Some(id),
            None if incoming_publication.is_some() => {
                find_near_event(
                    tx,
                    &item.title,
                    &canonical,
                    published,
                    &content_type,
                    owner.as_deref(),
                )
                .await?
            }
            None => None,
        };
        if let Some(id) = event_id {
            event_ids.push(id);
        } else {
            let event_id = Uuid::new_v4();
            let topic: Option<String> = sqlx::query_scalar("SELECT tn.label FROM source_topics st JOIN taxonomy_nodes tn ON tn.id=st.taxonomy_id WHERE st.source_id=$1 ORDER BY st.relevance DESC,tn.id LIMIT 1")
                .bind(source_id).fetch_optional(&mut **tx).await?;
            sqlx::query(r#"INSERT INTO events(id,canonical_title,summary,importance,primary_topic,event_type,first_seen_at,updated_at,owner_user_id)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)"#)
                .bind(event_id).bind(&item.title).bind(item.summary.as_deref().unwrap_or("Feed 未提供摘要，请打开原文核验。"))
                .bind("来自订阅 Feed 的原文摘录；请结合来源与互证信息判断重要性。")
                .bind(topic).bind(&content_type).bind(published).bind(now).bind(&owner).execute(&mut **tx).await?;
            event_ids.push(event_id);
            new_event = true;
        }
    }
    let adapter: String = source.try_get("adapter_type")?;
    let compliance: serde_json::Value = source.try_get("compliance")?;
    let source_endpoint: String = source.try_get("endpoint")?;
    let is_official = publisher_id.is_some()
        && source_adapters::official_evidence_url(
            &adapter,
            &source_endpoint,
            &item.url,
            &domains,
            &compliance,
        );
    let independence = if matches!(adapter.as_str(), "github_repository" | "github_search") {
        item.source_metadata
            .get("repositoryId")
            .and_then(serde_json::Value::as_u64)
            .map(|id| format!("github:repository:{id}"))
    } else {
        publisher_id
            .map(|id| format!("publisher:{id}"))
            .or_else(|| publisher_domain(&canonical).map(|domain| format!("domain:{domain}")))
    };
    for event_id in event_ids {
        let attached = sqlx::query(
            r#"INSERT INTO event_evidence(event_id,content_item_id,is_official,independence_group)
            VALUES($1,$2,$3,$4) ON CONFLICT(event_id,content_item_id) DO UPDATE
            SET is_official=EXCLUDED.is_official,independence_group=EXCLUDED.independence_group
            WHERE event_evidence.is_official IS DISTINCT FROM EXCLUDED.is_official
                OR event_evidence.independence_group IS DISTINCT FROM EXCLUDED.independence_group
            RETURNING event_id"#,
        )
        .bind(event_id)
        .bind(content_id)
        .bind(is_official)
        .bind(&independence)
        .fetch_optional(&mut **tx)
        .await?
        .is_some();
        sqlx::query(
            r#"INSERT INTO event_tags(event_id,taxonomy_id,confidence,origin)
            SELECT $1,taxonomy_id,relevance,'source_registry' FROM source_topics WHERE source_id=$2
            ON CONFLICT(event_id,taxonomy_id) DO NOTHING"#,
        )
        .bind(event_id)
        .bind(source_id)
        .execute(&mut **tx)
        .await?;
        if changed || reading_context_material_changed || attached || new_event {
            refresh_event(tx, event_id, now).await?;
        }
    }
    Ok(ItemCounts::for_item(
        existing.is_none(),
        changed || reading_context_state_changed,
    ))
}

#[cfg(test)]
pub(crate) async fn test_realm_ingestion(pool: &sqlx::PgPool, sources: [Uuid; 3]) -> Result<()> {
    let url = format!("https://example.com/research/realm-{}", Uuid::new_v4());
    let item=FetchedItem {
        external_id:"isolated-realm-fixture".into(),
        title:"An identical technical report on agent architecture with reproducible benchmark evaluation".into(),
        url:url.clone(),published_at:Some(Utc::now()),summary:Some("Measured architecture benchmark and evaluation.".repeat(20)),
        content_hash:Uuid::new_v4().to_string(),enclosures:vec![],
        source_metadata:serde_json::json!({}),reading_context:None,reading_context_resources:serde_json::json!({}),
    };
    for source in sources {
        let row = sqlx::query(
            "SELECT s.*,COALESCE(p.official_domains,'[]'::jsonb) AS official_domains
            FROM sources s LEFT JOIN publishers p ON p.id=s.publisher_id WHERE s.id=$1",
        )
        .bind(source)
        .fetch_one(pool)
        .await?;
        let mut tx = pool.begin().await?;
        persist_item(&mut tx, &row, &item).await?;
        tx.commit().await?;
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT count(DISTINCT ee.event_id) FROM event_evidence ee
        JOIN content_items ci ON ci.id=ee.content_item_id WHERE ci.canonical_url=$1",
    )
    .bind(&url)
    .fetch_one(pool)
    .await?;
    assert_eq!(
        count, 3,
        "system ingestion must never merge readers' identical material"
    );
    let cross:i64=sqlx::query_scalar("SELECT count(*) FROM event_evidence ee JOIN content_items c ON c.id=ee.content_item_id
        JOIN events e ON e.id=ee.event_id WHERE c.canonical_url=$1 AND c.owner_user_id IS DISTINCT FROM e.owner_user_id")
        .bind(&url).fetch_one(pool).await?;
    assert_eq!(cross, 0);
    Ok(())
}

fn reading_context_material_changed(
    metadata: &serde_json::Value,
    previous_context: Option<&ReadingContext>,
    material_hash: Option<&str>,
) -> bool {
    let previous_material_hash = metadata
        .get("readingContextMaterialHash")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
        .or_else(|| previous_context.and_then(ReadingContext::material_fingerprint))
        .or_else(|| {
            metadata
                .get("feedSummary")
                .and_then(|value| value.as_str())
                .and_then(text_material_fingerprint)
        });
    material_hash.is_some() && material_hash != previous_material_hash.as_deref()
}

async fn find_near_event(
    tx: &mut Transaction<'_, Postgres>,
    title: &str,
    url: &str,
    published: DateTime<Utc>,
    content_type: &str,
    owner: Option<&str>,
) -> Result<Option<Uuid>> {
    let candidates = sqlx::query(r#"SELECT e.id,e.canonical_title,e.first_seen_at,
        (SELECT ci.canonical_url FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
          WHERE ee.event_id=e.id ORDER BY ci.created_at,ci.id LIMIT 1) AS url
        FROM events e WHERE e.status='published' AND e.event_type=$1
          AND e.owner_user_id IS NOT DISTINCT FROM $4
          AND e.first_seen_at BETWEEN $2 - interval '36 hours' AND $2 + interval '36 hours'
          AND similarity(e.canonical_title,$3) >= 0.65
        ORDER BY similarity(e.canonical_title,$3) DESC,e.created_at,e.id LIMIT 40"#)
        .bind(content_type).bind(published).bind(title).bind(owner).fetch_all(&mut **tx).await?;
    for candidate in candidates {
        let candidate_title: String = candidate.try_get("canonical_title")?;
        let candidate_url: Option<String> = candidate.try_get("url")?;
        if near_duplicate(
            title,
            published,
            &candidate_title,
            candidate.try_get("first_seen_at")?,
        ) && candidate_url.is_some_and(|other| number_tokens(&other) == number_tokens(url))
        {
            return Ok(Some(candidate.try_get("id")?));
        }
    }
    Ok(None)
}

async fn refresh_event(
    tx: &mut Transaction<'_, Postgres>,
    event_id: Uuid,
    now: DateTime<Utc>,
) -> Result<()> {
    let rows = sqlx::query(r#"SELECT ci.id,s.name,s.tier,ci.title,ci.canonical_url,ee.is_official,
        COALESCE(ci.published_at,ci.created_at) AS published_at,ci.published_at AS original_published_at,ci.created_at AS collected_at,ci.metadata
        FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id JOIN sources s ON s.id=ci.source_id
        WHERE ee.event_id=$1 ORDER BY ee.is_official DESC,
        CASE s.tier WHEN 'T1' THEN 0 WHEN 'T1.5' THEN 1 ELSE 2 END,ci.created_at,ci.id"#)
        .bind(event_id).fetch_all(&mut **tx).await?;
    let evidence: Vec<Evidence> = rows
        .iter()
        .map(|row| {
            let metadata: serde_json::Value = row.try_get("metadata")?;
            Ok(Evidence {
                id: row.try_get("id")?,
                source_name: row.try_get("name")?,
                source_tier: row.try_get("tier")?,
                title: row.try_get("title")?,
                url: row.try_get("canonical_url")?,
                is_official: row.try_get("is_official")?,
                published_at: row.try_get("published_at")?,
                original_published_at: row.try_get("original_published_at")?,
                publication_precision: metadata
                    .get("sourceMetadata")
                    .and_then(|value| value.get("datePrecision"))
                    .and_then(|value| value.as_str())
                    .map(str::to_owned),
                collected_at: row.try_get("collected_at")?,
                excerpt: excerpt(
                    metadata
                        .get("feedSummary")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default(),
                    MAX_EXCERPT_CHARS,
                ),
                technical_basis: None,
                aggregation: metadata
                    .pointer("/sourceMetadata/aggregation")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()?,
                reading_context: metadata
                    .get("readingContext")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()?,
            })
        })
        .collect::<Result<_>>()?;
    let primary = evidence.first().context("event has no evidence")?;
    let importance = if evidence.iter().all(|item| item.aggregation.is_some()) {
        "来自公开聚合摘要；尚未独立读取或核验原文，请区分来源观点与事实。"
    } else {
        "来自订阅 Feed 的原文摘录；请结合来源与互证信息判断重要性。"
    };
    let summary = evidence
        .iter()
        .find(|item| !item.excerpt.is_empty())
        .map(|item| item.excerpt.as_str())
        .unwrap_or("Feed 未提供摘要，请打开原文核验。");
    let published = evidence
        .iter()
        .map(|item| item.published_at)
        .min()
        .unwrap_or(now)
        .min(now);
    let latest_publication = evidence
        .iter()
        .map(|item| item.published_at)
        .max()
        .unwrap_or(now)
        .min(now);
    // Also clear text and bump the optimistic version, not just its provenance label.
    sqlx::query(
        r#"UPDATE events SET canonical_title=$2,summary=$3,
        importance=$6,
        first_seen_at=$4,updated_at=$5,summary_kind='feed',summary_model=NULL,summarized_at=NULL,
        summary_format_version=0,summary_reasoning_effort=NULL,
        summary_points='[]',summary_material_limit=NULL,summary_limitations='[]',
        summary_evidence_ids='[]'::jsonb,content_version=content_version+1 WHERE id=$1"#,
    )
    .bind(event_id)
    .bind(&primary.title)
    .bind(summary)
    .bind(published)
    .bind(latest_publication)
    .bind(importance)
    .execute(&mut **tx)
    .await?;
    let score = score_event(&evidence, now, now);
    sqlx::query("INSERT INTO score_snapshots(id,event_id,components,total,rule_version,explanation) VALUES($1,$2,$3,$4,'v0.2-evidence-1',$5)")
        .bind(Uuid::new_v4()).bind(event_id).bind(serde_json::to_value(&score)?).bind(score.total).bind(score.explanation)
        .execute(&mut **tx).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn x_registry_accepts_only_bounded_same_author_originals() {
        let profile = "https://x.com/karpathy";
        let post = "https://x.com/karpathy/status/2083749667410727319";
        assert_eq!(
            validate_x_post_urls(profile, &[post.into(), format!("{post}?s=20&t=tracking")])
                .unwrap(),
            vec![post]
        );
        assert!(validate_x_post_urls(profile, &[]).is_err());
        assert!(validate_x_post_urls(profile, &vec![post.into(); 21]).is_err());
        assert!(
            validate_x_post_urls(
                profile,
                &["https://x.com/dotey/status/2083749667410727319".into()]
            )
            .is_err()
        );
        assert!(validate_x_post_urls(profile, &[format!("{post}?token=private")]).is_err());
        assert!(validate_x_post_urls(profile, &["https://127.0.0.1/status/1".into()]).is_err());
    }

    #[test]
    fn reddit_comment_policy_denies_crawling_and_unrecognizable_responses() {
        let endpoint = crate::reddit_comments::public_top_comment_rss_url(
            "https://www.reddit.com/r/test/comments/abc123/post/",
        )
        .unwrap();
        let denied = FeedAdapter::require_comment_policy(
            b"User-agent: *\nDisallow: /\n",
            Some("text/plain; charset=UTF-8"),
            &endpoint,
        )
        .unwrap_err();
        assert!(denied.downcast_ref::<CommentPolicyBlocked>().is_some());
        assert!(article_retry_after(&denied).unwrap() > Utc::now() + chrono::Duration::hours(23));
        assert!(article_source_backoff(&denied).is_none());
        assert!(
            FeedAdapter::require_comment_policy(
                b"<html>Login</html>",
                Some("text/html"),
                &endpoint
            )
            .is_err()
        );
        assert!(FeedAdapter::require_comment_policy(b"", Some("text/plain"), &endpoint).is_err());
        assert!(
            FeedAdapter::require_comment_policy(
                b"User-agent: *\nAllow: /\n",
                Some("text/plain"),
                &endpoint
            )
            .is_ok()
        );
    }

    fn parse(xml: &str) -> Vec<FetchedItem> {
        parse_items(
            xml.as_bytes(),
            &Url::parse("https://example.com/feeds/news.xml").unwrap(),
            "rss",
        )
        .unwrap()
    }

    #[test]
    fn future_dated_entries_are_not_recast_as_current_news() {
        let date = (Utc::now() + chrono::Duration::days(7)).to_rfc3339();
        let xml = format!(
            r#"<feed xmlns="http://www.w3.org/2005/Atom"><title>Feed</title><id>f</id><updated>{date}</updated>
            <entry><id>future</id><title>Future entry</title><published>{date}</published><link href="https://example.com/future"/></entry></feed>"#
        );
        assert!(
            parse_items(
                xml.as_bytes(),
                &Url::parse("https://example.com/feed").unwrap(),
                "atom",
            )
            .is_err()
        );
    }

    #[test]
    fn atom_prefers_html_alternate_and_resolves_urls() {
        let items = parse(
            r#"<feed xmlns="http://www.w3.org/2005/Atom"><title>Releases</title><id>x</id>
        <updated>2026-01-01T00:00:00Z</updated><entry><id>tag:v1</id><title>Version 1.0</title>
        <link rel="self" type="application/atom+xml" href="/api/1"/>
        <link rel="enclosure" type="audio/mpeg" href="/audio/1.mp3" length="42"/>
        <link rel="alternate" type="text/html" href="../release/1?utm_source=feed"/>
        <content type="html">&lt;p&gt;Stable &amp;amp; fast&lt;/p&gt;&lt;script&gt;bad()&lt;/script&gt;</content>
        </entry></feed>"#,
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].external_id, "tag:v1");
        assert_eq!(
            items[0].url,
            "https://example.com/release/1?utm_source=feed"
        );
        assert_eq!(items[0].summary.as_deref(), Some("Stable & fast"));
        assert_eq!(items[0].enclosures[0].length, Some(42));
    }

    #[test]
    fn arxiv_keeps_version_and_distinct_publication_and_modification_dates() {
        let xml = br#"<feed xmlns="http://www.w3.org/2005/Atom"><title>arXiv</title><id>query</id>
        <updated>2025-01-01T00:00:00Z</updated><entry><id>http://arxiv.org/abs/2401.12345v2</id>
        <title>Example paper</title><published>2024-01-01T00:00:00Z</published><updated>2025-01-01T00:00:00Z</updated>
        <author><name>Research Author</name></author><summary>Paper abstract.</summary>
        <link rel="alternate" type="text/html" href="http://arxiv.org/abs/2401.12345v2"/></entry></feed>"#;
        let items = parse_items(
            xml,
            &Url::parse("https://export.arxiv.org/api/query").unwrap(),
            "arxiv_atom",
        )
        .unwrap();
        assert_eq!(items[0].external_id, "http://arxiv.org/abs/2401.12345v2");
        assert_eq!(items[0].url, "https://arxiv.org/abs/2401.12345v2");
        assert_eq!(
            items[0].published_at.unwrap().to_rfc3339(),
            "2024-01-01T00:00:00+00:00"
        );
        assert_eq!(
            items[0].source_metadata["updatedAt"],
            "2025-01-01T00:00:00Z"
        );
        assert_eq!(items[0].source_metadata["authors"][0], "Research Author");
        assert_eq!(items[0].source_metadata["peerReviewVerified"], false);
    }

    #[test]
    fn podcast_feed_byte_limit_is_bounded_and_does_not_expand_other_adapters() {
        let endpoint = Url::parse("https://example.com/podcast/rss").unwrap();
        let mut xml = br#"<rss version="2.0"><channel><title>Show</title><link>https://example.com</link>
            <description>Show</description><item><title>Episode</title><link>https://example.com/episode</link>
            <description>Public episode description</description></item>"#.to_vec();
        xml.extend(std::iter::repeat_n(b' ', MAX_FEED_BYTES));
        xml.extend_from_slice(b"</channel></rss>");
        assert!(parse_items(&xml, &endpoint, "rss").is_err());
        assert!(parse_items(&xml, &endpoint, "atom").is_err());
        assert_eq!(
            parse_items(&xml, &endpoint, "podcast_rss").unwrap().len(),
            1
        );
        assert!(
            parse_items(
                &vec![b' '; MAX_PODCAST_FEED_BYTES + 1],
                &endpoint,
                "podcast_rss"
            )
            .is_err()
        );
        assert_eq!(feed_byte_limit("podcast_rss"), 16 * 1024 * 1024);
        for adapter in [
            "rss",
            "atom",
            "arxiv_atom",
            "github_release_atom",
            "anthropic_news",
        ] {
            assert_eq!(feed_byte_limit(adapter), 4 * 1024 * 1024);
        }
    }

    #[test]
    fn parses_podcast_enclosures_and_plaintext() {
        let items = parse_items(
            r#"<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
        <channel><title>Podcast</title><link>https://example.com</link><description>Show</description>
        <item><guid isPermaLink="false">episode-1</guid><title>Episode 1</title><link>https://example.com/episodes/1</link>
        <description><![CDATA[<p>Our guest&nbsp;talks <b>Rust</b>.</p>]]></description>
        <enclosure url="https://cdn.example.com/1.mp3" type="audio/mpeg" length="1234"/>
        <itunes:duration>00:42:03</itunes:duration></item></channel></rss>"#.as_bytes(),
            &Url::parse("https://example.com/feeds/podcast.xml").unwrap(),
            "podcast_rss",
        ).unwrap();
        assert_eq!(items[0].summary.as_deref(), Some("Our guest talks Rust."));
        assert!(
            items[0].enclosures.iter().any(
                |item| item.url == "https://cdn.example.com/1.mp3" && item.length == Some(1234)
            )
        );
        let context = items[0].reading_context.as_ref().unwrap();
        assert_eq!(context.kind, ReadingContextKind::Podcast);
        assert_eq!(context.duration_seconds, Some(2523));
        assert_eq!(context.body, "Our guest talks Rust.");
    }

    #[test]
    fn rss_context_retains_structured_body_and_reddit_never_invents_comments() {
        let rich = parse(
            r#"<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
              <title>Feed</title><link>https://example.com</link><description>Feed</description><item>
              <guid>article-1</guid><title>Article</title><link>https://example.com/article</link>
              <content:encoded><![CDATA[<h2>Why it matters</h2><p>First paragraph.</p><p>Second paragraph.</p>]]></content:encoded>
              </item></channel></rss>"#,
        );
        let context = rich[0].reading_context.as_ref().unwrap();
        assert_eq!(context.kind, ReadingContextKind::Article);
        assert_eq!(
            context.body,
            "Why it matters\n\nFirst paragraph.\n\nSecond paragraph."
        );
        assert!(!context.truncated);

        let reddit = parse_items(
            br#"<feed xmlns="http://www.w3.org/2005/Atom"><title>r/test</title><id>x</id>
            <entry><id>post-1</id><title>Post</title><content type="html">&lt;p&gt;Actual supplied body.&lt;/p&gt;</content>
            <link rel="alternate" href="https://www.reddit.com/r/test/comments/post-1/"/></entry></feed>"#,
            &Url::parse("https://www.reddit.com/r/test/.rss").unwrap(),
            "atom",
        )
        .unwrap();
        let context = reddit[0].reading_context.as_ref().unwrap();
        assert_eq!(context.kind, ReadingContextKind::Post);
        assert_eq!(
            context.comments_status,
            crate::reading_context::CommentsStatus::RequiresAuthorization
        );
        assert!(context.comments.is_empty());
    }

    #[test]
    fn canonical_identity_ignores_tracking_but_content_changes_are_detected() {
        let a = fingerprint(
            &canonical_url("https://example.com/a?utm_source=x").unwrap(),
            "Title",
            Some("First"),
            None,
            &[],
        )
        .unwrap();
        let b = fingerprint(
            &canonical_url("https://example.com/a?utm_source=y#part").unwrap(),
            "Title",
            Some("First"),
            None,
            &[],
        )
        .unwrap();
        let c = fingerprint("https://example.com/a", "Title", Some("Updated"), None, &[]).unwrap();
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn ingested_counts_only_new_rows_not_changed_or_unchanged_revisions() {
        let mut counts = ItemCounts::default();
        counts.add(ItemCounts::for_item(true, true));
        counts.add(ItemCounts::for_item(false, true));
        counts.add(ItemCounts::for_item(false, false));
        assert_eq!(
            counts,
            ItemCounts {
                ingested: 1,
                updated: 1
            }
        );
    }

    #[test]
    fn acquisition_state_does_not_requeue_legacy_or_non_feed_material() {
        let body = "Same retained RSS material";
        let context = ReadingContext::from_feed(
            ReadingContextKind::Article,
            "https://example.com/article".into(),
            FeedContext {
                body: body.into(),
                ..Default::default()
            },
            Utc::now(),
        );
        let legacy = serde_json::json!({"feedSummary":body});
        assert!(!reading_context_material_changed(
            &legacy,
            None,
            context.material_fingerprint().as_deref(),
        ));
        assert!(!reading_context_material_changed(
            &serde_json::json!({}),
            None,
            None
        ));

        let blocked = context.clone().blocked_from_feed();
        assert!(!reading_context_material_changed(
            &serde_json::json!({}),
            Some(&context),
            blocked.material_fingerprint().as_deref(),
        ));
        let richer = ReadingContext::from_feed(
            ReadingContextKind::Article,
            "https://example.com/article".into(),
            FeedContext {
                body: "More detailed publisher material ".repeat(500),
                ..Default::default()
            },
            Utc::now(),
        );
        assert!(reading_context_material_changed(
            &legacy,
            None,
            richer.material_fingerprint().as_deref(),
        ));
    }

    #[test]
    fn registered_non_rss_blogs_can_enrich_from_retained_excerpts() {
        assert!(supports_article_enrichment("anthropic_news"));
        assert!(supports_article_enrichment("anthropic_research"));
        assert!(supports_article_enrichment("anthropic_engineering"));
        assert!(!supports_article_enrichment("github_repository"));
        assert!(!supports_article_enrichment("huggingface_models"));
        assert!(!supports_article_enrichment("github_search"));

        let item = FetchedItem {
            external_id: "article".into(),
            title: "Article".into(),
            url: "https://www.anthropic.com/news/article".into(),
            published_at: None,
            summary: Some("Index-supplied explanatory excerpt".into()),
            content_hash: "hash".into(),
            enclosures: Vec::new(),
            source_metadata: serde_json::json!({}),
            reading_context: None,
            reading_context_resources: serde_json::json!({}),
        };
        let context = retained_excerpt_context(&item).expect("nonempty retained excerpt");
        assert_eq!(context.kind, ReadingContextKind::Article);
        assert_eq!(context.status, ReadingContextStatus::Partial);
        assert_eq!(context.body, "Index-supplied explanatory excerpt");
        assert!(
            retained_excerpt_context(&FetchedItem {
                summary: None,
                ..item
            })
            .is_none()
        );
    }

    #[test]
    fn official_requires_a_boundary_matched_registered_domain() {
        let domains = serde_json::json!(["example.com"]);
        assert!(official_url("https://blog.example.com/a", &domains));
        assert!(!official_url("https://example.com.evil.org/a", &domains));
        assert!(!official_url("https://notexample.com/a", &domains));
        assert!(!official_url(
            "https://example.com/a",
            &serde_json::json!([])
        ));
    }

    #[test]
    fn publisher_page_robots_and_content_type_fail_closed() {
        assert!(FeedAdapter::publisher_robots_allows(
            b"User-agent: ScoutNews\nAllow: /\n",
            "https://example.com/article"
        ));
        assert!(!FeedAdapter::publisher_robots_allows(
            b"User-agent: ScoutNews\nDisallow: /\n",
            "https://example.com/article"
        ));
        assert!(!FeedAdapter::publisher_robots_allows(
            b"\xff",
            "https://example.com/article"
        ));
        assert!(FeedAdapter::is_article_content_type(
            "text/html; charset=utf-8"
        ));
        assert!(!FeedAdapter::is_article_content_type("application/json"));
    }

    #[test]
    fn near_duplicate_is_conservative_about_versions_generic_titles_and_time() {
        let now = Utc::now();
        let title =
            "Rust introduces reliable asynchronous execution across embedded hardware devices";
        assert!(near_duplicate(title, now, &format!("The {title}"), now));
        assert!(!near_duplicate("Release v1.0", now, "Release v1.0", now));
        assert!(!near_duplicate(
            "New release notes and features improvements with bug fixes available",
            now,
            "New release notes and features improvements with bug fixes available",
            now
        ));
        assert!(!near_duplicate(
            &format!("{title} version 1.2"),
            now,
            &format!("{title} version 1.3"),
            now
        ));
        assert!(!near_duplicate(
            title,
            now,
            title,
            now + chrono::Duration::days(2)
        ));
        assert!(!near_duplicate(
            title,
            now,
            "Rust removes reliable asynchronous execution across embedded hardware devices",
            now
        ));
    }

    #[test]
    fn missing_or_future_dates_do_not_become_future_publication() {
        let now = Utc::now();
        assert_eq!(valid_publication(None, now), None);
        assert_eq!(
            valid_publication(Some(now + chrono::Duration::days(1)), now),
            None
        );
        assert_eq!(
            valid_publication(Some(now + chrono::Duration::minutes(1)), now),
            Some(now)
        );
    }

    #[test]
    fn feed_entry_count_is_bounded() {
        let mut xml = String::from(
            "<rss version=\"2.0\"><channel><title>Test</title><link>https://example.com</link><description>Test</description>",
        );
        for number in 0..MAX_FEED_ENTRIES + 20 {
            xml.push_str(&format!(
                "<item><title>Item {number}</title><link>https://example.com/{number}</link></item>"
            ));
        }
        xml.push_str("</channel></rss>");
        assert_eq!(parse(&xml).len(), MAX_FEED_ENTRIES);
    }

    #[tokio::test]
    #[ignore = "opt-in public network contract verification; never writes to the database"]
    async fn public_source_adapter_contracts() {
        let adapter = FeedAdapter::new(Client::new());
        for (kind, endpoint) in [
            (
                "arxiv_atom",
                "https://export.arxiv.org/api/query?search_query=cat:cs.AI&start=0&max_results=40&sortBy=submittedDate&sortOrder=descending",
            ),
            (
                "arxiv_atom",
                "https://export.arxiv.org/api/query?search_query=cat:cs.HC&start=0&max_results=40&sortBy=submittedDate&sortOrder=descending",
            ),
            (
                "huggingface_models",
                "https://huggingface.co/api/models?author=Qwen&sort=lastModified&direction=-1&limit=20&expand[]=sha&expand[]=createdAt&expand[]=lastModified&expand[]=tags&expand[]=pipeline_tag&expand[]=private&expand[]=gated",
            ),
            (
                "huggingface_models",
                "https://huggingface.co/api/models?author=deepseek-ai&sort=lastModified&direction=-1&limit=20&expand[]=sha&expand[]=createdAt&expand[]=lastModified&expand[]=tags&expand[]=pipeline_tag&expand[]=private&expand[]=gated",
            ),
            (
                "github_repository",
                "https://api.github.com/repos/microsoft/agent-framework",
            ),
            (
                "github_search",
                "https://api.github.com/search/repositories?q=topic%3Amcp+archived%3Afalse&sort=updated&order=desc&per_page=20",
            ),
            ("anthropic_news", "https://www.anthropic.com/news"),
            ("podcast_rss", "https://feed.xyzfm.space/dk4yh3pkpjp3"),
            ("podcast_rss", "https://lexfridman.com/feed/podcast/"),
            ("rss", "https://developer.apple.com/news/rss/news.rss"),
            ("rss", "https://www.psychologicalscience.org/feed"),
            ("rss", "https://www.smashingmagazine.com/feed/"),
        ] {
            let outcome = adapter
                .fetch_with_adapter(
                    &AdapterSource {
                        endpoint: endpoint.into(),
                        etag: None,
                        last_modified: None,
                    },
                    kind,
                )
                .await
                .unwrap_or_else(|error| panic!("{kind} {endpoint}: {error:#}"));
            let FetchOutcome::Items { items, .. } = outcome else {
                panic!("unexpected uncached 304")
            };
            assert!(!items.is_empty(), "{endpoint}: no usable items");
            assert!(
                items.iter().all(|item| item.published_at.is_some()),
                "{endpoint}: missing publication dates"
            );
            assert!(
                items
                    .iter()
                    .all(|item| item.summary.as_deref().unwrap_or("").chars().count()
                        <= MAX_EXCERPT_CHARS)
            );
            println!("{kind}: {} parsed records from {endpoint}", items.len());
        }
    }
}
