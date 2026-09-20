use anyhow::{Context, Result, bail, ensure};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use std::{collections::BTreeSet, env, path::PathBuf, process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command};

use crate::{
    processing::{canonical_url, is_public_ip, validate_public_https},
    reading_context::ReadingContext,
};

pub fn configured_for(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    env::var("SCOUTNEWS_BROWSER_ARTICLE_HOSTS")
        .ok()
        .is_some_and(|hosts| {
            hosts
                .split(',')
                .any(|entry| entry.trim().eq_ignore_ascii_case(host))
        })
}

pub fn retry_key(browser: bool) -> &'static str {
    if browser {
        "browserRetryAfter"
    } else {
        "enrichmentRetryAfter"
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct BrowserCaptureError {
    pub message: String,
    pub retry_at: DateTime<Utc>,
    pub source_backoff: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureResponse {
    ok: bool,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    truncated: Option<bool>,
    #[serde(default)]
    source_url: Option<String>,
    #[serde(default)]
    captured_at: Option<DateTime<Utc>>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    status: Option<u16>,
    #[serde(default)]
    retry_after: Option<String>,
}

fn normalize_title(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn article_identity(value: &str) -> Result<String> {
    let mut url = url::Url::parse(&canonical_url(value)?)?;
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(if path.is_empty() { "/" } else { &path });
    Ok(url.into())
}

fn decode_response(bytes: &[u8], requested: &str, title: &str) -> Result<ReadingContext> {
    ensure!(
        bytes.len() <= 128 * 1024,
        "browser response exceeds its size bound"
    );
    let response: CaptureResponse =
        serde_json::from_slice(bytes).context("invalid browser capture response")?;
    if !response.ok {
        let now = Utc::now();
        let delay = if matches!(response.status, Some(401 | 403 | 429)) {
            chrono::Duration::hours(6)
        } else {
            chrono::Duration::minutes(30)
        };
        let retry_at = response
            .retry_after
            .as_deref()
            .and_then(|value| {
                value
                    .parse::<i64>()
                    .ok()
                    .and_then(chrono::Duration::try_seconds)
                    .and_then(|duration| now.checked_add_signed(duration))
                    .or_else(|| {
                        DateTime::parse_from_rfc2822(value)
                            .ok()
                            .map(|date| date.with_timezone(&Utc))
                    })
            })
            .unwrap_or(now + delay)
            .max(now + chrono::Duration::minutes(1));
        return Err(BrowserCaptureError {
            message: format!(
                "{}: {}",
                response.code.as_deref().unwrap_or("browser_capture_failed"),
                response
                    .message
                    .as_deref()
                    .unwrap_or("Original publisher browser capture failed.")
            ),
            retry_at,
            source_backoff: response.status == Some(429) || response.retry_after.is_some(),
        }
        .into());
    }
    ensure!(
        response.method.as_deref() == Some("browser"),
        "invalid article acquisition provenance"
    );
    let source = response
        .source_url
        .context("browser capture is missing its source URL")?;
    validate_public_https(&source)?;
    ensure!(
        article_identity(&source)? == article_identity(requested)?,
        "browser returned a different article"
    );
    ensure!(
        normalize_title(
            response
                .title
                .as_deref()
                .context("browser capture is missing its title")?
        ) == normalize_title(title),
        "browser returned a different article title"
    );
    let body = response
        .body
        .context("browser capture is missing its article text")?;
    ensure!(
        (240..=16000).contains(&body.chars().count()),
        "browser article text is outside its bounds"
    );
    let captured = response
        .captured_at
        .context("browser capture is missing its time")?;
    ensure!(
        captured <= Utc::now() + chrono::Duration::minutes(1)
            && captured >= Utc::now() - chrono::Duration::minutes(5),
        "browser capture has a stale or future timestamp"
    );
    Ok(ReadingContext::publisher_page(
        canonical_url(requested)?,
        body,
        response
            .truncated
            .context("browser capture is missing truncation status")?,
        captured,
    ))
}

pub async fn capture(value: &str, title: &str) -> Result<ReadingContext> {
    ensure!(
        configured_for(value),
        "browser acquisition is not enabled for this publisher"
    );
    validate_public_https(value)?;
    let url = url::Url::parse(value)?;
    let host = url.host_str().context("missing publisher hostname")?;
    let addresses: BTreeSet<_> =
        tokio::time::timeout(Duration::from_secs(8), tokio::net::lookup_host((host, 443)))
            .await
            .context("publisher DNS lookup timed out")??
            .map(|address| address.ip())
            .collect();
    ensure!(
        !addresses.is_empty() && addresses.iter().all(|address| is_public_ip(*address)),
        "publisher DNS must resolve only to public addresses"
    );
    let address = addresses
        .iter()
        .find(|address| address.is_ipv4())
        .or_else(|| addresses.first())
        .context("missing publisher DNS address")?;
    let script = PathBuf::from(
        env::var("SCOUTNEWS_BROWSER_CAPTURE_SCRIPT")
            .context("browser capture script is not configured")?,
    );
    ensure!(
        script.is_absolute() && script.is_file(),
        "browser capture script must be an existing absolute path"
    );
    let node =
        env::var("SCOUTNEWS_BROWSER_NODE").context("browser Node runtime is not configured")?;
    ensure!(
        PathBuf::from(&node).is_absolute(),
        "browser Node runtime must be an absolute path"
    );
    let input = serde_json::json!({"url":value,"title":title,"address":address.to_string(),
        "headless":env::var("SCOUTNEWS_BROWSER_HEADLESS").is_ok_and(|value|value=="true")});
    let mut command = Command::new(node);
    command
        .arg(script)
        .env_clear()
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for key in [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "LOCALAPPDATA",
        "APPDATA",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "ProgramFiles",
        "ProgramFiles(x86)",
    ] {
        if let Some(value) = env::var_os(key) {
            command.env(key, value);
        }
    }
    let mut child = command
        .spawn()
        .context("could not launch the publisher browser")?;
    let mut stdin = child.stdin.take().context("browser input is unavailable")?;
    stdin.write_all(&serde_json::to_vec(&input)?).await?;
    stdin.shutdown().await?;
    drop(stdin);
    let output = tokio::time::timeout(Duration::from_secs(65), child.wait_with_output())
        .await
        .context("browser capture timed out")??;
    if output.stdout.is_empty() {
        bail!(
            "browser capture exited without a result (status {})",
            output.status
        );
    }
    let result = decode_response(&output.stdout, value, title)?;
    ensure!(
        output.status.success(),
        "browser capture process did not finish successfully"
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn response() -> serde_json::Value {
        serde_json::json!({"ok":true,"title":"Example article","body":"Original text. ".repeat(30),
            "truncated":false,"sourceUrl":"https://example.com/article/","capturedAt":Utc::now(),"method":"browser"})
    }
    #[test]
    fn browser_capture_requires_exact_identity_bounded_text_and_provenance() {
        let raw = response();
        let context = decode_response(
            &serde_json::to_vec(&raw).unwrap(),
            "https://example.com/article",
            "Example article",
        )
        .unwrap();
        assert_eq!(context.source_url, "https://example.com/article");
        for (field, value) in [
            ("sourceUrl", serde_json::json!("https://example.com/other")),
            ("title", serde_json::json!("Other article")),
            ("body", serde_json::json!("x".repeat(16001))),
            ("method", serde_json::json!("model_generated")),
            (
                "capturedAt",
                serde_json::json!(Utc::now() - chrono::Duration::hours(1)),
            ),
        ] {
            let mut invalid = raw.clone();
            invalid[field] = value;
            assert!(
                decode_response(
                    &serde_json::to_vec(&invalid).unwrap(),
                    "https://example.com/article",
                    "Example article"
                )
                .is_err()
            );
        }
    }
    #[test]
    fn browser_denial_is_an_explicit_backoff_not_feed_success() {
        let error = decode_response(
            br#"{"ok":false,"status":403,"code":"http_error","message":"Forbidden"}"#,
            "https://example.com/article",
            "Example article",
        )
        .unwrap_err();
        assert!(
            error
                .downcast_ref::<BrowserCaptureError>()
                .unwrap()
                .retry_at
                > Utc::now() + chrono::Duration::hours(5)
        );
        assert!(
            !error
                .downcast_ref::<BrowserCaptureError>()
                .unwrap()
                .source_backoff
        );
        let limited = decode_response(
            br#"{"ok":false,"status":429,"message":"Limited","retryAfter":"1800"}"#,
            "https://example.com/article",
            "Example article",
        )
        .unwrap_err();
        assert!(
            limited
                .downcast_ref::<BrowserCaptureError>()
                .unwrap()
                .source_backoff
        );
    }
}
