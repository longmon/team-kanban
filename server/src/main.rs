use std::net::SocketAddr;

use relay::{AppState, Config, MIGRATOR, app, bootstrap_superadmins, spawn_background};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).init();
    if let Err(e) = run().await {
        tracing::error!("{e}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let cfg = Config::from_env()?;
    let db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(20)
        .connect(&cfg.database_url)
        .await
        .map_err(|e| format!("连接数据库失败: {e}"))?;
    MIGRATOR.run(&db).await.map_err(|e| format!("迁移失败: {e}"))?;
    let (n, missing) = bootstrap_superadmins(&db, &relay::config::superadmin_emails()).await.map_err(|e| format!("设置超管失败: {e}"))?;
    if n > 0 {
        tracing::info!("SUPERADMIN_EMAILS：新设 {n} 个超管");
    }
    if !missing.is_empty() {
        tracing::warn!("SUPERADMIN_EMAILS 里这些邮箱还没注册，注册后重启生效: {}", missing.join(", "));
    }
    if cfg.pages_origin.is_none() {
        tracing::warn!("未配置 PAGES_ORIGIN：html 页面与主站同源，仅靠 sandbox 隔离，生产环境必须配置");
    }
    let bind = cfg.bind.clone();
    let st = AppState::new(db, cfg)?;
    spawn_background(st.clone());
    let listener = tokio::net::TcpListener::bind(&bind).await.map_err(|e| format!("监听 {bind} 失败: {e}"))?;
    tracing::info!("listening on {bind}");
    axum::serve(listener, app(st).into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async {
            // 容器里是 PID 1，必须显式处理 SIGTERM
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
        })
        .await
        .map_err(|e| e.to_string())
}
