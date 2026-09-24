use futures_util::{TryStreamExt, future::BoxFuture, stream::BoxStream};
use sqlx::{
    Describe, Either, Error, Execute, Executor, PgPool, Postgres, Transaction,
    postgres::{PgQueryResult, PgRow, PgStatement},
};
use std::sync::Arc;

/// A capability, not a session variable. Every reader operation gets a new
/// transaction; cancellation/drop rolls back both the role and actor setting.
#[derive(Clone, Debug)]
pub struct ScopedDb {
    pool: PgPool,
    actor: Option<Arc<str>>,
}

impl From<PgPool> for ScopedDb {
    fn from(pool: PgPool) -> Self {
        Self { pool, actor: None }
    }
}

impl ScopedDb {
    pub fn reader(&self, actor: &str) -> Self {
        Self {
            pool: self.pool.clone(),
            actor: Some(actor.into()),
        }
    }

    pub fn actor(&self) -> &str {
        self.actor.as_deref().unwrap_or("local")
    }

    pub fn is_reader(&self) -> bool {
        self.actor.is_some()
    }

    pub async fn begin(&self) -> Result<Transaction<'static, Postgres>, Error> {
        self.begin_with_snapshot(false).await
    }

    pub async fn begin_snapshot(&self) -> Result<Transaction<'static, Postgres>, Error> {
        self.begin_with_snapshot(true).await
    }

    async fn begin_with_snapshot(
        &self,
        snapshot: bool,
    ) -> Result<Transaction<'static, Postgres>, Error> {
        let mut tx = self.pool.begin().await?;
        if snapshot {
            sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
                .execute(&mut *tx)
                .await?;
        }
        if let Some(actor) = &self.actor {
            sqlx::query("SELECT set_config('scoutnews.actor',$1,true)")
                .bind(actor.as_ref())
                .execute(&mut *tx)
                .await?;
            sqlx::query("SET LOCAL ROLE scoutnews_reader")
                .execute(&mut *tx)
                .await?;
            sqlx::query("SET LOCAL statement_timeout='30s'")
                .execute(&mut *tx)
                .await?;
        }
        Ok(tx)
    }
}

impl<'c> Executor<'c> for &'c ScopedDb {
    type Database = Postgres;

    fn fetch_many<'e, 'q: 'e, E: 'q>(
        self,
        query: E,
    ) -> BoxStream<'e, Result<Either<PgQueryResult, PgRow>, Error>>
    where
        'c: 'e,
        E: Execute<'q, Postgres>,
    {
        if self.actor.is_none() {
            return (&self.pool).fetch_many(query);
        }
        Box::pin(async_stream::try_stream! {
            let mut tx = self.begin().await?;
            {
                let mut rows = (&mut *tx).fetch_many(query);
                while let Some(row) = rows.try_next().await? {
                    yield row;
                }
            }
            tx.commit().await?;
        })
    }

    fn fetch_optional<'e, 'q: 'e, E: 'q>(
        self,
        query: E,
    ) -> BoxFuture<'e, Result<Option<PgRow>, Error>>
    where
        'c: 'e,
        E: Execute<'q, Postgres>,
    {
        Box::pin(async move {
            if self.actor.is_none() {
                return (&self.pool).fetch_optional(query).await;
            }
            let mut tx = self.begin().await?;
            let result = (&mut *tx).fetch_optional(query).await?;
            tx.commit().await?;
            Ok(result)
        })
    }

    fn prepare_with<'e, 'q: 'e>(
        self,
        sql: &'q str,
        parameters: &'e [sqlx::postgres::PgTypeInfo],
    ) -> BoxFuture<'e, Result<PgStatement<'q>, Error>>
    where
        'c: 'e,
    {
        Box::pin(async move {
            let mut tx = self.begin().await?;
            let result = (&mut *tx).prepare_with(sql, parameters).await?;
            tx.commit().await?;
            Ok(result)
        })
    }

    fn describe<'e, 'q: 'e>(self, sql: &'q str) -> BoxFuture<'e, Result<Describe<Postgres>, Error>>
    where
        'c: 'e,
    {
        Box::pin(async move {
            let mut tx = self.begin().await?;
            let result = (&mut *tx).describe(sql).await?;
            tx.commit().await?;
            Ok(result)
        })
    }
}
