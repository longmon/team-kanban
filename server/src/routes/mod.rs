mod account;
mod groups;
mod invites;
mod orgs;
mod pages;
mod responses;
mod statics;
mod tasks;
mod tokens;

use axum::{
    Router,
    extract::DefaultBodyLimit,
    http::StatusCode,
    routing::{delete, get, patch, post},
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    AppState,
    error::{AppError, AppResult},
    util::ts,
};

pub use statics::static_router;

const PAGE_BODY_LIMIT: usize = 6 * 1024 * 1024;

pub fn api_router() -> Router<AppState> {
    Router::new()
        // 账号
        .route("/auth/register", post(account::register))
        .route("/auth/login", post(account::login))
        .route("/auth/logout", post(account::logout))
        .route("/auth/me", get(account::me).patch(account::update_me))
        .route("/auth/verify-email", post(account::verify_email))
        .route("/auth/resend-verification", post(account::resend_verification))
        .route("/auth/password/forgot", post(account::forgot_password))
        .route("/auth/password/reset", post(account::reset_password))
        .route("/auth/password/change", post(account::change_password))
        // 组织与成员
        .route("/orgs", get(orgs::list_orgs).post(orgs::create_org))
        .route("/orgs/{org_id}", get(orgs::get_org).patch(orgs::update_org).delete(orgs::delete_org))
        .route("/orgs/{org_id}/members", get(orgs::list_members))
        .route("/orgs/{org_id}/members/{user_id}", patch(orgs::update_member).delete(orgs::remove_member))
        .route("/orgs/{org_id}/members/accounts", post(orgs::create_account))
        .route("/orgs/{org_id}/members/{user_id}/reset-password", post(orgs::reset_account_password))
        .route("/orgs/{org_id}/audit", get(orgs::list_audit))
        // 项目
        .route("/orgs/{org_id}/projects", get(orgs::list_projects).post(orgs::create_project))
        .route("/projects/{id}", get(orgs::get_project).patch(orgs::update_project).delete(orgs::delete_project))
        .route("/me/projects", get(orgs::my_projects))
        .route("/projects/{id}/members", get(orgs::list_project_members).post(orgs::add_project_member))
        .route("/projects/{id}/members/{user_id}", patch(orgs::update_project_member).delete(orgs::remove_project_member))
        .route("/projects/{id}/groups", get(orgs::list_project_groups).post(groups::create_project_group))
        .route("/projects/{id}/groups/{group_id}", axum::routing::put(orgs::grant_project_group).delete(orgs::revoke_project_group))
        // 群组
        .route("/orgs/{org_id}/groups", get(groups::list_groups).post(groups::create_group))
        .route("/groups/{id}", get(groups::get_group).patch(groups::update_group).delete(groups::delete_group))
        .route("/groups/{id}/members", get(groups::list_members).post(groups::add_member))
        .route("/groups/{id}/members/{user_id}", delete(groups::remove_member))
        // 邀请
        .route("/orgs/{org_id}/invites", get(invites::list_org_invites).post(invites::create_invite))
        .route("/projects/{id}/invites", get(invites::list_project_invites))
        .route("/invites/{id}", delete(invites::revoke_invite))
        .route("/invites/by-token/{token}", get(invites::preview_invite))
        .route("/invites/by-token/{token}/accept", post(invites::accept_invite))
        // PAT
        .route("/tokens", get(tokens::list_tokens).post(tokens::create_token))
        .route("/tokens/{id}", delete(tokens::revoke_token))
        // 页面
        .route("/pages", get(pages::list_pages).post(pages::create_page).layer(DefaultBodyLimit::max(PAGE_BODY_LIMIT)))
        .route(
            "/pages/{id}",
            get(pages::get_page).patch(pages::update_page).delete(pages::delete_page).layer(DefaultBodyLimit::max(PAGE_BODY_LIMIT)),
        )
        .route("/pages/{id}/view", get(pages::view_page))
        .route("/pages/{id}/close", post(pages::close_page))
        .route("/pages/{id}/reopen", post(pages::reopen_page))
        .route("/activity", get(pages::activity))
        .route("/pages/{id}/share-links", get(pages::list_share_links).post(pages::create_share_link))
        .route("/share-links/{id}", delete(pages::revoke_share_link))
        .route("/s/{token}", get(pages::view_share))
        .route("/s/{token}/unlock", post(pages::unlock_share))
        // 任务树
        .route("/pages/{id}/tasks", get(tasks::list_tasks).post(tasks::add_task))
        .route("/tasks/{id}", patch(tasks::update_task))
        .route("/tasks/{id}/review", post(tasks::review_task))
        .route("/tasks/{id}/events", get(tasks::task_events))
        // 提交与结果
        .route("/pages/{id}/responses", get(responses::poll).post(responses::submit_page))
        .route("/pages/{id}/responses/stream", get(responses::stream_page))
        .route("/pages/{id}/responses.csv", get(responses::export_csv))
        .route("/s/{token}/responses", post(responses::submit_share))
        .route("/s/{token}/responses/stream", get(responses::stream_share))
        .fallback(|| async { AppError::not_found() })
        .method_not_allowed_fallback(|| async { AppError::new(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed", "不支持的请求方法") })
}

// ---------------------------------------------------------------- 共用 JSON 形状

pub fn org_json(id: Uuid, name: &str, slug: &str, role: &str, created_at: &DateTime<Utc>) -> Value {
    json!({ "id": id, "name": name, "slug": slug, "my_role": role, "created_at": ts(created_at) })
}

pub fn brief(id: Uuid, name: &str) -> Value {
    json!({ "id": id, "display_name": name })
}

pub fn list(items: Vec<Value>, next: Option<String>) -> Value {
    json!({ "items": items, "next_cursor": next })
}

pub async fn user_full(db: &PgPool, id: Uuid) -> AppResult<Value> {
    let (email, name, verified, created, must_change): (String, String, Option<DateTime<Utc>>, DateTime<Utc>, bool) =
        sqlx::query_as("SELECT email, display_name, email_verified_at, created_at, must_change_password FROM users WHERE id = $1")
            .bind(id)
            .fetch_one(db)
            .await?;
    Ok(json!({
        "id": id, "email": email, "display_name": name, "email_verified": verified.is_some(), "created_at": ts(&created),
        "must_change_password": must_change,
    }))
}

/// 可选更新字段里至少要有一个
pub fn require_any(present: &[bool]) -> AppResult<()> {
    if present.iter().any(|b| *b) { Ok(()) } else { Err(AppError::field("body", "至少提供一个要修改的字段")) }
}
