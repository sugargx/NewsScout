use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use std::{collections::BTreeSet, net::IpAddr};
use url::{Host, Url};

use crate::models::{Evidence, ScoreBreakdown};

pub const MAX_EXCERPT_CHARS: usize = 3_000;
pub const PUBLICATION_SKEW_MINUTES: i64 = 5;

/// Extract text, not HTML intended for insertion with innerHTML.
pub fn plain_text(input: &str) -> String {
    text(input, false)
}

/// Extract passive display text while preserving paragraph and heading boundaries.
pub fn reading_text(input: &str) -> String {
    text(input, true)
}

fn text(input: &str, preserve_blocks: bool) -> String {
    let decoded = decode_entities(input);
    let bytes = decoded.as_bytes();
    let mut output = String::with_capacity(decoded.len());
    let mut cursor = 0;
    let mut suppressed: Option<String> = None;
    while cursor < bytes.len() {
        if bytes[cursor] != b'<' {
            let ch = decoded[cursor..].chars().next().unwrap();
            if suppressed.is_none() && (!ch.is_control() || ch.is_whitespace()) {
                output.push(ch);
            }
            cursor += ch.len_utf8();
            continue;
        }
        if decoded[cursor..].starts_with("<!--") {
            cursor = decoded[cursor + 4..]
                .find("-->")
                .map(|offset| cursor + 4 + offset + 3)
                .unwrap_or(bytes.len());
            output.push(' ');
            continue;
        }
        let start = cursor + 1;
        let mut name_start = start;
        let closing = bytes.get(name_start) == Some(&b'/');
        if closing {
            name_start += 1;
        }
        let is_tag = bytes.get(name_start).is_some_and(u8::is_ascii_alphabetic)
            || matches!(bytes.get(start), Some(b'!' | b'?'));
        if !is_tag {
            if suppressed.is_none() {
                output.push('<');
            }
            cursor += 1;
            continue;
        }
        let name_end = bytes[name_start..]
            .iter()
            .position(|ch| !ch.is_ascii_alphanumeric() && *ch != b'-')
            .map(|offset| name_start + offset)
            .unwrap_or(bytes.len());
        let name = decoded[name_start..name_end].to_ascii_lowercase();
        let mut end = name_end;
        let mut quote = None;
        while end < bytes.len() {
            match (quote, bytes[end]) {
                (Some(expected), ch) if expected == ch => quote = None,
                (None, b'\'' | b'"') => quote = Some(bytes[end]),
                (None, b'>') => break,
                _ => {}
            }
            end += 1;
        }
        if end == bytes.len() {
            break;
        }
        if let Some(hidden) = &suppressed {
            if closing && hidden == &name {
                suppressed = None;
                output.push(' ');
            }
        } else if !closing
            && matches!(
                name.as_str(),
                "script"
                    | "style"
                    | "iframe"
                    | "object"
                    | "template"
                    | "noscript"
                    | "nav"
                    | "footer"
                    | "aside"
                    | "form"
            )
        {
            suppressed = Some(name);
            output.push(' ');
        } else if matches!(
            name.as_str(),
            "p" | "br"
                | "div"
                | "li"
                | "ul"
                | "ol"
                | "hr"
                | "table"
                | "tr"
                | "td"
                | "th"
                | "section"
                | "article"
                | "blockquote"
                | "h1"
                | "h2"
                | "h3"
                | "h4"
                | "h5"
                | "h6"
                | "pre"
        ) {
            if preserve_blocks && name == "br" {
                output.push_str("\n\n");
            } else {
                output.push(if preserve_blocks { '\n' } else { ' ' });
            }
        }
        cursor = end + 1;
    }
    if !preserve_blocks {
        return output.split_whitespace().collect::<Vec<_>>().join(" ");
    }
    let mut paragraphs = Vec::new();
    let mut current = String::new();
    for line in output.lines() {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            if !current.is_empty() {
                paragraphs.push(std::mem::take(&mut current));
            }
        } else {
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(&line);
        }
    }
    if !current.is_empty() {
        paragraphs.push(current);
    }
    paragraphs.join("\n\n")
}

pub(crate) fn decode_entities(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    while cursor < input.len() {
        let rest = &input[cursor..];
        if rest.starts_with('&')
            && let Some(end) = rest.as_bytes().iter().take(34).position(|ch| *ch == b';')
        {
            let entity = &rest[1..end];
            let value = if let Some(hex) = entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
            {
                u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
            } else if let Some(decimal) = entity.strip_prefix('#') {
                decimal.parse::<u32>().ok().and_then(char::from_u32)
            } else {
                match entity {
                    "amp" | "AMP" => Some('&'),
                    "lt" | "LT" => Some('<'),
                    "gt" | "GT" => Some('>'),
                    "quot" | "QUOT" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" | "ensp" | "emsp" | "thinsp" => Some(' '),
                    "ndash" => Some('–'),
                    "mdash" => Some('—'),
                    "lsquo" | "rsquo" => Some('\''),
                    "ldquo" | "rdquo" => Some('"'),
                    "hellip" => Some('…'),
                    "bull" | "middot" => Some('·'),
                    "copy" => Some('©'),
                    "reg" => Some('®'),
                    "trade" => Some('™'),
                    "euro" => Some('€'),
                    "pound" => Some('£'),
                    "yen" => Some('¥'),
                    "cent" => Some('¢'),
                    "times" => Some('×'),
                    "divide" => Some('÷'),
                    "laquo" => Some('«'),
                    "raquo" => Some('»'),
                    _ => None,
                }
            };
            if let Some(value) = value {
                output.push(value);
                cursor += end + 1;
                continue;
            }
        }
        let ch = rest.chars().next().unwrap();
        output.push(ch);
        cursor += ch.len_utf8();
    }
    output
}

pub fn excerpt(input: &str, limit: usize) -> String {
    let text = plain_text(input);
    if text.chars().count() <= limit {
        return text;
    }
    if limit == 0 {
        return String::new();
    }
    let mut shortened: String = text.chars().take(limit - 1).collect();
    shortened.truncate(shortened.trim_end().len());
    shortened.push('…');
    shortened
}

pub fn podcast_excerpt(input: &str, limit: usize) -> String {
    excerpt(&podcast_reading_text(input), limit)
}

pub fn podcast_reading_text(input: &str) -> String {
    let text = reading_text(input);
    let noise = [
        "SPONSORS:",
        "SUPPORT & SPONSORS:",
        "CONTACT:",
        "SOCIAL:",
        "EPISODE LINKS:",
        "广告：",
        "赞助商：",
        "联系我们：",
    ];
    let Some(cut) = noise.iter().filter_map(|marker| text.find(marker)).min() else {
        return text;
    };
    let introduction = text[..cut].trim();
    let chapter = [
        "OUTLINE:",
        "CHAPTERS:",
        "TIMESTAMPS:",
        "时间轴",
        "时间线",
        "本期内容",
        "节目内容",
    ]
    .iter()
    .filter_map(|marker| text.find(marker))
    .filter(|position| *position > cut)
    .min();
    match chapter {
        Some(start) => {
            let end = noise
                .iter()
                .filter_map(|marker| text[start..].find(marker))
                .map(|offset| start + offset)
                .min()
                .unwrap_or(text.len());
            format!("{introduction}\n\n{}", text[start..end].trim())
                .trim()
                .to_owned()
        }
        None => introduction.to_owned(),
    }
}

/// Keeps significant query parameters (including versions) and their ordering.
pub fn canonical_url(input: &str) -> Result<String> {
    if input.len() > 2_048 {
        bail!("content URL exceeds the 2048-byte limit");
    }
    let mut url = Url::parse(input.trim()).context("invalid content URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        bail!("content URL must be an HTTP(S) URL without credentials");
    }
    validate_public_host(&url)?;
    url.set_fragment(None);
    if let Some(host) = url.host_str().map(str::to_owned)
        && host.ends_with('.')
    {
        url.set_host(Some(host.trim_end_matches('.')))?;
    }
    if let Some(query) = url.query() {
        let kept: Vec<_> = query
            .split('&')
            .filter(|pair| {
                let key = pair.split('=').next().unwrap_or_default();
                let key = url::form_urlencoded::parse(key.as_bytes())
                    .next()
                    .map(|(key, _)| key.to_ascii_lowercase())
                    .unwrap_or_default();
                !key.starts_with("utm_")
                    && !matches!(
                        key.as_str(),
                        "fbclid"
                            | "gclid"
                            | "dclid"
                            | "msclkid"
                            | "mc_cid"
                            | "mc_eid"
                            | "igshid"
                            | "_hsenc"
                            | "_hsmi"
                    )
            })
            .collect();
        let query = kept.join("&");
        url.set_query((!query.is_empty()).then_some(query.as_str()));
    }
    if url.as_str().len() > 2_048 {
        bail!("normalized content URL exceeds the 2048-byte limit");
    }
    Ok(url.into())
}

pub fn validate_public_https(input: &str) -> Result<Url> {
    if input.len() > 2_048 {
        bail!("feed endpoint exceeds the 2048-byte limit");
    }
    let url = Url::parse(input.trim()).context("invalid feed endpoint")?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        bail!("feed endpoints and redirects must use HTTPS without credentials");
    }
    validate_public_host(&url)?;
    Ok(url)
}

fn validate_public_host(url: &Url) -> Result<()> {
    match url.host().context("endpoint has no host")? {
        Host::Ipv4(ip) if !is_public_ip(IpAddr::V4(ip)) => bail!("non-public endpoint IP"),
        Host::Ipv6(ip) if !is_public_ip(IpAddr::V6(ip)) => bail!("non-public endpoint IP"),
        Host::Domain(host) => {
            let host = host.trim_end_matches('.').to_ascii_lowercase();
            if !host.contains('.')
                || [
                    "localhost",
                    "local",
                    "internal",
                    "lan",
                    "home",
                    "test",
                    "invalid",
                ]
                .iter()
                .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
                || host == "home.arpa"
                || host.ends_with(".home.arpa")
            {
                bail!("non-public endpoint hostname");
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_broadcast()
                && !ip.is_documentation()
                && a != 0
                && a < 224
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 192 && b == 0 && c == 0)
                && !(a == 192 && b == 88 && c == 99)
                && !(a == 198 && (b == 18 || b == 19))
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(v4));
            }
            let segments = ip.segments();
            // Accept global unicast only; exclude transition/documentation ranges.
            segments[0] & 0xe000 == 0x2000
                && !(segments[0] == 0x2001 && segments[1] < 0x0200)
                && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
                && segments[0] != 0x2002
                && !(segments[0] == 0x3fff && segments[1] < 0x1000)
        }
    }
}

pub fn publisher_domain(input: &str) -> Option<String> {
    let url = Url::parse(input).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    if host.parse::<IpAddr>().is_ok() {
        return Some(host);
    }
    let parts: Vec<_> = host.split('.').collect();
    let suffix = parts
        .iter()
        .rev()
        .take(2)
        .rev()
        .copied()
        .collect::<Vec<_>>()
        .join(".");
    let count = if matches!(
        suffix.as_str(),
        "co.uk"
            | "org.uk"
            | "com.au"
            | "net.au"
            | "co.jp"
            | "co.nz"
            | "com.cn"
            | "com.br"
            | "co.in"
            | "co.za"
            | "com.sg"
    ) {
        3
    } else {
        2
    };
    Some(parts[parts.len().saturating_sub(count)..].join("."))
}

/// Scalar PostgreSQL expression for an `events e` row, evaluated before LIMIT/OFFSET.
/// Uses live evidence rather than cached snapshots; callers provide DESC and tie-breakers.
pub fn score_order_sql() -> &'static str {
    r#"(
        SELECT floor((
            current_score.source_quality::double precision * 0.45
            + current_score.corroboration::double precision * 0.20
            + CASE WHEN current_score.latest_publication IS NULL THEN 0.0
                -- Below displayed precision; avoid float4 underflow on archived feeds.
                WHEN current_score.latest_publication < now() - interval '90 days' THEN 0.0
                ELSE (100.0 * power(2.0::double precision,
                    -greatest(floor(extract(epoch FROM (now() - current_score.latest_publication))), 0)::double precision
                    / 172800.0))::real::double precision * 0.35
              END
        ) * 10.0 + 0.5) / 10.0
        FROM (
            SELECT coalesce(max(
                CASE s.tier WHEN 'T1' THEN 85 WHEN 'T1.5' THEN 70 WHEN 'T2' THEN 55 ELSE 40 END
                + CASE WHEN ee.is_official THEN 10 ELSE 0 END
            ), 0) AS source_quality,
            least(greatest(count(DISTINCT
                CASE
                    WHEN s.adapter_type='aihot_public' THEN NULL
                    WHEN domain.host ~ '^([0-9]{1,3}\.){3}[0-9]{1,3}$' THEN domain.host
                    WHEN substring(domain.host FROM '([^.]+\.[^.]+)$') IN
                        ('co.uk','org.uk','com.au','net.au','co.jp','co.nz','com.cn',
                         'com.br','co.in','co.za','com.sg')
                    THEN coalesce(substring(domain.host FROM '([^.]+\.[^.]+\.[^.]+)$'), domain.host)
                    ELSE coalesce(substring(domain.host FROM '([^.]+\.[^.]+)$'), domain.host)
                END
            ) - 1, 0) * 25, 100) AS corroboration,
            max(coalesce(ci.published_at,ci.created_at)) FILTER (
                WHERE coalesce(ci.published_at,ci.created_at) <= now() + interval '5 minutes'
            ) AS latest_publication
            FROM event_evidence ee
            JOIN content_items ci ON ci.id=ee.content_item_id
            JOIN sources s ON s.id=ci.source_id
            CROSS JOIN LATERAL (
                SELECT lower(rtrim(substring(ci.original_url FROM
                    '(?i)^https?://(?:[^/@]*@)?(\[[^]]+\]|[^/:?#]+)'), '.')) AS host
            ) domain
            WHERE ee.event_id=e.id
        ) current_score
    )"#
}

pub fn score_event(
    evidence: &[Evidence],
    _updated_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> ScoreBreakdown {
    let source_quality = evidence
        .iter()
        .map(|item| {
            let base: f32 = match item.source_tier.as_str() {
                "T1" => 85.0,
                "T1.5" => 70.0,
                "T2" => 55.0,
                _ => 40.0,
            };
            base + if item.is_official { 10.0 } else { 0.0 }
        })
        .fold(0.0_f32, f32::max);
    let domains: BTreeSet<_> = evidence
        .iter()
        .filter(|item| item.aggregation.is_none())
        .filter_map(|item| publisher_domain(&item.url))
        .collect();
    let corroboration = (domains.len().saturating_sub(1) as f32 * 25.0).min(100.0);
    let latest = evidence
        .iter()
        .map(|item| item.published_at)
        .filter(|date| *date <= now + chrono::Duration::minutes(PUBLICATION_SKEW_MINUTES))
        .max();
    let freshness = latest
        .map(|published| {
            let hours = (now - published).num_seconds().max(0) as f64 / 3600.0;
            (100.0 * 2.0_f64.powf(-hours / 48.0)) as f32
        })
        .unwrap_or(0.0);
    let round = |value: f32| (value * 10.0).round() / 10.0;
    // Use f64 for weighted arithmetic in both Rust and score_order_sql, then
    // expose the same one-decimal score independent of database real arithmetic.
    let total =
        (((source_quality as f64 * 0.45 + corroboration as f64 * 0.20 + freshness as f64 * 0.35)
            * 10.0)
            .round()
            / 10.0) as f32;
    ScoreBreakdown {
        source_quality,
        corroboration,
        freshness: round(freshness),
        relevance: 0.0,
        novelty: 0.0,
        engagement: 0.0,
        editorial_boost: 0.0,
        total,
        explanation: format!(
            "来源质量 {source_quality:.0}（登记等级 + 原文官方域名）；{} 个独立原文域名，互证 {corroboration:.0}；时效 {:.1}（按发布时间，48 小时半衰期）。总分 = 质量×45% + 互证×20% + 时效×35%；无相关性、新颖度、互动或编辑加分数据，均为 0。",
            domains.len(),
            round(freshness)
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn podcast_sponsor_blocks_do_not_displace_real_chapters() {
        let text = format!(
            "Our guest discusses memory. SPONSORS: {} OUTLINE: 00:00 Memory architecture 12:00 Evaluation CONTACT: private@example.com",
            "advertisement ".repeat(400)
        );
        let result = podcast_excerpt(&text, MAX_EXCERPT_CHARS);
        assert!(result.contains("Our guest"));
        assert!(result.contains("Memory architecture"));
        assert!(result.contains("Evaluation"));
        assert!(!result.contains("advertisement"));
        assert!(!result.contains("private@example.com"));
        assert_eq!(podcast_excerpt("SPONSORS: only an advertisement", 100), "");
    }
    use uuid::Uuid;

    #[test]
    fn strips_markup_and_hidden_content_and_decodes_entities() {
        assert_eq!(
            plain_text(
                "<p>Hello&nbsp;<strong>world</strong> &amp; &#x4E2D;&#25991;</p><style>x {}</style><SCRIPT>evil()</SCRIPT><p title='a > b'>Next &mdash; &#128640;</p>"
            ),
            "Hello world & 中文 Next — 🚀"
        );
        assert_eq!(plain_text("before<script>unclosed"), "before");
        assert_eq!(
            plain_text("2 < 3<!-- ignored --> and 5 > 4"),
            "2 < 3 and 5 > 4"
        );
        assert_eq!(plain_text("&lt;script&gt;bad()&lt;/script&gt;safe"), "safe");
    }

    #[test]
    fn excerpts_are_unicode_safe_and_bounded() {
        assert_eq!(excerpt("中文测试", 3), "中文…");
        assert_eq!(excerpt("x", 0), "");
        assert_eq!(excerpt("<p>hello</p>", 10), "hello");
    }

    #[test]
    fn url_identity_keeps_versions_and_significant_queries() {
        assert_eq!(
            canonical_url(
                "HTTPS://EXAMPLE.com:443/a/../release?v=1.2&utm_source=x&ref=docs#section"
            )
            .unwrap(),
            "https://example.com/release?v=1.2&ref=docs"
        );
        assert_eq!(
            canonical_url("https://example.com/r?UTM_medium=rss&x=a%20b&x=2").unwrap(),
            "https://example.com/r?x=a%20b&x=2"
        );
        assert_ne!(
            canonical_url("https://example.com/r?v=1").unwrap(),
            canonical_url("https://example.com/r?v=2").unwrap()
        );
        assert!(canonical_url("javascript:alert(1)").is_err());
        assert!(canonical_url("https://user:secret@example.com/").is_err());
    }

    #[test]
    fn public_endpoints_reject_local_and_obfuscated_addresses() {
        for url in [
            "http://example.com/feed",
            "https://localhost./feed",
            "https://foo.local/feed",
            "https://127.1/feed",
            "https://0x7f000001/feed",
            "https://10.1.2.3/feed",
            "https://169.254.169.254/feed",
            "https://100.64.0.1/feed",
            "https://[::1]/feed",
            "https://[::ffff:127.0.0.1]/feed",
            "https://[fe80::1]/feed",
            "https://[fc00::1]/feed",
            "https://[2002:7f00:1::]/feed",
        ] {
            assert!(validate_public_https(url).is_err(), "{url}");
        }
        assert!(validate_public_https("https://example.com/feed").is_ok());
        assert!(is_public_ip("8.8.8.8".parse().unwrap()));
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    fn evidence(url: &str, published_at: DateTime<Utc>) -> Evidence {
        Evidence {
            id: Uuid::new_v4(),
            source_name: "Feed".into(),
            source_tier: "T1".into(),
            title: "A release".into(),
            url: url.into(),
            is_official: true,
            published_at,
            original_published_at: Some(published_at),
            publication_precision: Some("time".into()),
            collected_at: Some(published_at),
            excerpt: String::new(),
            technical_basis: None,
            aggregation: None,
            reading_context: None,
        }
    }

    #[test]
    fn scoring_decays_and_counts_domains_not_feeds() {
        let now = DateTime::parse_from_rfc3339("2026-07-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let item = evidence("https://news.example.com/a", now);
        let fresh = score_event(std::slice::from_ref(&item), now, now);
        let old = score_event(
            std::slice::from_ref(&item),
            now,
            now + chrono::Duration::hours(48),
        );
        assert_eq!(fresh.freshness, 100.0);
        assert_eq!(old.freshness, 50.0);
        assert!(fresh.total > old.total);
        let repeated = score_event(
            &[item.clone(), evidence("https://blog.example.com/b", now)],
            now,
            now,
        );
        assert_eq!(repeated.corroboration, 0.0);
        let corroborated = score_event(&[item, evidence("https://other.org/a", now)], now, now);
        assert_eq!(corroborated.corroboration, 25.0);
        assert!(corroborated.total > fresh.total);
        assert_eq!(
            corroborated.engagement
                + corroborated.novelty
                + corroborated.relevance
                + corroborated.editorial_boost,
            0.0
        );
        assert_eq!(
            score_event(
                &[evidence(
                    "https://example.com/a",
                    now + chrono::Duration::days(7)
                )],
                now,
                now
            )
            .freshness,
            0.0
        );
        assert_eq!(score_event(&[], now, now).total, 0.0);
    }

    #[test]
    fn score_order_uses_live_publication_evidence_not_snapshot_totals() {
        let sql = score_order_sql();
        assert!(sql.contains("WHERE ee.event_id=e.id"));
        assert!(sql.contains("ci.original_url"));
        assert!(sql.contains("ci.published_at,ci.created_at"));
        assert!(sql.contains("interval '5 minutes'"));
        assert!(sql.contains("interval '90 days'"));
        assert!(sql.contains("/ 172800.0"));
        assert!(sql.contains("* 0.45"));
        assert!(sql.contains("* 0.20"));
        assert!(sql.contains("* 0.35"));
        assert!(!sql.contains("ss."));
        assert!(!sql.contains("updated_at"));
    }
}
