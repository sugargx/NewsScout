use crate::{app::ApiError, auth::ReaderState, scoped_db::ScopedDb};
use axum::Json;
use serde::Deserialize;
use sqlx::Row;
use uuid::Uuid;

const EXPORT_LIMIT: usize = 20 * 1024 * 1024;

pub async fn rate_limit(
    db: &ScopedDb,
    operation: &str,
    amount: i32,
    maximum: i32,
    seconds: i32,
) -> Result<(), ApiError> {
    let count: Option<i32> = sqlx::query_scalar(
        "INSERT INTO reader_rate_limits(user_id,operation,bucket,count)
         VALUES(scoutnews_actor(),$1,to_timestamp(floor(extract(epoch FROM now())/$4)*$4),$2)
         ON CONFLICT(user_id,operation,bucket) DO UPDATE SET count=reader_rate_limits.count+$2
         WHERE reader_rate_limits.count+$2<=$3 RETURNING count",
    )
    .bind(operation)
    .bind(amount)
    .bind(maximum)
    .bind(seconds)
    .fetch_optional(db)
    .await
    .map_err(anyhow::Error::from)?;
    if count.is_none() {
        return Err(ApiError::RateLimited("Please try again later".into()));
    }
    Ok(())
}

pub fn spawn_retention(pool: sqlx::PgPool) {
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(3600));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            if sqlx::query("DELETE FROM reader_telemetry WHERE created_at<now()-interval '30 days'")
                .execute(&pool)
                .await
                .is_err()
            {
                tracing::error!("analytics retention cleanup failed");
            }
        }
    });
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Consent {
    enabled: bool,
}

pub async fn consent(
    ReaderState(state): ReaderState,
    Json(input): Json<Consent>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user_id = state.account_id();
    let db = state.reader_db()?;
    rate_limit(&db, "consent", 1, 20, 60).await?;
    let mut tx = db.begin().await.map_err(anyhow::Error::from)?;
    sqlx::query("UPDATE app_users SET telemetry_consent=$2 WHERE id=$1")
        .bind(user_id)
        .bind(input.enabled)
        .execute(&mut *tx)
        .await
        .map_err(anyhow::Error::from)?;
    if !input.enabled {
        sqlx::query("DELETE FROM reader_telemetry WHERE user_id=scoutnews_actor()")
            .execute(&mut *tx)
            .await
            .map_err(anyhow::Error::from)?;
    }
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(Json(serde_json::json!({"enabled":input.enabled})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Telemetry {
    events: Vec<AnalyticsEvent>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AnalyticsEvent {
    name: String,
    page: String,
    outcome: Option<String>,
    duration_ms: Option<f64>,
}
impl AnalyticsEvent {
    fn valid(&self) -> bool {
        ["page_view", "action"].contains(&self.name.as_str())
            && [
                "brief", "radar", "reading", "weekly", "saved", "topics", "sources", "shares",
                "share", "other",
            ]
            .contains(&self.page.as_str())
            && self
                .outcome
                .as_deref()
                .is_none_or(|v| ["success", "failure", "cancelled"].contains(&v))
            && self
                .duration_ms
                .is_none_or(|v| v.is_finite() && (0.0..=300_000.0).contains(&v))
    }
}
pub async fn telemetry(
    ReaderState(state): ReaderState,
    Json(input): Json<Telemetry>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user_id = state.account_id();
    if input.events.is_empty()
        || input.events.len() > 50
        || input.events.iter().any(|event| !event.valid())
    {
        return Err(ApiError::BadRequest("Invalid analytics event batch".into()));
    }
    let db = state.reader_db()?;
    rate_limit(&db, "telemetry", input.events.len() as i32, 120, 60).await?;
    let mut tx = db.begin().await.map_err(anyhow::Error::from)?;
    let enabled: bool =
        sqlx::query_scalar("SELECT telemetry_consent FROM app_users WHERE id=$1 FOR UPDATE")
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(anyhow::Error::from)?;
    if !enabled {
        return Err(ApiError::Forbidden);
    }
    for event in &input.events {
        sqlx::query(
            "INSERT INTO reader_telemetry(id,name,page,outcome,duration_ms) VALUES($1,$2,$3,$4,$5)",
        )
        .bind(Uuid::new_v4())
        .bind(&event.name)
        .bind(&event.page)
        .bind(&event.outcome)
        .bind(event.duration_ms.map(|v| v.round() as i32))
        .execute(&mut *tx)
        .await
        .map_err(anyhow::Error::from)?;
    }
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(Json(serde_json::json!({"accepted":input.events.len()})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportInput {}

pub async fn export(
    ReaderState(state): ReaderState,
    Json(_): Json<ExportInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user_id = state.account_id();
    let db = state.reader_db()?;
    rate_limit(&db, "export", 1, 2, 3600).await?;
    let mut tx = db.begin_snapshot().await.map_err(anyhow::Error::from)?;
    // Explicit projections intentionally exclude providers, tokens, system
    // settings, fetched article bodies, and every other reader.
    let queries = [
        ("interests", "SELECT profile AS data FROM interest_profiles WHERE user_id=scoutnews_actor()"),
        ("states", "SELECT to_jsonb(s) AS data FROM user_event_states s WHERE user_id=scoutnews_actor()"),
        ("exposures", "SELECT to_jsonb(s) AS data FROM event_exposures s WHERE user_id=scoutnews_actor()"),
        ("shares", "SELECT to_jsonb(s) AS data FROM reader_shares s WHERE owner_user_id=scoutnews_actor()"),
        ("sources", "SELECT jsonb_build_object('id',id,'name',name,'endpoint',endpoint,'adapter',adapter_type,
            'contentType',content_type,'tier',tier,'scheduleMinutes',schedule_minutes,'lifecycleStatus',lifecycle_status,
            'originalPostUrls',compliance->'originalPostUrls') AS data FROM sources WHERE owner_user_id=scoutnews_actor()"),
        ("sourceOverrides", "SELECT to_jsonb(s) AS data FROM user_source_overrides s WHERE user_id=scoutnews_actor()"),
        ("briefs", "SELECT jsonb_build_object('id',id,'date',local_date,'generatedAt',generated_at,
            'items',(SELECT jsonb_agg(jsonb_build_object('eventId',i.event_id,'rank',i.rank,'selectionReason',i.selection_reason))
                FROM daily_brief_items i WHERE i.brief_id=b.id)) AS data FROM daily_briefs b WHERE owner_user_id=scoutnews_actor()"),
    ];
    let mut total = 0_i64;
    for (_, query) in queries {
        let bytes: i64 = sqlx::query_scalar(&format!(
            "SELECT COALESCE(sum(octet_length(data::text)),0)::bigint FROM ({query}) export_rows"
        ))
        .fetch_one(&mut *tx)
        .await
        .map_err(anyhow::Error::from)?;
        total = total.saturating_add(bytes);
    }
    if total > (EXPORT_LIMIT - 65536) as i64 {
        return Err(ApiError::BadRequest(
            "Export exceeds the 20 MiB limit".into(),
        ));
    }
    let enabled: bool = sqlx::query_scalar("SELECT telemetry_consent FROM app_users WHERE id=$1")
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(anyhow::Error::from)?;
    let mut result = serde_json::json!({"schemaVersion":1,"userId":user_id,
        "displayName":state.display_name(),"telemetryConsent":enabled,"exportedAt":chrono::Utc::now()});
    for (name, query) in queries {
        let rows = sqlx::query(&format!(
            "SELECT COALESCE(jsonb_agg(data),'[]'::jsonb) AS items FROM ({query}) export_rows"
        ))
        .fetch_one(&mut *tx)
        .await
        .map_err(anyhow::Error::from)?;
        result[name] = rows.try_get("items").map_err(anyhow::Error::from)?;
    }
    tx.commit().await.map_err(anyhow::Error::from)?;
    if serde_json::to_vec(&result)
        .map_err(anyhow::Error::from)?
        .len()
        > EXPORT_LIMIT
    {
        return Err(ApiError::BadRequest(
            "Export exceeds the 20 MiB limit".into(),
        ));
    }
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn analytics_accepts_no_content_or_unknown_fields() {
        assert!(
            serde_json::from_str::<Telemetry>(
                r#"{"events":[{"name":"page_view","page":"reading","title":"private"}]}"#
            )
            .is_err()
        );
        for duration in [-1.0, 300001.0, f64::NAN, f64::INFINITY] {
            assert!(
                !AnalyticsEvent {
                    name: "page_view".into(),
                    page: "reading".into(),
                    outcome: None,
                    duration_ms: Some(duration)
                }
                .valid()
            );
        }
        assert!(
            !AnalyticsEvent {
                name: "raw_search".into(),
                page: "https://private.example".into(),
                outcome: None,
                duration_ms: None
            }
            .valid()
        );
    }
}
