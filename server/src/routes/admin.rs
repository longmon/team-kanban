//! 全站超级管理员（api.md §15）：账号列表/建账号/分配组织项目群组/禁用启用/重置密码/授予撤销超管、组织列表/建组织。
//! 所有接口只接受 cookie 会话（PAT 403），调用者必须是超管；每个写操作记审计（不记密码）。
use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use super::{
    list, require_any,
    orgs::{AccountProject, Targets, ensure_org_member, initial_password, last_owner, owner_count, parse_project_role, password_mode, slug_taken},
};
use crate::{
    AppState, audit,
    auth::Caller,
    authz::OrgRole,
    error::{AppError, AppResult, JsonBody, P, Q, unique_violation},
    ratelimit::HOUR,
    util::{PageQuery, email_field, hash_password, like_prefix, new_id, paginate, slug_field, text_field, ts},
};

type J = AppResult<Json<Value>>;

/// 匿名 401、PAT 403、非超管 403；禁用的账号没有会话（auth.rs 过滤），不必再查 disabled_at
async fn require_superadmin(db: &PgPool, c: &Caller) -> AppResult<Uuid> {
    let uid = c.session_user()?;
    let ok: bool = sqlx::query_scalar("SELECT is_superadmin FROM users WHERE id = $1").bind(uid).fetch_one(db).await?;
    if ok { Ok(uid) } else { Err(AppError::forbidden()) }
}

const USER_COLS: &str = "u.id, u.email, u.display_name, u.is_superadmin, u.disabled_at, u.must_change_password, u.email_verified_at IS NOT NULL, u.created_at";
type UserRow = (Uuid, String, String, bool, Option<DateTime<Utc>>, bool, bool, DateTime<Utc>);

fn user_json(r: &UserRow) -> Value {
    json!({
        "id": r.0, "email": r.1, "display_name": r.2, "is_superadmin": r.3,
        "disabled": r.4.is_some(), "disabled_at": r.4.as_ref().map(ts), "must_change_password": r.5,
        "email_verified": r.6, "created_at": ts(&r.7),
    })
}

async fn user_by_id(conn: &mut sqlx::PgConnection, id: Uuid) -> AppResult<UserRow> {
    sqlx::query_as(&format!("SELECT {USER_COLS} FROM users u WHERE u.id = $1")).bind(id).fetch_optional(conn).await?.ok_or_else(AppError::not_found)
}

fn email_registered(user_id: Uuid) -> AppError {
    let mut e = AppError::conflict("email_registered", "该邮箱已注册，请在账号详情里直接分配组织");
    e.details = Some(json!({ "user_id": user_id }));
    e
}

async fn existing_user(db: &PgPool, email: &str) -> AppResult<()> {
    let id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE email = $1").bind(email).fetch_optional(db).await?;
    id.map_or(Ok(()), |id| Err(email_registered(id)))
}

/// 新账号：邮箱视为已验证、首次登录必须改密码（与组织管理员建账号一致）
async fn insert_user(conn: &mut sqlx::PgConnection, id: Uuid, email: &str, hash: String, name: &str, superadmin: bool) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO users (id, email, password_hash, display_name, email_verified_at, must_change_password, is_superadmin)
         VALUES ($1, $2, $3, $4, now(), true, $5)",
    )
    .bind(id)
    .bind(email)
    .bind(hash)
    .bind(name)
    .bind(superadmin)
    .execute(conn)
    .await
    .map_err(|e| if unique_violation(&e).is_some() { AppError::conflict("email_registered", "该邮箱已注册") } else { e.into() })?;
    Ok(())
}

// ---------------------------------------------------------------- 账号列表

#[derive(Deserialize)]
pub struct UsersQuery {
    q: Option<String>,
    status: Option<String>,
}

/// ponytail: 按 users 主键倒序分页，搜索/筛选是对 users 的顺序过滤（无专门索引）；账号到几十万再加 trigram / 部分索引
pub async fn list_users(State(st): State<AppState>, c: Caller, Q(page): Q<PageQuery>, Q(q): Q<UsersQuery>) -> J {
    require_superadmin(&st.db, &c).await?;
    let status = q.status.as_deref().filter(|s| !s.is_empty());
    if status.is_some_and(|s| !matches!(s, "disabled" | "must_change" | "superadmin")) {
        return Err(AppError::field("status", "取值必须是 disabled/must_change/superadmin"));
    }
    let pat = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(|s| like_prefix(&s.to_lowercase()));
    let rows: Vec<(Uuid, String, String, bool, Option<DateTime<Utc>>, bool, bool, DateTime<Utc>, i64)> = sqlx::query_as(&format!(
        "SELECT {USER_COLS},
                (SELECT count(*) FROM memberships m JOIN orgs o ON o.id = m.org_id AND o.deleted_at IS NULL WHERE m.user_id = u.id)
           FROM users u
          WHERE ($1::text IS NULL OR u.email LIKE $1 OR lower(u.display_name) LIKE $1)
            AND ($2::text IS NULL OR ($2 = 'disabled' AND u.disabled_at IS NOT NULL) OR ($2 = 'must_change' AND u.must_change_password)
                 OR ($2 = 'superadmin' AND u.is_superadmin))
            AND ($3::uuid IS NULL OR u.id < $3)
          ORDER BY u.id DESC LIMIT $4"
    ))
    .bind(pat)
    .bind(status)
    .bind(page.cursor_id()?)
    .bind(page.limit() + 1)
    .fetch_all(&st.db)
    .await?;
    let (rows, next) = paginate(rows, page.limit(), |r| r.0.to_string());
    let items = rows
        .into_iter()
        .map(|(a, b, c, d, e, f, g, h, n)| {
            let mut v = user_json(&(a, b, c, d, e, f, g, h));
            v["org_count"] = json!(n);
            v
        })
        .collect();
    Ok(Json(list(items, next)))
}

// ---------------------------------------------------------------- 账号详情

pub async fn get_user(State(st): State<AppState>, c: Caller, P(id): P<Uuid>) -> J {
    require_superadmin(&st.db, &c).await?;
    let mut conn = st.db.acquire().await?;
    let user = user_by_id(&mut conn, id).await?;
    let orgs: Vec<(Uuid, String, String, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT o.id, o.name, o.slug, m.role, m.created_at FROM memberships m JOIN orgs o ON o.id = m.org_id AND o.deleted_at IS NULL
          WHERE m.user_id = $1 ORDER BY o.name, o.id",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;
    let projects: Vec<(Uuid, Uuid, String, String)> = sqlx::query_as(
        "SELECT pm.org_id, p.id, p.name, pm.role FROM project_members pm JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
          WHERE pm.user_id = $1 ORDER BY p.name, p.id",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;
    let groups: Vec<(Uuid, Uuid, String, Option<Uuid>)> = sqlx::query_as(
        "SELECT gm.org_id, g.id, g.name, g.project_id FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = $1 ORDER BY g.name, g.id",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;
    let orgs: Vec<Value> = orgs
        .iter()
        .map(|(oid, name, slug, role, joined)| {
            json!({
                "org": { "id": oid, "name": name, "slug": slug }, "role": role, "joined_at": ts(joined),
                "projects": projects.iter().filter(|p| p.0 == *oid).map(|p| json!({ "id": p.1, "name": p.2, "role": p.3 })).collect::<Vec<_>>(),
                "groups": groups.iter().filter(|g| g.0 == *oid).map(|g| json!({ "id": g.1, "name": g.2, "project_id": g.3 })).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(Json(json!({ "user": user_json(&user), "orgs": orgs })))
}

// ---------------------------------------------------------------- 建账号

#[derive(Deserialize)]
pub struct OrgAssign {
    org_id: Uuid,
    role: String,
    #[serde(default)]
    projects: Vec<AccountProject>,
    #[serde(default)]
    group_ids: Vec<Uuid>,
}

#[derive(Deserialize)]
pub struct CreateUserReq {
    email: String,
    display_name: String,
    password: Option<String>,
    #[serde(default)]
    is_superadmin: bool,
    #[serde(default)]
    orgs: Vec<OrgAssign>,
}

const MAX_ORGS: usize = 50;

/// 超管建账号，可同时分配到多个组织（各自组织角色，可选项目及角色、群组）。邮箱已注册 → 409 email_registered（details.user_id），
/// 已注册账号请在详情里分配组织，绝不改其密码。系统生成的密码只在本响应里出现一次
pub async fn create_user(State(st): State<AppState>, c: Caller, JsonBody(r): JsonBody<CreateUserReq>) -> AppResult<(StatusCode, Json<Value>)> {
    let me = require_superadmin(&st.db, &c).await?;
    st.rl.hit(&format!("admin_account:{me}"), 60, HOUR)?;
    let email = email_field(&r.email)?;
    let name = text_field("display_name", &r.display_name, 1, 50)?;
    if r.orgs.len() > MAX_ORGS {
        return Err(AppError::field("orgs", "最多 50 个组织"));
    }
    let mut assigns = Vec::new();
    for a in &r.orgs {
        let role = OrgRole::parse(&a.role).ok_or_else(|| AppError::field("role", "取值必须是 owner/admin/member"))?;
        if assigns.iter().any(|(id, _, _)| *id == a.org_id) {
            return Err(AppError::field("orgs", "组织重复"));
        }
        assigns.push((a.org_id, role, Targets::parse(&a.projects, &a.group_ids)?));
    }
    let (password, generated) = initial_password(r.password.as_deref())?;
    existing_user(&st.db, &email).await?;
    let hash = hash_password(password.clone()).await?;
    let mut tx = st.db.begin().await?;
    let ids: Vec<Uuid> = assigns.iter().map(|a| a.0).collect();
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM orgs WHERE id = ANY($1) AND deleted_at IS NULL").bind(&ids).fetch_one(&mut *tx).await?;
    if n as usize != ids.len() {
        return Err(AppError::field("orgs", "包含不存在或已删除的组织"));
    }
    for (oid, _, t) in &assigns {
        t.check(&mut tx, *oid).await?;
    }
    let id = new_id();
    insert_user(&mut tx, id, &email, hash, &name, r.is_superadmin).await?;
    let mut meta_orgs = Vec::new();
    for (oid, role, t) in &assigns {
        sqlx::query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)").bind(oid).bind(id).bind(role.as_str()).execute(&mut *tx).await?;
        t.insert(&mut tx, *oid, id).await?;
        let (projects, gids) = t.audit();
        let m = json!({ "org_id": oid, "role": role.as_str(), "projects": projects, "group_ids": gids });
        // 组织审计里也能看到「超管把某人加进来」
        audit::log(&mut tx, Some(*oid), &c.actor(), "admin.member_set", "user", Some(id), json!({ "old": null, "new": role.as_str(), "projects": m["projects"], "group_ids": m["group_ids"] }))
            .await?;
        meta_orgs.push(m);
    }
    audit::log(
        &mut tx,
        None,
        &c.actor(),
        "admin.user_create",
        "user",
        Some(id),
        json!({ "is_superadmin": r.is_superadmin, "orgs": meta_orgs, "password": password_mode(generated) }),
    )
    .await?;
    tx.commit().await?;
    let mut conn = st.db.acquire().await?;
    let user = user_by_id(&mut conn, id).await?;
    Ok((StatusCode::CREATED, Json(json!({ "user": user_json(&user), "generated_password": generated.then_some(password) }))))
}

// ---------------------------------------------------------------- 改名 / 超管开关 / 禁用启用

#[derive(Deserialize)]
pub struct UpdateUserReq {
    display_name: Option<String>,
    is_superadmin: Option<bool>,
    disabled: Option<bool>,
}

/// 禁用：立即删其全部会话（踢下线），PAT 在鉴权处被拒（不吊销）；启用：清 disabled_at，未过期未吊销的 PAT 恢复可用。
/// 不能禁用自己；撤销超管或禁用超管后必须至少剩一个可用超管（锁住全部超管行再计数，防并发互撤出零个）
pub async fn update_user(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, JsonBody(r): JsonBody<UpdateUserReq>) -> J {
    let me = require_superadmin(&st.db, &c).await?;
    require_any(&[r.display_name.is_some(), r.is_superadmin.is_some(), r.disabled.is_some()])?;
    let name = r.display_name.as_deref().map(|n| text_field("display_name", n, 1, 50)).transpose()?;
    if r.disabled == Some(true) && id == me {
        return Err(AppError::conflict("cannot_disable_self", "不能禁用自己"));
    }
    let mut tx = st.db.begin().await?;
    let reduces = r.is_superadmin == Some(false) || r.disabled == Some(true);
    let active_supers: i64 = if reduces {
        sqlx::query_scalar("SELECT count(*) FROM (SELECT 1 FROM users WHERE is_superadmin AND disabled_at IS NULL FOR UPDATE) x").fetch_one(&mut *tx).await?
    } else {
        0
    };
    let old: Option<(bool, Option<DateTime<Utc>>, String)> =
        sqlx::query_as("SELECT is_superadmin, disabled_at, display_name FROM users WHERE id = $1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?;
    let (was_super, was_disabled, old_name) = old.ok_or_else(AppError::not_found)?;
    let (was_disabled, active_super) = (was_disabled.is_some(), was_super && was_disabled.is_none());
    if reduces && active_super && active_supers <= 1 {
        return Err(AppError::conflict("last_superadmin", "至少需要保留一个可用的超级管理员"));
    }
    sqlx::query(
        "UPDATE users SET display_name = COALESCE($2, display_name), is_superadmin = COALESCE($3, is_superadmin),
                disabled_at = CASE WHEN $4::bool IS NULL THEN disabled_at WHEN $4 THEN COALESCE(disabled_at, now()) ELSE NULL END,
                updated_at = now()
          WHERE id = $1",
    )
    .bind(id)
    .bind(&name)
    .bind(r.is_superadmin)
    .bind(r.disabled)
    .execute(&mut *tx)
    .await?;
    let actor = c.actor();
    if name.as_ref().is_some_and(|n| *n != old_name) {
        audit::log(&mut tx, None, &actor, "admin.user_update", "user", Some(id), json!({ "fields": ["display_name"] })).await?;
    }
    match r.is_superadmin {
        Some(true) if !was_super => audit::log(&mut tx, None, &actor, "admin.superadmin_grant", "user", Some(id), json!({})).await?,
        Some(false) if was_super => audit::log(&mut tx, None, &actor, "admin.superadmin_revoke", "user", Some(id), json!({})).await?,
        _ => {}
    }
    match r.disabled {
        Some(true) => {
            let n = sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(id).execute(&mut *tx).await?.rows_affected();
            if !was_disabled {
                audit::log(&mut tx, None, &actor, "admin.user_disable", "user", Some(id), json!({ "sessions_revoked": n })).await?;
            }
        }
        Some(false) if was_disabled => audit::log(&mut tx, None, &actor, "admin.user_enable", "user", Some(id), json!({})).await?,
        _ => {}
    }
    let user = user_by_id(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(json!({ "user": user_json(&user) })))
}

// ---------------------------------------------------------------- 重置密码

#[derive(Deserialize)]
pub struct ResetReq {
    password: Option<String>,
}

/// 显式重置任意账号的密码（不限 must_change_password）：生成一次性密码（只在本响应出现一次）或手填，
/// 设 must_change_password（下次登录必须先改密码）并删其全部会话。不能重置自己（自己用账号设置改密码）
pub async fn reset_password(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, JsonBody(r): JsonBody<ResetReq>) -> J {
    let me = require_superadmin(&st.db, &c).await?;
    st.rl.hit(&format!("admin_account:{me}"), 60, HOUR)?;
    if id == me {
        return Err(AppError::conflict("cannot_reset_self", "不能重置自己的密码，请在账号设置里修改"));
    }
    let (password, generated) = initial_password(r.password.as_deref())?;
    let hash = hash_password(password.clone()).await?;
    let mut tx = st.db.begin().await?;
    let n = sqlx::query("UPDATE users SET password_hash = $2, must_change_password = true, updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(hash)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::not_found());
    }
    sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(id).execute(&mut *tx).await?;
    audit::log(&mut tx, None, &c.actor(), "admin.password_reset", "user", Some(id), json!({ "password": password_mode(generated) })).await?;
    tx.commit().await?;
    Ok(Json(json!({ "generated_password": generated.then_some(password) })))
}

// ---------------------------------------------------------------- 组织 / 项目 / 群组分配

#[derive(Deserialize)]
pub struct RoleReq {
    role: String,
}

async fn ensure_user(conn: &mut sqlx::PgConnection, id: Uuid) -> AppResult<()> {
    let ok: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)").bind(id).fetch_one(conn).await?;
    if ok { Ok(()) } else { Err(AppError::not_found()) }
}

/// 加入组织或改组织角色（owner 也可以）；把最后一个 owner 降级 → 409 last_owner
pub async fn set_membership(State(st): State<AppState>, c: Caller, P((id, org_id)): P<(Uuid, Uuid)>, JsonBody(r): JsonBody<RoleReq>) -> AppResult<StatusCode> {
    require_superadmin(&st.db, &c).await?;
    let new = OrgRole::parse(&r.role).ok_or_else(|| AppError::field("role", "取值必须是 owner/admin/member"))?;
    let mut tx = st.db.begin().await?;
    let org: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM orgs WHERE id = $1 AND deleted_at IS NULL)").bind(org_id).fetch_one(&mut *tx).await?;
    if !org {
        return Err(AppError::not_found());
    }
    ensure_user(&mut tx, id).await?;
    let owners = owner_count(&mut tx, org_id).await?;
    let old: Option<String> =
        sqlx::query_scalar("SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2 FOR UPDATE").bind(org_id).bind(id).fetch_optional(&mut *tx).await?;
    if old.as_deref() == Some("owner") && new != OrgRole::Owner && owners <= 1 {
        return Err(last_owner());
    }
    sqlx::query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role")
        .bind(org_id)
        .bind(id)
        .bind(new.as_str())
        .execute(&mut *tx)
        .await?;
    audit::log(&mut tx, Some(org_id), &c.actor(), "admin.member_set", "user", Some(id), json!({ "old": old, "new": new.as_str() })).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// 移出组织（级联移出该组织下的项目与群组）；最后一个 owner 不能移出
pub async fn remove_membership(State(st): State<AppState>, c: Caller, P((id, org_id)): P<(Uuid, Uuid)>) -> AppResult<StatusCode> {
    require_superadmin(&st.db, &c).await?;
    let mut tx = st.db.begin().await?;
    let owners = owner_count(&mut tx, org_id).await?;
    let role: Option<String> =
        sqlx::query_scalar("SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2 FOR UPDATE").bind(org_id).bind(id).fetch_optional(&mut *tx).await?;
    let role = role.ok_or_else(AppError::not_found)?;
    if role == "owner" && owners <= 1 {
        return Err(last_owner());
    }
    sqlx::query("DELETE FROM memberships WHERE org_id = $1 AND user_id = $2").bind(org_id).bind(id).execute(&mut *tx).await?;
    audit::log(&mut tx, Some(org_id), &c.actor(), "admin.member_remove", "user", Some(id), json!({ "role": role })).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// 加入项目或改项目角色；必须先是该项目所属组织的成员（409 not_org_member）
pub async fn set_project_member(
    State(st): State<AppState>,
    c: Caller,
    P((id, project_id)): P<(Uuid, Uuid)>,
    JsonBody(r): JsonBody<RoleReq>,
) -> AppResult<StatusCode> {
    require_superadmin(&st.db, &c).await?;
    let role = parse_project_role(&r.role)?;
    let mut tx = st.db.begin().await?;
    let org_id: Uuid = sqlx::query_scalar("SELECT org_id FROM projects WHERE id = $1 AND deleted_at IS NULL")
        .bind(project_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(AppError::not_found)?;
    ensure_user(&mut tx, id).await?;
    ensure_org_member(&mut tx, org_id, id).await?;
    let old: Option<String> =
        sqlx::query_scalar("SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2").bind(project_id).bind(id).fetch_optional(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO project_members (org_id, project_id, user_id, role) VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role",
    )
    .bind(org_id)
    .bind(project_id)
    .bind(id)
    .bind(role.as_str())
    .execute(&mut *tx)
    .await?;
    audit::log(&mut tx, Some(org_id), &c.actor(), "admin.project_member_set", "project", Some(project_id), json!({ "user_id": id, "old": old, "new": role.as_str() }))
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove_project_member(State(st): State<AppState>, c: Caller, P((id, project_id)): P<(Uuid, Uuid)>) -> AppResult<StatusCode> {
    require_superadmin(&st.db, &c).await?;
    let mut tx = st.db.begin().await?;
    let org_id: Option<Uuid> = sqlx::query_scalar("DELETE FROM project_members WHERE project_id = $1 AND user_id = $2 RETURNING org_id")
        .bind(project_id)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let org_id = org_id.ok_or_else(AppError::not_found)?;
    audit::log(&mut tx, Some(org_id), &c.actor(), "admin.project_member_remove", "project", Some(project_id), json!({ "user_id": id })).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// 加入群组（幂等）；必须先是该群组所属组织的成员（与 POST /groups/{id}/members 一致）
pub async fn add_group_member(State(st): State<AppState>, c: Caller, P((id, group_id)): P<(Uuid, Uuid)>) -> AppResult<StatusCode> {
    require_superadmin(&st.db, &c).await?;
    let mut tx = st.db.begin().await?;
    let org_id: Uuid = sqlx::query_scalar("SELECT org_id FROM groups WHERE id = $1").bind(group_id).fetch_optional(&mut *tx).await?.ok_or_else(AppError::not_found)?;
    ensure_user(&mut tx, id).await?;
    ensure_org_member(&mut tx, org_id, id).await?;
    let n = sqlx::query("INSERT INTO group_members (org_id, group_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING")
        .bind(org_id)
        .bind(group_id)
        .bind(id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n > 0 {
        audit::log(&mut tx, Some(org_id), &c.actor(), "admin.group_member_add", "group", Some(group_id), json!({ "user_id": id })).await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove_group_member(State(st): State<AppState>, c: Caller, P((id, group_id)): P<(Uuid, Uuid)>) -> AppResult<StatusCode> {
    require_superadmin(&st.db, &c).await?;
    let mut tx = st.db.begin().await?;
    let org_id: Option<Uuid> = sqlx::query_scalar("DELETE FROM group_members WHERE group_id = $1 AND user_id = $2 RETURNING org_id")
        .bind(group_id)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let org_id = org_id.ok_or_else(AppError::not_found)?;
    audit::log(&mut tx, Some(org_id), &c.actor(), "admin.group_member_remove", "group", Some(group_id), json!({ "user_id": id })).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- 组织

#[derive(Deserialize)]
pub struct OrgsQuery {
    q: Option<String>,
}

pub async fn list_orgs(State(st): State<AppState>, c: Caller, Q(page): Q<PageQuery>, Q(q): Q<OrgsQuery>) -> J {
    require_superadmin(&st.db, &c).await?;
    let pat = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(|s| like_prefix(&s.to_lowercase()));
    let rows: Vec<(Uuid, String, String, DateTime<Utc>, i64, Value)> = sqlx::query_as(
        "SELECT o.id, o.name, o.slug, o.created_at,
                (SELECT count(*) FROM memberships m WHERE m.org_id = o.id),
                (SELECT coalesce(json_agg(json_build_object('id', u.id, 'display_name', u.display_name, 'email', u.email) ORDER BY m.created_at), '[]'::json)
                   FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id AND m.role = 'owner')
           FROM orgs o
          WHERE o.deleted_at IS NULL AND ($1::text IS NULL OR o.slug LIKE $1 OR lower(o.name) LIKE $1) AND ($2::uuid IS NULL OR o.id < $2)
          ORDER BY o.id DESC LIMIT $3",
    )
    .bind(pat)
    .bind(page.cursor_id()?)
    .bind(page.limit() + 1)
    .fetch_all(&st.db)
    .await?;
    let (rows, next) = paginate(rows, page.limit(), |r| r.0.to_string());
    let items = rows
        .into_iter()
        .map(|(id, name, slug, t, n, owners)| json!({ "id": id, "name": name, "slug": slug, "created_at": ts(&t), "member_count": n, "owners": owners }))
        .collect();
    Ok(Json(list(items, next)))
}

/// 超管面板分配项目/群组用：组织下未删除的项目与全部群组（超管不必是该组织成员）
pub async fn org_structure(State(st): State<AppState>, c: Caller, P(id): P<Uuid>) -> J {
    require_superadmin(&st.db, &c).await?;
    let org: Option<(String, String)> = sqlx::query_as("SELECT name, slug FROM orgs WHERE id = $1 AND deleted_at IS NULL").bind(id).fetch_optional(&st.db).await?;
    let (name, slug) = org.ok_or_else(AppError::not_found)?;
    let projects: Vec<(Uuid, String, String)> =
        sqlx::query_as("SELECT id, name, slug FROM projects WHERE org_id = $1 AND deleted_at IS NULL ORDER BY name, id").bind(id).fetch_all(&st.db).await?;
    let groups: Vec<(Uuid, String, Option<Uuid>)> =
        sqlx::query_as("SELECT id, name, project_id FROM groups WHERE org_id = $1 ORDER BY name, id").bind(id).fetch_all(&st.db).await?;
    Ok(Json(json!({
        "org": { "id": id, "name": name, "slug": slug },
        "projects": projects.iter().map(|(i, n, s)| json!({ "id": i, "name": n, "slug": s })).collect::<Vec<_>>(),
        "groups": groups.iter().map(|(i, n, p)| json!({ "id": i, "name": n, "project_id": p })).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
pub struct NewOwner {
    email: String,
    display_name: String,
    password: Option<String>,
}

#[derive(Deserialize)]
pub struct CreateOrgReq {
    name: String,
    slug: String,
    owner_user_id: Option<Uuid>,
    owner: Option<NewOwner>,
}

/// 建组织并指定所有者：owner_user_id（已有账号）与 owner（同时新建账号）二选一。超管本人不因此成为成员
pub async fn create_org(State(st): State<AppState>, c: Caller, JsonBody(r): JsonBody<CreateOrgReq>) -> AppResult<(StatusCode, Json<Value>)> {
    let me = require_superadmin(&st.db, &c).await?;
    let name = text_field("name", &r.name, 1, 100)?;
    let slug = slug_field(&r.slug)?;
    let new_owner = match (&r.owner_user_id, &r.owner) {
        (Some(_), None) => None,
        (None, Some(o)) => {
            st.rl.hit(&format!("admin_account:{me}"), 60, HOUR)?;
            let email = email_field(&o.email)?;
            let oname = text_field("display_name", &o.display_name, 1, 50)?;
            let (password, generated) = initial_password(o.password.as_deref())?;
            existing_user(&st.db, &email).await?;
            let hash = hash_password(password.clone()).await?;
            Some((email, oname, password, generated, hash))
        }
        _ => return Err(AppError::field("owner", "owner_user_id 与 owner 必须二选一")),
    };
    let mut tx = st.db.begin().await?;
    let owner_id = match (&r.owner_user_id, &new_owner) {
        (Some(uid), _) => {
            ensure_user(&mut tx, *uid).await.map_err(|_| AppError::field("owner_user_id", "账号不存在"))?;
            *uid
        }
        (None, Some((email, oname, _, generated, hash))) => {
            let uid = new_id();
            insert_user(&mut tx, uid, email, hash.clone(), oname, false).await?;
            audit::log(&mut tx, None, &c.actor(), "admin.user_create", "user", Some(uid), json!({ "is_superadmin": false, "orgs": [], "password": password_mode(*generated) }))
                .await?;
            uid
        }
        _ => unreachable!(),
    };
    let id = new_id();
    sqlx::query("INSERT INTO orgs (id, name, slug, created_by) VALUES ($1, $2, $3, $4)")
        .bind(id)
        .bind(&name)
        .bind(&slug)
        .bind(me)
        .execute(&mut *tx)
        .await
        .map_err(slug_taken)?;
    sqlx::query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')").bind(id).bind(owner_id).execute(&mut *tx).await?;
    audit::log(
        &mut tx,
        Some(id),
        &c.actor(),
        "admin.org_create",
        "org",
        Some(id),
        json!({ "slug": slug, "owner_user_id": owner_id, "owner_created": new_owner.is_some() }),
    )
    .await?;
    tx.commit().await?;
    let created: DateTime<Utc> = sqlx::query_scalar("SELECT created_at FROM orgs WHERE id = $1").bind(id).fetch_one(&st.db).await?;
    let mut conn = st.db.acquire().await?;
    let owner = user_by_id(&mut conn, owner_id).await?;
    let password = new_owner.and_then(|(_, _, p, g, _)| g.then_some(p));
    Ok((
        StatusCode::CREATED,
        Json(json!({ "org": { "id": id, "name": name, "slug": slug, "created_at": ts(&created) }, "owner": user_json(&owner), "generated_password": password })),
    ))
}
