use crate::{
    app::{ApiError, AppState},
    models::{DailyBrief, Event, EventQuery},
    reader,
};
use anyhow::{Context, Result};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    response::{Html, IntoResponse},
    routing::get,
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use uuid::Uuid;

#[derive(Clone)]
pub struct Publishing {
    pub pool: PgPool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShareSettings {
    pub public_base_url: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareSource {
    pub name: String,
    pub url: String,
    pub tier: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareItem {
    pub title: String,
    pub summary: String,
    pub published_at: Option<DateTime<Utc>>,
    pub sources: Vec<ShareSource>,
    pub summary_kind: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareDocument {
    pub title: String,
    pub kind: String,
    pub date: String,
    pub created_at: DateTime<Utc>,
    pub items: Vec<ShareItem>,
    pub note: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedEdition {
    pub id: Uuid,
    pub document: ShareDocument,
    pub published: bool,
    pub revoked: bool,
    pub public_url: Option<String>,
    pub editor: Option<ShareEditor>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditedItem {
    pub index: usize,
    pub title: String,
    pub summary: String,
    pub selected: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShareEditor {
    pub title: String,
    pub subtitle: String,
    pub caption: String,
    pub cta: String,
    pub format: String,
    pub theme: String,
    pub items: Vec<EditedItem>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShareInput {
    pub kind: String,
    pub event_id: Option<Uuid>,
    pub date: Option<String>,
    pub selection: Option<Vec<SelectedArticle>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectedArticle {
    pub event_id: Uuid,
    pub content_version: i64,
    pub summarized_at: Option<DateTime<Utc>>,
}
#[derive(Default, Deserialize)]
pub struct EditionQuery {
    pub date: Option<NaiveDate>,
}

fn database(state: &AppState) -> Result<&Publishing, ApiError> {
    state
        .publishing
        .as_ref()
        .ok_or_else(|| ApiError::Configuration("分享与名单需要持久化数据库".into()))
}
impl Publishing {
    pub async fn settings(&self) -> Result<ShareSettings> {
        let value: String =
            sqlx::query_scalar("SELECT value FROM app_settings WHERE key='share_settings'")
                .fetch_one(&self.pool)
                .await?;
        Ok(serde_json::from_str(&value)?)
    }
    pub async fn read(&self, id: Uuid, public_only: bool) -> Result<Option<SharedEdition>> {
        let row=sqlx::query("SELECT document,CASE WHEN $2 THEN NULL ELSE editor END AS editor,published,revoked_at FROM reader_shares
            WHERE id=$1 AND (NOT $2 OR published AND revoked_at IS NULL)")
            .bind(id).bind(public_only).fetch_optional(&self.pool).await?;
        let Some(row) = row else { return Ok(None) };
        let published: bool = row.try_get("published")?;
        let revoked: Option<DateTime<Utc>> = row.try_get("revoked_at")?;
        let base = if public_only {
            None
        } else {
            self.settings().await?.public_base_url
        };
        Ok(Some(SharedEdition {
            id,
            document: serde_json::from_value(row.try_get("document")?)?,
            editor: row
                .try_get::<Option<serde_json::Value>, _>("editor")?
                .map(serde_json::from_value)
                .transpose()?,
            published,
            revoked: revoked.is_some(),
            public_url: base
                .filter(|_| published && revoked.is_none())
                .map(|base| format!("{base}/share/{id}")),
        }))
    }
}

pub async fn watchlist(State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    let rows=sqlx::query("SELECT id,platform,name,handle,profile_url,status,note,source_id,origin_url,origin_label,origin_block,document_urls
        FROM source_watchlist ORDER BY platform,lower(name),id")
        .fetch_all(&database(&state)?.pool).await.map_err(anyhow::Error::from)?;
    let mut items = Vec::new();
    for row in rows {
        items.push(serde_json::json!({"id":row.try_get::<String,_>("id").map_err(anyhow::Error::from)?,
          "platform":row.try_get::<String,_>("platform").map_err(anyhow::Error::from)?,
          "name":row.try_get::<String,_>("name").map_err(anyhow::Error::from)?,
          "handle":row.try_get::<Option<String>,_>("handle").map_err(anyhow::Error::from)?,
          "profileUrl":row.try_get::<Option<String>,_>("profile_url").map_err(anyhow::Error::from)?,
          "status":row.try_get::<String,_>("status").map_err(anyhow::Error::from)?,
          "note":row.try_get::<String,_>("note").map_err(anyhow::Error::from)?,
          "sourceId":row.try_get::<Option<Uuid>,_>("source_id").map_err(anyhow::Error::from)?,
          "originUrl":row.try_get::<Option<String>,_>("origin_url").map_err(anyhow::Error::from)?,
          "originLabel":row.try_get::<Option<String>,_>("origin_label").map_err(anyhow::Error::from)?,
          "documentUrls":row.try_get::<serde_json::Value,_>("document_urls").map_err(anyhow::Error::from)?,
          "originBlock":row.try_get::<Option<String>,_>("origin_block").map_err(anyhow::Error::from)?}));
    }
    Ok(Json(serde_json::json!({"items":items})))
}

pub async fn weekly_document(
    state: &AppState,
    date: Option<NaiveDate>,
) -> Result<DailyBrief, ApiError> {
    let now = Utc::now();
    let today = reader::local_date(now);
    let date = date.unwrap_or(today);
    if date > today {
        return Err(ApiError::BadRequest("不能生成未来日期的周报".into()));
    }
    let cutoff = if date == today {
        now
    } else {
        date.succ_opt()
            .context("invalid weekly date")?
            .and_hms_opt(0, 0, 0)
            .context("invalid weekly time")?
            .and_utc()
            - Duration::hours(8)
    };
    let sources = state.store.sources().await?;
    let mut events = state
        .store
        .list_events(&EventQuery {
            hours: Some(168),
            as_of: Some(cutoff),
            limit: Some(100),
            sort: Some("weekly".into()),
            ..Default::default()
        })
        .await?;
    events.retain(|event| {
        reader::brief_qualified(event, cutoff)
            && event.summary_kind == "copilot"
            && event.summary_format_version >= 2
            && event.event_type != "repository"
            && event.evidence.iter().all(|item| item.aggregation.is_none())
            && event.evidence.iter().any(|item| {
                sources.iter().any(|source| {
                    source.name == item.source_name
                        && (source.lifecycle_status == "stable"
                            || source.lifecycle_status == "observing"
                                && source.last_success_at.is_some()
                                && source.consecutive_failures == 0)
                })
            })
    });
    reader::sort_candidates(&mut events, cutoff);
    let mut brief = reader::select_weekly(crate::coverage::rollup_events(events, cutoff), cutoff, 20);
    brief.local_date = date.to_string();
    brief.generated_at = now;
    Ok(brief)
}
pub async fn weekly(
    State(state): State<AppState>,
    Query(query): Query<EditionQuery>,
) -> Result<Json<DailyBrief>, ApiError> {
    Ok(Json(weekly_document(&state, query.date).await?))
}
pub async fn get_settings(State(state): State<AppState>) -> Result<Json<ShareSettings>, ApiError> {
    Ok(Json(database(&state)?.settings().await?))
}
pub async fn save_settings(
    State(state): State<AppState>,
    Json(mut input): Json<ShareSettings>,
) -> Result<Json<ShareSettings>, ApiError> {
    if let Some(base) = &input.public_base_url {
        let url = crate::processing::validate_public_https(base)
            .map_err(|error| ApiError::BadRequest(error.to_string()))?;
        if url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || url.port().is_some_and(|port| port != 443)
        {
            return Err(ApiError::BadRequest(
                "分享地址须是公网 HTTPS 站点根地址，不含路径、查询或非标准端口".into(),
            ));
        }
        input.public_base_url = Some(url.as_str().trim_end_matches('/').to_owned());
    }
    sqlx::query("UPDATE app_settings SET value=$1,updated_at=now() WHERE key='share_settings'")
        .bind(serde_json::to_string(&input).map_err(anyhow::Error::from)?)
        .execute(&database(&state)?.pool)
        .await
        .map_err(anyhow::Error::from)?;
    Ok(Json(input))
}
fn display_heading(event: &Event) -> &str {
    event.display_title.as_deref()
        .filter(|title| !title.trim().is_empty())
        .unwrap_or(&event.title)
}

fn public_item(event: Event) -> Result<ShareItem, ApiError> {
    if event.evidence.is_empty() || event.evidence.iter().any(|item| item.aggregation.is_some()) {
        return Err(ApiError::Conflict("只分享具有原始发布者证据的内容".into()));
    }
    let text = crate::summary::share_text(&event);
    let title = display_heading(&event).to_owned();
    let mut sources = Vec::new();
    for evidence in event.evidence {
        crate::processing::validate_public_https(&evidence.url)
            .map_err(|_| ApiError::Conflict("文章原始链接不是可公开分享的 HTTPS 地址".into()))?;
        if !sources
            .iter()
            .any(|item: &ShareSource| item.url == evidence.url)
        {
            sources.push(ShareSource {
                name: evidence.source_name,
                url: evidence.url,
                tier: evidence.source_tier,
            });
        }
    }
    Ok(ShareItem {
        title,
        summary: if event.summary_kind == "copilot" {
            text
        } else {
            "尚未生成 AI 摘要，请打开原始发布者的文章阅读。".into()
        },
        published_at: event.published_at,
        sources,
        summary_kind: event.summary_kind,
    })
}
pub async fn create(
    State(state): State<AppState>,
    Json(input): Json<ShareInput>,
) -> Result<Json<SharedEdition>, ApiError> {
    let db = database(&state)?;
    let date = input.date.as_deref().unwrap_or("latest");
    let mut selected = None;
    if let Some(selection) = input.selection {
        if !["brief", "week"].contains(&input.kind.as_str())
            || date != "latest"
            || selection.is_empty()
            || selection.len() > 30
        {
            return Err(ApiError::BadRequest(
                "自选分享仅适用于当前精选/周报，须包含1–30篇文章".into(),
            ));
        }
        let mut seen = std::collections::HashSet::new();
        let mut events = Vec::new();
        for item in selection {
            if !seen.insert(item.event_id) {
                return Err(ApiError::BadRequest("分享文章不能重复".into()));
            }
            let event = state
                .store
                .get_event(item.event_id)
                .await?
                .ok_or(ApiError::NotFound)?;
            if event.content_version != item.content_version
                || event.summarized_at != item.summarized_at
                || event.not_interested
            {
                return Err(ApiError::Conflict(
                    "本次所选文章已有更新，请先更新页面后再制作分享，避免分享与阅读内容不一致"
                        .into(),
                ));
            }
            events.push(event);
        }
        selected = Some(events);
    }
    let (title, edition_date, events) = match input.kind.as_str() {
        "event" => {
            let id = input
                .event_id
                .ok_or_else(|| ApiError::BadRequest("文章分享缺少 eventId".into()))?;
            let event = state.store.get_event(id).await?.ok_or(ApiError::NotFound)?;
            (
                display_heading(&event).to_owned(),
                reader::local_date(Utc::now()).to_string(),
                vec![event],
            )
        }
        "brief" => {
            if let Some(events) = selected {
                let day = reader::local_date(Utc::now()).to_string();
                (format!("NewsScout · {day} 当前精选"), day, events)
            } else {
                let brief = if date == "latest" {
                    state.store.latest_brief().await?
                } else {
                    let day = if date == "today" {
                        reader::local_date(Utc::now())
                    } else {
                        date.parse()
                            .map_err(|_| ApiError::BadRequest("简报日期无效".into()))?
                    };
                    state
                        .store
                        .brief(day, false)
                        .await?
                        .ok_or(ApiError::NotFound)?
                };
                (
                    format!(
                        "NewsScout · {} {}",
                        brief.local_date,
                        if date == "latest" {
                            "实时精选"
                        } else {
                            "晨间简报"
                        }
                    ),
                    brief.local_date,
                    brief
                        .items
                        .into_iter()
                        .filter(|item| !item.not_interested)
                        .collect(),
                )
            }
        }
        "week" => {
            if let Some(events) = selected {
                let day = reader::local_date(Utc::now()).to_string();
                (format!("NewsScout · 每周回顾 · {day}"), day, events)
            } else {
                let day = if date == "latest" {
                    None
                } else {
                    Some(
                        date.parse()
                            .map_err(|_| ApiError::BadRequest("周报日期无效".into()))?,
                    )
                };
                let brief = weekly_document(&state, day).await?;
                (
                    format!("NewsScout · 每周回顾 · {}", brief.local_date),
                    brief.local_date,
                    brief.items,
                )
            }
        }
        _ => {
            return Err(ApiError::BadRequest(
                "分享类型须为 event、brief 或 week".into(),
            ));
        }
    };
    if events.is_empty() {
        return Err(ApiError::Conflict("没有可分享的文章".into()));
    }
    let document = ShareDocument {
        title,
        kind: input.kind,
        date: edition_date,
        created_at: Utc::now(),
        items: events
            .into_iter()
            .take(30)
            .map(public_item)
            .collect::<Result<_, _>>()?,
        note: "AI 摘要不代替原文核验。仅包含文章与原始链接，不包含收藏、反馈、账户或个人推荐分。"
            .into(),
    };
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO reader_shares(id,document) VALUES($1,$2)")
        .bind(id)
        .bind(serde_json::to_value(document).map_err(anyhow::Error::from)?)
        .execute(&db.pool)
        .await
        .map_err(anyhow::Error::from)?;
    Ok(Json(db.read(id, false).await?.ok_or(ApiError::NotFound)?))
}
pub async fn read_share(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<SharedEdition>, ApiError> {
    Ok(Json(
        database(&state)?
            .read(id, false)
            .await?
            .ok_or(ApiError::NotFound)?,
    ))
}
pub async fn drafts(State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    let rows:Vec<serde_json::Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'title',COALESCE(editor->>'title',document->>'title'),
        'date',document->>'date','kind',document->>'kind','createdAt',created_at,'edited',editor IS NOT NULL)
        FROM reader_shares WHERE NOT published AND revoked_at IS NULL ORDER BY created_at DESC,id LIMIT 50")
        .fetch_all(&database(&state)?.pool).await.map_err(anyhow::Error::from)?;
    Ok(Json(serde_json::json!({"items":rows})))
}
pub async fn save_editor(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(input): Json<ShareEditor>,
) -> Result<Json<SharedEdition>, ApiError> {
    let db = database(&state)?;
    let share = db.read(id, false).await?.ok_or(ApiError::NotFound)?;
    if share.revoked || share.published {
        return Err(ApiError::Conflict("仅能编辑未发布的本地草稿".into()));
    }
    if input.title.trim().is_empty()
        || input.title.chars().count() > 120
        || input.subtitle.chars().count() > 120
        || input.cta.chars().count() > 100
        || input.caption.chars().count() > 12000
        || !["portrait", "square"].contains(&input.format.as_str())
        || !["light", "dark"].contains(&input.theme.as_str())
        || input.items.len() != share.document.items.len()
        || input.items.iter().enumerate().any(|(index, item)| {
            item.index != index
                || item.title.trim().is_empty()
                || item.title.chars().count() > 200
                || item.summary.chars().count() > 4000
        })
    {
        return Err(ApiError::BadRequest(
            "草稿格式或文字长度无效，请缩短过长文字后重试".into(),
        ));
    }
    let changed = sqlx::query(
        "UPDATE reader_shares SET editor=$2 WHERE id=$1 AND NOT published AND revoked_at IS NULL",
    )
    .bind(id)
    .bind(serde_json::to_value(input).map_err(anyhow::Error::from)?)
    .execute(&db.pool)
    .await
    .map_err(anyhow::Error::from)?
    .rows_affected();
    if changed == 0 {
        return Err(ApiError::Conflict(
            "草稿状态已改变，本次编辑没有保存".into(),
        ));
    }
    Ok(Json(db.read(id, false).await?.ok_or(ApiError::NotFound)?))
}
pub async fn publish(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<SharedEdition>, ApiError> {
    let db = database(&state)?;
    if db.settings().await?.public_base_url.is_none() {
        return Err(ApiError::Configuration(
            "尚未配置公网只读分享站点，不能发布链接或生成二维码".into(),
        ));
    }
    let count =
        sqlx::query("UPDATE reader_shares SET published=true WHERE id=$1 AND revoked_at IS NULL")
            .bind(id)
            .execute(&db.pool)
            .await
            .map_err(anyhow::Error::from)?
            .rows_affected();
    if count == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(Json(db.read(id, false).await?.ok_or(ApiError::NotFound)?))
}
pub async fn revoke(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<SharedEdition>, ApiError> {
    let db = database(&state)?;
    sqlx::query("UPDATE reader_shares SET revoked_at=now(),published=false WHERE id=$1")
        .bind(id)
        .execute(&db.pool)
        .await
        .map_err(anyhow::Error::from)?;
    Ok(Json(db.read(id, false).await?.ok_or(ApiError::NotFound)?))
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn page(title: &str, body: &str) -> Html<String> {
    Html(
        include_str!("../assets/public-share.html")
            .split("{{BODY}}")
            .map(|part| part.replace("{{TITLE}}", &escape(title)))
            .collect::<Vec<_>>()
            .join(body),
    )
}
async fn public_share(
    State(db): State<Publishing>,
    Path(id): Path<Uuid>,
) -> Result<Json<ShareDocument>, ApiError> {
    let share = db.read(id, true).await?.ok_or(ApiError::NotFound)?;
    Ok(Json(share.document))
}
async fn public_page(
    State(db): State<Publishing>,
    Path(id): Path<Uuid>,
) -> Result<Html<String>, ApiError> {
    let share = db.read(id, true).await?.ok_or(ApiError::NotFound)?;
    let doc = share.document;
    let mut body = format!(
        "<header><p class=\"eyebrow\">分享生成于 {} · {} 篇</p><h1>{}</h1><p>{}</p></header>",
        escape(&doc.date),
        doc.items.len(),
        escape(&doc.title),
        escape(&doc.note)
    );
    for (index, item) in doc.items.iter().enumerate() {
        body.push_str(&format!("<article id=\"item-{index}\"><span class=\"number\">{:02}</span><h2>{}</h2><p>{}</p><div class=\"sources\">",
            index+1,escape(&item.title),escape(&item.summary)));
        for source in &item.sources {
            body.push_str(&format!(
                "<a href=\"{}\" target=\"_blank\" rel=\"noopener noreferrer\">{} · 阅读原文 ↗</a>",
                escape(&source.url),
                escape(&source.name)
            ));
        }
        body.push_str("</div></article>");
    }
    body.push_str("<footer><a class=\"cta\" href=\"/\">探索更多 NewsScout 公开内容 →</a><p>仅展示作者主动发布的分享，不访问其个人阅读库或账户。</p></footer>");
    Ok(page(&doc.title, &body))
}
async fn public_index(State(db): State<Publishing>) -> Result<Html<String>, ApiError> {
    let rows = sqlx::query(
        "SELECT id,document->>'title' AS title,document->>'date' AS date FROM reader_shares
        WHERE published AND revoked_at IS NULL ORDER BY created_at DESC,id LIMIT 30",
    )
    .fetch_all(&db.pool)
    .await
    .map_err(anyhow::Error::from)?;
    let mut body="<header><p class=\"eyebrow\">IDEAS WORTH YOUR ATTENTION</p><h1>值得阅读，<br>也值得分享。</h1><p>从原始发布者出发，阅读公开分享的文章、晨报和每周回顾。</p></header>".to_owned();
    for row in rows {
        let id: Uuid = row.try_get("id").map_err(anyhow::Error::from)?;
        let title: String = row.try_get("title").map_err(anyhow::Error::from)?;
        let date: String = row.try_get("date").map_err(anyhow::Error::from)?;
        body.push_str(&format!(
            "<article><p class=\"eyebrow\">{}</p><h2><a href=\"/share/{id}\">{}</a></h2></article>",
            escape(&date),
            escape(&title)
        ));
    }
    Ok(page("NewsScout · 公开阅读", &body))
}
pub fn public_router(db: Publishing) -> Router {
    Router::new()
        .route("/", get(public_index))
        .route("/share/{id}", get(public_page))
        .route("/api/public/shares/{id}", get(public_share))
        .route(
            "/health",
            get(|| async {
                Json(serde_json::json!({"service":"newsscout-public","readOnly":true}))
            }),
        )
        .layer(axum::middleware::from_fn(
            |request: axum::extract::Request, next: axum::middleware::Next| async move {
                let mut response = next.run(request).await;
                response.headers_mut().insert(
                    "cache-control",
                    axum::http::HeaderValue::from_static("no-store"),
                );
                response.headers_mut().insert(
                    "x-content-type-options",
                    axum::http::HeaderValue::from_static("nosniff"),
                );
                response.headers_mut().insert(
                    "referrer-policy",
                    axum::http::HeaderValue::from_static("no-referrer"),
                );
                response.into_response()
            },
        ))
        .with_state(db)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn share_projection_excludes_private_state_and_raw_feed_text() {
        let event = crate::store::MemoryStore::demo()
            .list_events(&EventQuery::default())
            .await
            .unwrap()
            .remove(0);
        let item = public_item(event).unwrap();
        assert!(item.summary.contains("请打开原始发布者"));
        let serialized = serde_json::to_value(item).unwrap();
        let mut keys = serialized
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        keys.sort();
        assert_eq!(
            keys,
            vec!["publishedAt", "sources", "summary", "summaryKind", "title"]
        );
    }

    #[tokio::test]
    async fn new_share_headings_prefer_reading_title_without_changing_originals_or_archives() {
        let mut event = crate::store::MemoryStore::demo()
            .list_events(&Default::default()).await.unwrap().remove(0);
        let original_title = event.title.clone();
        let original_evidence = serde_json::to_value(&event.evidence).unwrap();
        let original_id = event.id;
        let legacy_item = public_item(event.clone()).unwrap();
        assert_eq!(legacy_item.title, original_title);
        let archive = serde_json::to_value(&legacy_item).unwrap();
        event.display_title = Some("Agent Framework 发布新的稳定版本".into());
        let current = public_item(event.clone()).unwrap();
        assert_eq!(current.title, event.display_title.as_ref().unwrap().as_str());
        assert_eq!(display_heading(&event), current.title);
        assert_eq!(event.title, original_title);
        assert_eq!(event.id, original_id);
        assert_eq!(serde_json::to_value(&event.evidence).unwrap(), original_evidence);
        assert_eq!(serde_json::from_value::<ShareItem>(archive.clone()).unwrap().title, original_title);
        assert_eq!(serde_json::to_value(&legacy_item).unwrap(), archive);
        event.display_title = Some("  ".into());
        assert_eq!(display_heading(&event), original_title);
    }

    #[tokio::test]
    async fn isolated_public_router_never_routes_private_api_or_writes() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused@127.0.0.1/unused")
            .unwrap();
        let router = public_router(Publishing { pool });
        for path in [
            "/api/v1/model-providers",
            "/api/v1/shares",
            "/api/v1/processing",
            "/api/v1/sources",
            "/api/v1/share-settings",
        ] {
            let response = router
                .clone()
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }
        let response = router
            .oneshot(
                Request::post("/api/public/shares/00000000-0000-0000-0000-000000000001")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(response.headers()["cache-control"], "no-store");
    }

    #[test]
    fn share_html_escapes_text_and_attribute_boundaries() {
        assert_eq!(
            escape("<script a=\"'&\">"),
            "&lt;script a=&quot;&#39;&amp;&quot;&gt;"
        );
        let rendered = page("{{BODY}}", "<article>content</article>").0;
        assert_eq!(rendered.matches("<article>").count(), 1);
        assert!(rendered.contains("<title>{{BODY}}</title>"));
    }
}
