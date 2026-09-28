use super::*;

pub(super) async fn verify_admission(
    pool: &PgPool,
    app: &Router,
    existing: &Reader,
) -> anyhow::Result<()> {
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM app_users")
        .fetch_one(pool)
        .await?;
    let microsoft = Reader::new(
        app,
        principal(Uuid::new_v4(), Uuid::new_v4(), "Microsoft reader"),
    )
    .await;
    let customer = Reader::new(app, customer_principal("customer-subject", "Email reader")).await;
    assert_ne!(existing.id, microsoft.id);
    assert_ne!(existing.id, customer.id);
    assert_ne!(microsoft.id, customer.id);
    assert_ne!(microsoft.csrf, customer.csrf);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM app_users")
            .fetch_one(pool)
            .await?,
        before + 2,
        "each verified provider identity must create its own reader account"
    );
    assert_eq!(
        microsoft.ok("GET", "/api/v1/session", Value::Null).await["user"]["id"],
        microsoft.id.to_string()
    );
    assert_eq!(
        customer.ok("GET", "/api/v1/session", Value::Null).await["user"]["id"],
        customer.id.to_string()
    );
    for principal in [
        "forged".to_owned(),
        STANDARD.encode(
            serde_json::to_vec(&json!({
                "auth_typ":"unknown",
                "claims":[{"typ":"sub","val":"subject"}]
            }))
            .unwrap(),
        ),
        STANDARD.encode(
            serde_json::to_vec(&json!({
                "auth_typ":CUSTOMER_PROVIDER,
                "claims":[
                    {"typ":"iss","val":"https://wrong.example/v2.0/"},
                    {"typ":"sub","val":"subject"}
                ]
            }))
            .unwrap(),
        ),
    ] {
        let (status, _) = send(
            app,
            Some(&principal),
            "GET",
            "/api/v1/session",
            Value::Null,
            None,
            None,
            true,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    let (status, _) = send(
        app,
        None,
        "GET",
        "/api/v1/session",
        Value::Null,
        None,
        None,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM app_users")
            .fetch_one(pool)
            .await?,
        before + 2,
        "invalid or anonymous identities must not create reader accounts"
    );
    let (status, body) = send(
        app,
        None,
        "GET",
        &format!("/api/v1/public/shares/{}", Uuid::new_v4()),
        Value::Null,
        None,
        None,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    Ok(())
}
