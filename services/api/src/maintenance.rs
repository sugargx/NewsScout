use anyhow::{Context, Result, ensure};
use chrono::{DateTime, NaiveDate, Utc};
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

struct EditionCorrection {
    date: NaiveDate,
    reader: Uuid,
    cutoff: DateTime<Utc>,
    required_events: Vec<Uuid>,
}

fn parse(args: &[String]) -> Result<EditionCorrection> {
    ensure!((5..=24).contains(&args.len()) && args[0] == "--correct-saved-edition",
        "usage: --correct-saved-edition DATE READER_UUID EXPECTED_CUTOFF REQUIRED_EVENT_UUID [REQUIRED_EVENT_UUID...]");
    Ok(EditionCorrection {
        date: NaiveDate::parse_from_str(&args[1], "%Y-%m-%d").context("invalid edition date")?,
        reader: args[2].parse().context("invalid reader UUID")?,
        cutoff: args[3].parse().context("invalid expected cutoff")?,
        required_events: args[4..].iter().map(|id| id.parse().context("invalid required event UUID"))
            .collect::<Result<_>>()?,
    })
}

/// Explicit operator command; no HTTP surface, migrations, workers or model calls.
pub(crate) async fn run(args: &[String]) -> Result<()> {
    let approval = parse(args)?;
    let pool = PgPoolOptions::new().max_connections(3)
        .connect(&std::env::var("DATABASE_URL").context("DATABASE_URL is required")?).await?;
    let schema: i64 = sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations WHERE success")
        .fetch_one(&pool).await?;
    ensure!(schema >= 39, "deploy the verified coverage release before correcting an edition");
    let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM app_users WHERE id=$1)")
        .bind(approval.reader).fetch_one(&pool).await?;
    ensure!(active, "reader does not exist");
    let store = crate::postgres_store::PostgresStore::new(
        crate::scoped_db::ScopedDb::from(pool.clone()).reader(&approval.reader.to_string()),
    );
    let corrected = store.correct_saved_edition(approval.date, approval.cutoff, &approval.required_events).await?;
    pool.close().await;
    println!("{}", serde_json::json!({"corrected":corrected,"date":approval.date,"cutoff":approval.cutoff}));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn correction_requires_exact_scope_and_at_least_one_acceptance_event() {
        assert!(parse(&[]).is_err());
        assert!(parse(&vec!["--other".into(); 5]).is_err());
        let args = vec!["--correct-saved-edition".into(), "2026-10-22".into(),
            Uuid::new_v4().to_string(), "2026-10-21T22:03:40Z".into(), Uuid::new_v4().to_string()];
        let approval = parse(&args).unwrap();
        assert_eq!(approval.date.to_string(), "2026-10-22");
        assert_eq!(approval.required_events.len(), 1);
        assert!(parse(&args[..4]).is_err());
    }
}
