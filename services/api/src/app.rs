use std::{collections::HashMap, env, sync::Arc};

use crate::auth::ReaderState as State;
use axum::{
    Json, Router,
    extract::{Path, Query},
    http::{HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Redirect},
    routing::{delete, get, post, put},
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tower_http::cors::{Any, CorsLayer};
use uuid::Uuid;

use crate::{
    automation::{self, AutomationStore, ProcessingSettings},
    edition::{self, EditionStore, ReaderSettings},
    ingestion::FeedWorker,
    models::{
        Event, EventQuery, EventStateInput, InterestInput, ProviderStatus, SourceInput,
        SourceUpdate, SummarizeInput, VisitorQuery,
    },
    reader,
    store::Store,
    summary,
};

#[derive(Clone)]
pub struct AppState {
    pub auth: Arc<crate::auth::Auth>,
    pub identity: Option<crate::auth::Identity>,
    pub store: Arc<dyn Store>,
    pub http: Client,
    pub oauth_states: Arc<tokio::sync::Mutex<HashMap<String, std::time::Instant>>>,
    pub provider: Arc<tokio::sync::RwLock<ProviderConnection>>,
    pub feed_worker: Option<FeedWorker>,
    pub generation_lock: Arc<tokio::sync::Mutex<()>>,
    pub automation: Option<AutomationStore>,
    pub edition: Option<EditionStore>,
    pub publishing: Option<crate::publishing::Publishing>,
}

#[derive(Default)]
pub struct ProviderConnection {
    pub eligible: bool,
    pub models: Vec<String>,
    pub verified_at: Option<chrono::DateTime<chrono::Utc>>,
    pub auth_mode: Option<CopilotAuthMode>,
    pub account_login: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CopilotAuthMode {
    Local,
    Oauth,
}

impl CopilotAuthMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Oauth => "oauth",
        }
    }
}

fn select_default_model(models: &[String], preferred: &str) -> Option<String> {
    models
        .iter()
        .find(|model| model.as_str() == preferred)
        .cloned()
}

pub fn router(state: AppState) -> Router {
    let mut origins = if state.auth.cloud() {
        vec![]
    } else {
        vec![
            HeaderValue::from_static("http://localhost:5173"),
            HeaderValue::from_static("http://127.0.0.1:5173"),
        ]
    };
    if let Some(origin) = state
        .auth
        .origin()
        .map(str::to_owned)
        .or_else(|| env::var("WEB_ORIGIN").ok())
    {
        match HeaderValue::from_str(&origin) {
            Ok(origin) => origins.push(origin),
            Err(error) => tracing::error!(?error, "WEB_ORIGIN is not a valid HTTP origin"),
        }
    }
    let allowed_origins = origins.clone();
    Router::new()
        .route("/health", get(health))
        .route("/api/v1/session", get(crate::auth::session))
        .route(
            "/api/v1/me/telemetry-consent",
            put(crate::reader_account::consent),
        )
        .route("/api/v1/telemetry", post(crate::reader_account::telemetry))
        .route("/api/v1/me/export", post(crate::reader_account::export))
        .route(
            "/api/v1/ingestion-runs/{id}",
            get(crate::ingestion_jobs::status),
        )
        .route(
            "/api/v1/public/shares/{id}",
            get(crate::publishing::cloud_public_share),
        )
        .route("/api/v1/runtime", get(runtime))
        .route("/api/v1/events", get(list_events))
        .route("/api/v1/events/exposures", post(record_exposures))
        .route("/api/v1/explore", get(explore_topics))
        .route("/api/v1/events/{id}", get(get_event))
        .route("/api/v1/events/{id}/state", put(update_event_state))
        .route("/api/v1/events/{id}/summarize", post(summarize_event))
        .route(
            "/api/v1/events/{id}/reading-context",
            post(enrich_event_context),
        )
        .route("/api/v1/briefs/today", get(today_brief))
        .route("/api/v1/briefs/latest", get(latest_brief))
        .route("/api/v1/briefs/today/generate", post(save_today_brief))
        .route("/api/v1/briefs/{date}", get(dated_brief))
        .route("/api/v1/briefs", get(brief_history))
        .route("/api/v1/topics", get(topics))
        .route("/api/v1/me/interests", get(topics).put(replace_topics))
        .route("/api/v1/sources", get(sources).post(create_source))
        .route("/api/v1/sources/coverage", get(source_coverage))
        .route(
            "/api/v1/source-watchlist",
            get(crate::publishing::watchlist),
        )
        .route("/api/v1/weekly", get(crate::publishing::weekly))
        .route(
            "/api/v1/share-settings",
            get(crate::publishing::get_settings).put(crate::publishing::save_settings),
        )
        .route(
            "/api/v1/shares",
            get(crate::publishing::drafts).post(crate::publishing::create),
        )
        .route(
            "/api/v1/shares/{id}",
            get(crate::publishing::read_share).delete(crate::publishing::revoke),
        )
        .route(
            "/api/v1/shares/{id}/publish",
            post(crate::publishing::publish),
        )
        .route(
            "/api/v1/shares/{id}/draft",
            axum::routing::put(crate::publishing::save_editor),
        )
        .route("/api/v1/sources/{id}", put(update_source))
        .route("/api/v1/sources/{id}/refresh", post(refresh_source))
        .route(
            "/api/v1/sources/{id}/x-posts",
            get(x_post_urls).put(save_x_post_urls),
        )
        .route("/api/v1/model-providers", get(model_providers))
        .route("/api/v1/processing", get(processing_status))
        .route("/api/v1/processing/settings", put(processing_settings))
        .route("/api/v1/processing/retry", post(retry_summaries))
        .route("/api/v1/reader-status", get(reader_status))
        .route("/api/v1/reader-settings", put(reader_settings))
        .route(
            "/api/v1/model-providers/github-copilot/local",
            post(copilot_connect_local),
        )
        .route(
            "/api/v1/model-providers/github-copilot/probe",
            post(copilot_probe),
        )
        .route(
            "/api/v1/model-providers/github-copilot",
            delete(copilot_disconnect),
        )
        .route("/api/v1/auth/github/start", get(github_start))
        .route("/api/v1/auth/github/callback", get(github_callback))
        .route("/api/v1/admin/ingestion/run", post(run_ingestion))
        .layer(
            CorsLayer::new()
                .allow_origin(origins)
                .allow_headers(Any)
                .allow_methods(Any),
        )
        .layer(middleware::from_fn(
            move |request: axum::extract::Request, next: Next| {
                let allowed = allowed_origins.clone();
                async move {
                    if request
                        .headers()
                        .get("origin")
                        .is_some_and(|origin| !allowed.contains(origin))
                    {
                        return (
                            StatusCode::FORBIDDEN,
                            Json(serde_json::json!({"error":"不允许的请求来源"})),
                        )
                            .into_response();
                    }
                    next.run(request).await
                }
            },
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            crate::auth::middleware,
        ))
        .layer(axum::extract::DefaultBodyLimit::max(256 * 1024))
        .with_state(state)
}

async fn runtime(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(
        serde_json::json!({"mode":if state.feed_worker.is_some() {"postgres"} else {"demo"},
        "timeZone":"Asia/Shanghai","version":"0.2.0"}),
    )
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({"status":"ok","service":"scoutnews-api"}))
}

async fn list_events(
    State(state): State<AppState>,
    Query(query): Query<EventQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if query.limit.is_some_and(|v| !(1..=100).contains(&v))
        || query.offset.is_some_and(|v| !(0..=100_000).contains(&v))
        || query.q.as_ref().is_some_and(|q| q.chars().count() > 200)
        || query
            .sort
            .as_deref()
            .is_some_and(|v| !["score", "newest", "recommended"].contains(&v))
        || query.hours.is_some_and(|hours| !(0..=720).contains(&hours))
        || query
            .facet
            .as_ref()
            .is_some_and(|facet| facet.chars().count() > 80)
        || query
            .as_of
            .is_some_and(|date| date > chrono::Utc::now() + chrono::Duration::minutes(5))
        || query
            .tier
            .as_deref()
            .is_some_and(|tier| !["T1", "T1.5", "T2"].contains(&tier))
        || query.kind.as_deref().is_some_and(|kind| {
            ![
                "blog",
                "release",
                "podcast",
                "paper",
                "model",
                "repository",
                "news",
                "research",
                "analysis",
                "tutorial",
                "discussion",
                "question",
                "promotion",
                "metadata",
            ]
            .contains(&kind)
        })
    {
        return Err(ApiError::BadRequest(
            "筛选参数无效：limit为1–100，hours为0–720，sort为recommended、score或newest".into(),
        ));
    }
    let items = state.store.list_events(&query).await?;
    let next_offset = (items.len() as i64 == query.limit.unwrap_or(50))
        .then_some(query.offset.unwrap_or(0) + items.len() as i64);
    let event_count: usize = items
        .iter()
        .map(|event| {
            event
                .coverage
                .as_ref()
                .map_or(1, |bundle| bundle.members.len())
        })
        .sum();
    let material_count: usize = items
        .iter()
        .map(|event| {
            event
                .coverage
                .as_ref()
                .map_or(event.evidence.len(), |bundle| bundle.material_count)
        })
        .sum();
    let mut response = serde_json::json!({"items":items,"nextOffset":next_offset,"returnedEventCount":event_count,
        "returnedMaterialCount":material_count,"grouping":if query.coverage.unwrap_or(false) {"proven-event-v1"} else {"events"}});
    if query.interests.is_some() {
        response["readerProfileApplied"] = true.into();
    }
    Ok(Json(response))
}

async fn get_event(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(query): Query<VisitorQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if query.as_of.is_some() {
        return Err(ApiError::BadRequest("单篇文章读取不接受时间参数。".into()));
    }
    let personalized = query.interests.is_some();
    let event = if let Some(interests) = query.interests {
        state.store.visitor_event(id, &interests).await?
    } else {
        state.store.get_event(id).await?
    };
    event
        .map(|event| {
            let mut response = serde_json::json!(event);
            if personalized {
                response["readerProfileApplied"] = true.into();
            }
            Json(response)
        })
        .ok_or(ApiError::NotFound)
}

async fn update_event_state(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(input): Json<EventStateInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if input.saved.is_none()
        && input.read.is_none()
        && input.later.is_none()
        && input.not_interested.is_none()
        && input.opened.is_none()
    {
        return Err(ApiError::BadRequest("至少提供一个阅读状态".into()));
    }
    if input.opened == Some(false)
        || (input.saved == Some(true) && input.not_interested == Some(true))
        || (input.not_interested_reason.is_some() && input.not_interested != Some(true))
    {
        return Err(ApiError::BadRequest(
            "打开事件只接受true，收藏与不感兴趣不能同时启用；原因须与不感兴趣true一起提交".into(),
        ));
    }
    state
        .store
        .update_event_state(id, input)
        .await?
        .map(|event| Json(serde_json::json!(event)))
        .ok_or(ApiError::NotFound)
}

async fn record_exposures(
    State(state): State<AppState>,
    Json(input): Json<crate::models::ExposureInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let mut ids = std::collections::HashSet::new();
    if input.items.is_empty()
        || input.items.len() > 100
        || input
            .items
            .iter()
            .any(|item| item.content_version < 0 || !ids.insert(item.event_id))
    {
        return Err(ApiError::BadRequest(
            "曝光须提供1–100个唯一事件及其有效内容版本".into(),
        ));
    }
    let submitted = input.items.len();
    let recorded = state.store.record_exposures(input.items).await?;
    Ok(Json(
        serde_json::json!({"recorded":recorded,"skipped":submitted as u64-recorded}),
    ))
}

async fn latest_brief(
    State(state): State<AppState>,
    Query(query): Query<VisitorQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if query.as_of.is_some() && query.interests.is_none() {
        return Err(ApiError::BadRequest(
            "指定精选时间时必须提供访客兴趣。".into(),
        ));
    }
    let cutoff = query.as_of.unwrap_or_else(chrono::Utc::now);
    if cutoff > chrono::Utc::now() + chrono::Duration::minutes(5) {
        return Err(ApiError::BadRequest("阅读时间不能位于未来。".into()));
    }
    let personalized = query.interests.is_some();
    let brief = if let Some(interests) = query.interests {
        state.store.visitor_brief(cutoff, &interests).await?
    } else {
        state.store.latest_brief().await?
    };
    let mut response = serde_json::json!(brief);
    if personalized {
        response["readerProfileApplied"] = true.into();
    }
    Ok(Json(response))
}

async fn explore_topics(
    State(state): State<AppState>,
    Query(mut query): Query<EventQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if query.hours.is_some_and(|hours| !(0..=720).contains(&hours))
        || query.q.as_ref().is_some_and(|q| q.chars().count() > 200)
        || query
            .as_of
            .is_some_and(|date| date > chrono::Utc::now() + chrono::Duration::minutes(5))
        || query
            .tier
            .as_deref()
            .is_some_and(|tier| !["T1", "T1.5", "T2"].contains(&tier))
        || query.kind.as_deref().is_some_and(|kind| {
            ![
                "blog",
                "release",
                "podcast",
                "paper",
                "model",
                "repository",
                "news",
                "research",
                "analysis",
                "tutorial",
                "discussion",
                "question",
                "promotion",
                "metadata",
            ]
            .contains(&kind)
        })
    {
        return Err(ApiError::BadRequest("探索时间范围或查询长度无效".into()));
    }
    query.limit = Some(100);
    query.offset = Some(0);
    query.sort = Some("recommended".into());
    query.as_of.get_or_insert_with(chrono::Utc::now);
    let events = state.store.list_events(&query).await?;
    let mut nodes = std::collections::BTreeMap::<String, usize>::new();
    let mut edges = std::collections::BTreeMap::<(String, String), usize>::new();
    for event in &events {
        let mut facets = event
            .recommendation
            .as_ref()
            .map(|r| r.facets.clone())
            .unwrap_or_else(|| event.topics.clone());
        facets.sort();
        facets.dedup();
        for (index, facet) in facets.iter().enumerate() {
            *nodes.entry(facet.clone()).or_default() += 1;
            for other in facets.iter().skip(index + 1) {
                *edges.entry((facet.clone(), other.clone())).or_default() += 1;
            }
        }
    }
    let mut response = serde_json::json!({"sampleSize":events.len(),"limit":100,
        "nodes":nodes.into_iter().map(|(id,count)|serde_json::json!({"id":id,"count":count})).collect::<Vec<_>>(),
        "edges":edges.into_iter().map(|((source,target),count)|serde_json::json!({"source":source,"target":target,"count":count})).collect::<Vec<_>>(),
        "meaning":"关系仅表示当前推荐样本中的主题共现，不表示因果或已核实的知识关系"});
    if query.interests.is_some() {
        response["readerProfileApplied"] = true.into();
    }
    Ok(Json(response))
}

async fn today_brief(State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    brief_response(&state, reader::local_date(chrono::Utc::now()), false).await
}
async fn save_today_brief(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    brief_response(&state, reader::local_date(chrono::Utc::now()), true).await
}
async fn dated_brief(
    State(state): State<AppState>,
    Path(date): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let date = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d")
        .map_err(|_| ApiError::BadRequest("日期格式须为YYYY-MM-DD".into()))?;
    brief_response(&state, date, false).await
}
async fn brief_response(
    state: &AppState,
    date: chrono::NaiveDate,
    persist: bool,
) -> Result<Json<serde_json::Value>, ApiError> {
    let brief = state.store.brief(date, persist).await?.ok_or_else(|| {
        if persist {
            ApiError::Conflict("暂无已完成 AI 摘要的合格候选，请等待处理后再保存简报".into())
        } else {
            ApiError::NotFound
        }
    })?;
    Ok(Json(serde_json::json!(brief)))
}
async fn brief_history(State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    Ok(Json(
        serde_json::json!({"items":state.store.brief_history().await?}),
    ))
}
async fn topics(State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    Ok(Json(
        serde_json::json!({"items":state.store.topics().await?}),
    ))
}
async fn replace_topics(
    State(state): State<AppState>,
    Json(input): Json<InterestInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let mut ids = std::collections::HashSet::new();
    if input.topics.len() > 100
        || input.topics.iter().any(|topic| {
            topic.id.trim().is_empty()
                || topic.id.len() > 100
                || !ids.insert(topic.id.clone())
                || topic.label.trim().is_empty()
                || topic.label.chars().count() > 80
                || !(0..=100).contains(&topic.weight)
                || topic.group.chars().count() > 80
                || !["long_term", "work", "current_project"].contains(&topic.context.as_str())
        })
    {
        return Err(ApiError::BadRequest(
            "兴趣最多100项，ID唯一，名称必填，权重为0–100，context为long_term/work/current_project"
                .into(),
        ));
    }
    Ok(Json(
        serde_json::json!({"items":state.store.replace_topics(input.topics).await?}),
    ))
}
async fn sources(State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    Ok(Json(
        serde_json::json!({"items":state.store.sources().await?}),
    ))
}

async fn source_coverage(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    Ok(Json(crate::ingestion::source_catalog::coverage(
        &state.store.sources().await?,
    )))
}

fn require_database(state: &AppState) -> Result<(), ApiError> {
    if state.feed_worker.is_none() {
        return Err(ApiError::Configuration(
            "演示模式不执行真实采集或模型操作；请启动数据库模式".into(),
        ));
    }
    Ok(())
}

async fn create_source(
    State(state): State<AppState>,
    Json(mut input): Json<SourceInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_database(&state)?;
    input.name = input.name.trim().to_owned();
    input.endpoint = input.endpoint.trim().to_owned();
    input.topic = input.topic.map(|v| v.trim().to_owned());
    if input.name.is_empty()
        || input.name.chars().count() > 120
        || input.endpoint.len() > 2048
        || !crate::ingestion::supported_adapters().contains(&input.adapter.as_str())
        || !["blog", "release", "podcast", "paper", "model", "repository"]
            .contains(&input.content_type.as_str())
        || !["T1", "T1.5", "T2"].contains(&input.tier.as_str())
        || !(15..=1440).contains(&input.schedule_minutes)
        || input.topic.as_ref().is_some_and(|v| v.chars().count() > 80)
    {
        return Err(ApiError::BadRequest(
            "来源参数无效；请填写名称、支持的适配器类型，以及15–1440分钟采集间隔".into(),
        ));
    }
    let url = url::Url::parse(&input.endpoint)
        .map_err(|_| ApiError::BadRequest("Feed URL无效".into()))?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err(ApiError::BadRequest(
            "Feed必须使用不含凭据的公开HTTPS地址".into(),
        ));
    }
    input.endpoint = crate::processing::canonical_url(&input.endpoint)
        .map_err(|_| ApiError::BadRequest("Feed地址无效或不是公开HTTPS地址".into()))?;
    crate::ingestion::validate_adapter_endpoint(&input.adapter, &input.endpoint)
        .map_err(|error| ApiError::BadRequest(error.to_string()))?;
    if input.adapter == "x_public_preview" {
        if input.content_type != "blog" {
            return Err(ApiError::BadRequest(
                "X 原帖预览使用 blog 存储类型，阅读内容会标识为帖子".into(),
            ));
        }
        input.original_post_urls = Some(
            crate::ingestion::validate_x_post_urls(
                &input.endpoint,
                input.original_post_urls.as_deref().unwrap_or_default(),
            )
            .map_err(|error| ApiError::BadRequest(error.to_string()))?,
        );
    } else if input.original_post_urls.is_some() {
        return Err(ApiError::BadRequest(
            "仅 X 公开预览适配器接受原帖链接列表".into(),
        ));
    }
    Ok(Json(serde_json::json!(
        state.store.create_source(input).await?
    )))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct XPostUrlsInput {
    urls: Vec<String>,
}

async fn x_post_urls(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_database(&state)?;
    if !state
        .store
        .sources()
        .await?
        .iter()
        .any(|source| source.id == id && source.adapter == "x_public_preview")
    {
        return Err(ApiError::NotFound);
    }
    let worker = state
        .feed_worker
        .as_ref()
        .ok_or_else(|| ApiError::Configuration("数据库未就绪".into()))?;
    let urls = worker.x_post_urls(id).await?;
    Ok(Json(
        serde_json::json!({"urls":urls,"coverage":"registered_posts_only"}),
    ))
}

async fn save_x_post_urls(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(input): Json<XPostUrlsInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_database(&state)?;
    let source = state
        .store
        .sources()
        .await?
        .into_iter()
        .find(|source| source.id == id && source.adapter == "x_public_preview")
        .ok_or(ApiError::NotFound)?;
    let urls = crate::ingestion::validate_x_post_urls(&source.endpoint, &input.urls)
        .map_err(|error| ApiError::BadRequest(error.to_string()))?;
    let worker = state
        .feed_worker
        .as_ref()
        .ok_or_else(|| ApiError::Configuration("数据库未就绪".into()))?;
    let urls = worker.save_x_post_urls(id, &urls).await?;
    let source_id = worker.x_registry_source(id).await?;
    Ok(Json(
        serde_json::json!({"urls":urls,"sourceId":source_id,"coverage":"registered_posts_only"}),
    ))
}

async fn update_source(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(input): Json<SourceUpdate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_database(&state)?;
    if (input.enabled.is_none() && input.schedule_minutes.is_none() && input.confirmed.is_none())
        || input.confirmed == Some(false)
        || (input.confirmed.is_some() && input.enabled.is_some())
        || input
            .schedule_minutes
            .is_some_and(|n| !(15..=1440).contains(&n))
    {
        return Err(ApiError::BadRequest(
            "至少提供一项设置；采集间隔为15–1440分钟；确认来源请单独提交 confirmed=true".into(),
        ));
    }
    let confirmation = input.confirmed == Some(true);
    Ok(Json(serde_json::json!(
        state
            .store
            .update_source(id, input)
            .await?
            .ok_or_else(|| if confirmation {
                ApiError::Conflict(
                    "来源需先成功采集且处于观察状态；项目发现查询不能整体确认为可信来源".into(),
                )
            } else {
                ApiError::NotFound
            })?
    )))
}

async fn refresh_source(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_database(&state)?;
    let source = state
        .store
        .sources()
        .await?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or(ApiError::NotFound)?;
    if !["stable", "observing"].contains(&source.lifecycle_status.as_str()) {
        return Err(ApiError::Conflict("请先启用此来源，再执行采集".into()));
    }
    if state.auth.cloud() {
        return crate::ingestion_jobs::submit(&state, Some(id))
            .await
            .map(Json);
    }

    let worker = state
        .feed_worker
        .as_ref()
        .ok_or_else(|| ApiError::Configuration("采集未启用".into()))?;
    Ok(Json(serde_json::json!(worker.run_source(id).await?)))
}

async fn enrich_event_context(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_database(&state)?;
    if state.store.get_event(id).await?.is_none() {
        return Err(ApiError::NotFound);
    }
    if state.auth.cloud() {
        return crate::ingestion_jobs::submit_context(&state, id)
            .await
            .map(Json);
    }
    let worker = state
        .feed_worker
        .as_ref()
        .ok_or_else(|| ApiError::Configuration("采集未启用".into()))?;
    Ok(Json(serde_json::json!(
        worker.run_event_context_backfill(id).await?
    )))
}

async fn summarize_event(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(input): Json<SummarizeInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    Ok(Json(serde_json::json!(
        generate_event_summary(&state, id, &input.model, false).await?
    )))
}

pub async fn generate_event_summary(
    state: &AppState,
    id: Uuid,
    model: &str,
    automatic: bool,
) -> Result<Event, ApiError> {
    require_database(&state)?;
    if state.auth.cloud()
        && (model != automation::CLOUD_MODEL || model != automation::settings(state).await?.model)
    {
        return Err(ApiError::Forbidden);
    }
    let _guard = state
        .generation_lock
        .try_lock()
        .map_err(|_| ApiError::RateLimited("已有摘要生成任务正在运行，请稍后重试".into()))?;
    let connection = state.provider.read().await;
    if !connection.eligible {
        return Err(ApiError::Configuration(if state.auth.cloud() {
            "Cloud Copilot is not configured or verified; contact the preview owner. Original articles remain available.".into()
        } else {
            "请先在模型与账户页连接并探测 GitHub Copilot".into()
        }));
    }
    if !connection.models.iter().any(|available| available == model) {
        if state.auth.cloud() {
            return Err(ApiError::Configuration(
                "The dedicated Copilot account does not provide gpt-5.6-terra; no fallback will be used".into(),
            ));
        }
        return Err(ApiError::BadRequest("请选择探测返回的可用模型".into()));
    }
    let mode = connection
        .auth_mode
        .ok_or_else(|| ApiError::Unauthorized("请重新连接 Copilot".into()))?;
    drop(connection);
    let event = state.store.get_event(id).await?.ok_or(ApiError::NotFound)?;
    let prompt = summary::prompt(&event).map_err(|e| ApiError::BadRequest(e.to_string()))?;
    let limit = automation::settings(state).await?.daily_limit;
    let used = if state.auth.cloud() {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM admin_audits
            WHERE action='summarize_attempt' AND created_at>=now()-interval '24 hours'",
        )
        .fetch_one(state.auth.pool.as_ref().ok_or(ApiError::Forbidden)?)
        .await
        .map_err(anyhow::Error::from)?
    } else {
        state.store.summary_attempts().await?
    };
    if used >= limit {
        return Err(ApiError::RateLimited(format!(
            "过去24小时摘要调用已达到本地限额{limit}次（含失败调用）"
        )));
    }
    if state.auth.cloud() && !automatic {
        crate::reader_account::rate_limit(&state.reader_db()?, "summarize", 1, 30, 3600).await?;
    }
    let path = if mode == CopilotAuthMode::Local {
        "/v1/generate/local"
    } else {
        "/v1/generate"
    };
    let request = gateway_request(&state, reqwest::Method::POST, path, mode)?;
    state
        .store
        .record_summary_attempt(id, model, automatic)
        .await?;
    let response = request.timeout(std::time::Duration::from_secs(110))
        .json(&serde_json::json!({"model":model,"system":summary::SYSTEM,"prompt":prompt,"sessionId":format!("scoutnews-{}",Uuid::new_v4())}))
        .send().await.map_err(|_| { tracing::warn!("summary gateway request failed"); ApiError::Upstream("摘要网关不可用或请求超时，原始摘录未更改".into()) })?;
    let status = response.status();
    let value: serde_json::Value = response.json().await?;
    if !status.is_success() {
        tracing::warn!(%status,"Copilot summary failed");
        if status == reqwest::StatusCode::BAD_REQUEST {
            state
                .provider
                .write()
                .await
                .models
                .retain(|available| available != model);
            return Err(ApiError::Configuration(
                "所选模型暂不可用，已暂停自动摘要；请重新探测模型，原始摘录未更改".into(),
            ));
        }
        if matches!(status.as_u16(), 401 | 403 | 412) {
            let mut connection = state.provider.write().await;
            connection.eligible = false;
            connection.last_error = Some("账户连接已失效，请在模型与账户页重新探测".into());
        }
        return Err(ApiError::Upstream(if state.auth.cloud() {
            "Copilot generation failed; original material unchanged".into()
        } else {
            value
                .get("error")
                .and_then(|value| value.as_str())
                .unwrap_or("Copilot生成失败，原始摘录未更改；请检查模型连接")
                .into()
        }));
    }
    if state.auth.cloud() {
        if let Err(error) = validate_cloud_generation_response(&value) {
            let mut connection = state.provider.write().await;
            connection
                .models
                .retain(|available| available != automation::CLOUD_MODEL);
            connection.last_error = Some("Required cloud Copilot model/reasoning was not confirmed; no fallback is permitted".into());
            return Err(error);
        }
    }
    let content = value
        .get("content")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| ApiError::Upstream("模型未返回摘要内容".into()))?;
    let generated = summary::parse_output(content, &event)
        .map_err(|error| ApiError::Upstream(error.to_string()))?;
    let reasoning_effort = value
        .get("reasoningEffort")
        .and_then(|value| value.as_str());
    let event = state
        .store
        .save_summary(
            id,
            generated,
            model,
            event.content_version,
            reasoning_effort,
        )
        .await?
        .ok_or_else(|| ApiError::Conflict("事件证据在生成期间发生变化，请刷新后重新生成".into()))?;
    Ok(event)
}

fn validate_cloud_generation_response(value: &serde_json::Value) -> Result<(), ApiError> {
    if value.get("provider").and_then(serde_json::Value::as_str) != Some("github-copilot")
        || value.get("model").and_then(serde_json::Value::as_str) != Some(automation::CLOUD_MODEL)
        || value
            .get("reasoningEffort")
            .and_then(serde_json::Value::as_str)
            != Some(automation::CLOUD_REASONING_EFFORT)
    {
        return Err(ApiError::Configuration(
            "Cloud Copilot did not confirm gpt-5.6-terra with low reasoning; no summary was saved and no fallback will be used".into(),
        ));
    }
    Ok(())
}

async fn processing_status(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    Ok(Json(serde_json::json!(automation::status(&state).await?)))
}

async fn reader_status(
    State(state): State<AppState>,
) -> Result<Json<edition::ReaderStatus>, ApiError> {
    Ok(Json(edition::status(&state).await?))
}

async fn reader_settings(
    State(state): State<AppState>,
    Json(input): Json<ReaderSettings>,
) -> Result<Json<ReaderSettings>, ApiError> {
    require_database(&state)?;
    input
        .validate()
        .map_err(|error| ApiError::BadRequest(error.to_string()))?;
    state
        .edition
        .as_ref()
        .ok_or_else(|| ApiError::Configuration("晨读调度未启用".into()))?
        .save_settings(&input)
        .await?;
    Ok(Json(input))
}

async fn processing_settings(
    State(state): State<AppState>,
    Json(input): Json<ProcessingSettings>,
) -> Result<Json<ProcessingSettings>, ApiError> {
    require_database(&state)?;
    input
        .validate()
        .map_err(|error| ApiError::BadRequest(error.to_string()))?;
    let store = state
        .automation
        .as_ref()
        .ok_or_else(|| ApiError::Configuration("摘要队列未启用".into()))?;
    let previous = store.settings().await?;
    if input.model != previous.model
        && input.model != ProcessingSettings::default().model
        && !state.provider.read().await.models.contains(&input.model)
    {
        return Err(ApiError::BadRequest(
            "请选择当前账户实际返回的模型，不会自动替换".into(),
        ));
    }
    store.save_settings(&input).await?;
    Ok(Json(input))
}

async fn retry_summaries(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_database(&state)?;
    let store = state
        .automation
        .as_ref()
        .ok_or_else(|| ApiError::Configuration("摘要队列未启用".into()))?;
    Ok(Json(
        serde_json::json!({"queued":store.retry_failed().await?}),
    ))
}

async fn run_ingestion(State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    if state.auth.cloud() {
        return crate::ingestion_jobs::submit(&state, None).await.map(Json);
    }
    let worker = state
        .feed_worker
        .as_ref()
        .ok_or_else(|| ApiError::Configuration("Demo 模式不执行真实采集".into()))?;
    Ok(Json(serde_json::json!(worker.run_all().await?)))
}

async fn model_providers(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let github_ready = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]
        .iter()
        .all(|key| env::var(key).is_ok_and(|value| !value.is_empty()));
    let preferred = automation::settings(&state).await?.model;
    let connection = state.provider.read().await;
    let default_model = select_default_model(&connection.models, &preferred);
    let providers = vec![
        ProviderStatus {
            provider: "github-copilot".into(),
            connected: connection.eligible,
            eligible: connection.eligible,
            model: default_model.clone(),
            message: if connection.eligible {
                if default_model.is_some() {
                    format!(
                        "可用 {} 个模型，默认使用 {preferred}",
                        connection.models.len()
                    )
                } else {
                    format!(
                        "账户可用，但 {preferred} 不在可用列表中；请手动选择其他模型，不会自动替换"
                    )
                }
            } else if let Some(error) = &connection.last_error {
                error.clone()
            } else {
                "可直接连接本机已登录的 GitHub/Copilot 账户，无需 OAuth App".into()
            },
            models: connection.models.clone(),
            verified_at: connection.verified_at,
            auth_mode: connection.auth_mode.map(|mode| mode.as_str().into()),
            account_login: connection.account_login.clone(),
            preferred_model: preferred,
            oauth_configured: github_ready,
        },
        ProviderStatus {
            provider: "azure-openai".into(),
            connected: false,
            eligible: false,
            model: env::var("AZURE_OPENAI_DEPLOYMENT").ok(),
            message: "本版未接入；不会自动调用或消耗 Azure 配额".into(),
            models: env::var("AZURE_OPENAI_DEPLOYMENT")
                .ok()
                .into_iter()
                .collect(),
            verified_at: None,
            auth_mode: None,
            account_login: None,
            preferred_model: String::new(),
            oauth_configured: false,
        },
    ];
    Ok(Json(serde_json::json!({"items":providers})))
}

async fn github_start(State(state): State<AppState>) -> Result<Redirect, ApiError> {
    require_database(&state)?;
    let client_id = env::var("GITHUB_CLIENT_ID")
        .map_err(|_| ApiError::Configuration("GITHUB_CLIENT_ID 未配置".into()))?;
    let callback = env::var("GITHUB_CALLBACK_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8080/api/v1/auth/github/callback".into());
    let oauth_state = Uuid::new_v4().to_string();
    state
        .oauth_states
        .lock()
        .await
        .insert(oauth_state.clone(), std::time::Instant::now());
    let url = format!(
        "https://github.com/login/oauth/authorize?client_id={}&redirect_uri={}&scope=read:user&state={}",
        urlencoding(&client_id),
        urlencoding(&callback),
        urlencoding(&oauth_state)
    );
    Ok(Redirect::temporary(&url))
}

#[derive(Deserialize)]
struct OAuthCallback {
    code: String,
    state: String,
}
#[derive(Serialize)]
struct TokenExchange<'a> {
    client_id: &'a str,
    client_secret: &'a str,
    code: &'a str,
}

async fn github_callback(
    State(state): State<AppState>,
    Query(query): Query<OAuthCallback>,
) -> Result<Redirect, ApiError> {
    let _guard = state
        .generation_lock
        .try_lock()
        .map_err(|_| ApiError::Conflict("Copilot 正忙，请稍后连接".into()))?;
    let issued = state
        .oauth_states
        .lock()
        .await
        .remove(&query.state)
        .ok_or_else(|| ApiError::Unauthorized("OAuth state 无效或已使用".into()))?;
    if issued.elapsed() > std::time::Duration::from_secs(600) {
        return Err(ApiError::Unauthorized("OAuth state 已过期".into()));
    }
    let client_id = env::var("GITHUB_CLIENT_ID")
        .map_err(|_| ApiError::Configuration("GITHUB_CLIENT_ID 未配置".into()))?;
    let client_secret = env::var("GITHUB_CLIENT_SECRET")
        .map_err(|_| ApiError::Configuration("GITHUB_CLIENT_SECRET 未配置".into()))?;
    let value: serde_json::Value = state
        .http
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .json(&TokenExchange {
            client_id: &client_id,
            client_secret: &client_secret,
            code: &query.code,
        })
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let token = value
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ApiError::Upstream("GitHub 未返回 access token".into()))?;
    keyring::Entry::new("ScoutNews", "github-copilot-token")
        .map_err(|e| ApiError::Internal(e.into()))?
        .set_password(token)
        .map_err(|e| ApiError::Internal(e.into()))?;
    state.store.set_provider_auth_mode("oauth").await?;
    probe_connection(&state, CopilotAuthMode::Oauth).await?;
    let origin = env::var("WEB_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:5173".into());
    Ok(Redirect::temporary(&format!(
        "{}/settings?copilot=connected",
        origin.trim_end_matches('/')
    )))
}

fn oauth_token() -> Result<String, ApiError> {
    keyring::Entry::new("ScoutNews", "github-copilot-token")
        .map_err(|error| ApiError::Internal(error.into()))?
        .get_password()
        .map_err(|_| ApiError::Unauthorized("OAuth 凭据不可用，请重新授权或改用本机登录".into()))
}

fn gateway_request(
    state: &AppState,
    method: reqwest::Method,
    path: &str,
    mode: CopilotAuthMode,
) -> Result<reqwest::RequestBuilder, ApiError> {
    let gateway =
        env::var("COPILOT_GATEWAY_URL").unwrap_or_else(|_| "http://127.0.0.1:8787".into());
    let secret = env::var("COPILOT_GATEWAY_SHARED_SECRET")
        .map_err(|_| ApiError::Configuration("COPILOT_GATEWAY_SHARED_SECRET 未配置".into()))?;
    let request = state
        .http
        .request(method, format!("{gateway}{path}"))
        .header("X-ScoutNews-Gateway-Secret", secret)
        .timeout(std::time::Duration::from_secs(60));
    Ok(match mode {
        CopilotAuthMode::Local => request,
        CopilotAuthMode::Oauth => request.bearer_auth(if state.auth.cloud() {
            env::var("COPILOT_GITHUB_TOKEN")
                .ok()
                .filter(|token| !token.trim().is_empty())
                .ok_or_else(|| {
                    ApiError::Configuration(
                        "Cloud Copilot service credential is not configured".into(),
                    )
                })?
        } else {
            oauth_token()?
        }),
    })
}

fn require_local_login_enabled() -> Result<(), ApiError> {
    if env::var("SCOUTNEWS_DISABLE_COPILOT_RESTORE")
        .is_ok_and(|value| value.eq_ignore_ascii_case("true"))
    {
        return Err(ApiError::Configuration(
            "隔离运行环境禁止访问本机 Copilot 登录".into(),
        ));
    }
    Ok(())
}

async fn probe_details(
    state: &AppState,
    mode: CopilotAuthMode,
) -> Result<ProviderConnection, ApiError> {
    let path = if mode == CopilotAuthMode::Local {
        require_local_login_enabled()?;
        "/v1/providers/copilot/local/probe"
    } else {
        "/v1/providers/copilot/probe"
    };
    let response = gateway_request(state, reqwest::Method::POST, path, mode)?
        .send()
        .await?;
    let status = response.status();
    let value: serde_json::Value = response.json().await?;
    if !status.is_success() {
        return Err(ApiError::Upstream(
            value
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("Copilot capability probe 失败")
                .into(),
        ));
    }
    let models: Vec<String> = value
        .get("models")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|model| {
            model
                .get("id")
                .and_then(|id| id.as_str())
                .map(str::to_owned)
        })
        .filter(|model| !model.is_empty() && model != "auto")
        .collect();
    if models.is_empty() {
        return Err(ApiError::Upstream(
            "Copilot未返回可用模型，请确认账户资格".into(),
        ));
    }
    let required_model_unavailable =
        state.auth.cloud() && !models.iter().any(|model| model == automation::CLOUD_MODEL);
    if required_model_unavailable {
        tracing::warn!("required cloud Copilot model is unavailable; no fallback will be used");
    }
    Ok(ProviderConnection {
        eligible: true,
        models,
        verified_at: Some(chrono::Utc::now()),
        auth_mode: Some(mode),
        account_login: value
            .get("login")
            .and_then(|value| value.as_str())
            .map(str::to_owned),
        last_error: required_model_unavailable.then(||
            "The dedicated Copilot account does not provide gpt-5.6-terra; no fallback will be used".into()),
    })
}

async fn probe_connection(state: &AppState, mode: CopilotAuthMode) -> Result<(), ApiError> {
    match probe_details(state, mode).await {
        Ok(connection) => {
            *state.provider.write().await = connection;
            Ok(())
        }
        Err(error) => {
            let message = match &error {
                ApiError::Upstream(message)
                | ApiError::Configuration(message)
                | ApiError::Unauthorized(message) => message.clone(),
                _ => "Copilot 连接失败，请检查本机登录和网关后重新探测".into(),
            };
            *state.provider.write().await = ProviderConnection {
                auth_mode: Some(mode),
                last_error: Some(message),
                ..ProviderConnection::default()
            };
            Err(error)
        }
    }
}

pub async fn restore_copilot(state: &AppState) -> Result<(), ApiError> {
    if state.auth.cloud() {
        if !env::var("COPILOT_GITHUB_TOKEN").is_ok_and(|token| !token.trim().is_empty()) {
            state.provider.write().await.last_error =
                Some("Cloud Copilot service credential is not configured".into());
            return Ok(());
        }
        let result = probe_connection(state, CopilotAuthMode::Oauth).await;
        state.provider.write().await.account_login = None;
        return result;
    }
    let mode = state.store.provider_auth_mode().await?;
    match mode.as_str() {
        "disconnected" => Ok(()),
        "local" => probe_connection(state, CopilotAuthMode::Local).await,
        "oauth" => probe_connection(state, CopilotAuthMode::Oauth).await,
        _ => Err(ApiError::Configuration(
            "保存的 Copilot 登录方式无效".into(),
        )),
    }
}

async fn copilot_connect_local(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_database(&state)?;
    require_local_login_enabled()?;
    let _guard = state
        .generation_lock
        .try_lock()
        .map_err(|_| ApiError::Conflict("Copilot 正忙，请稍后连接".into()))?;
    state.store.set_provider_auth_mode("local").await?;
    probe_connection(&state, CopilotAuthMode::Local).await?;
    Ok(Json(serde_json::json!({"status":"ok"})))
}

async fn copilot_probe(State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    require_database(&state)?;
    let _guard = state
        .generation_lock
        .try_lock()
        .map_err(|_| ApiError::Conflict("Copilot 正忙，请稍后探测".into()))?;
    let mode = state
        .provider
        .read()
        .await
        .auth_mode
        .ok_or_else(|| ApiError::Unauthorized("请先连接本机账户或 OAuth 账户".into()))?;
    probe_connection(&state, mode).await?;
    Ok(Json(serde_json::json!({"status":"ok"})))
}

async fn copilot_disconnect(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let _guard = state
        .generation_lock
        .try_lock()
        .map_err(|_| ApiError::Conflict("摘要生成仍在运行，请完成后再断开".into()))?;
    state.store.set_provider_auth_mode("disconnected").await?;
    let mode = {
        let mut connection = state.provider.write().await;
        connection.eligible = false;
        connection.auth_mode
    };
    if let Some(mode) = mode {
        let path = if mode == CopilotAuthMode::Local {
            "/v1/providers/copilot/local/client"
        } else {
            "/v1/providers/copilot/client"
        };
        gateway_request(&state, reqwest::Method::DELETE, path, mode)?
            .send()
            .await?
            .error_for_status()?;
    }
    if mode == Some(CopilotAuthMode::Oauth) {
        let token = oauth_token()?;
        if let (Ok(client_id), Ok(client_secret)) = (
            env::var("GITHUB_CLIENT_ID"),
            env::var("GITHUB_CLIENT_SECRET"),
        ) {
            let revocation = state
                .http
                .delete(format!(
                    "https://api.github.com/applications/{client_id}/token"
                ))
                .basic_auth(client_id, Some(client_secret))
                .header("User-Agent", "ScoutNews/0.1")
                .json(&serde_json::json!({"access_token": token}))
                .send()
                .await;
            if !revocation.is_ok_and(|response| response.status().is_success()) {
                tracing::warn!(
                    "Could not revoke the app OAuth token remotely; removing the app credential locally"
                );
            }
        }
        keyring::Entry::new("ScoutNews", "github-copilot-token")
            .map_err(|error| ApiError::Internal(error.into()))?
            .delete_credential()
            .map_err(|e| ApiError::Internal(e.into()))?;
    }
    *state.provider.write().await = ProviderConnection::default();
    Ok(Json(serde_json::json!({"status":"disconnected"})))
}

fn urlencoding(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

#[derive(Debug)]
pub enum ApiError {
    Forbidden,
    NotFound,
    BadRequest(String),
    Conflict(String),
    RateLimited(String),
    Configuration(String),
    Upstream(String),
    Unauthorized(String),
    Internal(anyhow::Error),
}
impl From<anyhow::Error> for ApiError {
    fn from(value: anyhow::Error) -> Self {
        if value
            .downcast_ref::<sqlx::Error>()
            .and_then(sqlx::Error::as_database_error)
            .is_some_and(|error| error.is_unique_violation())
        {
            return Self::Conflict("记录已存在，请勿重复添加".into());
        }
        Self::Internal(value)
    }
}
impl From<reqwest::Error> for ApiError {
    fn from(value: reqwest::Error) -> Self {
        Self::Internal(value.into())
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match self {
            Self::Forbidden => (
                StatusCode::FORBIDDEN,
                "This operation is not permitted".into(),
            ),
            Self::NotFound => (StatusCode::NOT_FOUND, "not found".into()),
            Self::BadRequest(v) => (StatusCode::BAD_REQUEST, v),
            Self::Conflict(v) => (StatusCode::CONFLICT, v),
            Self::RateLimited(v) => (StatusCode::TOO_MANY_REQUESTS, v),
            Self::Configuration(v) => (StatusCode::PRECONDITION_FAILED, v),
            Self::Upstream(v) => (StatusCode::BAD_GATEWAY, v),
            Self::Unauthorized(v) => (StatusCode::UNAUTHORIZED, v),
            Self::Internal(error) => {
                let _ = error;
                tracing::error!("request failed; details withheld to protect reader data");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
            }
        };
        (status, Json(serde_json::json!({"error":message}))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::MemoryStore;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn test_app() -> Router {
        router(AppState {
            auth: Arc::new(crate::auth::Auth::default()),
            identity: None,
            store: Arc::new(MemoryStore::demo()),
            http: Client::new(),
            oauth_states: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            provider: Arc::new(tokio::sync::RwLock::new(ProviderConnection::default())),
            feed_worker: None,
            generation_lock: Arc::new(tokio::sync::Mutex::new(())),
            automation: None,
            edition: None,
            publishing: None,
        })
    }

    #[test]
    fn default_model_requires_the_exact_available_id() {
        let models = vec!["gpt-5.5".into(), "gpt-5.6-terra".into()];
        assert_eq!(
            select_default_model(&models, "gpt-5.6-terra"),
            Some("gpt-5.6-terra".into())
        );
        assert_eq!(select_default_model(&models, "gpt-5.6"), None);
        assert_eq!(
            select_default_model(&["gpt-5.5".into()], "gpt-5.6-terra"),
            None
        );
        assert_eq!(select_default_model(&[], "gpt-5.6-terra"), None);
    }

    #[test]
    fn cloud_generation_requires_exact_provider_model_and_low_reasoning() {
        let expected = serde_json::json!({
            "provider":"github-copilot","model":"gpt-5.6-terra","reasoningEffort":"low"
        });
        validate_cloud_generation_response(&expected).unwrap();
        for (field, value) in [
            ("provider", serde_json::json!("azure-openai")),
            ("model", serde_json::json!("gpt-5.5")),
            ("model", serde_json::json!("gpt-5.6")),
            ("reasoningEffort", serde_json::json!("high")),
            ("reasoningEffort", serde_json::json!("medium")),
            ("reasoningEffort", serde_json::Value::Null),
        ] {
            let mut response = expected.clone();
            response[field] = value;
            assert!(matches!(
                validate_cloud_generation_response(&response),
                Err(ApiError::Configuration(_))
            ));
        }
        for field in ["provider", "model", "reasoningEffort"] {
            let mut response = expected.clone();
            response.as_object_mut().unwrap().remove(field);
            assert!(validate_cloud_generation_response(&response).is_err());
        }
    }

    #[tokio::test]
    async fn demo_rejects_local_login_and_exposes_no_connected_account() {
        let app = test_app();
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/v1/model-providers/github-copilot/local")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PRECONDITION_FAILED);
        let response = app
            .oneshot(
                Request::get("/api/v1/model-providers")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["items"][0]["connected"], false);
        assert!(value["items"][0]["authMode"].is_null());
        assert!(value["items"][0]["accountLogin"].is_null());
        assert!(value["items"][0]["model"].is_null());
    }

    #[tokio::test]
    async fn disconnected_preference_skips_all_credentials_and_gateway_requests() {
        let store = Arc::new(MemoryStore::demo());
        store.set_provider_auth_mode("disconnected").await.unwrap();
        let state = AppState {
            auth: Arc::new(crate::auth::Auth::default()),
            identity: None,
            store: store.clone(),
            http: Client::new(),
            oauth_states: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            provider: Arc::new(tokio::sync::RwLock::new(ProviderConnection::default())),
            feed_worker: None,
            generation_lock: Arc::new(tokio::sync::Mutex::new(())),
            automation: None,
            edition: None,
            publishing: None,
        };
        restore_copilot(&state).await.unwrap();
        assert!(!state.provider.read().await.eligible);
        assert_eq!(store.provider_auth_mode().await.unwrap(), "disconnected");
    }

    #[tokio::test]
    async fn demo_processing_is_visible_but_cannot_start_model_jobs() {
        let app = test_app();
        let response = app
            .clone()
            .oneshot(
                Request::get("/api/v1/processing")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["settings"]["model"], "gpt-5.6-terra");
        assert_eq!(value["settings"]["enabled"], false);
        assert_eq!(value["blockedReason"], "demo");
        assert_eq!(value["jobs"].as_array().unwrap().len(), 0);
        let response = app
            .oneshot(
                Request::post("/api/v1/processing/retry")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PRECONDITION_FAILED);
    }

    #[tokio::test]
    async fn events_endpoint_returns_demo_events() {
        let response = test_app()
            .oneshot(Request::get("/api/v1/events").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["items"].as_array().unwrap().len(), 5);
    }

    #[tokio::test]
    async fn oauth_callback_rejects_unknown_state_before_network_access() {
        let response = test_app()
            .oneshot(
                Request::get("/api/v1/auth/github/callback?code=fake&state=unknown")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn rejects_invalid_paging_and_untrusted_browser_origins() {
        for path in [
            "/api/v1/events?limit=0",
            "/api/v1/events?offset=-1",
            "/api/v1/events?sort=invalid",
            "/api/v1/briefs/not-a-date",
        ] {
            let response = test_app()
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
        let response = test_app()
            .oneshot(
                Request::post("/api/v1/admin/ingestion/run")
                    .header("origin", "https://untrusted.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn state_changes_and_brief_snapshots_are_independent() {
        let app = test_app();
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/v1/briefs/today/generate")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let first: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(first["isSnapshot"], true);
        let id = first["items"][0]["id"].as_str().unwrap();
        let response = app
            .clone()
            .oneshot(
                Request::put(format!("/api/v1/events/{id}/state"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"saved":true,"later":true,"read":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response = app
            .clone()
            .oneshot(
                Request::get("/api/v1/events?later=true&read=true")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let list: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(list["items"].as_array().unwrap().len(), 1);
        let response = app
            .oneshot(
                Request::post("/api/v1/briefs/today/generate")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let second: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(first["generatedAt"], second["generatedAt"]);
        assert_eq!(second["items"][0]["later"], true);
        assert_eq!(first["items"][0]["summary"], second["items"][0]["summary"]);
    }
}
