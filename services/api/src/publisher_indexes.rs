use super::{
    FetchedItem, MAX_FEED_ENTRIES, anthropic_flight_payload, anthropic_publication_date,
    attribute, canonical_url, elements, metadata_item, plain_text, slug, validate_public_https,
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use url::Url;

fn objects(payload: &str) -> Result<Vec<Value>> {
    let mut values = Vec::new();
    let (mut start, mut depth, mut quoted, mut escaped) = (0, 0usize, false, false);
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
                    values.push(serde_json::from_str(&payload[start..=index])
                        .context("publisher index contains invalid passive JSON")?);
                }
            }
            _ => {}
        }
    }
    if depth != 0 {
        bail!("publisher index contains an incomplete passive JSON object");
    }
    Ok(values)
}

fn listings<'a>(value: &'a Value, claude: bool, found: &mut Vec<&'a Vec<Value>>) {
    match value {
        Value::Object(object) => {
            let key = if claude { "items" } else { "posts" };
            let is_listing = if claude {
                object.get("total").is_some_and(Value::is_u64)
                    && object.contains_key("leadFromFeed")
            } else {
                object.get("hasNextPage").is_some_and(Value::is_boolean)
            };
            if is_listing {
                if let Some(items) = object.get(key).and_then(Value::as_array) {
                    found.push(items);
                }
            }
            for child in object.values() {
                listings(child, claude, found);
            }
        }
        Value::Array(children) => {
            for child in children {
                listings(child, claude, found);
            }
        }
        _ => {}
    }
}

fn article_url(href: &str, endpoint: &Url, claude: bool) -> Option<String> {
    let location = href.split(['?', '#']).next()?;
    if location.contains(['%', '\\'])
        || location.split('/').any(|part| matches!(part, "." | ".."))
    {
        return None;
    }
    let url = endpoint.join(href).ok()?;
    validate_public_https(url.as_str()).ok()?;
    if url.host_str() != endpoint.host_str()
        || url.port().is_some_and(|port| port != 443)
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    let valid = if claude {
        matches!(parts.as_slice(), ["resources", "articles", name] if slug(name))
    } else {
        match parts.as_slice() {
            ["news" | "research" | "engineering" | "features" | "institute", name] => slug(name),
            [name] => slug(name) && !matches!(*name,
                "news" | "research" | "engineering" | "features" | "institute" | "careers"
                | "about" | "company" | "products" | "models" | "claude" | "pricing"
                | "contact" | "contact-sales" | "api" | "login" | "press" | "events"
                | "learn" | "legal" | "privacy" | "terms" | "robots.txt" | "sitemap.xml"),
            _ => false,
        }
    };
    valid.then(|| canonical_url(url.as_str()).ok()).flatten()
}

fn literal_text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str)
        .filter(|text| !text.starts_with('$'))
        .map(plain_text)
        .filter(|text| !text.is_empty())
}

/// Only the page's dated listing is collected. Navigation, related articles and
/// carousel recommendations also contain records, but are not this index.
pub(super) fn parse(html: &str, endpoint: &Url) -> Result<Option<Vec<FetchedItem>>> {
    if !html.contains("self.__next_f.push(") {
        return Ok(None);
    }
    let claude = endpoint.host_str() == Some("claude.com");
    let payload = anthropic_flight_payload(html)?;
    let values = objects(&payload)?;
    let mut lists = Vec::new();
    for value in &values {
        listings(value, claude, &mut lists);
    }
    if lists.is_empty() {
        return Ok(None);
    }
    let mut rendered: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (header, _) in elements(html, "a") {
        if let Some(url) = attribute(header, "href")
            .and_then(|href| article_url(href, endpoint, claude))
        {
            let key = Url::parse(&url)?.path().trim_end_matches('/')
                .rsplit('/').next().unwrap_or_default().to_owned();
            rendered.entry(key).or_default().insert(url);
        }
    }
    let mut items = Vec::new();
    for article in lists.into_iter().flatten() {
        let expected_type = if claude { "blogPost" } else { "article" };
        if article.get("_type").and_then(Value::as_str) != Some(expected_type) {
            continue;
        }
        if claude && (article.get("externalUrl").is_some_and(|value| !value.is_null())
            || article.get("language").and_then(Value::as_str).is_some_and(|lang| lang != "en"))
        {
            continue;
        }
        let linked = article.get("linkedUrl").and_then(Value::as_str).filter(|url| !url.is_empty());
        if linked.is_some_and(|href| Url::parse(href)
            .is_ok_and(|url| url.host_str() != endpoint.host_str()))
        {
            continue;
        }
        let title = literal_text(article.get("title"))
            .context("publisher index article has no literal title")?;
        let (published, precision) = article.get(if claude { "date" } else { "publishedOn" })
            .and_then(Value::as_str)
            .and_then(anthropic_publication_date)
            .context("publisher index article has no valid publication date")?;
        let url = if let Some(href) = linked {
            let Some(url) = article_url(href, endpoint, claude) else {
                // Explicit external publications belong to their original publisher.
                if Url::parse(href).is_ok_and(|url| url.host_str() != endpoint.host_str()) {
                    continue;
                }
                bail!("publisher index article has an unsupported linked URL");
            };
            url
        } else {
            let name = article.get("slug")
                .and_then(|value| if claude { value.as_str() } else { value.get("current")?.as_str() })
                .filter(|name| slug(name))
                .context("publisher index article has no valid slug")?;
            if claude {
                // Only part of the product site's typed listing is rendered before hydration.
                format!("https://claude.com/resources/articles/{name}")
            } else {
                let urls = rendered.get(name)
                    .with_context(|| format!("publisher index article lacks a rendered permalink: {name}"))?;
                if urls.len() != 1 {
                    bail!("publisher index article has ambiguous rendered permalinks");
                }
                urls.first().cloned().context("publisher index article lacks a permalink")?
            }
        };
        let summary = literal_text(article.get(if claude { "excerpt" } else { "summary" }))
            .or_else(|| literal_text(article.get("seoDescription")));
        let category = if claude {
            article.get("category").and_then(|category| category.get("name"))
                .and_then(Value::as_str).unwrap_or("Product announcements")
        } else {
            match endpoint.path() {
                "/research" => "Research",
                "/engineering" => "Engineering",
                _ => "News",
            }
        };
        items.push(metadata_item(url.clone(), title, url, published, summary, json!({
            "kind":"official_publisher_index", "datePrecision":precision,
            "feedCategories":[category], "articleBodyFetched":false,
            "indexUrl":endpoint.as_str(), "paginationFetched":false, "urlEvidence":"publisher_listing"
        }))?);
    }
    items.sort_by(|left, right| right.published_at.cmp(&left.published_at)
        .then(right.summary.as_ref().map_or(0, String::len).cmp(&left.summary.as_ref().map_or(0, String::len)))
        .then(left.url.cmp(&right.url)));
    let mut seen = BTreeSet::new();
    items.retain(|item| seen.insert(item.url.clone()));
    if items.is_empty() || items.len() > MAX_FEED_ENTRIES {
        bail!("publisher index has no usable dated articles or exceeds its collection bound");
    }
    Ok(Some(items))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(value: Value, links: &str) -> String {
        let payload = format!("0:{}", serde_json::to_string(&value).unwrap());
        format!("{links}<script>self.__next_f.push({});</script>",
            serde_json::to_string(&json!([1, payload])).unwrap())
    }

    fn article(name: &str) -> Value {
        json!({"_type":"article","title":"Measured systems research",
            "slug":{"current":name},"publishedOn":"2026-09-17","summary":"A bounded original excerpt."})
    }

    #[test]
    fn collects_only_the_listing_and_accepts_an_explicit_institute_link_without_a_slug() {
        let endpoint = Url::parse("https://www.anthropic.com/research").unwrap();
        let mut linked = article("linked");
        linked["slug"] = Value::Null;
        linked["linkedUrl"] = json!("/institute/measuring-pace-of-ai-development");
        let html = page(json!({
            "relatedArticles":[article("not-in-list")],
            "listing":{"posts":[article("measured"),linked],"hasNextPage":true}
        }), "<a href='/research/measured'>Measured</a><a href='/research/not-in-list'>Related</a>");
        let items = parse(&html, &endpoint).unwrap().unwrap();
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|item| !item.url.contains("not-in-list")));
        assert!(items.iter().any(|item| item.url.ends_with("/institute/measuring-pace-of-ai-development")));
        assert!(items.iter().all(|item| item.source_metadata["datePrecision"] == "day"));
        assert!(items.iter().all(|item| item.published_at.unwrap().to_rfc3339() == "2026-09-17T00:00:00+00:00"));
    }

    #[test]
    fn claude_product_listing_has_a_separate_contract_and_does_not_collect_external_promos() {
        let endpoint = Url::parse("https://claude.com/resources/articles").unwrap();
        let post = json!({"_type":"blogPost","slug":"a-new-agent","title":"Introducing a new agent",
            "date":"2026-09-17","language":"en","externalUrl":null,"excerpt":"$2a"});
        let mut external = post.clone();
        external["externalUrl"] = json!("https://elsewhere.example/news");
        let html = page(json!({
            "carousel":{"items":[external.clone()],"ctaPosition":1},
            "listing":{"items":[post,external],"total":2,"leadFromFeed":true}
        }), "");
        let items = parse(&html, &endpoint).unwrap().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].url, "https://claude.com/resources/articles/a-new-agent");
        assert!(items[0].summary.is_none(), "unresolved Flight references are not source text");
    }

    #[test]
    fn missing_dates_changed_shapes_and_ambiguous_urls_do_not_report_partial_success() {
        let endpoint = Url::parse("https://www.anthropic.com/news").unwrap();
        for (key, value) in [("publishedOn", Value::Null), ("slug", json!({"current":"../escape"}))] {
            let mut broken = article("valid");
            broken[key] = value;
            let html = page(json!({"posts":[article("valid"),broken],"hasNextPage":false}),
                "<a href='/news/valid'>Valid</a>");
            assert!(parse(&html, &endpoint).is_err());
        }
        let html = page(json!({"posts":[article("valid")],"hasNextPage":false}),
            "<a href='/news/valid'>One</a><a href='/research/valid'>Two</a>");
        assert!(parse(&html, &endpoint).is_err());
        assert!(parse("<script>self.__next_f.push([1, execute()])</script>", &endpoint).is_err());
        assert!(parse(&page(json!({"relatedArticles":[article("valid")]}), ""), &endpoint)
            .unwrap().is_none());
    }
}
