use crate::{
    app::{ApiError, AppState},
    auth::{Identity, ReaderState},
    ingestion::IngestionReport,
    reader_account::rate_limit,
};
use axum::{Json, extract::Path};
use sqlx::Row;
use uuid::Uuid;

pub async fn submit(state: &AppState, source: Option<Uuid>) -> Result<serde_json::Value, ApiError> {
    submit_kind(state, source, None).await
}

pub async fn submit_context(state: &AppState, event: Uuid) -> Result<serde_json::Value, ApiError> {
    if state.store.get_event(event).await?.is_none() {
        return Err(ApiError::NotFound);
    }
    submit_kind(state, None, Some(event)).await
}

async fn submit_kind(
    state: &AppState,
    source: Option<Uuid>,
    event: Option<Uuid>,
) -> Result<serde_json::Value, ApiError> {
    let db = state.reader_db()?;
    if state.identity.is_none() {
        return Err(ApiError::Forbidden);
    }
    let source = if let Some(id) = source {
        let selected = state
            .store
            .sources()
            .await?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or(ApiError::NotFound)?;
        if selected.adapter == "x_public_preview" {
            Some(
                state
                    .feed_worker
                    .as_ref()
                    .ok_or(ApiError::NotFound)?
                    .x_registry_source(id)
                    .await?,
            )
        } else {
            Some(id)
        }
    } else {
        None
    };
    rate_limit(&db, "ingestion", 1, 6, 3600).await?;
    let mut tx = db.begin().await.map_err(anyhow::Error::from)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('ingestion:'||scoutnews_actor()))")
        .execute(&mut *tx)
        .await
        .map_err(anyhow::Error::from)?;
    if let Some(id)=sqlx::query_scalar::<_,Uuid>("SELECT id FROM ingestion_runs WHERE user_id=scoutnews_actor() AND status IN('pending','running')")
        .fetch_optional(&mut *tx).await.map_err(anyhow::Error::from)? {
        tx.commit().await.map_err(anyhow::Error::from)?;
        return Ok(serde_json::json!({"jobId":id,"status":"pending","duplicate":true}));
    }
    let ids:Vec<Uuid>=sqlx::query_scalar("SELECT s.id FROM sources s
        WHERE ($1::uuid IS NULL OR s.id=$1) AND scoutnews_source_enabled(s.id)
          AND scoutnews_source_status(s.id,s.lifecycle_status) IN('stable','observing')
          AND s.adapter_type=ANY($2)
          AND ($3::uuid IS NULL OR EXISTS(SELECT FROM event_evidence ee
            JOIN content_items ci ON ci.id=ee.content_item_id WHERE ee.event_id=$3 AND ci.source_id=s.id))
        ORDER BY s.last_success_at ASC NULLS FIRST,s.id LIMIT 100")
        .bind(source).bind(crate::ingestion::supported_adapters()).bind(event)
        .fetch_all(&mut *tx).await.map_err(anyhow::Error::from)?;
    if ids.is_empty() {
        return Err(ApiError::Conflict(
            "No enabled sources available for collection".into(),
        ));
    }
    let mut accepted = Vec::new();
    for id in ids {
        let claimed:Option<Uuid>=sqlx::query_scalar("INSERT INTO ingestion_source_claims(source_id,last_submitted_at)
            VALUES($1,now()) ON CONFLICT(source_id) DO UPDATE SET last_submitted_at=now()
            WHERE ingestion_source_claims.last_submitted_at<now()-interval '2 minutes' RETURNING source_id")
            .bind(id).fetch_optional(&mut *tx).await.map_err(anyhow::Error::from)?;
        if let Some(id) = claimed {
            accepted.push(id);
        }
    }
    if accepted.is_empty() {
        return Err(ApiError::RateLimited(
            "Sources were recently submitted; wait before retrying".into(),
        ));
    }
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO ingestion_runs(id,source_ids,status,event_id) VALUES($1,$2,'pending',$3)",
    )
    .bind(id)
    .bind(&accepted)
    .bind(event)
    .execute(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(serde_json::json!({"jobId":id,"status":"pending","total":accepted.len(),"completed":0}))
}

pub async fn status(
    ReaderState(state): ReaderState,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let db = state.reader_db()?;
    let value: Option<serde_json::Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('jobId',id,'status',status,
        'total',cardinality(source_ids),'completed',completed,'result',result,'error',error_code,
        'createdAt',created_at,'startedAt',started_at,'finishedAt',finished_at)
        FROM ingestion_runs WHERE id=$1 AND user_id=scoutnews_actor()",
    )
    .bind(id)
    .fetch_optional(&db)
    .await
    .map_err(anyhow::Error::from)?;
    Ok(Json(value.ok_or(ApiError::NotFound)?))
}

pub async fn recover(state: &AppState) -> anyhow::Result<()> {
    let pool = state
        .auth
        .pool
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("database required"))?;
    sqlx::query("UPDATE ingestion_runs SET status='failed',error_code='worker_interrupted',
        finished_at=now(),lease_id=NULL,lease_until=NULL WHERE status='running' AND lease_until<now()")
        .execute(pool).await?;
    sqlx::query("DELETE FROM reader_telemetry WHERE created_at<now()-interval '30 days'")
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM reader_rate_limits WHERE bucket<now()-interval '2 days'")
        .execute(pool)
        .await?;
    Ok(())
}

pub(crate) async fn tick(state: &AppState) -> anyhow::Result<()> {
    recover(state).await?;
    let pool = state
        .auth
        .pool
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("database required"))?;
    let lease = Uuid::new_v4();
    let row=sqlx::query("WITH candidate AS(SELECT id FROM ingestion_runs WHERE status='pending'
        ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE ingestion_runs r SET status='running',started_at=now(),lease_id=$1,lease_until=now()+interval '10 minutes'
        FROM candidate c WHERE r.id=c.id RETURNING r.id,r.user_id,r.source_ids,r.event_id")
        .bind(lease).fetch_optional(pool).await?;
    let Some(row) = row else { return Ok(()) };
    let id: Uuid = row.try_get("id")?;
    let actor: String = row.try_get("user_id")?;
    let ids: Vec<Uuid> = row.try_get("source_ids")?;
    let event: Option<Uuid> = row.try_get("event_id")?;
    let owner = state.for_reader(Identity {
        id: Uuid::parse_str(&actor)?,
        display_name: String::new(),
        telemetry_consent: false,
    });
    let db = owner
        .reader_db()
        .map_err(|_| anyhow::anyhow!("database unavailable"))?;
    let worker = state
        .feed_worker
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("worker unavailable"))?;
    let mut report = IngestionReport::default();
    for (index, source) in ids.iter().enumerate() {
        sqlx::query("UPDATE ingestion_runs SET lease_until=now()+interval '10 minutes' WHERE id=$1 AND lease_id=$2 AND status='running'")
            .bind(id).bind(lease).execute(pool).await?;
        let visible: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT FROM sources WHERE id=$1 AND scoutnews_source_enabled(id))",
        )
        .bind(source)
        .fetch_one(&db)
        .await?;
        let result = if !visible {
            Err(anyhow::anyhow!("source no longer available"))
        } else if let Some(event) = event {
            if owner.store.get_event(event).await?.is_none() {
                Err(anyhow::anyhow!("event no longer available"))
            } else {
                let visible_sources: Vec<Uuid> = sqlx::query_scalar(
                    "SELECT id FROM sources WHERE id=ANY($1) AND scoutnews_source_enabled(id)",
                )
                .bind(&ids)
                .fetch_all(&db)
                .await?;
                tokio::time::timeout(
                    std::time::Duration::from_secs(480),
                    worker.run_event_context_backfill_for_sources(event, Some(&visible_sources)),
                )
                .await
                .unwrap_or_else(|_| Err(anyhow::anyhow!("collection timeout")))
            }
        } else {
            tokio::time::timeout(
                std::time::Duration::from_secs(480),
                worker.run_authorized_source(*source, &actor),
            )
            .await
            .unwrap_or_else(|_| Err(anyhow::anyhow!("collection timeout")))
        };
        match result {
            Ok(part) => {
                report.attempted += part.attempted;
                report.succeeded += part.succeeded;
                report.failed += part.failed;
                report.ingested += part.ingested;
                report.updated += part.updated;
            }
            Err(_) => {
                report.attempted += 1;
                report.failed += 1;
            }
        }
        sqlx::query("UPDATE ingestion_runs SET completed=$3,result=$4 WHERE id=$1 AND lease_id=$2 AND status='running'")
            .bind(id).bind(lease).bind(if event.is_some(){ids.len()}else{index+1} as i32)
            .bind(serde_json::to_value(&report)?).execute(pool).await?;
        if event.is_some() {
            break;
        }
    }
    sqlx::query("UPDATE ingestion_runs SET status=$3,finished_at=now(),lease_id=NULL,lease_until=NULL,
        error_code=CASE WHEN $3='failed' THEN 'collection_failed' END WHERE id=$1 AND lease_id=$2 AND status='running'")
        .bind(id).bind(lease).bind(if report.failed>0 && report.succeeded==0 {"failed"}else{"succeeded"})
        .execute(pool).await?;
    Ok(())
}

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(2));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            if tick(&state).await.is_err() {
                tracing::error!("durable ingestion worker failed");
            }
        }
    });
}
