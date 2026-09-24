use crate::scoped_db::ScopedDb;
use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::{env, time::Duration};
use uuid::Uuid;

use crate::app::{self, ApiError, AppState};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessingSettings {
    pub enabled: bool,
    pub model: String,
    pub daily_limit: i64,
}

pub const CLOUD_MODEL: &str = "gpt-5.6-terra";
pub const CLOUD_REASONING_EFFORT: &str = "low";

impl Default for ProcessingSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            model: "gpt-5.6-terra".into(),
            daily_limit: 20,
        }
    }
}

impl ProcessingSettings {
    pub fn validate(&self) -> Result<()> {
        if !(1..=5000).contains(&self.daily_limit) {
            bail!("每日限额须为 1–5000 的整数");
        }
        if self.model.is_empty()
            || self.model.len() > 200
            || self.model.trim() != self.model
            || self.model == "auto"
        {
            bail!("请选择精确的可用模型，不支持自动替换");
        }
        Ok(())
    }
}

#[derive(Default, Serialize)]
pub struct QueueCounts {
    pub pending: i64,
    pub running: i64,
    pub failed: i64,
    pub completed: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub used: i64,
    pub limit: i64,
    pub resets_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub event_id: Uuid,
    pub title: String,
    pub status: String,
    pub model: Option<String>,
    pub attempts: i32,
    pub last_error: Option<String>,
    pub next_attempt_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingStatus {
    pub settings: ProcessingSettings,
    pub counts: QueueCounts,
    pub usage: Usage,
    pub blocked_reason: Option<String>,
    pub feed_count: i64,
    pub ai_count: i64,
    pub jobs: Vec<JobView>,
}

#[derive(Clone)]
pub struct AutomationStore {
    pool: ScopedDb,
}

pub struct ClaimedJob {
    event_id: Uuid,
    lease_id: Uuid,
    attempts: i32,
    owner: Option<String>,
}

impl AutomationStore {
    pub fn new(pool: impl Into<ScopedDb>) -> Self {
        Self { pool: pool.into() }
    }

    pub async fn settings(&self) -> Result<ProcessingSettings> {
        let value: String =
            sqlx::query_scalar("SELECT value FROM app_settings WHERE key='summary_settings'")
                .fetch_one(&self.pool)
                .await?;
        let settings: ProcessingSettings =
            serde_json::from_str(&value).context("invalid saved summary settings")?;
        settings.validate()?;
        Ok(settings)
    }

    pub async fn save_settings(&self, settings: &ProcessingSettings) -> Result<()> {
        settings.validate()?;
        sqlx::query("INSERT INTO app_settings(key,value) VALUES('summary_settings',$1) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=now()")
            .bind(serde_json::to_string(settings)?).execute(&self.pool).await?;
        Ok(())
    }

    pub async fn usage(&self, limit: i64) -> Result<Usage> {
        let row = sqlx::query(
            "WITH attempts AS (SELECT created_at FROM admin_audits WHERE action='summarize_attempt' AND created_at>now()-interval '24 hours'),
             total AS (SELECT count(*) AS used FROM attempts)
             SELECT used,(SELECT created_at+interval '24 hours' FROM attempts ORDER BY created_at
                OFFSET GREATEST((SELECT used FROM total)-$1,0) LIMIT 1) AS resets_at FROM total")
            .bind(limit).fetch_one(&self.pool).await?;
        Ok(Usage {
            used: row.try_get("used")?,
            limit,
            resets_at: row.try_get("resets_at")?,
        })
    }

    async fn recover_expired(&self) -> Result<()> {
        sqlx::query(
            "UPDATE summary_jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,
            last_error='上次处理被中断，已回收过期任务',lease_id=NULL,lease_until=NULL,
            next_attempt_at=CASE WHEN attempts<3 THEN now() END,updated_at=now()
            WHERE status='running' AND lease_until<now()",
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn claim(&self, model: &str) -> Result<Option<ClaimedJob>> {
        let lease = Uuid::new_v4();
        let row = sqlx::query(
            "WITH recent_topics AS (
                SELECT e.primary_topic,count(*) AS finished FROM summary_jobs j JOIN events e ON e.id=j.event_id
                WHERE j.status='completed' AND j.updated_at>now()-interval '24 hours' GROUP BY e.primary_topic
             ), candidate AS (
                SELECT j.event_id FROM summary_jobs j JOIN events e ON e.id=j.event_id
                LEFT JOIN recent_topics t ON t.primary_topic=e.primary_topic
                WHERE j.status='pending' AND j.attempts<3 AND j.next_attempt_at<=now()
                  AND e.status='published' AND (e.summary_kind='feed' OR e.summary_format_version<$3)
                  AND j.format_version=$3 AND j.content_version=e.content_version
                ORDER BY CASE
                  WHEN EXISTS(SELECT 1 FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
                    WHERE ee.event_id=e.id
                    AND ci.published_at>=now()-interval '24 hours' AND ci.published_at<=now()) THEN 0
                  WHEN EXISTS(SELECT 1 FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
                    WHERE ee.event_id=e.id AND ci.published_at>=now()-interval '30 days' AND ci.published_at<=now()) THEN 1
                  WHEN EXISTS(SELECT 1 FROM user_event_states us WHERE us.event_id=e.id AND us.saved_at IS NOT NULL) THEN 2 ELSE 3 END,
                  CASE WHEN e.summary_kind='feed' THEN 0 ELSE 1 END,COALESCE(t.finished,0),
                  (SELECT max(ci.published_at) FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id WHERE ee.event_id=e.id) DESC NULLS LAST,
                  j.created_at,j.event_id
                FOR UPDATE OF j SKIP LOCKED LIMIT 1
             )
             UPDATE summary_jobs j SET status='running',attempts=j.attempts+1,model=$1,
               lease_id=$2,lease_until=now()+interval '5 minutes',next_attempt_at=NULL,updated_at=now()
             FROM candidate c WHERE j.event_id=c.event_id RETURNING j.event_id,j.attempts,
               (SELECT owner_user_id FROM events WHERE id=j.event_id) AS owner_user_id")
            .bind(model).bind(lease).bind(crate::summary::FORMAT_VERSION).fetch_optional(&self.pool).await?;
        row.map(|row| {
            Ok(ClaimedJob {
                event_id: row.try_get("event_id")?,
                attempts: row.try_get("attempts")?,
                owner: row.try_get("owner_user_id")?,
                lease_id: lease,
            })
        })
        .transpose()
    }

    async fn failed(
        &self,
        job: &ClaimedJob,
        error: &str,
        deferred: bool,
        permanent: bool,
    ) -> Result<()> {
        let retry = !permanent && (deferred || job.attempts < 3);
        let delay: i64 = if deferred {
            15
        } else {
            60 * i64::from(job.attempts)
        };
        sqlx::query(
            "UPDATE summary_jobs SET status=$3,last_error=$4,
            attempts=GREATEST(attempts-CASE WHEN $5 THEN 1 ELSE 0 END,0),
            next_attempt_at=CASE WHEN $6 THEN now()+($7*interval '1 second') END,
            lease_id=NULL,lease_until=NULL,updated_at=now() WHERE event_id=$1 AND lease_id=$2",
        )
        .bind(job.event_id)
        .bind(job.lease_id)
        .bind(if retry { "pending" } else { "failed" })
        .bind(error.chars().take(600).collect::<String>())
        .bind(deferred)
        .bind(retry)
        .bind(delay)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn retry_failed(&self) -> Result<u64> {
        Ok(sqlx::query("UPDATE summary_jobs j SET status='pending',attempts=0,last_error=NULL,
            next_attempt_at=now(),updated_at=now() FROM events e WHERE j.event_id=e.id
            AND j.status='failed' AND (e.summary_kind='feed' OR e.summary_format_version<$1) AND e.status='published'")
            .bind(crate::summary::FORMAT_VERSION).execute(&self.pool).await?.rows_affected())
    }

    async fn status(&self, state: &AppState) -> Result<ProcessingStatus> {
        let settings = self.settings().await?;
        let usage = self.usage(settings.daily_limit).await?;
        let row = sqlx::query("SELECT count(*) FILTER(WHERE status='pending') AS pending,
            count(*) FILTER(WHERE status='running') AS running,count(*) FILTER(WHERE status='failed') AS failed,
            count(*) FILTER(WHERE status='completed') AS completed FROM summary_jobs").fetch_one(&self.pool).await?;
        let totals = sqlx::query("SELECT count(*) FILTER(WHERE summary_kind='feed') AS feed,
            count(*) FILTER(WHERE summary_kind='copilot') AS ai FROM events WHERE status='published'").fetch_one(&self.pool).await?;
        let rows = sqlx::query("SELECT j.*,e.canonical_title FROM summary_jobs j JOIN events e ON e.id=j.event_id
            ORDER BY CASE j.status WHEN 'running' THEN 0 WHEN 'failed' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
            e.updated_at DESC,j.event_id LIMIT 20").fetch_all(&self.pool).await?;
        let jobs = rows
            .into_iter()
            .map(|row| -> Result<JobView> {
                Ok(JobView {
                    event_id: row.try_get("event_id")?,
                    title: row.try_get("canonical_title")?,
                    status: row.try_get("status")?,
                    model: row.try_get("model")?,
                    attempts: row.try_get("attempts")?,
                    last_error: row.try_get("last_error")?,
                    next_attempt_at: row.try_get("next_attempt_at")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let blocked_reason = blocked_reason(state, &settings, usage.used).await;
        Ok(ProcessingStatus {
            settings,
            usage,
            blocked_reason,
            jobs,
            counts: QueueCounts {
                pending: row.try_get("pending")?,
                running: row.try_get("running")?,
                failed: row.try_get("failed")?,
                completed: row.try_get("completed")?,
            },
            feed_count: totals.try_get("feed")?,
            ai_count: totals.try_get("ai")?,
        })
    }
}

pub async fn settings(state: &AppState) -> Result<ProcessingSettings> {
    match &state.automation {
        Some(store) => store.settings().await,
        None => Ok(ProcessingSettings {
            enabled: false,
            ..ProcessingSettings::default()
        }),
    }
}

pub async fn status(state: &AppState) -> Result<ProcessingStatus> {
    if let Some(store) = &state.automation {
        return store.status(state).await;
    }
    Ok(ProcessingStatus {
        settings: settings(state).await?,
        counts: QueueCounts::default(),
        usage: Usage {
            used: 0,
            limit: 20,
            resets_at: None,
        },
        blocked_reason: Some("demo".into()),
        feed_count: 0,
        ai_count: 0,
        jobs: vec![],
    })
}

fn isolation_enabled() -> bool {
    env::var("SCOUTNEWS_DISABLE_COPILOT_RESTORE")
        .is_ok_and(|value| value.eq_ignore_ascii_case("true"))
}

async fn blocked_reason(
    state: &AppState,
    settings: &ProcessingSettings,
    used: i64,
) -> Option<String> {
    let provider = state.provider.read().await;
    blocking_condition(
        isolation_enabled(),
        settings,
        provider.eligible,
        provider.models.contains(&settings.model)
            && (!state.auth.cloud() || settings.model == CLOUD_MODEL),
        used,
    )
    .map(str::to_owned)
}

fn blocking_condition(
    isolated: bool,
    settings: &ProcessingSettings,
    eligible: bool,
    model_available: bool,
    used: i64,
) -> Option<&'static str> {
    if isolated {
        Some("isolated")
    } else if !settings.enabled {
        Some("disabled")
    } else if !eligible {
        Some("account")
    } else if !model_available {
        Some("model")
    } else if used >= settings.daily_limit {
        Some("quota")
    } else {
        None
    }
}

async fn tick(state: &AppState) -> Result<()> {
    let store = state
        .automation
        .as_ref()
        .context("summary queue requires PostgreSQL")?;
    store.recover_expired().await?;
    let settings = store.settings().await?;
    let usage = store.usage(settings.daily_limit).await?;
    if blocked_reason(state, &settings, usage.used).await.is_some() {
        return Ok(());
    }
    let Some(job) = store.claim(&settings.model).await? else {
        return Ok(());
    };
    let reader = if state.auth.cloud() {
        job.owner
            .as_deref()
            .and_then(|id| Uuid::parse_str(id).ok())
            .map(|id| {
                state.for_reader(crate::auth::Identity {
                    id,
                    display_name: String::new(),
                    telemetry_consent: false,
                })
            })
    } else {
        None
    };
    if let Err(error) = app::generate_event_summary(
        reader.as_ref().unwrap_or(state),
        job.event_id,
        &settings.model,
        true,
    )
    .await
    {
        let deferred = matches!(
            error,
            ApiError::RateLimited(_) | ApiError::Configuration(_) | ApiError::Unauthorized(_)
        );
        let permanent = matches!(error, ApiError::BadRequest(_) | ApiError::NotFound);
        let message = match &error {
            ApiError::Forbidden => "Operation not permitted".into(),
            ApiError::BadRequest(value)
            | ApiError::Conflict(value)
            | ApiError::RateLimited(value)
            | ApiError::Configuration(value)
            | ApiError::Upstream(value)
            | ApiError::Unauthorized(value) => value.clone(),
            ApiError::NotFound => "事件不存在".into(),
            ApiError::Internal(_) => {
                tracing::error!(event_id=%job.event_id,"automatic summary failed");
                "摘要处理内部错误，请查看服务日志".into()
            }
        };
        store.failed(&job, &message, deferred, permanent).await?;
    }
    Ok(())
}

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_secs(8));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            if let Err(_error) = tick(&state).await {
                tracing::error!("automatic summary queue tick failed");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terra_is_default_and_budget_is_bounded() {
        let mut settings = ProcessingSettings::default();
        assert_eq!(settings.model, "gpt-5.6-terra");
        assert_eq!(settings.daily_limit, 20);
        settings.validate().unwrap();
        settings.daily_limit = 0;
        assert!(settings.validate().is_err());
        settings.daily_limit = 5000;
        settings.validate().unwrap();
        settings.daily_limit = 5001;
        assert!(settings.validate().is_err());
        settings.daily_limit = 20;
        settings.model = "auto".into();
        assert!(settings.validate().is_err());
    }

    #[test]
    fn queue_never_bypasses_isolation_account_model_or_budget() {
        let settings = ProcessingSettings::default();
        assert_eq!(
            blocking_condition(true, &settings, true, true, 0),
            Some("isolated")
        );
        assert_eq!(
            blocking_condition(false, &settings, false, true, 0),
            Some("account")
        );
        assert_eq!(
            blocking_condition(false, &settings, true, false, 0),
            Some("model")
        );
        assert_eq!(
            blocking_condition(false, &settings, true, true, 20),
            Some("quota")
        );
        assert_eq!(blocking_condition(false, &settings, true, true, 19), None);
        assert_eq!(
            blocking_condition(
                false,
                &ProcessingSettings {
                    enabled: false,
                    ..settings
                },
                true,
                true,
                0
            ),
            Some("disabled")
        );
    }
}
