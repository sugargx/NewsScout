use super::{FetchedItem, MAX_FEED_BYTES, MAX_FEED_ENTRIES, fingerprint, valid_publication};
use crate::processing::{
    MAX_EXCERPT_CHARS, canonical_url, excerpt, plain_text, validate_public_https,
};
use anyhow::{Context, Result, bail};
use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::OnceLock,
    time::Duration,
};
use url::Url;

pub fn supported_adapters() -> &'static [&'static str] {
    &[
        "rss",
        "atom",
        "podcast_rss",
        "github_release_atom",
        "arxiv_atom",
        "huggingface_models",
        "github_repository",
        "github_search",
        "anthropic_news",
        "anthropic_research",
        "anthropic_engineering",
        "x_public_preview",
    ]
}

fn slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'-' | b'_' | b'.'))
}

fn query_value(url: &Url, key: &str) -> Option<String> {
    let values: Vec<_> = url.query_pairs().filter(|(name, _)| name == key).collect();
    (values.len() == 1).then(|| values[0].1.to_string())
}

fn bounded_query(url: &Url, key: &str) -> bool {
    query_value(url, key)
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|count| (1..=MAX_FEED_ENTRIES).contains(&count))
}

pub fn validate_adapter_endpoint(adapter: &str, endpoint: &str) -> Result<Url> {
    let url = validate_public_https(endpoint)?;
    let host = url.host_str().unwrap_or_default();
    if host == "aihot.news"
        || host.ends_with(".aihot.news")
        || host == "aihot.virxact.com"
        || host.ends_with(".aihot.virxact.com")
        || (host == "barretlee.github.io" && url.path().starts_with("/agent-pulse/"))
    {
        bail!("请订阅原始发布者或作者的直接来源；不支持聚合平台接口或其 RSS");
    }
    let path: Vec<_> = url.path().trim_matches('/').split('/').collect();
    let api_port = url.port().is_none_or(|port| port == 443);
    let valid = match adapter {
        "x_public_preview" => crate::x_public_posts::validate_profile_endpoint(endpoint).is_ok(),
        "x_oembed" => {
            api_port && host == "publish.x.com" && url.path() == "/oembed"
                && url.query_pairs().all(|(key, _)| matches!(key.as_ref(), "url" | "omit_script" | "hide_thread" | "lang"))
                && query_value(&url, "url").is_some_and(|post| {
                    Url::parse(&post).ok().and_then(|post_url| {
                        let handle = post_url.path_segments()?.next()?;
                        crate::x_public_posts::validate_post_url(&post, handle).ok()
                    }).is_some()
                })
                && query_value(&url, "omit_script").as_deref() == Some("true")
                && query_value(&url, "hide_thread").as_deref() == Some("true")
                && query_value(&url, "lang").as_deref() == Some("en")
        }
        "reddit_comment_atom" => crate::reddit_comments::validate_comment_rss_endpoint(&url).is_ok(),
        "rss" | "atom" | "podcast_rss" | "github_release_atom" | "publisher_page" => true,
        "arxiv_atom" => {
            api_port
                && matches!(host, "arxiv.org" | "export.arxiv.org")
                && url.path() == "/api/query"
                && bounded_query(&url, "max_results")
                && ["search_query", "id_list"]
                    .iter()
                    .any(|key| query_value(&url, key).is_some_and(|value| !value.trim().is_empty()))
        }
        "huggingface_models" => {
            api_port
                && host == "huggingface.co"
                && url.query_pairs().all(|(key, _)| {
                    matches!(
                        key.as_ref(),
                        "author" | "sort" | "direction" | "limit" | "expand[]" | "full" | "config"
                    )
                })
                && ((url.path() == "/api/models"
                    && query_value(&url, "author").is_some_and(|author| slug(&author))
                    && bounded_query(&url, "limit"))
                    || (path.len() == 4
                        && path[0..2] == ["api", "models"]
                        && slug(path[2])
                        && slug(path[3])
                        && url.query().is_none()))
        }
        "github_repository" => {
            api_port
                && host == "api.github.com"
                && path.len() == 3
                && path[0] == "repos"
                && slug(path[1])
                && slug(path[2])
                && url.query().is_none()
        }
        "github_search" => {
            api_port
                && host == "api.github.com"
                && url.path() == "/search/repositories"
                && bounded_query(&url, "per_page")
                && query_value(&url, "q").is_some_and(|query| !query.trim().is_empty())
                && url.query_pairs().all(|(key, _)| {
                    matches!(key.as_ref(), "q" | "sort" | "order" | "per_page" | "page")
                })
        }
        "anthropic_news" => {
            api_port
                && host == "www.anthropic.com"
                && url.path().trim_end_matches('/') == "/news"
                && url.query().is_none()
        }
        "anthropic_research" => {
            api_port
                && host == "www.anthropic.com"
                && url.path() == "/research"
                && url.query().is_none()
        }
        "anthropic_engineering" => {
            api_port
                && host == "www.anthropic.com"
                && url.path() == "/engineering"
                && url.query().is_none()
        }
        _ => false,
    };
    if !valid || url.fragment().is_some() {
        bail!("unsupported adapter or endpoint outside the adapter's public contract: {adapter}");
    }
    Ok(url)
}

pub(super) fn official_evidence_url(
    adapter: &str,
    endpoint: &str,
    content_url: &str,
    domains: &Value,
    compliance: &Value,
) -> bool {
    if adapter == "github_search" {
        return false;
    }
    if matches!(adapter, "github_release_atom" | "github_repository") {
        let Ok(url) = Url::parse(content_url) else {
            return false;
        };
        let Ok(source) = Url::parse(endpoint) else {
            return false;
        };
        let repository = if adapter == "github_release_atom"
            && source.host_str() == Some("github.com")
        {
            source.path().strip_suffix("/releases.atom")
        } else if adapter == "github_repository" && source.host_str() == Some("api.github.com") {
            source
                .path()
                .strip_prefix("/repos")
                .filter(|path| path.starts_with('/'))
        } else {
            None
        };
        let Some(repository) = repository else {
            return false;
        };
        if url.host_str() != Some("github.com")
            || !(url.path() == repository || url.path().starts_with(&format!("{repository}/")))
        {
            return false;
        }
        let verified_scope = format!("https://github.com{repository}");
        return super::official_url(content_url, domains)
            || (compliance.get("catalogVersion").is_some()
                && compliance.get("publisherScope").and_then(Value::as_str)
                    == Some(verified_scope.as_str()));
    }
    super::official_url(content_url, domains)
}

pub(super) async fn pace_arxiv() {
    static LAST_REQUEST: OnceLock<tokio::sync::Mutex<Option<tokio::time::Instant>>> =
        OnceLock::new();
    let mut last = LAST_REQUEST
        .get_or_init(|| tokio::sync::Mutex::new(None))
        .lock()
        .await;
    if let Some(previous) = *last {
        tokio::time::sleep_until(previous + Duration::from_secs(3)).await;
    }
    *last = Some(tokio::time::Instant::now());
}

pub(super) fn parse(adapter: &str, bytes: &[u8], endpoint: &Url) -> Result<Vec<FetchedItem>> {
    validate_adapter_endpoint(adapter, endpoint.as_str())?;
    if bytes.len() > MAX_FEED_BYTES {
        bail!("source body exceeds the bounded fetch limit");
    }
    if adapter == "anthropic_news" {
        return parse_anthropic(
            std::str::from_utf8(bytes).context("news index is not UTF-8")?,
            endpoint,
        );
    }
    if matches!(adapter, "anthropic_research" | "anthropic_engineering") {
        return parse_anthropic_technical(
            std::str::from_utf8(bytes).context("technical index is not UTF-8")?,
            endpoint,
        );
    }
    let data: Value = serde_json::from_slice(bytes).context("invalid public metadata JSON")?;
    let mut items = Vec::new();
    match adapter {
        "huggingface_models" => {
            let models = if endpoint.path() == "/api/models" {
                data.as_array()
                    .context("model list is not a JSON array")?
                    .as_slice()
            } else {
                if !data.is_object() {
                    bail!("model metadata is not an object");
                }
                std::slice::from_ref(&data)
            };
            for model in models.iter().take(MAX_FEED_ENTRIES) {
                if let Some(item) = huggingface_item(model, endpoint)? {
                    items.push(item);
                }
            }
        }
        "github_repository" => {
            if let Some(item) = github_item(&data, endpoint, false)? {
                items.push(item);
            }
        }
        "github_search" => {
            if data.get("incomplete_results").and_then(Value::as_bool) != Some(false) {
                bail!("GitHub search response is incomplete or lacks its completeness flag");
            }
            for repo in data
                .get("items")
                .and_then(Value::as_array)
                .context("GitHub search has no repository items")?
                .iter()
                .take(MAX_FEED_ENTRIES)
            {
                if let Some(item) = github_item(repo, endpoint, true)? {
                    items.push(item);
                }
            }
        }
        _ => bail!("unsupported metadata adapter"),
    }
    // An empty, valid discovery response is not an ingestion failure. Private/gated
    // entries are intentionally skipped without fetching their cards or repositories.
    Ok(items)
}

fn date(data: &Value, key: &str) -> Option<DateTime<Utc>> {
    data.get(key)
        .and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|date| date.with_timezone(&Utc))
        .and_then(|date| valid_publication(Some(date), Utc::now()))
}

fn metadata_item(
    external_id: String,
    title: String,
    url: String,
    published_at: DateTime<Utc>,
    summary: Option<String>,
    metadata: Value,
) -> Result<FetchedItem> {
    let title = excerpt(&title, 300);
    let summary = summary
        .map(|text| excerpt(&text, MAX_EXCERPT_CHARS))
        .filter(|text| !text.is_empty());
    // Revision metadata is part of the fingerprint, not the stable identity. A
    // renamed/updated model or repository must retain its existing content row.
    let base_hash = fingerprint(
        &canonical_url(&url)?,
        &title,
        summary.as_deref(),
        Some(published_at),
        &[],
    )?;
    let content_hash = fingerprint(
        &base_hash,
        &serde_json::to_string(&metadata)?,
        None,
        None,
        &[],
    )?;
    Ok(FetchedItem {
        external_id,
        title,
        url,
        published_at: Some(published_at),
        summary,
        content_hash,
        enclosures: Vec::new(),
        source_metadata: metadata,
        reading_context: None,
        reading_context_resources: Value::Null,
    })
}

fn huggingface_item(model: &Value, endpoint: &Url) -> Result<Option<FetchedItem>> {
    let private = model
        .get("private")
        .and_then(Value::as_bool)
        .context("model lacks public/private metadata")?;
    let gated = model.get("gated").context("model lacks gating metadata")?;
    if private || (!gated.is_null() && gated != &Value::Bool(false)) {
        return Ok(None);
    }
    let id = model
        .get("id")
        .and_then(Value::as_str)
        .context("model has no public ID")?;
    let segments: Vec<_> = id.split('/').collect();
    if segments.len() != 2 || !segments.iter().all(|part| slug(part)) {
        bail!("invalid public model ID");
    }
    if endpoint.path() == "/api/models" {
        if query_value(endpoint, "author").as_deref() != Some(segments[0]) {
            bail!("model response is outside the curated author");
        }
    } else if endpoint.path().strip_prefix("/api/models/") != Some(id) {
        bail!("model response does not match the monitored model");
    }
    let Some(created) = date(model, "createdAt") else {
        bail!("model lacks a valid creation date");
    };
    let revision = model
        .get("sha")
        .and_then(Value::as_str)
        .filter(|sha| (7..=64).contains(&sha.len()) && sha.bytes().all(|ch| ch.is_ascii_hexdigit()))
        .context("model lacks a valid revision SHA")?;
    let modified = date(model, "lastModified").context("model lacks a valid modification date")?;
    if modified < created {
        bail!("model modification precedes creation");
    }
    let tags: Vec<_> = model
        .get("tags")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .take(50)
        .map(|tag| excerpt(tag, 150))
        .collect();
    let license = tags.iter().find_map(|tag| tag.strip_prefix("license:"));
    let pipeline = model
        .get("pipeline_tag")
        .and_then(Value::as_str)
        .map(|text| excerpt(text, 100));
    let identity = model
        .get("_id")
        .and_then(Value::as_str)
        .filter(|id| id.len() == 24 && id.bytes().all(|ch| ch.is_ascii_hexdigit()))
        .unwrap_or(id);
    let metadata = json!({
        "kind":"model_metadata", "modelId":id, "revision":revision,
        "createdAt":created, "lastModified":modified, "pipelineTag":pipeline,
        "tags":tags, "license":license, "modelCardFetched":false
    });
    let summary = format!(
        "Hugging Face public model metadata: {id}. Pipeline: {}. License tag: {}. Revision: {revision}. Created: {created}. Modified: {modified}. Model card and weights were not fetched; metadata is not a capability evaluation.",
        pipeline.as_deref().unwrap_or("not supplied"),
        license.unwrap_or("not supplied")
    );
    metadata_item(
        format!("huggingface:{identity}"),
        id.to_owned(),
        format!("https://huggingface.co/{id}"),
        created,
        Some(summary),
        metadata,
    )
    .map(Some)
}

fn github_item(repo: &Value, endpoint: &Url, discovery: bool) -> Result<Option<FetchedItem>> {
    if repo
        .get("private")
        .and_then(Value::as_bool)
        .context("repository lacks public/private metadata")?
    {
        return Ok(None);
    }
    let id = repo
        .get("id")
        .and_then(Value::as_u64)
        .filter(|id| *id > 0)
        .context("repository has no stable ID")?;
    let name = repo
        .get("full_name")
        .and_then(Value::as_str)
        .context("repository has no full name")?;
    let parts: Vec<_> = name.split('/').collect();
    if parts.len() != 2 || !parts.iter().all(|part| slug(part)) {
        bail!("invalid repository name");
    }
    if !discovery
        && !endpoint
            .path()
            .strip_prefix("/repos/")
            .is_some_and(|expected| expected.eq_ignore_ascii_case(name))
    {
        bail!("repository response is outside the monitored repository");
    }
    let url = format!("https://github.com/{name}");
    if repo.get("html_url").and_then(Value::as_str) != Some(url.as_str()) {
        bail!("repository HTML URL does not match its name");
    }
    let created = date(repo, "created_at").context("repository lacks a valid creation date")?;
    let pushed = date(repo, "pushed_at");
    let description = repo
        .get("description")
        .and_then(Value::as_str)
        .map(|text| excerpt(text, 700))
        .unwrap_or_default();
    let topics: Vec<_> = repo
        .get("topics")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .take(30)
        .map(|text| excerpt(text, 100))
        .collect();
    let metadata = json!({
        "kind":if discovery {"repository_discovery"} else {"repository_metadata"},
        "repositoryId":id, "fullName":name, "createdAt":created, "pushedAt":pushed,
        "defaultBranch":repo.get("default_branch"), "archived":repo.get("archived"),
        "license":repo.get("license").and_then(|license| license.get("spdx_id")), "topics":topics,
        "discovery":discovery, "popularityIsNotEvidence":true
    });
    let context = if discovery {
        "GitHub search candidate, not a verified recommendation or official publisher."
    } else {
        "Public repository metadata, not a release announcement."
    };
    let summary = format!(
        "{context} {description} Repository created: {created}. Last push: {}. No popularity ranking is used as evidence.",
        pushed
            .map(|date| date.to_rfc3339())
            .unwrap_or_else(|| "not supplied".into())
    );
    metadata_item(
        format!("github:repository:{id}"),
        name.to_owned(),
        url,
        created,
        Some(summary),
        metadata,
    )
    .map(Some)
}

pub(super) fn anthropic_robots_allows(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let mut wildcard = false;
    let mut allow_root = false;
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        if key.eq_ignore_ascii_case("user-agent") {
            wildcard = value == "*" || value.to_ascii_lowercase().contains("scoutnews");
            if !wildcard {
                return false;
            }
        } else if wildcard && key.eq_ignore_ascii_case("disallow") && !value.is_empty() {
            // Fail closed on a changed policy rather than guessing wildcard precedence.
            return false;
        } else if wildcard && key.eq_ignore_ascii_case("allow") && value == "/" {
            allow_root = true;
        }
    }
    allow_root
}

// Narrow server-rendered index contract, not a generic HTML crawler. No article,
// pagination, script execution, transcript or audio requests are performed.
fn elements<'a>(html: &'a str, tag: &str) -> Vec<(&'a str, &'a str)> {
    let mut result = Vec::new();
    let mut cursor = 0;
    while let Some(offset) = html[cursor..].find('<') {
        let start = cursor + offset;
        if html[start..].starts_with("<!--") {
            let Some(end) = html[start + 4..].find("-->") else {
                break;
            };
            cursor = start + 4 + end + 3;
            continue;
        }
        let Some(end) = tag_end(html, start) else {
            break;
        };
        let header = &html[start + 1..end];
        let name = header.split_ascii_whitespace().next().unwrap_or("");
        cursor = end + 1;
        if matches!(name, "script" | "style") && name != tag {
            let Some(close) = html[cursor..].find(&format!("</{name}>")) else {
                break;
            };
            cursor += close + name.len() + 3;
            continue;
        }
        if name != tag {
            continue;
        }
        let Some(close) = html[cursor..].find(&format!("</{tag}>")) else {
            break;
        };
        result.push((header, &html[cursor..cursor + close]));
        cursor += close + tag.len() + 3;
    }
    result
}

fn tag_end(html: &str, start: usize) -> Option<usize> {
    let mut quote = None;
    for (offset, byte) in html.as_bytes()[start + 1..].iter().enumerate() {
        match (quote, *byte) {
            (Some(expected), value) if expected == value => quote = None,
            (None, b'\'' | b'"') => quote = Some(*byte),
            (None, b'>') => return Some(start + 1 + offset),
            _ => {}
        }
    }
    None
}

fn attribute<'a>(header: &'a str, wanted: &str) -> Option<&'a str> {
    let bytes = header.as_bytes();
    let mut cursor = header.find(char::is_whitespace)?;
    while cursor < bytes.len() {
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        let start = cursor;
        while bytes
            .get(cursor)
            .is_some_and(|ch| !ch.is_ascii_whitespace() && *ch != b'=')
        {
            cursor += 1;
        }
        let key = &header[start..cursor];
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        if bytes.get(cursor) != Some(&b'=') {
            continue;
        }
        cursor += 1;
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        let quote = *bytes.get(cursor)?;
        if !matches!(quote, b'\'' | b'"') {
            return None;
        }
        cursor += 1;
        let value_start = cursor;
        while bytes.get(cursor).is_some_and(|ch| *ch != quote) {
            cursor += 1;
        }
        if cursor >= bytes.len() {
            return None;
        }
        let value = &header[value_start..cursor];
        cursor += 1;
        if key == wanted {
            return Some(value);
        }
    }
    None
}

fn parse_anthropic(html: &str, endpoint: &Url) -> Result<Vec<FetchedItem>> {
    let mut seen = BTreeSet::new();
    let mut items = Vec::new();
    for (header, body) in elements(html, "a") {
        let Some(href) = attribute(header, "href") else {
            continue;
        };
        let Ok(url) = endpoint.join(href) else {
            continue;
        };
        if url.host_str() != Some("www.anthropic.com")
            || url.scheme() != "https"
            || !url.path().starts_with("/news/")
            || url.path() == "/news/"
        {
            continue;
        }
        let title = ["h1", "h2", "h3", "h4"]
            .iter()
            .find_map(|tag| {
                elements(body, tag)
                    .first()
                    .map(|(_, text)| plain_text(text))
            })
            .or_else(|| {
                elements(body, "span")
                    .into_iter()
                    .find_map(|(header, text)| {
                        attribute(header, "class")
                            .filter(|value| value.contains("__title"))
                            .map(|_| plain_text(text))
                    })
            });
        let Some(title) = title.filter(|text| !text.is_empty()) else {
            continue;
        };
        let published = elements(body, "time")
            .first()
            .and_then(|(header, text)| {
                attribute(header, "datetime")
                    .and_then(|date| DateTime::parse_from_rfc3339(date).ok())
                    .map(|date| date.with_timezone(&Utc))
                    .or_else(|| {
                        let value = plain_text(text);
                        NaiveDate::parse_from_str(&value, "%b %e, %Y")
                            .or_else(|_| NaiveDate::parse_from_str(&value, "%B %e, %Y"))
                            .ok()
                            .and_then(|date| date.and_hms_opt(0, 0, 0))
                            .map(|date| date.and_utc())
                    })
            })
            .and_then(|date| valid_publication(Some(date), Utc::now()));
        let Some(published) = published else { continue };
        let canonical = canonical_url(url.as_str())?;
        if !seen.insert(canonical.clone()) {
            continue;
        }
        let summary = elements(body, "p")
            .first()
            .map(|(_, text)| plain_text(text));
        items.push(metadata_item(
            canonical.clone(),
            title,
            canonical,
            published,
            summary,
            json!({"kind":"official_news_index","datePrecision":"day","articleBodyFetched":false}),
        )?);
        if items.len() == MAX_FEED_ENTRIES {
            break;
        }
    }
    if items.is_empty() {
        bail!("Anthropic index contract changed: no dated news cards; manual review required");
    }
    Ok(items)
}

fn anthropic_flight_payload(html: &str) -> Result<String> {
    let mut payload = String::new();
    for (_, script) in elements(html, "script") {
        let mut remaining = script.trim();
        while let Some(argument) = remaining.strip_prefix("self.__next_f.push(") {
            // Only decode a JSON argument. No JavaScript evaluation, imports or execution.
            let mut values = serde_json::Deserializer::from_str(argument).into_iter::<Value>();
            let value = values
                .next()
                .context("Anthropic Flight push has no JSON argument")??;
            remaining = argument[values.byte_offset()..]
                .trim_start()
                .strip_prefix(')')
                .context("Anthropic Flight push is not a passive JSON call")?
                .trim_start()
                .trim_start_matches(';')
                .trim_start();
            let array = value
                .as_array()
                .context("Anthropic Flight push is not an array")?;
            if array.first().and_then(Value::as_u64) == Some(1) {
                let chunk = array
                    .get(1)
                    .and_then(Value::as_str)
                    .filter(|_| array.len() == 2)
                    .context("Anthropic Flight text chunk changed")?;
                payload.push_str(chunk);
            }
        }
    }
    if payload.is_empty() {
        bail!("Anthropic index contract changed: no passive Flight text; manual review required");
    }
    Ok(payload)
}

fn anthropic_index_date(article: &Value) -> Option<(DateTime<Utc>, &'static str)> {
    let value = article.get("publishedOn")?.as_str()?;
    if let Ok(published) = DateTime::parse_from_rfc3339(value) {
        return valid_publication(Some(published.with_timezone(&Utc)), Utc::now())
            .map(|published| (published, "time"));
    }
    if value.len() != 10 || value.as_bytes()[4] != b'-' || value.as_bytes()[7] != b'-' {
        return None;
    }
    let published = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()?
        .and_hms_opt(0, 0, 0)?
        .and_utc();
    valid_publication(Some(published), Utc::now()).map(|published| (published, "day"))
}

fn anthropic_article_href(href: &str, endpoint: &Url) -> Option<(String, String)> {
    let url = endpoint.join(href).ok()?;
    validate_public_https(url.as_str()).ok()?;
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    let valid_directory = if endpoint.path() == "/research" {
        matches!(parts.first().copied(), Some("research" | "news"))
    } else {
        parts.first().copied() == Some("engineering")
    };
    if url.host_str() != Some("www.anthropic.com")
        || url.port().is_some_and(|port| port != 443)
        || !valid_directory
        || parts.len() != 2
        || !slug(parts[1])
    {
        return None;
    }
    Some((parts[1].to_owned(), url.to_string()))
}

fn anthropic_article_url(
    article: &Value,
    endpoint: &Url,
    slug: &str,
    rendered_links: &BTreeMap<String, String>,
) -> Option<(String, &'static str)> {
    if let Some(href) = article.get("href").and_then(Value::as_str) {
        let (linked_slug, url) = anthropic_article_href(href, endpoint)?;
        return (linked_slug == slug).then_some((url, "explicit_href"));
    }
    if let Some(url) = rendered_links.get(slug) {
        return Some((url.clone(), "rendered_href"));
    }
    let directory = if endpoint.path() == "/engineering" {
        "engineering"
    } else {
        // Verified in the publisher's 2026-09-09 index renderer:
        // /_next/static/chunks/1yvygrnfxpzcr.js chooses directories[0].value.
        // Membership in Research alone does not establish a /research/ permalink.
        match article
            .get("directories")?
            .as_array()?
            .first()?
            .get("value")?
            .as_str()?
        {
            "research" => "research",
            "news" => "news",
            _ => return None,
        }
    };
    Some((
        format!("https://www.anthropic.com/{directory}/{slug}"),
        "directory_contract",
    ))
}

fn anthropic_technical_item(
    article: &Value,
    endpoint: &Url,
    rendered_links: &BTreeMap<String, String>,
) -> Result<Option<FetchedItem>> {
    let Some(title) = article
        .get("title")
        .and_then(Value::as_str)
        .map(plain_text)
        .filter(|title| !title.is_empty())
    else {
        return Ok(None);
    };
    let Some(slug) = article
        .get("slug")
        .and_then(|value| value.get("current"))
        .and_then(Value::as_str)
        .filter(|value| slug(value))
    else {
        return Ok(None);
    };
    let Some((published, precision)) = anthropic_index_date(article) else {
        return Ok(None);
    };
    let Some((url, url_evidence)) = anthropic_article_url(article, endpoint, slug, rendered_links)
    else {
        return Ok(None);
    };
    let category = if endpoint.path() == "/research" {
        "Research"
    } else {
        "Engineering"
    };
    let summary = article
        .get("summary")
        .and_then(Value::as_str)
        .map(plain_text);
    let subjects: Vec<_> = article
        .get("subjects")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(50)
        .filter_map(|subject| {
            let label = subject.get("label").and_then(Value::as_str);
            let value = subject.get("value").and_then(Value::as_str);
            (label.is_some() || value.is_some()).then(|| {
                json!({
                    "label":label.map(|text| excerpt(&plain_text(text), 150)),
                    "value":value.map(|text| excerpt(text, 150))
                })
            })
        })
        .collect();
    metadata_item(url.clone(), title, url, published, summary, json!({
        "kind":if category == "Research" { "official_research_index" } else { "official_engineering_index" },
        "subjects":subjects, "feedCategories":[category], "datePrecision":precision,
        "publishedOn":article["publishedOn"], "articleBodyFetched":false,
        "indexUrl":endpoint.as_str(), "paginationFetched":false, "urlEvidence":url_evidence
    })).map(Some)
}

fn anthropic_technical_records(
    data: &Value,
    endpoint: &Url,
    rendered_links: &BTreeMap<String, String>,
    items: &mut Vec<FetchedItem>,
) -> Result<()> {
    match data {
        Value::Object(object) => {
            if endpoint.path() == "/research"
                && data.get("_type").and_then(Value::as_str) == Some("post")
                && data
                    .get("directories")
                    .and_then(Value::as_array)
                    .is_some_and(|directories| {
                        directories.iter().any(|directory| {
                            directory.get("value").and_then(Value::as_str) == Some("research")
                        })
                    })
            {
                if let Some(item) = anthropic_technical_item(data, endpoint, rendered_links)? {
                    items.push(item);
                }
            } else if endpoint.path() == "/engineering"
                && data.get("_type").and_then(Value::as_str) == Some("articleList")
            {
                for article in data
                    .get("articles")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if article.get("_type").and_then(Value::as_str) == Some("engineeringArticle") {
                        if let Some(item) =
                            anthropic_technical_item(article, endpoint, rendered_links)?
                        {
                            items.push(item);
                        }
                    }
                }
            }
            for value in object.values() {
                anthropic_technical_records(value, endpoint, rendered_links, items)?;
            }
        }
        Value::Array(array) => {
            for value in array {
                anthropic_technical_records(value, endpoint, rendered_links, items)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn parse_anthropic_technical(html: &str, endpoint: &Url) -> Result<Vec<FetchedItem>> {
    let payload = anthropic_flight_payload(html)?;
    let mut rendered_links = BTreeMap::new();
    for (header, _) in elements(html, "a") {
        if let Some((slug, url)) =
            attribute(header, "href").and_then(|href| anthropic_article_href(href, endpoint))
        {
            rendered_links.entry(slug).or_insert(url);
        }
    }
    let mut items = Vec::new();
    let mut start = 0;
    let mut depth = 0usize;
    let mut quoted = false;
    let mut escaped = false;
    // Flight rows contain non-JSON framing. Extract balanced objects after joining
    // text chunks; escaped quotes and braces inside JSON strings are not delimiters.
    for (index, byte) in payload.bytes().enumerate() {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
            continue;
        }
        match byte {
            b'"' => quoted = true,
            b'{' => {
                if depth == 0 {
                    start = index;
                }
                depth += 1;
            }
            b'}' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    if let Ok(value) = serde_json::from_str::<Value>(&payload[start..=index]) {
                        anthropic_technical_records(&value, endpoint, &rendered_links, &mut items)?;
                    }
                }
            }
            _ => {}
        }
    }
    items.sort_by(|left, right| {
        right
            .published_at
            .cmp(&left.published_at)
            .then_with(|| {
                right
                    .summary
                    .as_ref()
                    .map_or(0, String::len)
                    .cmp(&left.summary.as_ref().map_or(0, String::len))
            })
            .then_with(|| left.url.cmp(&right.url))
    });
    let mut seen = BTreeSet::new();
    items.retain(|item| seen.insert(item.url.clone()));
    items.truncate(MAX_FEED_ENTRIES);
    if items.is_empty() {
        bail!(
            "Anthropic {} index contract changed: no dated article records; manual review required",
            endpoint.path()
        );
    }
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model() -> Value {
        json!({"_id":"507f1f77bcf86cd799439011","id":"Qwen/example","private":false,"gated":false,
            "createdAt":"2024-01-01T00:00:00Z","lastModified":"2025-02-03T00:00:00Z",
            "sha":"0123456789abcdef","pipeline_tag":"text-generation","tags":["license:apache-2.0"]})
    }

    fn model_endpoint() -> Url {
        Url::parse("https://huggingface.co/api/models?author=Qwen&limit=20").unwrap()
    }

    #[test]
    fn x_oembed_transport_is_restricted_to_known_post_api_requests() {
        let mut endpoint = Url::parse("https://publish.x.com/oembed").unwrap();
        endpoint.query_pairs_mut()
            .append_pair("url", "https://x.com/karpathy/status/2083749667410727319")
            .append_pair("omit_script", "true")
            .append_pair("hide_thread", "true")
            .append_pair("lang", "en");
        assert!(validate_adapter_endpoint("x_oembed", endpoint.as_str()).is_ok());
        assert!(!supported_adapters().contains(&"x_oembed"));
        for invalid in [
            endpoint.as_str().replace("publish.x.com", "publish.x.com.evil.example"),
            endpoint.as_str().replace("publish.x.com", "127.0.0.1"),
            endpoint.as_str().replace("https://publish", "http://publish"),
            endpoint.as_str().replace("omit_script=true", "omit_script=false"),
            endpoint.as_str().replace("hide_thread=true", "hide_thread=false"),
            format!("{endpoint}&url=https%3A%2F%2Fx.com%2Fkarpathy"),
            format!("{endpoint}&callback=script"),
            "https://x.com/karpathy".into(),
        ] {
            assert!(validate_adapter_endpoint("x_oembed", &invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn adapters_reject_wrong_hosts_unbounded_queries_and_credentials() {
        for (adapter, endpoint) in [
            (
                "huggingface_models",
                "https://huggingface.co.evil.com/api/models?author=Qwen&limit=20",
            ),
            (
                "huggingface_models",
                "https://huggingface.co/api/models?limit=20",
            ),
            (
                "huggingface_models",
                "https://huggingface.co/api/models?author=Qwen&author=other&limit=20",
            ),
            (
                "github_repository",
                "https://api.github.com/repos/microsoft/agent-framework/issues",
            ),
            (
                "github_search",
                "https://api.github.com/search/repositories?q=rust&per_page=999",
            ),
            (
                "arxiv_atom",
                "http://export.arxiv.org/api/query?search_query=cat:cs.AI&max_results=40",
            ),
            ("anthropic_news", "https://www.anthropic.com/news/article"),
            (
                "aihot_public",
                "https://aihot.virxact.com/api/public/daily/2026-09-08",
            ),
            (
                "aihot_public",
                "https://aihot.virxact.com/api/v1/items?mode=all&window=7d&by=published&limit=30",
            ),
            (
                "aihot_public",
                "https://aihot.virxact.com/api/v1/items?mode=selected&window=7d&by=published&limit=999",
            ),
            ("rss", "https://user:secret@example.com/feed"),
        ] {
            assert!(
                validate_adapter_endpoint(adapter, endpoint).is_err(),
                "{endpoint}"
            );
        }
        assert!(validate_adapter_endpoint("huggingface_models", model_endpoint().as_str()).is_ok());
        assert!(validate_adapter_endpoint("publisher_page", "https://example.com/article").is_ok());
        assert!(validate_adapter_endpoint("publisher_page", "http://example.com/article").is_err());
        assert!(validate_adapter_endpoint("publisher_page", "https://127.0.0.1/article").is_err());
    }

    #[test]
    fn aggregate_platforms_cannot_be_reenabled_as_generic_feeds() {
        assert!(!supported_adapters().contains(&"aihot_public"));
        for endpoint in [
            "https://aihot.virxact.com/feed.xml",
            "https://aihot.news/feed/all.xml",
            "https://www.aihot.news/feed.xml",
            "https://barretlee.github.io/agent-pulse/signals/",
        ] {
            for adapter in ["rss", "atom", "podcast_rss"] {
                assert!(validate_adapter_endpoint(adapter, endpoint).is_err());
            }
        }
        assert!(validate_adapter_endpoint("rss", "https://mistral.ai/news/rss").is_ok());
        assert!(
            validate_adapter_endpoint("atom", "https://simonwillison.net/atom/entries/").is_ok()
        );
    }

    #[test]
    fn model_revision_changes_content_not_identity_or_publication() {
        let mut data = model();
        let a = huggingface_item(&data, &model_endpoint()).unwrap().unwrap();
        data["sha"] = json!("abcdef0123456789");
        data["lastModified"] = json!("2025-03-01T00:00:00Z");
        let b = huggingface_item(&data, &model_endpoint()).unwrap().unwrap();
        assert_eq!(a.external_id, b.external_id);
        assert_eq!(a.published_at, b.published_at);
        assert_ne!(a.content_hash, b.content_hash);
        assert_eq!(b.source_metadata["revision"], "abcdef0123456789");
        assert!(b.summary.unwrap().contains("not a capability evaluation"));
    }

    #[test]
    fn model_gating_scope_and_unknown_dates_fail_closed() {
        let mut data = model();
        data["gated"] = json!("auto");
        assert!(
            huggingface_item(&data, &model_endpoint())
                .unwrap()
                .is_none()
        );
        data["gated"] = json!(false);
        data["id"] = json!("unconfirmed/example");
        assert!(huggingface_item(&data, &model_endpoint()).is_err());
        data["id"] = json!("Qwen/example");
        data["createdAt"] = Value::Null;
        assert!(huggingface_item(&data, &model_endpoint()).is_err());
    }

    #[test]
    fn repository_import_uses_creation_not_push_or_observation_clock() {
        let endpoint =
            Url::parse("https://api.github.com/search/repositories?q=topic:mcp&per_page=20")
                .unwrap();
        let mut data = json!({"id":123,"full_name":"someone/project","html_url":"https://github.com/someone/project",
            "private":false,"created_at":"2020-01-01T00:00:00Z","pushed_at":"2025-01-01T00:00:00Z","stargazers_count":10});
        let a = github_item(&data, &endpoint, true).unwrap().unwrap();
        data["stargazers_count"] = json!(1000000);
        let b = github_item(&data, &endpoint, true).unwrap().unwrap();
        assert_eq!(a.content_hash, b.content_hash);
        assert_eq!(
            a.published_at.unwrap().to_rfc3339(),
            "2020-01-01T00:00:00+00:00"
        );
        assert_eq!(a.source_metadata["discovery"], true);
        assert!(a.summary.unwrap().contains("not a verified recommendation"));
        data["created_at"] = Value::Null;
        assert!(github_item(&data, &endpoint, true).is_err());
    }

    #[test]
    fn anthropic_index_requires_dated_title_contract_and_deduplicates() {
        let endpoint = Url::parse("https://www.anthropic.com/news").unwrap();
        let card = r#"<a href="/news/example"><time>Aug 27, 2025</time>
            <span class="PublicationList__title">Example &amp; research</span><p>Actual excerpt.</p></a>"#;
        let html =
            format!("<a href='/news/undated'>No date</a>{card}{card}<script>{card}</script>");
        let items = parse_anthropic(&html, &endpoint).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Example & research");
        assert_eq!(items[0].summary.as_deref(), Some("Actual excerpt."));
        assert!(parse_anthropic("<html>Login required</html>", &endpoint).is_err());
    }

    fn flight_html(chunks: &[&str]) -> String {
        chunks
            .iter()
            .map(|chunk| format!("<script>self.__next_f.push({})</script>", json!([1, chunk])))
            .collect()
    }

    fn technical_article(kind: &str, slug: &str, published: &str) -> Value {
        json!({"_type":kind, "title":"An original technical article",
            "slug":{"current":slug}, "publishedOn":published,
            "directories":[{"label":"Research","value":"research"}],
            "subjects":[{"label":"Agents","value":"agents"}],
            "summary":"An original index summary, not an article body."})
    }

    fn parse_technical_fixture(adapter: &str, value: &Value) -> Result<Vec<FetchedItem>> {
        let path = adapter.strip_prefix("anthropic_").unwrap();
        let endpoint = Url::parse(&format!("https://www.anthropic.com/{path}")).unwrap();
        let payload = format!("0:[\"$\",\"$L1\",null,{}]\n", value);
        parse(adapter, flight_html(&[&payload]).as_bytes(), &endpoint)
    }

    #[test]
    fn anthropic_technical_adapters_accept_only_the_exact_public_indexes() {
        for (adapter, path) in [
            ("anthropic_research", "research"),
            ("anthropic_engineering", "engineering"),
        ] {
            assert!(supported_adapters().contains(&adapter));
            assert!(
                validate_adapter_endpoint(adapter, &format!("https://www.anthropic.com/{path}"))
                    .is_ok()
            );
            for endpoint in [
                format!("http://www.anthropic.com/{path}"),
                format!("https://anthropic.com/{path}"),
                format!("https://www.anthropic.com.evil.com/{path}"),
                format!("https://www.anthropic.com:444/{path}"),
                format!("https://www.anthropic.com/{path}/"),
                format!("https://www.anthropic.com/{path}/article"),
                format!("https://www.anthropic.com/{path}?page=2"),
                format!("https://www.anthropic.com/{path}#articles"),
                "https://www.anthropic.com/news".to_owned(),
            ] {
                assert!(
                    validate_adapter_endpoint(adapter, &endpoint).is_err(),
                    "{endpoint}"
                );
                assert!(parse(adapter, b"{}", &Url::parse(&endpoint).unwrap()).is_err());
            }
        }
    }

    #[test]
    fn anthropic_research_decodes_chunked_json_quotes_braces_and_nested_records() {
        let mut article =
            technical_article("post", "original-research", "2025-09-04T15:27:00.000Z");
        article["title"] = json!("Research &amp; agents");
        article["summary"] = json!(
            "A {balanced} object, an unmatched } and a \"quoted\" path C:\\model.\nOriginal excerpt."
        );
        let data = json!({"content":[{"items":[article.clone(), article]}]});
        let payload = format!("1:\"$Sreact.fragment\"\n2:[\"$\",null,{}]\n", data);
        let strings: Vec<String> = payload
            .chars()
            .collect::<Vec<_>>()
            .chunks(17)
            .map(|chunk| chunk.iter().collect())
            .collect();
        let chunks: Vec<_> = strings.iter().map(String::as_str).collect();
        let html = format!(
            "<!--{}--><script>const irrelevant = \"self.__next_f.push([])\";</script>{}",
            flight_html(&["not-json"]),
            flight_html(&chunks)
        );
        let items = parse(
            "anthropic_research",
            html.as_bytes(),
            &Url::parse("https://www.anthropic.com/research").unwrap(),
        )
        .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Research & agents");
        assert!(
            items[0]
                .summary
                .as_deref()
                .unwrap()
                .contains("unmatched } and a \"quoted\" path C:\\model.")
        );
        assert_eq!(
            items[0].url,
            "https://www.anthropic.com/research/original-research"
        );
        assert_eq!(items[0].source_metadata["kind"], "official_research_index");
        assert_eq!(
            items[0].source_metadata["feedCategories"],
            json!(["Research"])
        );
        assert_eq!(
            items[0].source_metadata["subjects"],
            json!([{"label":"Agents","value":"agents"}])
        );
        assert_eq!(items[0].source_metadata["datePrecision"], "time");
        assert_eq!(items[0].source_metadata["articleBodyFetched"], false);
        assert_eq!(
            items[0].published_at.unwrap().to_rfc3339(),
            "2025-09-04T15:27:00+00:00"
        );
    }

    #[test]
    fn anthropic_engineering_requires_article_list_and_preserves_original_date_precision() {
        let day = technical_article("engineeringArticle", "day", "2025-05-25");
        let time = technical_article("engineeringArticle", "time", "2025-05-25T15:00:00+02:00");
        let wrong = technical_article("post", "wrong-type", "2025-05-25");
        let unrelated = technical_article("engineeringArticle", "outside-list", "2025-06-01");
        let data = json!({"blocks":[{"_type":"articleList","articles":[day,time,wrong]}],"related":unrelated});
        let items = parse_technical_fixture("anthropic_engineering", &data).unwrap();
        assert_eq!(items.len(), 2);
        assert!(items[0].url.ends_with("/engineering/time"));
        assert_eq!(items[0].source_metadata["datePrecision"], "time");
        assert_eq!(
            items[0].published_at.unwrap().to_rfc3339(),
            "2025-05-25T13:00:00+00:00"
        );
        assert!(items[1].url.ends_with("/engineering/day"));
        assert_eq!(
            items[1].published_at.unwrap().to_rfc3339(),
            "2025-05-25T00:00:00+00:00"
        );
        assert_eq!(items[1].source_metadata["datePrecision"], "day");
        assert_eq!(items[1].source_metadata["publishedOn"], "2025-05-25");
        assert_eq!(
            items[1].source_metadata["kind"],
            "official_engineering_index"
        );
        assert_eq!(
            items[1].source_metadata["feedCategories"],
            json!(["Engineering"])
        );
        assert!(
            items[1]
                .summary
                .as_deref()
                .unwrap()
                .starts_with("An original index summary")
        );
        assert!(parse_technical_fixture("anthropic_engineering", &unrelated).is_err());
    }

    #[test]
    fn anthropic_research_rejects_wrong_schema_directories_dates_and_unsafe_slugs() {
        let article = technical_article("post", "valid", "2025-05-25T00:00:00Z");
        let mut wrong = article.clone();
        wrong["directories"] = json!([{"label":"Research","value":"news"}]);
        assert!(parse_technical_fixture("anthropic_research", &wrong).is_err());
        wrong["directories"] = json!(["research"]);
        assert!(parse_technical_fixture("anthropic_research", &wrong).is_err());
        wrong = article.clone();
        wrong["_type"] = json!("engineeringArticle");
        assert!(parse_technical_fixture("anthropic_research", &wrong).is_err());
        for slug in [
            "",
            ".",
            "..",
            "../news/article",
            "https://evil.com/article",
            "//evil.com",
            "path%2fescape",
            "article?x=1",
            "article#x",
        ] {
            wrong = article.clone();
            wrong["slug"]["current"] = json!(slug);
            assert!(
                parse_technical_fixture("anthropic_research", &wrong).is_err(),
                "{slug}"
            );
        }
        for date in [
            Value::Null,
            json!("recently"),
            json!("2025-02-30"),
            json!("9999-01-01"),
        ] {
            wrong = article.clone();
            wrong["publishedOn"] = date;
            assert!(parse_technical_fixture("anthropic_research", &wrong).is_err());
        }
    }

    #[test]
    fn anthropic_research_uses_rendered_links_and_the_publishers_first_directory_contract() {
        let mut news_first = technical_article("post", "news-first", "2025-05-25T00:00:00Z");
        news_first["directories"] = json!([{"value":"news"},{"value":"research"}]);
        let mut research_first =
            technical_article("post", "research-first", "2025-05-25T00:00:00Z");
        research_first["directories"] = json!([{"value":"research"},{"value":"news"}]);
        let rendered = technical_article("post", "rendered", "2025-05-25T00:00:00Z");
        let mut explicit = technical_article("post", "explicit", "2025-05-25T00:00:00Z");
        explicit["href"] = json!("/news/explicit");
        let payload = json!({"items":[news_first,research_first,rendered,explicit]}).to_string();
        let html = format!(
            "<a href='https://www.anthropic.com/news/rendered?source=research#summary'>Original link</a>{}",
            flight_html(&[&payload])
        );
        let endpoint = Url::parse("https://www.anthropic.com/research").unwrap();
        let items = parse("anthropic_research", html.as_bytes(), &endpoint).unwrap();
        assert_eq!(items.len(), 4);
        for (ending, evidence) in [
            ("/news/news-first", "directory_contract"),
            ("/research/research-first", "directory_contract"),
            ("/news/rendered?source=research#summary", "rendered_href"),
            ("/news/explicit", "explicit_href"),
        ] {
            let item = items
                .iter()
                .find(|item| item.url.ends_with(ending))
                .unwrap();
            assert_eq!(item.source_metadata["urlEvidence"], evidence);
            assert_eq!(item.source_metadata["feedCategories"], json!(["Research"]));
        }
        let mut unsafe_article = technical_article("post", "unsafe", "2025-05-25T00:00:00Z");
        for href in [
            "https://www.anthropic.com.evil.com/news/unsafe",
            "https://www.anthropic.com:444/news/unsafe",
            "http://www.anthropic.com/news/unsafe",
            "/news/different-slug",
            "/engineering/unsafe",
        ] {
            unsafe_article["href"] = json!(href);
            assert!(
                parse_technical_fixture("anthropic_research", &unsafe_article).is_err(),
                "{href}"
            );
        }
        unsafe_article.as_object_mut().unwrap().remove("href");
        unsafe_article["directories"] = json!([{"value":"unknown"},{"value":"research"}]);
        assert!(parse_technical_fixture("anthropic_research", &unsafe_article).is_err());
    }

    #[test]
    fn anthropic_technical_sorts_deduplicates_and_bounds_index_summaries() {
        let first = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
        let mut articles: Vec<_> = (0..MAX_FEED_ENTRIES + 5)
            .map(|index| {
                technical_article(
                    "post",
                    &format!("article-{index}"),
                    &(first + chrono::Duration::days(index as i64))
                        .format("%Y-%m-%d")
                        .to_string(),
                )
            })
            .collect();
        let mut duplicate = articles.last().unwrap().clone();
        articles.last_mut().unwrap()["summary"] = Value::Null;
        duplicate["summary"] = json!("研".repeat(MAX_EXCERPT_CHARS + 500));
        articles.push(duplicate);
        let items =
            parse_technical_fixture("anthropic_research", &json!({"items":articles})).unwrap();
        assert_eq!(items.len(), MAX_FEED_ENTRIES);
        assert!(
            items[0]
                .url
                .ends_with(&format!("article-{}", MAX_FEED_ENTRIES + 4))
        );
        assert!(items.last().unwrap().url.ends_with("article-5"));
        assert!(items[0].summary.as_deref().unwrap().chars().count() <= MAX_EXCERPT_CHARS);
        assert!(items[0].summary.as_deref().unwrap().starts_with("研"));
        assert!(
            items
                .windows(2)
                .all(|pair| pair[0].published_at >= pair[1].published_at)
        );
        let endpoint = Url::parse("https://www.anthropic.com/research").unwrap();
        assert!(
            parse(
                "anthropic_research",
                &vec![b' '; MAX_FEED_BYTES + 1],
                &endpoint
            )
            .is_err()
        );
    }

    #[test]
    fn anthropic_changed_contract_or_executable_payload_fails_visibly() {
        let endpoint = Url::parse("https://www.anthropic.com/research").unwrap();
        for html in [
            "<html>Access denied</html>",
            "<script>self.__next_f.push([0])</script>",
            "<script>self.__next_f.push([1, getArticles()])</script>",
            "<script>self.__next_f.push([1, \"data\"] + execute())</script>",
            "<script>self.__next_f.push([1, {}])</script>",
            "<script>self.__next_f.push([1, \"{}\"])</script>",
            "<a href='/research/example'><time>May 25, 2025</time><h2>Not the Flight contract</h2></a>",
        ] {
            assert!(
                parse("anthropic_research", html.as_bytes(), &endpoint).is_err(),
                "{html}"
            );
        }
    }

    #[tokio::test]
    #[ignore = "explicit opt-in: reads robots and the two public index pages, never article bodies"]
    async fn anthropic_live_technical_indexes() {
        let client = reqwest::Client::builder()
            .user_agent("ScoutNews/0.2 (public-index metadata verification)")
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(45))
            .build()
            .unwrap();
        let robots = client
            .get("https://www.anthropic.com/robots.txt")
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .bytes()
            .await
            .unwrap();
        assert!(anthropic_robots_allows(&robots));
        for path in ["research", "engineering"] {
            let endpoint = Url::parse(&format!("https://www.anthropic.com/{path}")).unwrap();
            let mut response = client
                .get(endpoint.clone())
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.unwrap() {
                assert!(bytes.len() + chunk.len() <= MAX_FEED_BYTES);
                bytes.extend_from_slice(&chunk);
            }
            let items = parse(&format!("anthropic_{path}"), &bytes, &endpoint).unwrap();
            let recent: Vec<_> = items
                .iter()
                .filter(|item| {
                    item.published_at
                        .is_some_and(|date| date >= Utc::now() - chrono::Duration::days(30))
                })
                .collect();
            println!(
                "{path}: bytes={}, entries={}, summaries={}, recent30={}, recent30Summaries={}, newest={:?}, oldest={:?}, newestTitle={}, precision={}",
                bytes.len(),
                items.len(),
                items.iter().filter(|item| item.summary.is_some()).count(),
                recent.len(),
                recent.iter().filter(|item| item.summary.is_some()).count(),
                items[0].published_at,
                items.last().unwrap().published_at,
                items[0].title,
                items[0].source_metadata["datePrecision"]
            );
            println!(
                "{path}: researchUrls={}, newsUrls={}, renderedUrls={}, newestUrl={}",
                items
                    .iter()
                    .filter(|item| item.url.starts_with("https://www.anthropic.com/research/"))
                    .count(),
                items
                    .iter()
                    .filter(|item| item.url.starts_with("https://www.anthropic.com/news/"))
                    .count(),
                items
                    .iter()
                    .filter(|item| item.source_metadata["urlEvidence"] == "rendered_href")
                    .count(),
                items[0].url
            );
        }
    }

    #[test]
    fn changed_robots_policy_is_not_bypassed() {
        assert!(anthropic_robots_allows(b"User-Agent: *\nAllow: /\n"));
        assert!(!anthropic_robots_allows(
            b"User-Agent: *\nDisallow: /news\n"
        ));
        assert!(!anthropic_robots_allows(
            b"User-Agent: *\nAllow: /\nDisallow: /news\n"
        ));
        assert!(!anthropic_robots_allows(b"<html>Blocked</html>"));
        assert!(!anthropic_robots_allows(
            b"User-Agent: *\nAllow: /\nUser-Agent: *\nUser-Agent: Other\nDisallow: /"
        ));
    }

    #[test]
    fn discovery_and_unrelated_platform_projects_are_not_official_evidence() {
        let domains = json!(["github.com"]);
        let endpoint = "https://github.com/langchain-ai/langgraph/releases.atom";
        assert!(official_evidence_url(
            "github_release_atom",
            endpoint,
            "https://github.com/langchain-ai/langgraph/releases/tag/v1",
            &domains,
            &Value::Null
        ));
        assert!(!official_evidence_url(
            "github_release_atom",
            endpoint,
            "https://github.com/unrelated/project/releases/tag/v1",
            &domains,
            &Value::Null
        ));
        assert!(!official_evidence_url(
            "github_search",
            endpoint,
            "https://github.com/langchain-ai/langgraph",
            &domains,
            &Value::Null
        ));
    }
}
