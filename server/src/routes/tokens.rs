use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::FromRow;
use uuid::Uuid;

use crate::{
    AppState, audit,
    auth::Caller,
    authz::{Allow, OrgRole, ProjectRole, require_org, require_project},
    error::{AppError, AppResult, JsonBody, P, Q},
    util::{new_id, random_token, sha256, text_field, ts, ts_opt},
};

#[derive(FromRow)]
struct PatRow {
    id: Uuid,
    name: String,
    token_prefix: String,
    org_id: Option<Uuid>,
    org_name: Option<String>,
    project_id: Option<Uuid>,
    project_name: Option<String>,
    scopes: Vec<String>,
    expires_at: Option<DateTime<Utc>>,
    last_used_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
}

const PAT_SELECT: &str = "SELECT t.id, t.name, t.token_prefix, t.org_id, o.name AS org_name, t.project_id, p.name AS project_name,
        t.scopes, t.expires_at, t.last_used_at, t.created_at, t.revoked_at
   FROM personal_access_tokens t
   LEFT JOIN orgs o ON o.id = t.org_id
   LEFT JOIN projects p ON p.org_id = t.org_id AND p.id = t.project_id";

impl PatRow {
    fn json(&self) -> Value {
        json!({
            "id": self.id, "name": self.name, "token_prefix": self.token_prefix,
            "org": self.org_id.map(|id| json!({ "id": id, "name": self.org_name })),
            "project": self.project_id.map(|id| json!({ "id": id, "name": self.project_name })),
            "scopes": self.scopes, "expires_at": ts_opt(&self.expires_at), "last_used_at": ts_opt(&self.last_used_at),
            "created_at": ts(&self.created_at), "revoked_at": ts_opt(&self.revoked_at),
        })
    }
}

#[derive(Deserialize)]
pub struct ListQuery {
    include_revoked: Option<bool>,
}

pub async fn list_tokens(State(st): State<AppState>, c: Caller, Q(q): Q<ListQuery>) -> AppResult<Json<Value>> {
    let uid = c.session_user()?;
    let rows: Vec<PatRow> = sqlx::query_as(&format!("{PAT_SELECT} WHERE t.user_id = $1 AND ($2 OR t.revoked_at IS NULL) ORDER BY t.id DESC"))
        .bind(uid)
        .bind(q.include_revoked.unwrap_or(false))
        .fetch_all(&st.db)
        .await?;
    Ok(Json(json!({ "items": rows.iter().map(PatRow::json).collect::<Vec<_>>() })))
}

#[derive(Deserialize)]
pub struct CreateReq {
    name: String,
    scopes: Vec<String>,
    org_id: Option<Uuid>,
    project_id: Option<Uuid>,
    expires_in: Option<i64>,
}

pub async fn create_token(State(st): State<AppState>, c: Caller, JsonBody(r): JsonBody<CreateReq>) -> AppResult<(StatusCode, Json<Value>)> {
    // 先做组织/项目归属检查（别人的组织一律 404），最后再要求 cookie 会话
    let uid = c.p.user_id().ok_or_else(AppError::unauthenticated)?;
    let name = text_field("name", &r.name, 1, 100)?;
    let mut scopes = r.scopes.clone();
    scopes.sort();
    scopes.dedup();
    if scopes.is_empty() || !scopes.iter().all(|s| matches!(s.as_str(), "publish" | "read_responses" | "manage")) {
        return Err(AppError::field("scopes", "必须非空且只能是 publish/read_responses/manage"));
    }
    if let Some(e) = r.expires_in
        && !(86400..=31_536_000).contains(&e) {
            return Err(AppError::field("expires_in", "范围 86400..31536000 秒，或 null 表示不过期"));
        }
    match (r.org_id, r.project_id) {
        (None, Some(_)) => return Err(AppError::field("org_id", "指定 project_id 时必须同时指定 org_id")),
        (Some(oid), None) => {
            require_org(&st.db, &c, oid, OrgRole::Member, Allow::Session).await?;
        }
        (Some(oid), Some(pid)) => {
            let p = require_project(&st.db, &c, pid, ProjectRole::Viewer, Allow::Session).await?;
            if p.org_id() != oid {
                return Err(AppError::field("project_id", "项目不属于该组织"));
            }
        }
        (None, None) => {}
    }
    c.session_user()?;
    let token = format!("arp_{}", random_token());
    let id = new_id();
    let mut tx = st.db.begin().await?;
    sqlx::query(
        "INSERT INTO personal_access_tokens (id, user_id, name, token_hash, token_prefix, org_id, project_id, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9))",
    )
    .bind(id)
    .bind(uid)
    .bind(&name)
    .bind(sha256(&token))
    .bind(&token[4..10])
    .bind(r.org_id)
    .bind(r.project_id)
    .bind(&scopes)
    .bind(r.expires_in.map(|e| e as f64))
    .execute(&mut *tx)
    .await?;
    audit::log(&mut tx, r.org_id, &c.actor(), "pat.create", "pat", Some(id), json!({ "scopes": scopes, "project_id": r.project_id })).await?;
    tx.commit().await?;
    let row: PatRow = sqlx::query_as(&format!("{PAT_SELECT} WHERE t.user_id = $1 AND t.id = $2")).bind(uid).bind(id).fetch_one(&st.db).await?;
    Ok((StatusCode::CREATED, Json(json!({ "pat": row.json(), "token": token }))))
}

pub async fn revoke_token(State(st): State<AppState>, c: Caller, P(id): P<Uuid>) -> AppResult<StatusCode> {
    // 先按本人查找（别人的 token 一律 404），再检查是否 cookie 会话
    let uid = c.p.user_id().ok_or_else(AppError::unauthenticated)?;
    let mut tx = st.db.begin().await?;
    let org: Option<Option<Uuid>> = sqlx::query_scalar("SELECT org_id FROM personal_access_tokens WHERE user_id = $1 AND id = $2 FOR UPDATE")
        .bind(uid)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let org = org.ok_or_else(AppError::not_found)?;
    c.session_user()?;
    sqlx::query("UPDATE personal_access_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1 AND id = $2")
        .bind(uid)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::log(&mut tx, org, &c.actor(), "pat.revoke", "pat", Some(id), json!({})).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
