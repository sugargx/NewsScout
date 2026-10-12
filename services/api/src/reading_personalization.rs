use crate::{app::ApiError, auth::ReaderState, reader_account::rate_limit, scoped_db::ScopedDb};
use axum::Json;
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingPersonalization {
    pub enabled: bool,
    pub generation: Option<Uuid>,
    pub signal_count: i64,
}

fn account_db(state: &crate::app::AppState) -> Result<ScopedDb, ApiError> {
    if !state.auth.cloud() || state.identity.is_none() {
        return Err(ApiError::Forbidden);
    }
    state.reader_db()
}

async fn read_settings(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<ReadingPersonalization, sqlx::Error> {
    let row = sqlx::query(
        "SELECT p.enabled,p.generation,(SELECT count(*) FROM reader_reading_signals s
           WHERE s.user_id=p.user_id AND s.generation=p.generation
             AND s.recorded_at>=now()-interval '30 days') AS signal_count
         FROM reader_personalization p WHERE p.user_id=scoutnews_actor()",
    )
    .fetch_optional(&mut **tx)
    .await?;
    match row {
        Some(row) => Ok(ReadingPersonalization {
            enabled: row.try_get("enabled")?,
            generation: row.try_get("generation")?,
            signal_count: row.try_get("signal_count")?,
        }),
        None => Ok(ReadingPersonalization::default()),
    }
}

pub async fn settings(db: &ScopedDb) -> Result<ReadingPersonalization, ApiError> {
    let mut tx = db.begin().await.map_err(anyhow::Error::from)?;
    let value = read_settings(&mut tx).await.map_err(anyhow::Error::from)?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(value)
}

pub async fn get(
    ReaderState(state): ReaderState,
) -> Result<Json<ReadingPersonalization>, ApiError> {
    Ok(Json(settings(&account_db(&state)?).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreferenceInput {
    enabled: bool,
}

pub async fn update(
    ReaderState(state): ReaderState,
    Json(input): Json<PreferenceInput>,
) -> Result<Json<ReadingPersonalization>, ApiError> {
    let db = account_db(&state)?;
    rate_limit(&db, "reading_preference", 1, 20, 60).await?;
    let mut tx = db.begin().await.map_err(anyhow::Error::from)?;
    sqlx::query(
        "INSERT INTO reader_personalization(user_id,enabled,generation,enabled_since)
         VALUES(scoutnews_actor(),$1,$2,CASE WHEN $1 THEN now() END)
         ON CONFLICT(user_id) DO UPDATE SET enabled=$1,
           generation=CASE WHEN reader_personalization.enabled=$1
             THEN reader_personalization.generation ELSE $2 END,
           enabled_since=CASE WHEN NOT $1 THEN NULL WHEN reader_personalization.enabled
             THEN reader_personalization.enabled_since ELSE now() END,updated_at=now()",
    )
    .bind(input.enabled)
    .bind(Uuid::new_v4())
    .execute(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;
    if !input.enabled {
        sqlx::query("DELETE FROM reader_reading_signals WHERE user_id=scoutnews_actor()")
            .execute(&mut *tx)
            .await
            .map_err(anyhow::Error::from)?;
    }
    let value = read_settings(&mut tx).await.map_err(anyhow::Error::from)?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(Json(value))
}

pub async fn clear(
    ReaderState(state): ReaderState,
) -> Result<Json<ReadingPersonalization>, ApiError> {
    let db = account_db(&state)?;
    rate_limit(&db, "reading_preference", 1, 20, 60).await?;
    let mut tx = db.begin().await.map_err(anyhow::Error::from)?;
    // The row lock and new generation also invalidate already in-flight signals.
    sqlx::query(
        "UPDATE reader_personalization SET generation=$1,updated_at=now(),
           enabled_since=CASE WHEN enabled THEN now() END WHERE user_id=scoutnews_actor()",
    )
    .bind(Uuid::new_v4())
    .execute(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;
    sqlx::query("DELETE FROM reader_reading_signals WHERE user_id=scoutnews_actor()")
        .execute(&mut *tx)
        .await
        .map_err(anyhow::Error::from)?;
    let value = read_settings(&mut tx).await.map_err(anyhow::Error::from)?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(Json(value))
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum ReadingSurface {
    Radar,
    Brief,
    Reading,
    Weekly,
    Saved,
    Topics,
    Article,
}

impl ReadingSurface {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Radar => "radar",
            Self::Brief => "brief",
            Self::Reading => "reading",
            Self::Weekly => "weekly",
            Self::Saved => "saved",
            Self::Topics => "topics",
            Self::Article => "article",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadingSignalInput {
    event_id: Uuid,
    content_version: i64,
    generation: Uuid,
    active_ms: i32,
    surface: ReadingSurface,
}

pub async fn record(
    ReaderState(state): ReaderState,
    Json(input): Json<ReadingSignalInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !(20_000..=120_000).contains(&input.active_ms) || input.content_version < 0 {
        return Err(ApiError::BadRequest("Invalid reading signal".into()));
    }
    let db = account_db(&state)?;
    rate_limit(&db, "reading_signal", 1, 30, 60).await?;
    let mut tx = db.begin().await.map_err(anyhow::Error::from)?;
    let preference = sqlx::query(
        "SELECT enabled,generation FROM reader_personalization
         WHERE user_id=scoutnews_actor() FOR UPDATE",
    )
    .fetch_optional(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;
    let Some(preference) = preference else {
        return Err(ApiError::Forbidden);
    };
    if !preference
        .try_get::<bool, _>("enabled")
        .map_err(anyhow::Error::from)?
    {
        return Err(ApiError::Forbidden);
    }
    if preference
        .try_get::<Uuid, _>("generation")
        .map_err(anyhow::Error::from)?
        != input.generation
    {
        return Err(ApiError::Conflict(
            "阅读学习设置已变更，请重新载入。".into(),
        ));
    }
    let version: Option<i64> = sqlx::query_scalar(
        "SELECT content_version FROM events WHERE id=$1 AND status='published' FOR SHARE",
    )
    .bind(input.event_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;
    let version = version.ok_or(ApiError::NotFound)?;
    if version != input.content_version {
        return Err(ApiError::Conflict(
            "文章已更新，请重新读取后再记录阅读信号。".into(),
        ));
    }
    sqlx::query(
        "DELETE FROM reader_reading_signals WHERE user_id=scoutnews_actor()
         AND recorded_at<now()-interval '30 days'",
    )
    .execute(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;
    let duplicate: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT FROM reader_reading_signals
         WHERE user_id=scoutnews_actor() AND event_id=$1)",
    )
    .bind(input.event_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;
    if !duplicate {
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM reader_reading_signals WHERE user_id=scoutnews_actor()
             AND recorded_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(anyhow::Error::from)?;
        if count >= 60 {
            return Err(ApiError::RateLimited(
                "今天的阅读兴趣信号已达到上限，明天继续积累。".into(),
            ));
        }
        let inserted = sqlx::query(
            "INSERT INTO reader_reading_signals(event_id,generation,content_version,surface,active_ms,facets)
             SELECT $1,$2,$3,$4,$5,f.facets FROM reader_editorial_features(ARRAY[$1]) f
             ON CONFLICT(user_id,event_id) DO NOTHING",
        )
        .bind(input.event_id)
        .bind(input.generation)
        .bind(input.content_version)
        .bind(input.surface.as_str())
        .bind(input.active_ms)
        .execute(&mut *tx)
        .await
        .map_err(anyhow::Error::from)?;
        if inserted.rows_affected() != 1 {
            return Err(ApiError::Conflict(
                "当前材料无法记录阅读信号，请重新读取。".into(),
            ));
        }
    }
    let value = read_settings(&mut tx).await.map_err(anyhow::Error::from)?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(Json(
        serde_json::json!({"recorded":!duplicate,"settings":value}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_signal_rejects_untrusted_profile_and_time_fields() {
        let value = serde_json::json!({
            "eventId":Uuid::new_v4(),"contentVersion":1,"generation":Uuid::new_v4(),
            "activeMs":20_000,"surface":"radar"
        });
        assert!(serde_json::from_value::<ReadingSignalInput>(value.clone()).is_ok());
        for (name, field) in [
            ("userId", serde_json::json!(Uuid::new_v4())),
            ("recordedAt", serde_json::json!("2026-01-01T00:00:00Z")),
            ("facets", serde_json::json!(["injected"])),
            ("title", serde_json::json!("private")),
        ] {
            let mut invalid = value.clone();
            invalid[name] = field;
            assert!(serde_json::from_value::<ReadingSignalInput>(invalid).is_err());
        }
        let mut invalid = value;
        invalid["surface"] = serde_json::json!("arbitrary_url");
        assert!(serde_json::from_value::<ReadingSignalInput>(invalid).is_err());
    }
}
