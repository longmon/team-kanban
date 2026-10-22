pub mod audit;
pub mod auth;
pub mod authz;
pub mod config;
pub mod error;
pub mod mail;
pub mod notify;
pub mod ratelimit;
pub mod routes;
pub mod util;

use std::{ops::Deref, sync::Arc, time::Duration};

use axum::{
    Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderValue, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use sqlx::PgPool;

pub use config::Config;

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

pub struct Inner {
    pub db: PgPool,
    pub cfg: Config,
    pub rl: ratelimit::RateLimiter,
    pub notify: notify::Notify,
    pub mail: mail::Mailer,
}

impl Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    pub fn new(db: PgPool, cfg: Config) -> Result<Self, String> {
        let mail = mail::Mailer::new(cfg.smtp_url.as_deref(), cfg.smtp_from.as_deref())?;
        Ok(Self(Arc::new(Inner { db, cfg, rl: Default::default(), notify: Default::default(), mail })))
    }
}

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

pub fn app(st: AppState) -> Router {
    let api = routes::api_router()
        .layer(middleware::from_fn_with_state(st.clone(), auth::api_auth))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(middleware::map_response(|mut r: Response| async move {
            r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            r
        }));
    Router::new()
        .nest("/api", api)
        .merge(routes::static_router())
        .layer(middleware::from_fn_with_state(st.clone(), host_guard))
        .with_state(st)
}

/// PAGES_ORIGIN 主机名下只开放 /h/*；配置了 PAGES_ORIGIN 时主站不提供 /h/*。主站响应加安全头
async fn host_guard(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let is_h = req.uri().path().starts_with("/h/");
    if let Some(pages_host) = st.cfg.pages_host() {
        let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("").to_ascii_lowercase();
        if (host == pages_host) != is_h {
            return (axum::http::StatusCode::NOT_FOUND, "not found").into_response();
        }
    }
    let mut res = next.run(req).await;
    if !is_h {
        let h = res.headers_mut();
        let frame_src = st.cfg.pages_origin.as_deref().unwrap_or("'self'");
        let csp = format!(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; \
             font-src 'self' data:; connect-src 'self'; frame-src {frame_src}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        );
        h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_str(&csp).expect("csp"));
        h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
        h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    }
    res
}

/// 后台：每分钟清理限流表与通知表，每小时删除过期会话与邮件 token
pub fn spawn_background(st: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        let mut n: u64 = 0;
        loop {
            tick.tick().await;
            st.rl.sweep();
            st.notify.sweep();
            if n.is_multiple_of(60) {
                for sql in ["DELETE FROM sessions WHERE expires_at < now()", "DELETE FROM email_tokens WHERE expires_at < now()"] {
                    if let Err(e) = sqlx::query(sql).execute(&st.db).await {
                        tracing::warn!("清理失败: {e}");
                    }
                }
            }
            n += 1;
        }
    });
}
