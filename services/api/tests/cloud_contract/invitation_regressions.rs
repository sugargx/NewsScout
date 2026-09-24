use super::*;

pub(super) async fn verify_admission(
    pool: &PgPool,
    app: &Router,
    approved: &Reader,
    tenant: Uuid,
    object: Uuid,
) -> anyhow::Result<()> {
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM app_users")
        .fetch_one(pool)
        .await?;
    let closed = app::router(root(pool.clone(), &[]));
    let another_object = Uuid::new_v4();
    let another_tenant = Uuid::new_v4();
    for (router, tid, oid) in [
        (app, tenant, another_object),
        (app, another_tenant, object),
        (&closed, tenant, object),
    ] {
        let identity = principal(tid, oid, "Same display name");
        for (method, path) in [
            ("GET", "/api/v1/session"),
            ("GET", "/api/v1/events"),
            ("PUT", "/api/v1/me/interests"),
            ("POST", "/api/v1/admin/ingestion/run"),
            ("POST", "/api/v1/shares"),
            ("POST", "/api/v1/me/export"),
        ] {
            let (status, body) = send(
                router,
                Some(&identity),
                method,
                path,
                json!({}),
                Some(&approved.csrf),
                Some(ORIGIN),
                true,
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}: {body}");
            assert_eq!(body["error"], "invitation_required");
            assert_eq!(body["invitationKey"], format!("{tid}:{oid}"));
            assert!(body.get("user").is_none());
            assert!(body.get("csrfToken").is_none());
        }
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM app_users")
            .fetch_one(pool)
            .await?,
        before,
        "unapproved identities must not create or update reader accounts"
    );
    let response = closed
        .clone()
        .oneshot(
            Request::get("/api/v1/session")
                .header("x-scoutnews-proxy-token", PROXY)
                .header("x-ms-client-principal", &approved.principal)
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(response.headers()["cache-control"], "no-store, private");
    let session = approved.ok("GET", "/api/v1/session", Value::Null).await;
    assert_eq!(session["user"]["id"], approved.id.to_string());
    // Anonymous publication is an explicit capability, independent of reader admission.
    let (status, body) = send(
        &closed,
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
    assert_ne!(body["error"], "invitation_required");
    Ok(())
}
