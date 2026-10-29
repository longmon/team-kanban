use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use super::{org_json, user_full};
use crate::{
    AppState, audit,
    auth::{Caller, clear_cookie, create_session, session_cookie},
    error::{AppError, AppResult, JsonBody, unique_violation},
    ratelimit::{HOUR, MIN, MIN15},
    routes::invites::invite_by_token,
    util::{email_field, hash_password, new_id, password_field, random_token, sha256, text_field, verify_password},
};

#[derive(Deserialize)]
pub struct RegisterReq {
    email: String,
    password: String,
    display_name: String,
    invite_token: Option<String>,
}

fn ua(h: &HeaderMap) -> Option<&str> {
    h.get(header::USER_AGENT).and_then(|v| v.to_str().ok())
}

async fn issue_email_token(db: &PgPool, user_id: Uuid, purpose: &str, hours: i32) -> AppResult<String> {
    let token = random_token();
    sqlx::query(
        "INSERT INTO email_tokens (id, user_id, purpose, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))",
    )
    .bind(new_id())
    .bind(user_id)
    .bind(purpose)
    .bind(sha256(&token))
    .bind(hours)
    .execute(db)
    .await?;
    Ok(token)
}

async fn send_verification(st: &AppState, user_id: Uuid, email: &str) -> AppResult<()> {
    let token = issue_email_token(&st.db, user_id, "verify_email", 24).await?;
    let link = format!("{}/verify-email?token={token}", st.cfg.public_url);
    st.mail.send(email, "验证你的邮箱", format!("点击链接验证邮箱（24 小时内有效）：\n{link}\n"));
    Ok(())
}

async fn logged_in(st: &AppState, user_id: Uuid, c: &Caller, h: &HeaderMap, status: StatusCode) -> AppResult<Response> {
    let (token, csrf) = create_session(&st.db, user_id, &c.ip, ua(h)).await?;
    let body = json!({ "user": user_full(&st.db, user_id).await?, "csrf_token": csrf });
    Ok((status, [(header::SET_COOKIE, session_cookie(st, &token))], Json(body)).into_response())
}

pub async fn register(State(st): State<AppState>, c: Caller, h: HeaderMap, JsonBody(r): JsonBody<RegisterReq>) -> AppResult<Response> {
    st.rl.hit(&format!("register:{}", c.ip), 5, HOUR)?;
    let email = email_field(&r.email)?;
    password_field("password", &r.password)?;
    let name = text_field("display_name", &r.display_name, 1, 50)?;
    if !st.cfg.allow_signup {
        let ok = match r.invite_token.as_deref() {
            Some(t) => invite_by_token(&st.db, t).await.is_ok_and(|i| i.active_error().is_none()),
            None => false,
        };
        if !ok {
            return Err(AppError::new(StatusCode::FORBIDDEN, "signup_disabled", "当前只能凭邀请链接注册"));
        }
    }
    let hash = hash_password(r.password).await?;
    let id = new_id();
    let mut tx = st.db.begin().await?;
    let ins = sqlx::query("INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)")
        .bind(id)
        .bind(&email)
        .bind(hash)
        .bind(&name)
        .execute(&mut *tx)
        .await;
    if let Err(e) = ins {
        return Err(if unique_violation(&e).is_some() { AppError::conflict("email_taken", "该邮箱已注册") } else { e.into() });
    }
    let mut actor = c.actor();
    actor.user_id = Some(id);
    audit::log(&mut tx, None, &actor, "auth.register", "user", Some(id), json!({})).await?;
    tx.commit().await?;
    send_verification(&st, id, &email).await?;
    logged_in(&st, id, &c, &h, StatusCode::CREATED).await
}

#[derive(Deserialize)]
pub struct LoginReq {
    email: String,
    password: String,
}

pub async fn login(State(st): State<AppState>, c: Caller, h: HeaderMap, JsonBody(r): JsonBody<LoginReq>) -> AppResult<Response> {
    st.rl.hit(&format!("login:{}", c.ip), 20, MIN)?;
    let email = r.email.trim().to_lowercase();
    let key = format!("login_fail:{email}");
    st.rl.check(&key, 10).map_err(AppError::rate_limited)?;
    let row: Option<(Uuid, String, bool)> = sqlx::query_as("SELECT id, password_hash, disabled_at IS NOT NULL FROM users WHERE email = $1")
        .bind(&email)
        .fetch_optional(&st.db)
        .await?;
    let (id, hash, disabled) = row.map_or((None, None, false), |(i, h, d)| (Some(i), Some(h), d));
    if !verify_password(r.password, hash).await {
        st.rl.fail(&key, 10, MIN15);
        return Err(AppError::new(StatusCode::UNAUTHORIZED, "invalid_credentials", "邮箱或密码错误"));
    }
    st.rl.clear(&key);
    // 密码正确后才提示已禁用（不向猜密码的人暴露账号状态）
    if disabled {
        return Err(AppError::new(StatusCode::FORBIDDEN, "account_disabled", "账号已被停用，请联系管理员"));
    }
    logged_in(&st, id.expect("verified"), &c, &h, StatusCode::OK).await
}

pub async fn logout(State(st): State<AppState>, c: Caller) -> AppResult<Response> {
    if c.p.is_pat() {
        return Err(AppError::forbidden());
    }
    if let Ok((_, session_id, _)) = c.session() {
        sqlx::query("DELETE FROM sessions WHERE id = $1").bind(session_id).execute(&st.db).await?;
    }
    Ok((StatusCode::NO_CONTENT, [(header::SET_COOKIE, clear_cookie(&st))]).into_response())
}

pub async fn me(State(st): State<AppState>, c: Caller) -> AppResult<Json<serde_json::Value>> {
    let (uid, _, csrf) = c.session()?;
    let rows: Vec<(Uuid, String, String, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT o.id, o.name, o.slug, m.role, o.created_at FROM memberships m JOIN orgs o ON o.id = m.org_id AND o.deleted_at IS NULL
          WHERE m.user_id = $1 ORDER BY o.id DESC",
    )
    .bind(uid)
    .fetch_all(&st.db)
    .await?;
    let orgs: Vec<_> = rows.iter().map(|(id, n, s, r, t)| org_json(*id, n, s, r, t)).collect();
    Ok(Json(json!({ "user": user_full(&st.db, uid).await?, "csrf_token": csrf, "orgs": orgs })))
}

#[derive(Deserialize)]
pub struct UpdateMeReq {
    display_name: String,
}

pub async fn update_me(State(st): State<AppState>, c: Caller, JsonBody(r): JsonBody<UpdateMeReq>) -> AppResult<Json<serde_json::Value>> {
    let uid = c.session_user()?;
    let name = text_field("display_name", &r.display_name, 1, 50)?;
    sqlx::query("UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1").bind(uid).bind(name).execute(&st.db).await?;
    Ok(Json(json!({ "user": user_full(&st.db, uid).await? })))
}

#[derive(Deserialize)]
pub struct TokenReq {
    token: String,
}

fn token_invalid() -> AppError {
    AppError::gone("token_invalid", "链接无效、已过期或已使用")
}

/// 原子消费一次性邮件 token，返回 user_id
async fn consume_email_token(conn: &mut sqlx::PgConnection, token: &str, purpose: &str) -> AppResult<Uuid> {
    sqlx::query_scalar(
        "UPDATE email_tokens SET used_at = now() WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
         RETURNING user_id",
    )
    .bind(sha256(token))
    .bind(purpose)
    .fetch_optional(conn)
    .await?
    .ok_or_else(token_invalid)
}

pub async fn verify_email(State(st): State<AppState>, JsonBody(r): JsonBody<TokenReq>) -> AppResult<StatusCode> {
    let mut tx = st.db.begin().await?;
    let uid = consume_email_token(&mut tx, &r.token, "verify_email").await?;
    sqlx::query("UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1")
        .bind(uid)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// 忘记密码 / 重发验证：IP 5/小时，同邮箱 3/小时；超限静默成功
fn quiet_limit(st: &AppState, ip: &str, email: &str) -> bool {
    st.rl.try_hit(&format!("mail_ip:{ip}"), 5, HOUR).is_ok() && st.rl.try_hit(&format!("mail_email:{email}"), 3, HOUR).is_ok()
}

pub async fn resend_verification(State(st): State<AppState>, c: Caller) -> AppResult<StatusCode> {
    let uid = c.session_user()?;
    let (email, verified): (String, Option<DateTime<Utc>>) =
        sqlx::query_as("SELECT email, email_verified_at FROM users WHERE id = $1").bind(uid).fetch_one(&st.db).await?;
    if verified.is_none() && quiet_limit(&st, &c.ip, &email) {
        send_verification(&st, uid, &email).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct ForgotReq {
    email: String,
}

pub async fn forgot_password(State(st): State<AppState>, c: Caller, JsonBody(r): JsonBody<ForgotReq>) -> AppResult<StatusCode> {
    let email = r.email.trim().to_lowercase();
    if !quiet_limit(&st, &c.ip, &email) {
        return Ok(StatusCode::NO_CONTENT);
    }
    let uid: Option<Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE email = $1").bind(&email).fetch_optional(&st.db).await?;
    if let Some(uid) = uid {
        let token = issue_email_token(&st.db, uid, "reset_password", 1).await?;
        let link = format!("{}/reset-password?token={token}", st.cfg.public_url);
        st.mail.send(&email, "重置密码", format!("点击链接重置密码（1 小时内有效）：\n{link}\n如果不是你本人操作，请忽略此邮件。\n"));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct ResetReq {
    token: String,
    password: String,
}

pub async fn reset_password(State(st): State<AppState>, c: Caller, JsonBody(r): JsonBody<ResetReq>) -> AppResult<StatusCode> {
    password_field("password", &r.password)?;
    let hash = hash_password(r.password).await?;
    let mut tx = st.db.begin().await?;
    let uid = consume_email_token(&mut tx, &r.token, "reset_password").await?;
    sqlx::query("UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1")
        .bind(uid)
        .bind(hash)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(uid).execute(&mut *tx).await?;
    let mut actor = c.actor();
    actor.user_id = Some(uid);
    audit::log(&mut tx, None, &actor, "auth.password_reset", "user", Some(uid), json!({})).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct ChangeReq {
    current_password: String,
    new_password: String,
}

pub async fn change_password(State(st): State<AppState>, c: Caller, JsonBody(r): JsonBody<ChangeReq>) -> AppResult<StatusCode> {
    let (uid, session_id, _) = c.session()?;
    let (hash, must_change): (String, bool) =
        sqlx::query_as("SELECT password_hash, must_change_password FROM users WHERE id = $1").bind(uid).fetch_one(&st.db).await?;
    if must_change && r.new_password == r.current_password {
        return Err(AppError::field("new_password", "新密码不能与初始密码相同"));
    }
    if !verify_password(r.current_password, Some(hash)).await {
        return Err(AppError::new(StatusCode::UNAUTHORIZED, "invalid_credentials", "当前密码错误"));
    }
    password_field("new_password", &r.new_password)?;
    let hash = hash_password(r.new_password).await?;
    let mut tx = st.db.begin().await?;
    sqlx::query("UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1")
        .bind(uid)
        .bind(hash)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2").bind(uid).bind(session_id).execute(&mut *tx).await?;
    audit::log(&mut tx, None, &c.actor(), "auth.password_change", "user", Some(uid), json!({})).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
