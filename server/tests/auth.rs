//! 注册、登录、登出、CSRF、邮箱验证、改密/重置、限流
mod common;

use common::*;
use serde_json::json;

async fn insert_email_token(h: &H, user_id: &str, purpose: &str, token: &str) {
    use sha2::{Digest, Sha256};
    sqlx::query("INSERT INTO email_tokens (id, user_id, purpose, token_hash, expires_at) VALUES ($1, $2::uuid, $3, $4, now() + interval '1 hour')")
        .bind(uuid::Uuid::now_v7())
        .bind(user_id)
        .bind(purpose)
        .bind(Sha256::digest(token.as_bytes()).to_vec())
        .execute(&h.db)
        .await
        .unwrap();
}

#[tokio::test]
async fn register_login_logout_csrf() {
    let h = H::new().await;
    let ip = fresh_ip();
    let anon = C { ip: ip.clone(), ..Default::default() };
    let r = h.req(&anon, "POST", "/api/auth/register", Some(json!({ "email": "  Alice@Example.COM ", "password": "password-123", "display_name": "Alice" }))).await;
    let body = r.ok(201);
    assert_eq!(body["user"]["email"], "alice@example.com");
    assert_eq!(body["user"]["email_verified"], false);
    let cookie = r.header("set-cookie");
    assert!(cookie.starts_with("relay_session=") && cookie.contains("HttpOnly") && cookie.contains("SameSite=Lax"), "{cookie}");
    assert_eq!(r.header("cache-control"), "no-store");
    let a = session_from(&r, &ip);

    let me = h.req(&a, "GET", "/api/auth/me", None).await.ok(200);
    assert_eq!(me["csrf_token"], a.csrf.clone().unwrap().as_str());
    assert_eq!(me["orgs"], json!([]));

    // 重复邮箱、参数校验
    let r = h.req(&C::anon(), "POST", "/api/auth/register", Some(json!({ "email": "alice@example.com", "password": "password-123", "display_name": "A2" }))).await;
    assert_eq!((r.status, r.code()), (409, "email_taken".into()));
    let r = h.req(&C::anon(), "POST", "/api/auth/register", Some(json!({ "email": "b@example.com", "password": "short", "display_name": "B" }))).await;
    assert_eq!((r.status, r.code()), (400, "validation_failed".into()));
    assert!(r.json()["error"]["details"]["fields"]["password"].is_string());

    // CSRF：缺 token / 错 token / 错 Origin → 403；正确 → 200
    let no_csrf = C { csrf: None, ..a.clone() };
    let r = h.req(&no_csrf, "PATCH", "/api/auth/me", Some(json!({ "display_name": "X" }))).await;
    assert_eq!((r.status, r.code()), (403, "csrf_failed".into()));
    let bad = C { csrf: Some("nope".into()), ..a.clone() };
    assert_eq!(h.req(&bad, "PATCH", "/api/auth/me", Some(json!({ "display_name": "X" }))).await.status, 403);
    let r = h.raw(&a, "PATCH", "/api/auth/me", Some(r#"{"display_name":"X"}"#.into()), &[("origin", "https://evil.example")]).await;
    assert_eq!((r.status, r.code()), (403, "csrf_failed".into()));
    let r = h.raw(&a, "PATCH", "/api/auth/me", Some(r#"{"display_name":"Alice2"}"#.into()), &[("origin", PUBLIC)]).await;
    assert_eq!(r.ok(200)["user"]["display_name"], "Alice2");
    // 匿名请求也检查 Origin
    let r = h.raw(&C::anon(), "POST", "/api/auth/login", Some(r#"{"email":"a@b.c","password":"x"}"#.into()), &[("origin", "https://evil.example")]).await;
    assert_eq!(r.status, 403);

    // 415 / invalid_json
    let r = h.raw(&a, "PATCH", "/api/auth/me", Some("display_name=x".into()), &[("content-type", "application/x-www-form-urlencoded")]).await;
    assert_eq!((r.status, r.code()), (415, "unsupported_media_type".into()));
    let r = h.raw(&a, "PATCH", "/api/auth/me", Some("{bad".into()), &[]).await;
    assert_eq!((r.status, r.code()), (400, "invalid_json".into()));
    assert_eq!(h.req(&a, "GET", "/api/nope", None).await.code(), "not_found");
    assert_eq!(h.req(&a, "PUT", "/api/auth/me", None).await.status, 405);

    // 邮箱验证
    insert_email_token(&h, &a.user_id, "verify_email", "verify-tok").await;
    h.req(&C::anon(), "POST", "/api/auth/verify-email", Some(json!({ "token": "verify-tok" }))).await.ok(204);
    assert_eq!(h.req(&a, "GET", "/api/auth/me", None).await.json()["user"]["email_verified"], true);
    let r = h.req(&C::anon(), "POST", "/api/auth/verify-email", Some(json!({ "token": "verify-tok" }))).await;
    assert_eq!((r.status, r.code()), (410, "token_invalid".into()));

    // 第二个会话；改密码后其它会话失效
    let r = h.req(&C::anon(), "POST", "/api/auth/login", Some(json!({ "email": "alice@example.com", "password": "password-123" }))).await;
    let a2 = session_from(&r, &fresh_ip());
    let r = h.req(&a, "POST", "/api/auth/password/change", Some(json!({ "current_password": "wrong-password", "new_password": "password-456" }))).await;
    assert_eq!((r.status, r.code()), (401, "invalid_credentials".into()));
    h.req(&a, "POST", "/api/auth/password/change", Some(json!({ "current_password": "password-123", "new_password": "password-456" }))).await.ok(204);
    assert_eq!(h.req(&a2, "GET", "/api/auth/me", None).await.status, 401);
    h.req(&a, "GET", "/api/auth/me", None).await.ok(200);

    // 登出
    let r = h.req(&a, "POST", "/api/auth/logout", None).await;
    assert_eq!(r.status, 204);
    assert!(r.header("set-cookie").contains("Max-Age=0"));
    assert_eq!(h.req(&a, "GET", "/api/auth/me", None).await.code(), "unauthenticated");

    // 登录失败不区分邮箱是否存在
    for email in ["alice@example.com", "ghost@example.com"] {
        let r = h.req(&C::anon(), "POST", "/api/auth/login", Some(json!({ "email": email, "password": "password-123" }))).await;
        assert_eq!((r.status, r.code()), (401, "invalid_credentials".into()));
    }
    h.req(&C::anon(), "POST", "/api/auth/login", Some(json!({ "email": "ALICE@example.com", "password": "password-456" }))).await.ok(200);

    // 忘记密码恒 204；重置密码删除全部会话
    h.req(&C::anon(), "POST", "/api/auth/password/forgot", Some(json!({ "email": "ghost@example.com" }))).await.ok(204);
    h.req(&C::anon(), "POST", "/api/auth/password/forgot", Some(json!({ "email": "alice@example.com" }))).await.ok(204);
    let r = h.req(&C::anon(), "POST", "/api/auth/login", Some(json!({ "email": "alice@example.com", "password": "password-456" }))).await;
    let a3 = session_from(&r, &fresh_ip());
    insert_email_token(&h, &a.user_id, "reset_password", "reset-tok").await;
    let r = h.req(&C::anon(), "POST", "/api/auth/password/reset", Some(json!({ "token": "bad", "password": "password-789" }))).await;
    assert_eq!(r.status, 410);
    h.req(&C::anon(), "POST", "/api/auth/password/reset", Some(json!({ "token": "reset-tok", "password": "password-789" }))).await.ok(204);
    assert_eq!(h.req(&a3, "GET", "/api/auth/me", None).await.status, 401);
    h.req(&C::anon(), "POST", "/api/auth/login", Some(json!({ "email": "alice@example.com", "password": "password-789" }))).await.ok(200);

    // 审计
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action IN ('auth.register', 'auth.password_change', 'auth.password_reset')")
        .fetch_one(&h.db)
        .await
        .unwrap();
    assert_eq!(n, 3);
}

#[tokio::test]
async fn signup_disabled_requires_invite() {
    let h = H::with(|c| c.allow_signup = false).await;
    let r = h.req(&C::anon(), "POST", "/api/auth/register", Some(json!({ "email": "x@example.com", "password": "password-123", "display_name": "X" }))).await;
    assert_eq!((r.status, r.code()), (403, "signup_disabled".into()));
    // 手工造一个用户和组织，发邀请后可凭邀请注册
    let uid = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, 'o@example.com', 'x', 'O')").bind(uid).execute(&h.db).await.unwrap();
    let ip = fresh_ip();
    let r = h.req(&C { ip: ip.clone(), ..Default::default() }, "POST", "/api/auth/login", Some(json!({ "email": "o@example.com", "password": "x" }))).await;
    assert_eq!(r.status, 401);
    // 直接在库里放邀请（token 已知）
    use sha2::{Digest, Sha256};
    let oid = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO orgs (id, name, slug, created_by) VALUES ($1, 'o', 'o', $2)").bind(oid).bind(uid).execute(&h.db).await.unwrap();
    sqlx::query("INSERT INTO invites (id, org_id, target_type, role, token_hash, created_by, expires_at) VALUES ($1, $2, 'org', 'member', $3, $4, now() + interval '1 day')")
        .bind(uuid::Uuid::now_v7())
        .bind(oid)
        .bind(Sha256::digest(b"inv-tok").to_vec())
        .bind(uid)
        .execute(&h.db)
        .await
        .unwrap();
    let body = json!({ "email": "x@example.com", "password": "password-123", "display_name": "X", "invite_token": "inv-tok" });
    h.req(&C::anon(), "POST", "/api/auth/register", Some(body)).await.ok(201);
}

#[tokio::test]
async fn rate_limits() {
    let h = H::new().await;
    // 登录：IP 20/分钟
    let c = C::anon();
    for i in 0..20 {
        let r = h.req(&c, "POST", "/api/auth/login", Some(json!({ "email": format!("n{i}@example.com"), "password": "x" }))).await;
        assert_eq!(r.status, 401);
    }
    let r = h.req(&c, "POST", "/api/auth/login", Some(json!({ "email": "n@example.com", "password": "x" }))).await;
    assert_eq!((r.status, r.code()), (429, "rate_limited".into()));
    assert!(r.header("retry-after").parse::<u64>().unwrap() >= 1);

    // 登录：同邮箱失败 10 次后锁定（即使密码正确）
    register(&h, "victim@example.com").await;
    for _ in 0..10 {
        let r = h.req(&C::anon(), "POST", "/api/auth/login", Some(json!({ "email": "victim@example.com", "password": "wrong-pass" }))).await;
        assert_eq!(r.status, 401);
    }
    let r = h.req(&C::anon(), "POST", "/api/auth/login", Some(json!({ "email": "victim@example.com", "password": "password-123" }))).await;
    assert_eq!(r.status, 429);

    // 注册：IP 5/小时
    let c = C::anon();
    for i in 0..5 {
        let r = h.req(&c, "POST", "/api/auth/register", Some(json!({ "email": format!("r{i}@example.com"), "password": "password-123", "display_name": "R" }))).await;
        assert_eq!(r.status, 201);
    }
    let r = h.req(&c, "POST", "/api/auth/register", Some(json!({ "email": "r9@example.com", "password": "password-123", "display_name": "R" }))).await;
    assert_eq!(r.status, 429);

    // 提交：IP 30/分钟
    let owner = register(&h, "owner@example.com").await;
    let org = create_org(&h, &owner, "rl").await;
    let proj = create_project(&h, &owner, &org, "p").await;
    let page = publish(&h, &owner, &proj, "public", &[]).await;
    let anon = C::anon();
    let body = json!({ "data": {}, "nickname": "n" });
    for _ in 0..30 {
        h.req(&anon, "POST", &format!("/api/pages/{page}/responses"), Some(body.clone())).await.ok(201);
    }
    assert_eq!(h.req(&anon, "POST", &format!("/api/pages/{page}/responses"), Some(body)).await.status, 429);

    // 其它已认证 API：用户 600/分钟
    let u = register(&h, "busy@example.com").await;
    for _ in 0..600 {
        assert_eq!(h.req(&u, "GET", "/api/auth/me", None).await.status, 200);
    }
    assert_eq!(h.req(&u, "GET", "/api/auth/me", None).await.status, 429);
}
