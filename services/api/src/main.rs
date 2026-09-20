mod app;
mod automation;
mod browser_articles;
mod coverage;
mod edition;
mod ingestion;
mod models;
mod postgres_store;
mod processing;
mod publishing;
mod reader;
mod reading_context;
mod reddit_comments;
mod source_directory;
mod store;
mod summary;
mod visitor_interests;
mod x_public_posts;

use anyhow::Result;
use app::AppState;
use ingestion::FeedWorker;
use postgres_store::PostgresStore;
use sqlx::postgres::PgPoolOptions;
use std::{env, sync::Arc};
use store::{MemoryStore, Store};

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "scoutnews_api=info,tower_http=info".into()),
        )
        .init();
    let public_only =
        env::var("SCOUTNEWS_PUBLIC_ONLY").is_ok_and(|value| value.eq_ignore_ascii_case("true"));
    let bind = env::var("SCOUTNEWS_BIND").unwrap_or_else(|_| {
        if public_only {
            "127.0.0.1:8081".into()
        } else {
            "127.0.0.1:8080".into()
        }
    });
    if public_only {
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .after_connect(|connection, _| {
                Box::pin(async move {
                    sqlx::query("SET default_transaction_read_only=on")
                        .execute(connection)
                        .await?;
                    Ok(())
                })
            })
            .connect(&env::var("DATABASE_URL")?)
            .await?;
        let ready: bool = sqlx::query_scalar("SELECT to_regclass('reader_shares') IS NOT NULL")
            .fetch_one(&pool)
            .await?;
        anyhow::ensure!(
            ready,
            "Initialize the private reader database before starting the read-only share site"
        );
        let listener = tokio::net::TcpListener::bind(&bind).await?;
        tracing::info!(%bind,"NewsScout read-only share site; no private routes, migrations, account restore or workers");
        axum::serve(
            listener,
            publishing::public_router(publishing::Publishing { pool }),
        )
        .await?;
        return Ok(());
    }
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let demo_mode =
        env::var("SCOUTNEWS_DEMO_MODE").is_ok_and(|value| value.eq_ignore_ascii_case("true"));
    let mut feed_worker = None;
    let mut automation = None;
    let mut edition = None;
    let mut publishing = None;
    let store: Arc<dyn Store> = if demo_mode {
        tracing::warn!("running with volatile demo data");
        Arc::new(MemoryStore::demo())
    } else {
        let database_url = env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(&database_url)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        source_directory::import(&pool).await?;
        automation = Some(automation::AutomationStore::new(pool.clone()));
        edition = Some(edition::EditionStore::new(pool.clone()));
        publishing = Some(publishing::Publishing { pool: pool.clone() });
        let worker = FeedWorker::new(pool.clone(), http.clone());
        feed_worker = Some(worker);
        Arc::new(PostgresStore::new(pool))
    };
    let state = AppState {
        store,
        http,
        oauth_states: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        provider: Arc::new(tokio::sync::RwLock::new(app::ProviderConnection::default())),
        feed_worker,
        generation_lock: Arc::new(tokio::sync::Mutex::new(())),
        automation,
        edition,
        publishing,
    };
    if !demo_mode
        && !env::var("SCOUTNEWS_DISABLE_COPILOT_RESTORE")
            .is_ok_and(|value| value.eq_ignore_ascii_case("true"))
    {
        if let Err(error) = app::restore_copilot(&state).await {
            tracing::warn!(?error, "selected Copilot connection could not be restored");
        }
    }
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    if state.automation.is_some() {
        automation::spawn(state.clone());
    }
    if state.edition.is_some() {
        edition::spawn(state.clone());
    }
    tracing::info!(%bind, "ScoutNews API listening");
    axum::serve(listener, app::router(state)).await?;
    Ok(())
}
