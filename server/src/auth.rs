//! 认证层：只回答「是谁」→ Principal（design §5.1 第 1 层），并在此校验 CSRF / Origin、通用限流
use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, FromRequestParts, Request, State},
    http::{HeaderMap, HeaderValue, Method, header, request::Parts},
    middleware::Next,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Duration, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    AppState,
    error::{AppError, AppResult},
    ratelimit::MIN,
    util::{ct_eq, new_id, random_token, sha256},
};

pub const SESSION_DAYS: i64 = 30;

#[derive(Clone, Debug)]
pub enum Principal {
    Anonymous,
    User(UserPrincipal),
}

#[derive(Clone, Debug)]
pub struct UserPrincipal {
    pub user_id: Uuid,
    pub via: Via,
}

#[derive(Clone, Debug)]
pub enum Via {
    Session { session_id: Uuid, csrf: String },
    Pat(PatInfo),
}

#[derive(Clone, Debug)]
pub struct PatInfo {
    pub id: Uuid,
    pub org_id: Option<Uuid>,
    pub project_id: Option<Uuid>,
    pub scopes: Vec<String>,
}

impl Principal {
    pub fn user_id(&self) -> Option<Uuid> {
        match self {
            Principal::User(u) => Some(u.user_id),
            Principal::Anonymous => None,
        }
    }
    pub fn pat(&self) -> Option<&PatInfo> {
        match self {
            Principal::User(UserPrincipal { via: Via::Pat(p), .. }) => Some(p),
            _ => None,
        }
    }
    pub fn is_pat(&self) -> bool {
        self.pat().is_some()
    }
}

/// 调用方：principal + 客户端 IP。所有 /api handler 从这里拿身份
#[derive(Clone, Debug)]
pub struct Caller {
    pub p: Principal,
    pub ip: String,
}

/// 审计用的行为人
pub struct Actor {
    pub user_id: Option<Uuid>,
    pub pat_id: Option<Uuid>,
    pub ip: String,
}

impl Caller {
    pub fn actor(&self) -> Actor {
        Actor { user_id: self.p.user_id(), pat_id: self.p.pat().map(|p| p.id), ip: self.ip.clone() }
    }

    /// 仅 cookie 会话可用的接口：匿名 401，PAT 403
    pub fn session(&self) -> AppResult<(Uuid, Uuid, &str)> {
        match &self.p {
            Principal::User(UserPrincipal { user_id, via: Via::Session { session_id, csrf } }) => {
                Ok((*user_id, *session_id, csrf.as_str()))
            }
            Principal::User(_) => Err(AppError::forbidden()),
            Principal::Anonymous => Err(AppError::unauthenticated()),
        }
    }

    pub fn session_user(&self) -> AppResult<Uuid> {
        self.session().map(|s| s.0)
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Caller {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, AppError> {
        parts.extensions.get::<Caller>().cloned().ok_or_else(|| AppError::internal("Caller 缺失"))
    }
}

pub fn client_ip(headers: &HeaderMap, conn: Option<&ConnectInfo<SocketAddr>>, trust_proxy: bool) -> String {
    if trust_proxy {
        let xff = headers.get_all("x-forwarded-for").iter().filter_map(|v| v.to_str().ok()).next_back();
        if let Some(ip) = xff.and_then(|v| v.rsplit(',').next()).map(str::trim).filter(|s| s.parse::<std::net::IpAddr>().is_ok()) {
            return ip.to_string();
        }
    }
    conn.map_or_else(|| "127.0.0.1".to_string(), |c| c.0.ip().to_string())
}

pub fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v)
}

fn origin_of(url: &str) -> &str {
    match url.find("://") {
        Some(i) => url[i + 3..].find('/').map_or(url, |j| &url[..i + 3 + j]),
        None => url,
    }
}

/// /api/* 中间件
pub async fn api_auth(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let (mut parts, body) = req.into_parts();
    match resolve(&st, &parts).await {
        Ok(caller) => {
            parts.extensions.insert(caller);
            next.run(Request::from_parts(parts, body)).await
        }
        Err(e) => e.into_response(),
    }
}

async fn resolve(st: &AppState, req: &Parts) -> AppResult<Caller> {
    let h = &req.headers;
    let ip = client_ip(h, req.extensions.get::<ConnectInfo<SocketAddr>>(), st.cfg.trust_proxy);
    let unsafe_method = !matches!(req.method, Method::GET | Method::HEAD | Method::OPTIONS);

    let p = if let Some(auth) = h.get(header::AUTHORIZATION) {
        // 带 Authorization 只认 PAT，无效即 401，不回落 cookie
        let token = auth.to_str().ok().and_then(|v| v.strip_prefix("Bearer ")).map(str::trim).filter(|t| t.starts_with("arp_"));
        let token = token.ok_or_else(AppError::unauthenticated)?;
        Principal::User(load_pat(&st.db, token).await?.ok_or_else(AppError::unauthenticated)?)
    } else if let Some(token) = cookie(h, st.cfg.session_cookie_name()) {
        load_session(&st.db, token).await?.map_or(Principal::Anonymous, Principal::User)
    } else {
        Principal::Anonymous
    };

    if unsafe_method && !p.is_pat() {
        if let Some(o) = h.get(header::ORIGIN)
            && o.as_bytes() != origin_of(&st.cfg.public_url).as_bytes() {
                return Err(AppError::csrf());
            }
        if let Principal::User(UserPrincipal { via: Via::Session { csrf, .. }, .. }) = &p {
            let sent = h.get("x-csrf-token").map(|v| v.as_bytes()).unwrap_or_default();
            if !ct_eq(sent, csrf.as_bytes()) {
                return Err(AppError::csrf());
            }
        }
    }

    match &p {
        Principal::User(UserPrincipal { via: Via::Pat(pat), .. }) => st.rl.hit(&format!("api:pat:{}", pat.id), 600, MIN)?,
        Principal::User(u) => st.rl.hit(&format!("api:user:{}", u.user_id), 600, MIN)?,
        Principal::Anonymous => {}
    }
    Ok(Caller { p, ip })
}

async fn load_session(db: &PgPool, token: &str) -> AppResult<Option<UserPrincipal>> {
    let row: Option<(Uuid, Uuid, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT id, user_id, csrf_token, last_seen_at FROM sessions WHERE token_hash = $1 AND expires_at > now()",
    )
    .bind(sha256(token))
    .fetch_optional(db)
    .await?;
    let Some((session_id, user_id, csrf, last_seen)) = row else { return Ok(None) };
    // 滑动续期，最多每小时写一次
    if Utc::now() - last_seen > Duration::hours(1) {
        sqlx::query("UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(days => $2) WHERE id = $1")
            .bind(session_id)
            .bind(SESSION_DAYS as i32)
            .execute(db)
            .await?;
    }
    Ok(Some(UserPrincipal { user_id, via: Via::Session { session_id, csrf } }))
}

type PatRow = (Uuid, Uuid, Option<Uuid>, Option<Uuid>, Vec<String>, Option<DateTime<Utc>>);

async fn load_pat(db: &PgPool, token: &str) -> AppResult<Option<UserPrincipal>> {
    let row: Option<PatRow> = sqlx::query_as(
        "SELECT id, user_id, org_id, project_id, scopes, last_used_at FROM personal_access_tokens
          WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())",
    )
    .bind(sha256(token))
    .fetch_optional(db)
    .await?;
    let Some((id, user_id, org_id, project_id, scopes, last_used)) = row else { return Ok(None) };
    if last_used.is_none_or(|t| Utc::now() - t > Duration::minutes(1)) {
        sqlx::query("UPDATE personal_access_tokens SET last_used_at = now() WHERE id = $1").bind(id).execute(db).await?;
    }
    Ok(Some(UserPrincipal { user_id, via: Via::Pat(PatInfo { id, org_id, project_id, scopes }) }))
}

/// 新建会话，返回 (cookie 明文 token, csrf_token)
pub async fn create_session(db: &PgPool, user_id: Uuid, ip: &str, ua: Option<&str>) -> AppResult<(String, String)> {
    let token = random_token();
    let csrf = random_token();
    sqlx::query(
        "INSERT INTO sessions (id, user_id, token_hash, csrf_token, ip, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, $5::inet, $6, now() + make_interval(days => $7))",
    )
    .bind(new_id())
    .bind(user_id)
    .bind(sha256(&token))
    .bind(&csrf)
    .bind(ip)
    .bind(ua.map(|s| s.chars().take(500).collect::<String>()))
    .bind(SESSION_DAYS as i32)
    .execute(db)
    .await?;
    Ok((token, csrf))
}

pub fn session_cookie(st: &AppState, token: &str) -> HeaderValue {
    let secure = if st.cfg.cookie_secure { "; Secure" } else { "" };
    let v = format!(
        "{}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{secure}",
        st.cfg.session_cookie_name(),
        SESSION_DAYS * 86400
    );
    HeaderValue::from_str(&v).expect("cookie")
}

pub fn clear_cookie(st: &AppState) -> HeaderValue {
    let secure = if st.cfg.cookie_secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!("{}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{secure}", st.cfg.session_cookie_name()))
        .expect("cookie")
}
