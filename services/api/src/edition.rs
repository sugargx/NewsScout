use crate::scoped_db::ScopedDb;
use anyhow::{Context, Result, bail};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::time::Duration as StdDuration;

use crate::{app::AppState, models::DailyBrief, reader};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReaderSettings {
    pub mode: String,
    pub hour: u32,
    #[serde(default = "include_observing")]
    pub include_observing: bool,
    #[serde(default = "brief_limit")]
    pub brief_limit: usize,
}

fn include_observing() -> bool {
    true
}
fn brief_limit() -> usize {
    20
}

impl Default for ReaderSettings {
    fn default() -> Self {
        Self {
            mode: "daily".into(),
            hour: 6,
            include_observing: true,
            brief_limit: 20,
        }
    }
}

impl ReaderSettings {
    pub fn validate(&self) -> Result<()> {
        if !["daily", "interval"].contains(&self.mode.as_str())
            || self.hour > 23
            || !(5..=30).contains(&self.brief_limit)
        {
            bail!("采集模式须为 daily 或 interval，小时须为 0–23，精选上限须为5–30");
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct EditionStore {
    pool: ScopedDb,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MorningRun {
    pub local_date: NaiveDate,
    pub status: String,
    pub scheduled_at: DateTime<Utc>,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub source_succeeded: i32,
    pub source_failed: i32,
    pub message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderStatus {
    pub settings: ReaderSettings,
    pub time_zone: &'static str,
    pub next_collection_at: Option<DateTime<Utc>>,
    pub last_collection_at: Option<DateTime<Utc>>,
    pub latest_published_at: Option<DateTime<Utc>>,
    pub morning_run: Option<MorningRun>,
}

pub(crate) fn slot(date: NaiveDate, hour: u32) -> DateTime<Utc> {
    date.and_hms_opt(hour, 0, 0)
        .expect("validated hour")
        .and_utc()
        - Duration::hours(8)
}

/// The daily edition current at `at`: today's once today's slot has passed,
/// otherwise yesterday's. Each edition is served unchanged for 24 hours.
pub(crate) fn edition_date(settings: &ReaderSettings, at: DateTime<Utc>) -> NaiveDate {
    let today = reader::local_date(at);
    if at >= slot(today, settings.hour) {
        today
    } else {
        today.pred_opt().expect("valid current date")
    }
}

pub(crate) fn edition_refresh_at(settings: &ReaderSettings, edition: NaiveDate) -> DateTime<Utc> {
    slot(
        edition.succ_opt().expect("valid edition date"),
        settings.hour,
    )
}

/// How long readers keep the previous edition while this morning's run finishes.
pub(crate) const EDITION_GRACE_HOURS: i64 = 3;

/// Whether `now` falls inside `edition`'s grace window. Measured from the slot
/// itself so a late-evening edition hour keeps its full grace past midnight.
pub(crate) fn within_grace(
    settings: &ReaderSettings,
    edition: NaiveDate,
    now: DateTime<Utc>,
) -> bool {
    let start = slot(edition, settings.hour);
    settings.mode == "daily" && now >= start && now < start + Duration::hours(EDITION_GRACE_HOURS)
}

pub fn next_slot(
    settings: &ReaderSettings,
    configured_at: DateTime<Utc>,
    now: DateTime<Utc>,
    ran_today: bool,
) -> Option<DateTime<Utc>> {
    if settings.mode != "daily" {
        return None;
    }
    let today = reader::local_date(now);
    let scheduled = slot(today, settings.hour);
    if !ran_today && scheduled >= configured_at {
        Some(scheduled)
    } else {
        Some(slot(
            today.succ_opt().expect("valid current date"),
            settings.hour,
        ))
    }
}

fn ready_for_snapshot(
    brief: &DailyBrief,
    pending: i64,
    current_pending: i64,
    limit: usize,
) -> bool {
    let start = brief.window_end - Duration::hours(24);
    let current_ready = brief
        .items
        .iter()
        .filter(|event| {
            event
                .freshness_at
                .or(event.published_at)
                .is_some_and(|date| date >= start)
        })
        .count();
    let minimum = limit.min(12);
    brief.is_snapshot
        || current_ready >= minimum
        || (current_pending == 0 && brief.items.len() >= minimum)
        || (pending == 0 && current_pending == 0 && !brief.items.is_empty())
}

impl EditionStore {
    pub fn new(pool: impl Into<ScopedDb>) -> Self {
        Self { pool: pool.into() }
    }

    pub async fn settings(&self) -> Result<(ReaderSettings, DateTime<Utc>)> {
        let row =
            sqlx::query("SELECT value,updated_at FROM app_settings WHERE key='reader_settings'")
                .fetch_one(&self.pool)
                .await?;
        let settings: ReaderSettings = serde_json::from_str(&row.try_get::<String, _>("value")?)?;
        settings.validate()?;
        Ok((settings, row.try_get("updated_at")?))
    }

    pub async fn save_settings(&self, settings: &ReaderSettings) -> Result<()> {
        settings.validate()?;
        sqlx::query("UPDATE app_settings SET value=$1,
            updated_at=CASE WHEN value::jsonb->>'mode'<>$1::jsonb->>'mode' OR value::jsonb->>'hour'<>$1::jsonb->>'hour'
              THEN now() ELSE updated_at END WHERE key='reader_settings' AND value<>$1")
            .bind(serde_json::to_string(settings)?).execute(&self.pool).await?;
        Ok(())
    }

    async fn today(&self, date: NaiveDate) -> Result<Option<MorningRun>> {
        let row = sqlx::query(
            "SELECT * FROM morning_runs WHERE local_date=$1 AND owner_user_id=scoutnews_actor()",
        )
        .bind(date)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            Ok(MorningRun {
                local_date: row.try_get("local_date")?,
                status: row.try_get("status")?,
                scheduled_at: row.try_get("scheduled_at")?,
                started_at: row.try_get("started_at")?,
                finished_at: row.try_get("finished_at")?,
                source_succeeded: row.try_get("source_succeeded")?,
                source_failed: row.try_get("source_failed")?,
                message: row.try_get("message")?,
            })
        })
        .transpose()
    }

    pub async fn status(&self) -> Result<ReaderStatus> {
        let now = Utc::now();
        let (settings, configured) = self.settings().await?;
        let morning_run = self.today(reader::local_date(now)).await?;
        let next_collection_at = next_slot(&settings, configured, now, morning_run.is_some());
        let last_collection_at = sqlx::query_scalar(
            "SELECT max(finished_at) FROM fetch_runs WHERE status IN ('success','not_modified')",
        )
        .fetch_one(&self.pool)
        .await?;
        let latest_published_at = sqlx::query_scalar("SELECT max(published_at) FROM content_items")
            .fetch_one(&self.pool)
            .await?;
        Ok(ReaderStatus {
            settings,
            time_zone: "Asia/Shanghai",
            next_collection_at,
            last_collection_at,
            latest_published_at,
            morning_run,
        })
    }

    async fn claim(
        &self,
        date: NaiveDate,
        scheduled: DateTime<Utc>,
    ) -> Result<Option<DateTime<Utc>>> {
        Ok(sqlx::query_scalar(
            "INSERT INTO morning_runs(local_date,status,scheduled_at,lease_until,message)
            VALUES($1,'collecting',$2,now()+interval '30 minutes','正在采集每日来源')
            ON CONFLICT(owner_user_id,local_date) DO UPDATE SET lease_until=now()+interval '30 minutes',
              message='正在恢复中断的每日采集'
            WHERE morning_runs.status='collecting' AND morning_runs.lease_until<now()
            RETURNING started_at",
        )
        .bind(date)
        .bind(scheduled)
        .fetch_optional(&self.pool)
        .await?)
    }

    async fn finish_collecting(
        &self,
        date: NaiveDate,
        succeeded: i32,
        failed: i32,
        message: String,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE morning_runs SET status='summarizing',source_succeeded=$2,source_failed=$3,
            lease_until=NULL,message=$4 WHERE local_date=$1 AND owner_user_id=scoutnews_actor()",
        )
        .bind(date)
        .bind(succeeded)
        .bind(failed)
        .bind(message)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn finalize(&self, state: &AppState, date: NaiveDate) -> Result<()> {
        let Some(run) = self.today(date).await? else {
            return Ok(());
        };
        if run.finished_at.is_some() || !["summarizing", "partial"].contains(&run.status.as_str()) {
            return Ok(());
        }
        let Some(preview) = state.store.brief(date, false).await? else {
            return Ok(());
        };
        let pending = preview
            .eligibility
            .as_ref()
            .map(|value| value.awaiting_summary)
            .unwrap_or(0);
        let (settings, _) = self.settings().await?;
        let progress = sqlx::query("SELECT
            count(*) FILTER(WHERE j.status IN ('pending','running') AND EXISTS(
              SELECT 1 FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
              WHERE ee.event_id=e.id AND ci.published_at >= $2-interval '24 hours' AND ci.published_at <= $2)) AS current_pending,
            count(*) FILTER(WHERE j.status='failed') AS failed
            FROM events e JOIN summary_jobs j ON j.event_id=e.id
              JOIN reader_editorial_features(ARRAY(
                SELECT DISTINCT ee.event_id FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
                JOIN summary_jobs pending ON pending.event_id=ee.event_id
                WHERE ci.published_at BETWEEN $1 AND $2 AND pending.status IN('pending','running','failed')
              )) f ON f.id=e.id WHERE e.status='published'
               AND (f.editorial->>'briefEligible')::boolean AND f.freshness_at BETWEEN $1 AND $2
              AND (e.summary_kind<>'copilot' OR e.summary_format_version<2)
              AND EXISTS(SELECT 1 FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
                WHERE ee.event_id=e.id AND ci.published_at >= $1 AND ci.published_at <= $2)
              AND NOT EXISTS(SELECT 1 FROM user_event_states us WHERE us.event_id=e.id AND us.user_id=scoutnews_actor() AND us.not_interested_at IS NOT NULL)
              AND NOT EXISTS(SELECT 1 FROM event_evidence ae JOIN content_items ac ON ac.id=ae.content_item_id
                JOIN sources ads ON ads.id=ac.source_id WHERE ae.event_id=e.id AND ads.adapter_type='aihot_public')
              AND EXISTS(SELECT 1 FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
                JOIN sources s ON s.id=ci.source_id WHERE ee.event_id=e.id AND (s.lifecycle_status='stable'
                  OR ($3 AND s.lifecycle_status='observing' AND s.last_success_at IS NOT NULL
                      AND s.consecutive_failures=0 AND s.adapter_type<>'github_search')))")
            .bind(preview.window_start).bind(preview.window_end).bind(settings.include_observing).fetch_one(&self.pool).await?;
        let failed: i64 = progress.try_get("failed")?;
        // Old, already-processed supplements must not freeze out this morning's pending news.
        if ready_for_snapshot(
            &preview,
            (pending - failed).max(0),
            progress.try_get("current_pending")?,
            settings.brief_limit,
        ) {
            let saved = state
                .store
                .brief(date, true)
                .await?
                .context("eligible morning brief could not be saved")?;
            let partial = run.source_failed > 0 || failed > 0 || saved.items.len() < 5;
            sqlx::query("UPDATE morning_runs SET status=$2,finished_at=now(),message=$3 WHERE local_date=$1 AND owner_user_id=scoutnews_actor()")
                .bind(date).bind(if partial { "partial" } else { "ready" })
                .bind(format!("晨报已保存：{} 条；{} 个来源失败或退避，{} 条摘要失败；快照不会被后续更新覆盖",saved.items.len(),run.source_failed,failed))
                .execute(&self.pool).await?;
        } else if Utc::now() - run.started_at > Duration::minutes(60) {
            sqlx::query("UPDATE morning_runs SET status='partial',message=$2 WHERE local_date=$1 AND owner_user_id=scoutnews_actor()")
                .bind(date)
                .bind(format!(
                    "已采集，等待合格摘要：当前 {} 条，不固化空报或用原文摘录凑数",
                    preview.items.len()
                ))
                .execute(&self.pool)
                .await?;
        }
        Ok(())
    }

    async fn tick(&self, state: &AppState) -> Result<()> {
        let (settings, configured) = self.settings().await?;
        let worker = state
            .feed_worker
            .as_ref()
            .context("source scheduler requires PostgreSQL")?;
        if settings.mode == "interval" {
            worker.run_due().await?;
            return Ok(());
        }
        let now = Utc::now();
        let date = reader::local_date(now);
        let scheduled = slot(date, settings.hour);
        if now >= scheduled && scheduled >= configured {
            if let Some(started) = self.claim(date, scheduled).await? {
                let active = state
                    .store
                    .sources()
                    .await?
                    .iter()
                    .filter(|source| {
                        matches!(source.lifecycle_status.as_str(), "stable" | "observing")
                    })
                    .count();
                match worker.run_daily(started).await {
                    Ok(report) => {
                        let succeeded: i64 = sqlx::query_scalar(
                            "SELECT count(DISTINCT source_id) FROM fetch_runs
                            WHERE started_at>=$1 AND status IN ('success','not_modified')",
                        )
                        .bind(started)
                        .fetch_one(&self.pool)
                        .await?;
                        let missing = active.saturating_sub(succeeded as usize) as i32;
                        self.finish_collecting(
                            date,
                            succeeded as i32,
                            missing,
                            format!(
                                "每日采集完成，{} 个来源成功；本轮新增 {} 条，正在准备摘要",
                                succeeded, report.ingested
                            ),
                        )
                        .await?;
                    }
                    Err(error) => {
                        sqlx::query("UPDATE morning_runs SET status='failed',lease_until=NULL,finished_at=now(),message=$2 WHERE local_date=$1 AND owner_user_id=scoutnews_actor()")
                            .bind(date).bind("Daily collection failed").execute(&self.pool).await?;
                        return Err(error);
                    }
                }
            }
        }
        self.finalize(state, date).await?;
        reselect_after_rule_change(state, date).await;
        Ok(())
    }
}

/// A saved edition stays fixed, except that today's edition is re-selected once
/// when the selection rule changes. Failure keeps the saved edition and must not
/// stall collection or the other readers' editions.
async fn reselect_after_rule_change(state: &AppState, date: NaiveDate) {
    if state.store.reselect_outdated_brief(date).await.is_err() {
        tracing::warn!("edition reselection failed; the saved edition is kept");
    }
}

pub async fn status(state: &AppState) -> Result<ReaderStatus> {
    match &state.edition {
        Some(store) => store.status().await,
        None => Ok(ReaderStatus {
            settings: ReaderSettings::default(),
            time_zone: "Asia/Shanghai",
            next_collection_at: None,
            last_collection_at: None,
            latest_published_at: None,
            morning_run: None,
        }),
    }
}

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(StdDuration::from_secs(30));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            // Isolated E2E exercises collection explicitly; never run calendar jobs there.
            if std::env::var("SCOUTNEWS_DISABLE_COPILOT_RESTORE")
                .is_ok_and(|value| value.eq_ignore_ascii_case("true"))
            {
                continue;
            }
            if let Some(store) = &state.edition {
                let result = if state.auth.cloud() {
                    cloud_tick(&state).await
                } else {
                    store.tick(&state).await
                };
                if result.is_err() {
                    tracing::error!("reader schedule failed");
                }
            }
        }
    });
}

async fn cloud_tick(state: &AppState) -> Result<()> {
    state
        .edition
        .as_ref()
        .context("global edition schedule required")?
        .tick(state)
        .await?;
    let worker = state
        .feed_worker
        .as_ref()
        .context("collection worker required")?;
    worker.run_cloud_due().await?;
    archive_cloud_readers(state, Utc::now()).await
}

pub(crate) async fn archive_cloud_readers(state: &AppState, now: DateTime<Utc>) -> Result<()> {
    let pool = state
        .auth
        .pool
        .as_ref()
        .context("cloud database required")?;
    let (settings, _) = state
        .edition
        .as_ref()
        .context("edition store required")?
        .settings()
        .await?;
    let date = reader::local_date(now);
    if settings.mode != "daily" || now < slot(date, settings.hour) {
        return Ok(());
    }
    let users = sqlx::query(
        "SELECT id,display_name,telemetry_consent FROM app_users
        WHERE last_seen_at>now()-interval '30 days' AND issuer<>'local' ORDER BY id",
    )
    .fetch_all(pool)
    .await?;
    for row in users {
        let reader = state.for_reader(crate::auth::Identity {
            id: row.try_get("id")?,
            display_name: row.try_get("display_name")?,
            telemetry_consent: row.try_get("telemetry_consent")?,
        });
        let edition = reader.edition.as_ref().context("reader edition required")?;
        if edition
            .claim(date, slot(date, settings.hour))
            .await?
            .is_some()
        {
            let sources = reader.store.sources().await?;
            let active = sources
                .iter()
                .filter(|source| matches!(source.lifecycle_status.as_str(), "stable" | "observing"))
                .collect::<Vec<_>>();
            let succeeded = active
                .iter()
                .filter(|source| {
                    source.last_success_at.is_some() && source.consecutive_failures == 0
                })
                .count() as i32;
            edition
                .finish_collecting(
                    date,
                    succeeded,
                    active.len() as i32 - succeeded,
                    "Reader-specific collection complete; awaiting qualified summaries".into(),
                )
                .await?;
        }
        // Reuse the existing readiness gate and immutable snapshot contract,
        // but with this reader's recommendations, feedback and visible jobs.
        edition.finalize(&reader, date).await?;
        reselect_after_rule_change(&reader, date).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn six_am_is_shanghai_and_missed_runs_catch_up_once() {
        let settings = ReaderSettings::default();
        let configured = "2026-09-07T12:00:00Z".parse().unwrap();
        let now = "2026-09-07T13:00:00Z".parse().unwrap();
        assert_eq!(
            next_slot(&settings, configured, now, false)
                .unwrap()
                .to_rfc3339(),
            "2026-09-07T22:00:00+00:00"
        );
        let late = "2026-09-08T01:00:00Z".parse().unwrap();
        assert_eq!(
            next_slot(&settings, configured, late, false)
                .unwrap()
                .to_rfc3339(),
            "2026-09-07T22:00:00+00:00"
        );
        assert_eq!(
            next_slot(&settings, configured, late, true)
                .unwrap()
                .to_rfc3339(),
            "2026-09-08T22:00:00+00:00"
        );
    }

    #[test]
    fn editions_turn_over_at_the_shanghai_slot_and_last_24_hours() {
        let settings = ReaderSettings::default();
        let before: DateTime<Utc> = "2026-09-23T21:59:59Z".parse().unwrap();
        let at: DateTime<Utc> = "2026-09-23T22:00:00Z".parse().unwrap();
        assert_eq!(edition_date(&settings, before).to_string(), "2026-09-23");
        assert_eq!(edition_date(&settings, at).to_string(), "2026-09-24");
        assert_eq!(
            edition_refresh_at(&settings, edition_date(&settings, before)),
            at
        );
        assert_eq!(
            edition_refresh_at(&settings, edition_date(&settings, at)) - at,
            Duration::hours(24)
        );
    }

    #[tokio::test]
    async fn processed_supplements_wait_for_current_news_before_auto_publishing() {
        use crate::store::{MemoryStore, Store};
        let now = Utc::now();
        let mut events = MemoryStore::demo()
            .list_events(&Default::default())
            .await
            .unwrap();
        for event in &mut events {
            event.published_at = Some(now - Duration::days(2));
            for evidence in &mut event.evidence {
                evidence.original_published_at = event.published_at;
            }
        }
        let brief = reader::select_brief(events, now);
        assert_eq!(brief.items.len(), 3);
        assert!(!ready_for_snapshot(&brief, 10, 2, 20));
        assert!(!ready_for_snapshot(&brief, 10, 0, 20));
        assert!(ready_for_snapshot(&brief, 10, 0, 3));
        assert!(ready_for_snapshot(&brief, 0, 0, 20));
        let mut empty = brief.clone();
        empty.items.clear();
        assert!(!ready_for_snapshot(&empty, 0, 0, 20));
    }

    #[test]
    fn grace_lasts_three_hours_from_the_slot_even_across_midnight() {
        let morning = ReaderSettings::default();
        let date = NaiveDate::from_ymd_opt(2026, 9, 24).unwrap();
        let start = slot(date, 6);
        assert_eq!(start.to_rfc3339(), "2026-09-23T22:00:00+00:00");
        assert!(!within_grace(&morning, date, start - Duration::seconds(1)));
        assert!(within_grace(&morning, date, start));
        assert!(within_grace(
            &morning,
            date,
            start + Duration::hours(EDITION_GRACE_HOURS) - Duration::seconds(1)
        ));
        assert!(!within_grace(
            &morning,
            date,
            start + Duration::hours(EDITION_GRACE_HOURS)
        ));
        // Yesterday's edition is never "preparing" once today's slot has passed.
        assert!(!within_grace(&morning, date.pred_opt().unwrap(), start));

        let late = ReaderSettings {
            hour: 23,
            ..ReaderSettings::default()
        };
        let after_midnight = slot(date, 23) + Duration::hours(2);
        assert_eq!(reader::local_date(after_midnight).to_string(), "2026-09-25");
        assert_eq!(edition_date(&late, after_midnight), date);
        assert!(within_grace(&late, date, after_midnight));
        assert!(!within_grace(
            &late,
            date,
            slot(date, 23) + Duration::hours(EDITION_GRACE_HOURS)
        ));

        let interval = ReaderSettings {
            mode: "interval".into(),
            ..ReaderSettings::default()
        };
        assert!(!within_grace(&interval, date, start));
    }

    const FIXTURE_BODY: &str = "Fixture material describing a bounded platform update with measured latency and throughput results. Fixture material describing a bounded platform update with measured latency and throughput results. Fixture material describing a bounded platform update with measured latency and throughput results.";

    async fn isolated_pool() -> Result<sqlx::PgPool> {
        let connection = std::env::var("SCOUTNEWS_E2E_DATABASE_URL")?;
        let url = url::Url::parse(&connection)?;
        ensure_isolated_database(&url, url.path().trim_start_matches('/'))?;
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(4)
            .connect(&connection)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(pool)
    }

    async fn fixture_source(
        pool: &sqlx::PgPool,
        entity: &str,
        lifecycle: &str,
    ) -> Result<uuid::Uuid> {
        let (publisher, source) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        sqlx::query("INSERT INTO publishers(id,name,entity_type) VALUES($1,$2,$3)")
            .bind(publisher)
            .bind(format!("Selection fixture {publisher}"))
            .bind(entity)
            .execute(pool)
            .await?;
        sqlx::query(
            "INSERT INTO sources(id,publisher_id,name,endpoint,content_type,adapter_type,tier,lifecycle_status,last_success_at)
             VALUES($1,$2,$3,$4,'blog','rss','T1',$5,now())",
        )
        .bind(source)
        .bind(publisher)
        .bind(format!("Selection fixture {source}"))
        .bind(format!("https://selection.scoutnews.test/{source}/feed"))
        .bind(lifecycle)
        .execute(pool)
        .await?;
        Ok(source)
    }

    /// One summarised event with one evidence item per given source.
    async fn fixture_event(
        pool: &sqlx::PgPool,
        title: &str,
        topic: &str,
        published: DateTime<Utc>,
        sources: &[uuid::Uuid],
    ) -> Result<uuid::Uuid> {
        let event = uuid::Uuid::new_v4();
        sqlx::query(
            "INSERT INTO events(id,canonical_title,summary,importance,primary_topic,event_type,
                first_seen_at,updated_at,summary_kind,summary_model,summary_format_version,
                content_version,summary_points,summarized_at)
             VALUES($1,$2,$3,'Fixture importance',$4,'blog',$5,now(),'copilot','gpt-5.6-terra',3,1,$6,now())",
        )
        .bind(event)
        .bind(title)
        .bind(format!("{title}: bounded fixture summary."))
        .bind(topic)
        .bind(published)
        .bind(serde_json::json!([format!("{title}: fixture point")]))
        .execute(pool)
        .await?;
        for source in sources {
            let content = uuid::Uuid::new_v4();
            let url = format!("https://selection.scoutnews.test/{source}/{event}");
            sqlx::query(
                "INSERT INTO content_items(id,source_id,content_type,original_url,canonical_url,title,
                    content_hash,published_at,metadata)
                 VALUES($1,$2,'blog',$3,$3,$4,$5,$6,$7)",
            )
            .bind(content)
            .bind(source)
            .bind(&url)
            .bind(title)
            .bind(content.to_string())
            .bind(published)
            .bind(serde_json::json!({
                "feedSummary": FIXTURE_BODY,
                "sourceMetadata": {"datePrecision": "time"}
            }))
            .execute(pool)
            .await?;
            sqlx::query(
                "INSERT INTO event_evidence(event_id,content_item_id,is_official) VALUES($1,$2,true)",
            )
            .bind(event)
            .bind(content)
            .execute(pool)
            .await?;
        }
        Ok(event)
    }

    /// Fixtures stay referenced by saved editions, so retire them instead of deleting.
    async fn retire_fixture(
        pool: &sqlx::PgPool,
        events: &[uuid::Uuid],
        sources: &[uuid::Uuid],
    ) -> Result<()> {
        sqlx::query("UPDATE events SET status='withdrawn' WHERE id=ANY($1)")
            .bind(events)
            .execute(pool)
            .await?;
        sqlx::query("UPDATE sources SET lifecycle_status='paused' WHERE id=ANY($1)")
            .bind(sources)
            .execute(pool)
            .await?;
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires the isolated E2E database; never uses personal data or Copilot"]
    async fn daily_selection_significance_contract() -> Result<()> {
        let pool = isolated_pool().await?;
        // Exact scores pin the documented editorial-significance-v1 rubric, listed
        // from most to least significant.
        let cases: [(&str, &str, Option<&str>, i64, &str); 12] = [
            (
                "Introducing Claude Opus 5.5",
                "release",
                Some("company"),
                95,
                "first_party",
            ),
            (
                "阿里发布 Qwen 3.5",
                "news",
                Some("company"),
                80,
                "first_party",
            ),
            (
                "Changelog: API improvements",
                "release",
                Some("company"),
                70,
                "first_party",
            ),
            (
                "Anthropic launches Claude Opus 5.5",
                "news",
                Some("publication"),
                65,
                "editorial",
            ),
            (
                "Startup launches a new enterprise dashboard",
                "news",
                Some("publication"),
                55,
                "editorial",
            ),
            ("Foo 2.0", "release", Some("project"), 55, "project"),
            (
                "Jane Doe joins Anthropic as head of research",
                "news",
                Some("publication"),
                45,
                "editorial",
            ),
            ("Weekly notes", "news", None, 45, "unknown"),
            (
                "Claude Opus 5.5 feels much better at coding",
                "discussion",
                Some("community"),
                42,
                "community",
            ),
            (
                "A survey of retrieval methods",
                "research",
                Some("index"),
                35,
                "index",
            ),
            (
                "llama.cpp v1.2.3",
                "release",
                Some("project"),
                30,
                "project",
            ),
            (
                "Foo 2.1.0-beta.1",
                "release",
                Some("project"),
                30,
                "project",
            ),
        ];
        let mut previous = i64::MAX;
        let mut basis = std::collections::HashMap::new();
        for (title, kind, entity, score, role) in cases {
            let value: serde_json::Value =
                sqlx::query_scalar("SELECT news_editorial_significance($1,$2,$3)")
                    .bind(title)
                    .bind(kind)
                    .bind(entity)
                    .fetch_one(&pool)
                    .await?;
            assert_eq!(value["score"].as_i64(), Some(score), "{title}: {value}");
            assert_eq!(value["role"].as_str(), Some(role), "{title}");
            assert!(
                score <= previous,
                "{title} must not outrank an earlier case"
            );
            previous = score;
            basis.insert(
                title,
                value["basis"].as_str().unwrap_or_default().to_owned(),
            );
        }
        let first_party = &basis["Introducing Claude Opus 5.5"];
        assert!(
            first_party.contains("明确发布动作 +20") && first_party.contains("旗舰模型版本 +5")
        );
        assert!(basis["Jane Doe joins Anthropic as head of research"].contains("人事动态 -10"));
        assert!(basis["llama.cpp v1.2.3"].contains("补丁/预发布版本 -15"));
        assert!(basis["Foo 2.0"].contains("主版本 +10"));
        assert!(!basis["Claude Opus 5.5 feels much better at coding"].contains("旗舰模型版本"));

        // Independent publishers lift an event by 10 each (at most 30); one
        // publisher's copy of the same report does not.
        let now = Utc::now();
        let mut sources = Vec::new();
        for _ in 0..3 {
            sources.push(fixture_source(&pool, "publication", "stable").await?);
        }
        let title = "Anthropic launches Claude Opus 5.5";
        let corroborated = fixture_event(
            &pool,
            title,
            "模型与平台",
            now - Duration::hours(2),
            &sources,
        )
        .await?;
        let single = fixture_event(
            &pool,
            title,
            "模型与平台",
            now - Duration::hours(2),
            &sources[..1],
        )
        .await?;
        let observing = fixture_source(&pool, "company", "observing").await?;
        let unconfirmed = fixture_event(
            &pool,
            "Fixture Labs quarterly platform notes",
            "工程与开源",
            now - Duration::hours(3),
            &[observing],
        )
        .await?;
        let rows = sqlx::query(
            "SELECT id,editorial,confirmed FROM reader_editorial_features(ARRAY[$1,$2]::uuid[])",
        )
        .bind(corroborated)
        .bind(single)
        .fetch_all(&pool)
        .await?;
        let editorial = |id: uuid::Uuid| -> Result<serde_json::Value> {
            rows.iter()
                .find(|row| row.try_get::<uuid::Uuid, _>("id").ok() == Some(id))
                .context("fixture event missing from features")?
                .try_get("editorial")
                .map_err(Into::into)
        };
        let (lifted, alone) = (editorial(corroborated)?, editorial(single)?);
        assert_eq!(
            lifted["significance"].as_f64().unwrap() - alone["significance"].as_f64().unwrap(),
            20.0,
            "{lifted} / {alone}"
        );
        assert!(
            lifted["significanceBasis"]
                .as_str()
                .unwrap()
                .contains("3 家独立发布者 +20")
        );
        assert!(
            !alone["significanceBasis"]
                .as_str()
                .unwrap()
                .contains("家独立发布者")
        );

        // A reader's own confirmation of an observing source counts as confirmed
        // for that reader only (0025 contract, restored by 0030).
        let reader = uuid::Uuid::new_v4().to_string();
        let confirmed = |actor: String| {
            let pool = pool.clone();
            async move {
                let scoped = ScopedDb::from(pool).reader(&actor);
                sqlx::query_scalar::<_, bool>(
                    "SELECT confirmed FROM reader_editorial_features(ARRAY[$1]::uuid[])",
                )
                .bind(unconfirmed)
                .fetch_one(&scoped)
                .await
            }
        };
        assert!(!confirmed(reader.clone()).await?);
        sqlx::query(
            "INSERT INTO user_source_overrides(user_id,source_id,confirmed) VALUES($1,$2,true)",
        )
        .bind(&reader)
        .bind(observing)
        .execute(&pool)
        .await?;
        assert!(confirmed(reader.clone()).await?);
        assert!(!confirmed("local".into()).await?);

        sqlx::query("DELETE FROM user_source_overrides WHERE user_id=$1")
            .bind(&reader)
            .execute(&pool)
            .await?;
        sources.push(observing);
        retire_fixture(&pool, &[corroborated, single, unconfirmed], &sources).await?;
        pool.close().await;
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires the isolated E2E database; never uses personal data or Copilot"]
    async fn daily_selection_edition_contract() -> Result<()> {
        use crate::store::Store;
        let pool = isolated_pool().await?;
        let now = Utc::now();
        let mut sources = Vec::new();
        let mut events = Vec::new();
        for publisher in 0..3 {
            let source = fixture_source(&pool, "company", "stable").await?;
            sources.push(source);
            for item in 0..2 {
                let ordinal = publisher * 2 + item;
                events.push(
                    fixture_event(
                        &pool,
                        &format!("Fixture Labs quarterly platform notes {ordinal}"),
                        if item == 0 {
                            "模型与平台"
                        } else {
                            "工程与开源"
                        },
                        now - Duration::hours(1 + ordinal as i64),
                        &[source],
                    )
                    .await?,
                );
            }
        }
        let reader = uuid::Uuid::new_v4().to_string();
        let store =
            crate::postgres_store::PostgresStore::new(ScopedDb::from(pool.clone()).reader(&reader));
        let today = reader::local_date(now);
        let saved = store
            .brief(today, true)
            .await?
            .context("fixture edition was not saved")?;
        let expected: Vec<_> = saved.items.iter().map(|event| event.id).collect();
        assert!(expected.len() >= 2, "fixture must fill a real edition");
        let brief_id: uuid::Uuid = sqlx::query_scalar(
            "SELECT id FROM daily_briefs WHERE owner_user_id=$1 AND local_date=$2",
        )
        .bind(&reader)
        .bind(today)
        .fetch_one(&pool)
        .await?;
        let audits = |target: uuid::Uuid| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, i64>(
                    "SELECT count(*) FROM admin_audits WHERE action='edition_reselect' AND target_id=$1",
                )
                .bind(target.to_string())
                .fetch_one(&pool)
                .await
            }
        };
        let rule = |target: uuid::Uuid| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, String>("SELECT rule_version FROM daily_briefs WHERE id=$1")
                    .bind(target)
                    .fetch_one(&pool)
                    .await
            }
        };
        // Make today's edition look like one chosen by the previous rule.
        sqlx::query(
            "UPDATE daily_briefs SET rule_version='article-value-v1',sections='[]' WHERE id=$1",
        )
        .bind(brief_id)
        .execute(&pool)
        .await?;
        sqlx::query("DELETE FROM daily_brief_items WHERE brief_id=$1 AND rank>1")
            .bind(brief_id)
            .execute(&pool)
            .await?;
        // An outdated past edition is history and never changes.
        let past_id = uuid::Uuid::new_v4();
        sqlx::query(
            "INSERT INTO daily_briefs(id,local_date,status,generated_at,published_at,rule_version,
                window_start,window_end,sections,owner_user_id)
             SELECT $1,local_date-1,status,generated_at-interval '1 day',published_at-interval '1 day',
                rule_version,window_start-interval '1 day',window_end-interval '1 day',sections,owner_user_id
             FROM daily_briefs WHERE id=$2",
        )
        .bind(past_id)
        .bind(brief_id)
        .execute(&pool)
        .await?;
        sqlx::query(
            "INSERT INTO daily_brief_items(brief_id,event_id,rank,section,selection_reason,snapshot)
             SELECT $1,event_id,rank,section,selection_reason,snapshot FROM daily_brief_items WHERE brief_id=$2",
        )
        .bind(past_id)
        .bind(brief_id)
        .execute(&pool)
        .await?;
        assert!(
            !store
                .reselect_outdated_brief(today.pred_opt().unwrap())
                .await?
        );
        assert_eq!(rule(past_id).await?, "article-value-v1");
        assert_eq!(audits(past_id).await?, 0);

        // Today's outdated edition is re-selected once, at its original cutoff.
        assert!(store.reselect_outdated_brief(today).await?);
        let reselected = store
            .brief(today, false)
            .await?
            .context("edition missing")?;
        assert!(reselected.is_snapshot);
        assert_eq!(
            reselected
                .items
                .iter()
                .map(|event| event.id)
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(reselected.window_end, saved.window_end);
        assert!(!reselected.sections.is_empty());
        assert_eq!(rule(brief_id).await?, reader::DAILY_SELECTION_RULE);
        let (before, after): (serde_json::Value, serde_json::Value) = sqlx::query_as(
            "SELECT before_value,after_value FROM admin_audits
             WHERE action='edition_reselect' AND target_id=$1 AND actor=$2",
        )
        .bind(brief_id.to_string())
        .bind(&reader)
        .fetch_one(&pool)
        .await?;
        assert_eq!(before["ruleVersion"], "article-value-v1");
        assert_eq!(before["items"].as_array().map(Vec::len), Some(1));
        assert_eq!(after["replaced"], true);
        assert_eq!(after["ruleVersion"], reader::DAILY_SELECTION_RULE);

        // Once only: nothing happens again, even if the stored version reverts.
        assert!(!store.reselect_outdated_brief(today).await?);
        sqlx::query("UPDATE daily_briefs SET rule_version='article-value-v1' WHERE id=$1")
            .bind(brief_id)
            .execute(&pool)
            .await?;
        assert!(!store.reselect_outdated_brief(today).await?);
        assert_eq!(audits(brief_id).await?, 1);

        // Without qualified candidates the saved edition is kept and marked once.
        sqlx::query("DELETE FROM admin_audits WHERE action='edition_reselect' AND target_id=$1")
            .bind(brief_id.to_string())
            .execute(&pool)
            .await?;
        sqlx::query("UPDATE events SET status='withdrawn' WHERE id=ANY($1)")
            .bind(&events)
            .execute(&pool)
            .await?;
        assert!(!store.reselect_outdated_brief(today).await?);
        assert_eq!(audits(brief_id).await?, 1);
        assert_eq!(rule(brief_id).await?, "article-value-v1");
        let kept = store
            .brief(today, false)
            .await?
            .context("kept edition missing")?;
        assert_eq!(
            kept.items.iter().map(|event| event.id).collect::<Vec<_>>(),
            expected
        );
        assert!(!store.reselect_outdated_brief(today).await?);
        assert_eq!(audits(brief_id).await?, 1);

        // Grace window at fixed times: the previous edition is served, flagged as
        // refreshing, only while this morning's run is unfinished and within 3 h.
        let edition = NaiveDate::from_ymd_opt(2099, 3, 2).unwrap();
        let previous = edition.pred_opt().unwrap();
        sqlx::query(
            "INSERT INTO daily_briefs(id,local_date,status,generated_at,published_at,rule_version,
                window_start,window_end,sections,owner_user_id)
             SELECT $1,$2,status,generated_at,published_at,rule_version,window_start,window_end,sections,owner_user_id
             FROM daily_briefs WHERE id=$3",
        )
        .bind(uuid::Uuid::new_v4())
        .bind(previous)
        .bind(brief_id)
        .execute(&pool)
        .await?;
        sqlx::query(
            "INSERT INTO daily_brief_items(brief_id,event_id,rank,section,selection_reason,snapshot)
             SELECT b.id,i.event_id,i.rank,i.section,i.selection_reason,i.snapshot
             FROM daily_brief_items i JOIN daily_briefs b ON b.owner_user_id=$1 AND b.local_date=$2
             WHERE i.brief_id=$3",
        )
        .bind(&reader)
        .bind(previous)
        .bind(brief_id)
        .execute(&pool)
        .await?;
        let morning = slot(edition, 6);
        sqlx::query(
            "INSERT INTO morning_runs(owner_user_id,local_date,status,scheduled_at,started_at,message)
             VALUES($1,$2,'summarizing',$3,$3,'isolated grace assertion')",
        )
        .bind(&reader)
        .bind(edition)
        .bind(morning)
        .execute(&pool)
        .await?;
        let before_slot = store
            .latest_brief_at(morning - Duration::seconds(1))
            .await?;
        assert!(before_slot.is_snapshot && !before_slot.refresh_pending);
        assert_eq!(before_slot.local_date, previous.to_string());
        assert_eq!(before_slot.next_refresh_at, Some(morning));
        let preparing = store.latest_brief_at(morning + Duration::hours(1)).await?;
        assert!(preparing.is_snapshot && preparing.refresh_pending);
        assert_eq!(preparing.local_date, previous.to_string());
        let expired = store
            .latest_brief_at(morning + Duration::hours(EDITION_GRACE_HOURS))
            .await?;
        assert!(!expired.is_snapshot && !expired.refresh_pending);
        sqlx::query("UPDATE morning_runs SET status='partial',finished_at=now() WHERE owner_user_id=$1 AND local_date=$2")
            .bind(&reader)
            .bind(edition)
            .execute(&pool)
            .await?;
        let finished = store.latest_brief_at(morning + Duration::hours(1)).await?;
        assert!(!finished.is_snapshot && !finished.refresh_pending);

        // A late edition hour keeps its grace past local midnight.
        let original: String =
            sqlx::query_scalar("SELECT value FROM app_settings WHERE key='reader_settings'")
                .fetch_one(&pool)
                .await?;
        let mut late: serde_json::Value = serde_json::from_str(&original)?;
        late["hour"] = 23.into();
        sqlx::query("UPDATE app_settings SET value=$1 WHERE key='reader_settings'")
            .bind(late.to_string())
            .execute(&pool)
            .await?;
        sqlx::query("UPDATE morning_runs SET status='summarizing',finished_at=NULL WHERE owner_user_id=$1 AND local_date=$2")
            .bind(&reader)
            .bind(edition)
            .execute(&pool)
            .await?;
        let evening = slot(edition, 23);
        let after_midnight = store.latest_brief_at(evening + Duration::hours(2)).await;
        let late_expired = store
            .latest_brief_at(evening + Duration::hours(EDITION_GRACE_HOURS))
            .await;
        sqlx::query("UPDATE app_settings SET value=$1 WHERE key='reader_settings'")
            .bind(&original)
            .execute(&pool)
            .await?;
        let after_midnight = after_midnight?;
        assert!(after_midnight.is_snapshot && after_midnight.refresh_pending);
        assert_eq!(after_midnight.local_date, previous.to_string());
        let late_expired = late_expired?;
        assert!(!late_expired.is_snapshot && !late_expired.refresh_pending);

        for table in ["daily_briefs", "morning_runs"] {
            sqlx::query(&format!("DELETE FROM {table} WHERE owner_user_id=$1"))
                .bind(&reader)
                .execute(&pool)
                .await?;
        }
        sqlx::query("DELETE FROM admin_audits WHERE actor=$1")
            .bind(&reader)
            .execute(&pool)
            .await?;
        retire_fixture(&pool, &events, &sources).await?;
        pool.close().await;
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires the isolated E2E database; never uses personal data or Copilot"]
    async fn morning_database_contract() -> Result<()> {
        let connection = std::env::var("SCOUTNEWS_E2E_DATABASE_URL")?;
        let url = url::Url::parse(&connection)?;
        let name = url.path().trim_start_matches('/');
        ensure_isolated_database(&url, name)?;
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&connection)
            .await?;
        let store = EditionStore::new(pool.clone());
        let date = NaiveDate::from_ymd_opt(2099, 1, 1).unwrap();
        let scheduled = slot(date, 6);
        let first = store
            .claim(date, scheduled)
            .await?
            .context("first claim missing")?;
        assert!(store.claim(date, scheduled).await?.is_none());
        sqlx::query(
            "UPDATE morning_runs SET lease_until=now()-interval '1 minute' WHERE local_date=$1",
        )
        .bind(date)
        .execute(&pool)
        .await?;
        assert_eq!(store.claim(date, scheduled).await?, Some(first));
        store
            .finish_collecting(date, 4, 0, "isolated schedule assertion".into())
            .await?;
        assert!(store.claim(date, scheduled).await?.is_none());
        assert_eq!(store.today(date).await?.unwrap().source_succeeded, 4);
        sqlx::query("DELETE FROM morning_runs WHERE local_date=$1")
            .bind(date)
            .execute(&pool)
            .await?;
        let today = reader::local_date(Utc::now());
        store
            .claim(today, slot(today, 6))
            .await?
            .context("isolated current-day claim missing")?;
        store
            .finish_collecting(today, 4, 0, "isolated finalizer assertion".into())
            .await?;
        sqlx::query(
            "UPDATE morning_runs SET started_at=now()-interval '2 hours' WHERE local_date=$1",
        )
        .bind(today)
        .execute(&pool)
        .await?;
        let state = AppState {
            auth: std::sync::Arc::new(crate::auth::Auth::default()),
            identity: None,
            store: std::sync::Arc::new(crate::postgres_store::PostgresStore::new(pool.clone())),
            http: reqwest::Client::new(),
            oauth_states: Default::default(),
            provider: Default::default(),
            feed_worker: None,
            generation_lock: Default::default(),
            automation: None,
            edition: Some(store.clone()),
            publishing: None,
        };
        store.finalize(&state, today).await?;
        let waiting = store.today(today).await?.unwrap();
        assert_eq!(waiting.status, "partial");
        assert!(waiting.finished_at.is_none());
        sqlx::query("DELETE FROM morning_runs WHERE local_date=$1")
            .bind(today)
            .execute(&pool)
            .await?;
        pool.close().await;
        Ok(())
    }

    fn ensure_isolated_database(url: &url::Url, name: &str) -> Result<()> {
        let suffix = name.strip_prefix("scoutnews_e2e_").unwrap_or("");
        if !matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
            || suffix.len() != 32
            || !suffix.chars().all(|value| value.is_ascii_hexdigit())
        {
            bail!("refusing a non-E2E database");
        }
        Ok(())
    }
}
