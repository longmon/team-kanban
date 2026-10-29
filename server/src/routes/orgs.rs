//! 组织、组织成员、审计、项目、项目成员、项目群组授权
use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use super::{brief, list, org_json, require_any};
use crate::{
    AppState, audit,
    auth::Caller,
    authz::{
        ACTIVE_GROUP_SECS, Allow, ANY_SCOPE, MANAGE, OrgRole, PUBLISH_OR_MANAGE, ProjectRole, Scope, require_org, require_project, require_user,
        role_expr,
    },
    error::{AppError, AppResult, JsonBody, P, Q, unique_violation},
    ratelimit::HOUR,
    util::{
        PageQuery, email_field, hash_password, like_prefix, new_id, paginate, password_field, random_token, slug_field, text_field, time_cursor, ts,
    },
};

type J = AppResult<Json<Value>>;

pub(super) fn slug_taken(e: sqlx::Error) -> AppError {
    if unique_violation(&e).is_some() { AppError::conflict("slug_taken", "slug 已被占用") } else { e.into() }
}

// ---------------------------------------------------------------- 组织

async fn org_by_id(db: &PgPool, org_id: Uuid, role: OrgRole) -> J {
    let (name, slug, created): (String, String, DateTime<Utc>) =
        sqlx::query_as("SELECT name, slug, created_at FROM orgs WHERE id = $1 AND deleted_at IS NULL").bind(org_id).fetch_one(db).await?;
    Ok(Json(org_json(org_id, &name, &slug, role.as_str(), &created)))
}

/// 会话或任意 scope 的 PAT；PAT 限定了组织时只返回该组织（agent 据此在空组织里建第一个项目）
pub async fn list_orgs(State(st): State<AppState>, c: Caller, Q(q): Q<PageQuery>) -> J {
    let uid = require_user(&c, ANY_SCOPE)?;
    let rows: Vec<(Uuid, String, String, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT o.id, o.name, o.slug, m.role, o.created_at FROM memberships m JOIN orgs o ON o.id = m.org_id AND o.deleted_at IS NULL
          WHERE m.user_id = $1 AND ($2::uuid IS NULL OR o.id < $2) AND ($4::uuid IS NULL OR o.id = $4) ORDER BY o.id DESC LIMIT $3",
    )
    .bind(uid)
    .bind(q.cursor_id()?)
    .bind(q.limit() + 1)
    .bind(c.p.pat().and_then(|p| p.org_id))
    .fetch_all(&st.db)
    .await?;
    let (rows, next) = paginate(rows, q.limit(), |r| r.0.to_string());
    Ok(Json(list(rows.iter().map(|(id, n, s, r, t)| org_json(*id, n, s, r, t)).collect(), next)))
}

#[derive(Deserialize)]
pub struct CreateOrgReq {
    name: String,
    slug: String,
}

pub async fn create_org(State(st): State<AppState>, c: Caller, JsonBody(r): JsonBody<CreateOrgReq>) -> AppResult<(StatusCode, Json<Value>)> {
    let uid = c.session_user()?;
    let name = text_field("name", &r.name, 1, 100)?;
    let slug = slug_field(&r.slug)?;
    let id = new_id();
    let mut tx = st.db.begin().await?;
    sqlx::query("INSERT INTO orgs (id, name, slug, created_by) VALUES ($1, $2, $3, $4)")
        .bind(id)
        .bind(&name)
        .bind(&slug)
        .bind(uid)
        .execute(&mut *tx)
        .await
        .map_err(slug_taken)?;
    sqlx::query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')").bind(id).bind(uid).execute(&mut *tx).await?;
    audit::log(&mut tx, Some(id), &c.actor(), "org.create", "org", Some(id), json!({ "slug": slug })).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, org_by_id(&st.db, id, OrgRole::Owner).await?))
}

pub async fn get_org(State(st): State<AppState>, c: Caller, P(org_id): P<Uuid>) -> J {
    let ctx = require_org(&st.db, &c, org_id, OrgRole::Member, Allow::Session).await?;
    org_by_id(&st.db, ctx.org_id(), ctx.role()).await
}

#[derive(Deserialize)]
pub struct UpdateOrgReq {
    name: Option<String>,
    slug: Option<String>,
}

pub async fn update_org(State(st): State<AppState>, c: Caller, P(org_id): P<Uuid>, JsonBody(r): JsonBody<UpdateOrgReq>) -> J {
    let ctx = require_org(&st.db, &c, org_id, OrgRole::Admin, Allow::Session).await?;
    require_any(&[r.name.is_some(), r.slug.is_some()])?;
    let name = r.name.as_deref().map(|n| text_field("name", n, 1, 100)).transpose()?;
    let slug = r.slug.as_deref().map(slug_field).transpose()?;
    let mut tx = st.db.begin().await?;
    sqlx::query("UPDATE orgs SET name = COALESCE($2, name), slug = COALESCE($3, slug), updated_at = now() WHERE id = $1 AND deleted_at IS NULL")
        .bind(ctx.org_id())
        .bind(&name)
        .bind(&slug)
        .execute(&mut *tx)
        .await
        .map_err(slug_taken)?;
    let fields: Vec<&str> = [name.as_ref().map(|_| "name"), slug.as_ref().map(|_| "slug")].into_iter().flatten().collect();
    audit::log(&mut tx, Some(ctx.org_id()), &c.actor(), "org.update", "org", Some(ctx.org_id()), json!({ "fields": fields })).await?;
    tx.commit().await?;
    org_by_id(&st.db, ctx.org_id(), ctx.role()).await
}

#[derive(Deserialize)]
pub struct DeleteOrgReq {
    confirm_slug: String,
}

pub async fn delete_org(State(st): State<AppState>, c: Caller, P(org_id): P<Uuid>, JsonBody(r): JsonBody<DeleteOrgReq>) -> AppResult<StatusCode> {
    let ctx = require_org(&st.db, &c, org_id, OrgRole::Owner, Allow::Session).await?;
    let mut tx = st.db.begin().await?;
    let n = sqlx::query("UPDATE orgs SET deleted_at = now(), updated_at = now() WHERE id = $1 AND slug = $2 AND deleted_at IS NULL")
        .bind(ctx.org_id())
        .bind(&r.confirm_slug)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::field("confirm_slug", "与组织 slug 不一致"));
    }
    audit::log(&mut tx, Some(ctx.org_id()), &c.actor(), "org.delete", "org", Some(ctx.org_id()), json!({})).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- 组织成员

pub fn member_json(id: Uuid, name: &str, email: &str, role: Option<&str>, joined: &DateTime<Utc>) -> Value {
    let mut v = json!({ "user": { "id": id, "display_name": name, "email": email }, "joined_at": ts(joined) });
    if let Some(r) = role {
        v["role"] = json!(r);
    }
    v
}

type MemberRow = (Uuid, String, String, String, DateTime<Utc>);

#[derive(Deserialize)]
pub struct MembersQuery {
    q: Option<String>,
}

pub async fn list_members(State(st): State<AppState>, c: Caller, P(org_id): P<Uuid>, Q(page): Q<PageQuery>, Q(q): Q<MembersQuery>) -> J {
    let ctx = require_org(&st.db, &c, org_id, OrgRole::Member, Allow::Session).await?;
    let cur = page.cursor_time()?;
    let pat = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(|s| like_prefix(&s.to_lowercase()));
    let rows: Vec<(Uuid, String, String, String, DateTime<Utc>, bool)> = sqlx::query_as(
        "SELECT u.id, u.display_name, u.email, m.role, m.created_at, u.must_change_password FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.org_id = $1 AND ($2::text IS NULL OR u.email LIKE $2 OR lower(u.display_name) LIKE $2)
            AND ($3::timestamptz IS NULL OR (m.created_at, m.user_id) < ($3, $4))
          ORDER BY m.created_at DESC, m.user_id DESC LIMIT $5",
    )
    .bind(ctx.org_id())
    .bind(pat)
    .bind(cur.map(|c| c.0))
    .bind(cur.map(|c| c.1))
    .bind(page.limit() + 1)
    .fetch_all(&st.db)
    .await?;
    let (rows, next) = paginate(rows, page.limit(), |r| time_cursor(&r.4, &r.0));
    // 待改密（管理员建的账号尚未改过初始密码）只给 owner/admin 看，供「重置一次性密码」
    let admin = ctx.role() >= OrgRole::Admin;
    let items = rows
        .iter()
        .map(|(id, n, e, r, t, pending)| {
            let mut v = member_json(*id, n, e, Some(r), t);
            if admin {
                v["must_change_password"] = json!(pending);
            }
            v
        })
        .collect();
    Ok(Json(list(items, next)))
}

#[derive(Deserialize)]
pub struct RoleReq {
    role: String,
}

/// 锁住该组织的 owner 行并计数（防并发降级出零 owner）
pub(super) async fn owner_count(conn: &mut sqlx::PgConnection, org_id: Uuid) -> AppResult<i64> {
    Ok(sqlx::query_scalar("SELECT count(*) FROM (SELECT 1 FROM memberships WHERE org_id = $1 AND role = 'owner' FOR UPDATE) x")
        .bind(org_id)
        .fetch_one(conn)
        .await?)
}

pub(super) fn last_owner() -> AppError {
    AppError::conflict("last_owner", "组织至少需要一个 owner")
}

pub async fn update_member(State(st): State<AppState>, c: Caller, P((org_id, user_id)): P<(Uuid, Uuid)>, JsonBody(r): JsonBody<RoleReq>) -> J {
    let ctx = require_org(&st.db, &c, org_id, OrgRole::Admin, Allow::Session).await?;
    let new = OrgRole::parse(&r.role).ok_or_else(|| AppError::field("role", "取值必须是 owner/admin/member"))?;
    let mut tx = st.db.begin().await?;
    let owners = owner_count(&mut tx, ctx.org_id()).await?;
    let old: Option<String> = sqlx::query_scalar("SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2 FOR UPDATE")
        .bind(ctx.org_id())
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?;
    let old = old.as_deref().and_then(OrgRole::parse).ok_or_else(AppError::not_found)?;
    if ctx.role() < OrgRole::Owner && (old == OrgRole::Owner || new == OrgRole::Owner) {
        return Err(AppError::forbidden());
    }
    if old == OrgRole::Owner && new != OrgRole::Owner && owners <= 1 {
        return Err(last_owner());
    }
    let row: MemberRow = sqlx::query_as(
        "UPDATE memberships m SET role = $3 FROM users u WHERE m.org_id = $1 AND m.user_id = $2 AND u.id = m.user_id
         RETURNING u.id, u.display_name, u.email, m.role, m.created_at",
    )
    .bind(ctx.org_id())
    .bind(user_id)
    .bind(new.as_str())
    .fetch_one(&mut *tx)
    .await?;
    audit::log(
        &mut tx,
        Some(ctx.org_id()),
        &c.actor(),
        "member.role_change",
        "user",
        Some(user_id),
        json!({ "old": old.as_str(), "new": new.as_str() }),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(member_json(row.0, &row.1, &row.2, Some(&row.3), &row.4)))
}

pub async fn remove_member(State(st): State<AppState>, c: Caller, P((org_id, user_id)): P<(Uuid, Uuid)>) -> AppResult<StatusCode> {
    let ctx = require_org(&st.db, &c, org_id, OrgRole::Member, Allow::Session).await?;
    let is_self = user_id == ctx.user_id();
    let mut tx = st.db.begin().await?;
    let owners = owner_count(&mut tx, ctx.org_id()).await?;
    let target: Option<String> = sqlx::query_scalar("SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2 FOR UPDATE")
        .bind(ctx.org_id())
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?;
    let target = target.as_deref().and_then(OrgRole::parse).ok_or_else(AppError::not_found)?;
    let allowed = is_self || ctx.role() == OrgRole::Owner || (ctx.role() == OrgRole::Admin && target == OrgRole::Member);
    if !allowed {
        return Err(AppError::forbidden());
    }
    if target == OrgRole::Owner && owners <= 1 {
        return Err(last_owner());
    }
    sqlx::query("DELETE FROM memberships WHERE org_id = $1 AND user_id = $2").bind(ctx.org_id()).bind(user_id).execute(&mut *tx).await?;
    let action = if is_self { "member.leave" } else { "member.remove" };
    audit::log(&mut tx, Some(ctx.org_id()), &c.actor(), action, "user", Some(user_id), json!({ "role": target.as_str() })).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- 管理员直接建账号

const MAX_ACCOUNT_TARGETS: usize = 50;

/// 初始密码：给了就按注册的强度规则校验；没给就用 CSPRNG 生成 20 位 base64url 字符。返回 (明文, 是否系统生成)
pub(super) fn initial_password(pw: Option<&str>) -> AppResult<(String, bool)> {
    match pw.filter(|p| !p.is_empty()) {
        Some(p) => {
            password_field("password", p)?;
            Ok((p.to_string(), false))
        }
        None => Ok((random_token()[..20].to_string(), true)),
    }
}

pub(super) fn password_mode(generated: bool) -> &'static str {
    if generated { "generated" } else { "manual" }
}

#[derive(Deserialize)]
pub struct AccountProject {
    project_id: Uuid,
    role: String,
}

/// 建账号时附带的项目（含角色）与群组：组织管理员建账号与超管建账号共用同一套校验
pub(super) struct Targets {
    pids: Vec<Uuid>,
    proles: Vec<&'static str>,
    gids: Vec<Uuid>,
}

impl Targets {
    pub(super) fn parse(projects: &[AccountProject], group_ids: &[Uuid]) -> AppResult<Self> {
        if projects.len() > MAX_ACCOUNT_TARGETS || group_ids.len() > MAX_ACCOUNT_TARGETS {
            return Err(AppError::field("body", "项目、群组各最多 50 个"));
        }
        let mut pids = Vec::new();
        let mut proles = Vec::new();
        for p in projects {
            let pr = parse_project_role(&p.role)?;
            if pids.contains(&p.project_id) {
                return Err(AppError::field("projects", "项目重复"));
            }
            pids.push(p.project_id);
            proles.push(pr.as_str());
        }
        let mut gids = group_ids.to_vec();
        gids.sort();
        gids.dedup();
        Ok(Self { pids, proles, gids })
    }

    /// 项目必须属于该组织且未删除；群组必须属于该组织，项目群组只能是本次所选项目的
    pub(super) async fn check(&self, conn: &mut sqlx::PgConnection, org_id: Uuid) -> AppResult<()> {
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM projects WHERE org_id = $1 AND id = ANY($2) AND deleted_at IS NULL")
            .bind(org_id)
            .bind(&self.pids)
            .fetch_one(&mut *conn)
            .await?;
        if n as usize != self.pids.len() {
            return Err(AppError::field("projects", "包含不存在或不属于本组织的项目"));
        }
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM groups WHERE org_id = $1 AND id = ANY($2) AND (project_id IS NULL OR project_id = ANY($3))")
            .bind(org_id)
            .bind(&self.gids)
            .bind(&self.pids)
            .fetch_one(&mut *conn)
            .await?;
        if n as usize != self.gids.len() {
            return Err(AppError::field("group_ids", "包含不存在、不属于本组织或不属于所选项目的群组"));
        }
        Ok(())
    }

    /// 调用前须已插入 (org_id, user_id) 的 memberships 行
    pub(super) async fn insert(&self, conn: &mut sqlx::PgConnection, org_id: Uuid, user_id: Uuid) -> AppResult<()> {
        sqlx::query("INSERT INTO project_members (org_id, project_id, user_id, role) SELECT $1, unnest($2::uuid[]), $3, unnest($4::text[])")
            .bind(org_id)
            .bind(&self.pids)
            .bind(user_id)
            .bind(&self.proles)
            .execute(&mut *conn)
            .await?;
        sqlx::query("INSERT INTO group_members (org_id, group_id, user_id) SELECT $1, unnest($2::uuid[]), $3")
            .bind(org_id)
            .bind(&self.gids)
            .bind(user_id)
            .execute(&mut *conn)
            .await?;
        Ok(())
    }

    /// 审计 meta：projects（[{project_id, role}]）与 group_ids
    pub(super) fn audit(&self) -> (Vec<Value>, &[Uuid]) {
        (self.pids.iter().zip(&self.proles).map(|(p, r)| json!({ "project_id": p, "role": r })).collect(), &self.gids)
    }
}

#[derive(Deserialize)]
pub struct CreateAccountReq {
    email: String,
    display_name: String,
    role: String,
    password: Option<String>,
    #[serde(default)]
    projects: Vec<AccountProject>,
    #[serde(default)]
    group_ids: Vec<Uuid>,
}

/// 组织 owner/admin 直接建账号：邮箱视为已验证，首次登录必须改密码（auth.rs 拦截）。
/// 系统生成的密码只在本响应里出现一次，不入库明文、不进审计
pub async fn create_account(State(st): State<AppState>, c: Caller, P(org_id): P<Uuid>, JsonBody(r): JsonBody<CreateAccountReq>) -> AppResult<(StatusCode, Json<Value>)> {
    let ctx = require_org(&st.db, &c, org_id, OrgRole::Admin, Allow::Session).await?;
    st.rl.hit(&format!("create_account:{}", ctx.user_id()), 30, HOUR)?;
    let email = email_field(&r.email)?;
    let name = text_field("display_name", &r.display_name, 1, 50)?;
    // 与组织邀请一致（invites.rs create_invite）：admin 只有 owner 能授予；owner 不能这样建
    let role = match r.role.as_str() {
        "member" => OrgRole::Member,
        "admin" => OrgRole::Admin,
        _ => return Err(AppError::field("role", "取值必须是 member/admin")),
    };
    if role == OrgRole::Admin && ctx.role() < OrgRole::Owner {
        return Err(AppError::forbidden());
    }
    let targets = Targets::parse(&r.projects, &r.group_ids)?;
    let (password, generated) = initial_password(r.password.as_deref())?;
    // 邮箱已存在：不改其密码、不回显其信息；本组织成员 → already_member，其他已注册用户 → 改用邀请
    let existing: Option<bool> = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = $1 AND m.user_id = u.id) FROM users u WHERE u.email = $2",
    )
    .bind(ctx.org_id())
    .bind(&email)
    .fetch_optional(&st.db)
    .await?;
    let registered = || AppError::conflict("email_registered", "该邮箱已注册，请改用邀请把对方加入组织");
    match existing {
        Some(true) => return Err(AppError::conflict("already_member", "该邮箱已是本组织成员")),
        Some(false) => return Err(registered()),
        None => {}
    }
    let hash = hash_password(password.clone()).await?;
    let mut tx = st.db.begin().await?;
    targets.check(&mut tx, ctx.org_id()).await?;
    let id = new_id();
    sqlx::query(
        "INSERT INTO users (id, email, password_hash, display_name, email_verified_at, must_change_password) VALUES ($1, $2, $3, $4, now(), true)",
    )
    .bind(id)
    .bind(&email)
    .bind(hash)
    .bind(&name)
    .execute(&mut *tx)
    .await
    .map_err(|e| if unique_violation(&e).is_some() { registered() } else { e.into() })?;
    sqlx::query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)").bind(ctx.org_id()).bind(id).bind(role.as_str()).execute(&mut *tx).await?;
    targets.insert(&mut tx, ctx.org_id(), id).await?;
    let (projects, gids) = targets.audit();
    audit::log(
        &mut tx,
        Some(ctx.org_id()),
        &c.actor(),
        "member.account_create",
        "user",
        Some(id),
        json!({ "role": role.as_str(), "projects": projects, "group_ids": gids, "password": password_mode(generated) }),
    )
    .await?;
    tx.commit().await?;
    let joined: DateTime<Utc> =
        sqlx::query_scalar("SELECT created_at FROM memberships WHERE org_id = $1 AND user_id = $2").bind(ctx.org_id()).bind(id).fetch_one(&st.db).await?;
    let mut member = member_json(id, &name, &email, Some(role.as_str()), &joined);
    member["must_change_password"] = json!(true);
    Ok((StatusCode::CREATED, Json(json!({ "member": member, "generated_password": generated.then_some(password) }))))
}

#[derive(Deserialize)]
pub struct ResetAccountReq {
    password: Option<String>,
}

/// 重置管理员所建、尚未改过密码（must_change_password）的账号的一次性密码；已正常使用的账号一律 409。
/// 权限同移除成员：owner 可重置任何人，admin 只能重置 member；不能重置自己
pub async fn reset_account_password(
    State(st): State<AppState>,
    c: Caller,
    P((org_id, user_id)): P<(Uuid, Uuid)>,
    JsonBody(r): JsonBody<ResetAccountReq>,
) -> J {
    let ctx = require_org(&st.db, &c, org_id, OrgRole::Admin, Allow::Session).await?;
    st.rl.hit(&format!("create_account:{}", ctx.user_id()), 30, HOUR)?;
    let (password, generated) = initial_password(r.password.as_deref())?;
    let target: Option<(String, bool)> = sqlx::query_as(
        "SELECT m.role, u.must_change_password FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND m.user_id = $2",
    )
    .bind(ctx.org_id())
    .bind(user_id)
    .fetch_optional(&st.db)
    .await?;
    let (role, pending) = target.ok_or_else(AppError::not_found)?;
    if user_id == ctx.user_id() || !(ctx.role() == OrgRole::Owner || role == "member") {
        return Err(AppError::forbidden());
    }
    let in_use = || AppError::conflict("password_in_use", "该账号已改过密码、正常使用中，不能重置（请本人用「忘记密码」）");
    if !pending {
        return Err(in_use());
    }
    let hash = hash_password(password.clone()).await?;
    let mut tx = st.db.begin().await?;
    let n = sqlx::query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1 AND must_change_password")
        .bind(user_id)
        .bind(hash)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(in_use());
    }
    sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(user_id).execute(&mut *tx).await?;
    audit::log(&mut tx, Some(ctx.org_id()), &c.actor(), "member.password_reset", "user", Some(user_id), json!({ "password": password_mode(generated) }))
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "generated_password": generated.then_some(password) })))
}

// ---------------------------------------------------------------- 审计

#[derive(Deserialize)]
pub struct AuditQuery {
    limit: Option<i64>,
    cursor: Option<String>,
    action: Option<String>,
}

type AuditRow = (i64, String, String, Option<Uuid>, Option<Uuid>, Option<String>, Option<Uuid>, Option<String>, Value, DateTime<Utc>);

pub async fn list_audit(State(st): State<AppState>, c: Caller, P(org_id): P<Uuid>, Q(q): Q<AuditQuery>) -> J {
    let ctx = require_org(&st.db, &c, org_id, OrgRole::Admin, Allow::Session).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let cursor = q
        .cursor
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<i64>().map_err(|_| AppError::field("cursor", "无效游标")))
        .transpose()?;
    let rows: Vec<AuditRow> = sqlx::query_as(
        "SELECT a.id, a.action, a.target_type, a.target_id, a.actor_user_id, u.display_name, a.actor_pat_id, t.name, a.meta, a.created_at
           FROM audit_log a
           LEFT JOIN users u ON u.id = a.actor_user_id
           LEFT JOIN personal_access_tokens t ON t.id = a.actor_pat_id
          WHERE a.org_id = $1 AND ($2::bigint IS NULL OR a.id < $2) AND ($3::text IS NULL OR a.action = $3)
          ORDER BY a.id DESC LIMIT $4",
    )
    .bind(ctx.org_id())
    .bind(cursor)
    .bind(q.action.as_deref().filter(|s| !s.is_empty()))
    .bind(limit + 1)
    .fetch_all(&st.db)
    .await?;
    let (rows, next) = paginate(rows, limit, |r| r.0.to_string());
    let items = rows
        .into_iter()
        .map(|(id, action, tt, tid, uid, uname, pid, pname, meta, t)| {
            json!({
                "id": id, "action": action, "target_type": tt, "target_id": tid,
                "actor": {
                    "user": uid.map(|u| brief(u, uname.as_deref().unwrap_or(""))),
                    "pat": pid.map(|p| json!({ "id": p, "name": pname.unwrap_or_default() })),
                },
                "meta": meta, "created_at": ts(&t),
            })
        })
        .collect();
    Ok(Json(list(items, next)))
}

// ---------------------------------------------------------------- 项目

type ProjectRow = (Uuid, Uuid, String, String, String, Option<String>, DateTime<Utc>, DateTime<Utc>);

fn project_json(r: &ProjectRow) -> Value {
    json!({
        "id": r.0, "org_id": r.1, "name": r.2, "slug": r.3, "description": r.4,
        "my_role": r.5, "created_at": ts(&r.6), "updated_at": ts(&r.7),
    })
}

fn project_select() -> String {
    format!(
        "SELECT p.id, p.org_id, p.name, p.slug, p.description, {} AS my_role, p.created_at, p.updated_at
           FROM projects p LEFT JOIN memberships m ON m.org_id = p.org_id AND m.user_id = $2",
        role_expr("p.org_id", "p.id", "$2", "m.role")
    )
}

pub async fn project_by_id(db: &PgPool, org_id: Uuid, project_id: Uuid, uid: Uuid) -> AppResult<Value> {
    let sql = format!("{} WHERE p.org_id = $1 AND p.id = $3 AND p.deleted_at IS NULL", project_select());
    let row: ProjectRow = sqlx::query_as(&sql).bind(org_id).bind(uid).bind(project_id).fetch_one(db).await?;
    Ok(project_json(&row))
}

pub async fn list_projects(State(st): State<AppState>, c: Caller, P(org_id): P<Uuid>, Q(q): Q<PageQuery>) -> J {
    let ctx = require_org(&st.db, &c, org_id, OrgRole::Member, Allow::Session).await?;
    let sql = format!(
        "SELECT * FROM ({} WHERE p.org_id = $1 AND p.deleted_at IS NULL AND ($3::uuid IS NULL OR p.id < $3)) x
          WHERE $4 OR my_role IS NOT NULL ORDER BY id DESC LIMIT $5",
        project_select()
    );
    let rows: Vec<ProjectRow> = sqlx::query_as(&sql)
        .bind(ctx.org_id())
        .bind(ctx.user_id())
        .bind(q.cursor_id()?)
        .bind(ctx.role() >= OrgRole::Admin)
        .bind(q.limit() + 1)
        .fetch_all(&st.db)
        .await?;
    let (rows, next) = paginate(rows, q.limit(), |r| r.0.to_string());
    Ok(Json(list(rows.iter().map(project_json).collect(), next)))
}

#[derive(Deserialize)]
pub struct ProjectReq {
    name: Option<String>,
    slug: Option<String>,
    description: Option<String>,
}

fn description(d: Option<&str>) -> AppResult<Option<String>> {
    d.map(|d| text_field("description", d, 0, 2000)).transpose()
}

pub async fn create_project(State(st): State<AppState>, c: Caller, P(org_id): P<Uuid>, JsonBody(r): JsonBody<ProjectReq>) -> AppResult<(StatusCode, Json<Value>)> {
    let ctx = require_org(&st.db, &c, org_id, OrgRole::Member, MANAGE).await?;
    if c.p.pat().is_some_and(|p| p.project_id.is_some()) {
        return Err(AppError::new(StatusCode::FORBIDDEN, "project_scoped_token", "限定了项目的令牌不能创建项目，请使用不限项目的令牌"));
    }
    let name = text_field("name", r.name.as_deref().unwrap_or(""), 1, 100)?;
    let slug = slug_field(r.slug.as_deref().unwrap_or(""))?;
    let desc = description(r.description.as_deref())?.unwrap_or_default();
    let id = new_id();
    let mut tx = st.db.begin().await?;
    sqlx::query("INSERT INTO projects (id, org_id, name, slug, description, created_by) VALUES ($1, $2, $3, $4, $5, $6)")
        .bind(id)
        .bind(ctx.org_id())
        .bind(&name)
        .bind(&slug)
        .bind(&desc)
        .bind(ctx.user_id())
        .execute(&mut *tx)
        .await
        .map_err(slug_taken)?;
    sqlx::query("INSERT INTO project_members (org_id, project_id, user_id, role) VALUES ($1, $2, $3, 'admin')")
        .bind(ctx.org_id())
        .bind(id)
        .bind(ctx.user_id())
        .execute(&mut *tx)
        .await?;
    audit::log(&mut tx, Some(ctx.org_id()), &c.actor(), "project.create", "project", Some(id), json!({ "slug": slug })).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(project_by_id(&st.db, ctx.org_id(), id, ctx.user_id()).await?)))
}

pub async fn get_project(State(st): State<AppState>, c: Caller, P(id): P<Uuid>) -> J {
    let ctx = require_project(&st.db, &c, id, ProjectRole::Viewer, Allow::Session).await?;
    Ok(Json(project_by_id(&st.db, ctx.org_id(), ctx.project_id(), ctx.user_id()).await?))
}

pub async fn update_project(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, JsonBody(r): JsonBody<ProjectReq>) -> J {
    let ctx = require_project(&st.db, &c, id, ProjectRole::Admin, Allow::Session).await?;
    require_any(&[r.name.is_some(), r.slug.is_some(), r.description.is_some()])?;
    let name = r.name.as_deref().map(|n| text_field("name", n, 1, 100)).transpose()?;
    let slug = r.slug.as_deref().map(slug_field).transpose()?;
    let desc = description(r.description.as_deref())?;
    let mut tx = st.db.begin().await?;
    sqlx::query(
        "UPDATE projects SET name = COALESCE($3, name), slug = COALESCE($4, slug), description = COALESCE($5, description), updated_at = now()
          WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL",
    )
    .bind(ctx.org_id())
    .bind(ctx.project_id())
    .bind(&name)
    .bind(&slug)
    .bind(&desc)
    .execute(&mut *tx)
    .await
    .map_err(slug_taken)?;
    let fields: Vec<&str> =
        [name.as_ref().map(|_| "name"), slug.as_ref().map(|_| "slug"), desc.as_ref().map(|_| "description")].into_iter().flatten().collect();
    audit::log(&mut tx, Some(ctx.org_id()), &c.actor(), "project.update", "project", Some(ctx.project_id()), json!({ "fields": fields })).await?;
    tx.commit().await?;
    Ok(Json(project_by_id(&st.db, ctx.org_id(), ctx.project_id(), ctx.user_id()).await?))
}

pub async fn delete_project(State(st): State<AppState>, c: Caller, P(id): P<Uuid>) -> AppResult<StatusCode> {
    let ctx = require_project(&st.db, &c, id, ProjectRole::Admin, Allow::Session).await?;
    let mut tx = st.db.begin().await?;
    sqlx::query("UPDATE projects SET deleted_at = now(), updated_at = now() WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL")
        .bind(ctx.org_id())
        .bind(ctx.project_id())
        .execute(&mut *tx)
        .await?;
    audit::log(&mut tx, Some(ctx.org_id()), &c.actor(), "project.delete", "project", Some(ctx.project_id()), json!({})).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

type MyProjectRow = (Uuid, String, String, Uuid, String, String, String);

pub async fn my_projects(State(st): State<AppState>, c: Caller) -> J {
    let uid = require_user(&c, ANY_SCOPE)?;
    let pat = c.p.pat();
    let sql = format!(
        "SELECT * FROM (
           SELECT p.id, p.name, p.slug, o.id AS org_id, o.name AS org_name, o.slug AS org_slug, {} AS role
             FROM memberships m
             JOIN orgs o ON o.id = m.org_id AND o.deleted_at IS NULL
             JOIN projects p ON p.org_id = m.org_id AND p.deleted_at IS NULL
            WHERE m.user_id = $1 AND ($2::uuid IS NULL OR o.id = $2) AND ($3::uuid IS NULL OR p.id = $3)
         ) x WHERE role IS NOT NULL ORDER BY org_name, name",
        role_expr("p.org_id", "p.id", "$1", "m.role")
    );
    let rows: Vec<MyProjectRow> = sqlx::query_as(&sql)
        .bind(uid)
        .bind(pat.and_then(|p| p.org_id))
        .bind(pat.and_then(|p| p.project_id))
        .fetch_all(&st.db)
        .await?;
    let has = |s: Scope| pat.is_none_or(|p| p.scopes.iter().any(|x| x == s.as_str()));
    let items: Vec<Value> = rows
        .iter()
        .map(|(id, name, slug, oid, oname, oslug, role)| {
            let manager = role == "admin" || role == "editor";
            json!({
                "id": id, "name": name, "slug": slug,
                "org": { "id": oid, "name": oname, "slug": oslug },
                "role": role,
                "can_publish": manager && has(Scope::Publish),
                "can_read_responses": manager && has(Scope::ReadResponses),
            })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

// ---------------------------------------------------------------- 项目成员

pub(super) fn parse_project_role(s: &str) -> AppResult<ProjectRole> {
    ProjectRole::parse(s).ok_or_else(|| AppError::field("role", "取值必须是 admin/editor/viewer"))
}

pub async fn list_project_members(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, Q(q): Q<PageQuery>) -> J {
    let ctx = require_project(&st.db, &c, id, ProjectRole::Viewer, Allow::Session).await?;
    let cur = q.cursor_time()?;
    let rows: Vec<MemberRow> = sqlx::query_as(
        "SELECT u.id, u.display_name, u.email, pm.role, pm.created_at FROM project_members pm JOIN users u ON u.id = pm.user_id
          WHERE pm.org_id = $1 AND pm.project_id = $2 AND ($3::timestamptz IS NULL OR (pm.created_at, pm.user_id) < ($3, $4))
          ORDER BY pm.created_at DESC, pm.user_id DESC LIMIT $5",
    )
    .bind(ctx.org_id())
    .bind(ctx.project_id())
    .bind(cur.map(|c| c.0))
    .bind(cur.map(|c| c.1))
    .bind(q.limit() + 1)
    .fetch_all(&st.db)
    .await?;
    let (rows, next) = paginate(rows, q.limit(), |r| time_cursor(&r.4, &r.0));
    Ok(Json(list(rows.iter().map(|(id, n, e, r, t)| member_json(*id, n, e, Some(r), t)).collect(), next)))
}

/// 用户是否为组织成员（加入项目/群组前检查）
pub async fn ensure_org_member(conn: &mut sqlx::PgConnection, org_id: Uuid, user_id: Uuid) -> AppResult<()> {
    let ok: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = $2)")
        .bind(org_id)
        .bind(user_id)
        .fetch_one(conn)
        .await?;
    if ok { Ok(()) } else { Err(AppError::conflict("not_org_member", "该用户不是组织成员")) }
}

#[derive(Deserialize)]
pub struct AddMemberReq {
    user_id: Uuid,
    role: String,
}

pub async fn add_project_member(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, JsonBody(r): JsonBody<AddMemberReq>) -> AppResult<(StatusCode, Json<Value>)> {
    let ctx = require_project(&st.db, &c, id, ProjectRole::Admin, Allow::Session).await?;
    let role = parse_project_role(&r.role)?;
    let mut tx = st.db.begin().await?;
    ensure_org_member(&mut tx, ctx.org_id(), r.user_id).await?;
    let row: Result<MemberRow, _> = sqlx::query_as(
        "WITH ins AS (INSERT INTO project_members (org_id, project_id, user_id, role) VALUES ($1, $2, $3, $4) RETURNING user_id, role, created_at)
         SELECT u.id, u.display_name, u.email, ins.role, ins.created_at FROM ins JOIN users u ON u.id = ins.user_id",
    )
    .bind(ctx.org_id())
    .bind(ctx.project_id())
    .bind(r.user_id)
    .bind(role.as_str())
    .fetch_one(&mut *tx)
    .await;
    let row = row.map_err(|e| if unique_violation(&e).is_some() { AppError::conflict("already_member", "已是项目成员") } else { e.into() })?;
    audit::log(
        &mut tx,
        Some(ctx.org_id()),
        &c.actor(),
        "project_member.add",
        "project",
        Some(ctx.project_id()),
        json!({ "user_id": r.user_id, "role": role.as_str() }),
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(member_json(row.0, &row.1, &row.2, Some(&row.3), &row.4))))
}

pub async fn update_project_member(
    State(st): State<AppState>,
    c: Caller,
    P((id, user_id)): P<(Uuid, Uuid)>,
    JsonBody(r): JsonBody<RoleReq>,
) -> J {
    let ctx = require_project(&st.db, &c, id, ProjectRole::Admin, Allow::Session).await?;
    let role = parse_project_role(&r.role)?;
    let mut tx = st.db.begin().await?;
    let row: Option<(MemberRow, String)> = sqlx::query_as::<_, (Uuid, String, String, String, DateTime<Utc>, String)>(
        "WITH old AS (SELECT role FROM project_members WHERE org_id = $1 AND project_id = $2 AND user_id = $3),
              upd AS (UPDATE project_members SET role = $4 WHERE org_id = $1 AND project_id = $2 AND user_id = $3 RETURNING user_id, role, created_at)
         SELECT u.id, u.display_name, u.email, upd.role, upd.created_at, old.role FROM upd, old, users u WHERE u.id = upd.user_id",
    )
    .bind(ctx.org_id())
    .bind(ctx.project_id())
    .bind(user_id)
    .bind(role.as_str())
    .fetch_optional(&mut *tx)
    .await?
    .map(|(a, b, c, d, e, f)| ((a, b, c, d, e), f));
    let (row, old) = row.ok_or_else(AppError::not_found)?;
    audit::log(
        &mut tx,
        Some(ctx.org_id()),
        &c.actor(),
        "project_member.role_change",
        "project",
        Some(ctx.project_id()),
        json!({ "user_id": user_id, "old": old, "new": role.as_str() }),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(member_json(row.0, &row.1, &row.2, Some(&row.3), &row.4)))
}

pub async fn remove_project_member(State(st): State<AppState>, c: Caller, P((id, user_id)): P<(Uuid, Uuid)>) -> AppResult<StatusCode> {
    let ctx = require_project(&st.db, &c, id, ProjectRole::Viewer, Allow::Session).await?;
    if user_id != ctx.user_id() && ctx.role() < ProjectRole::Admin {
        return Err(AppError::forbidden());
    }
    let mut tx = st.db.begin().await?;
    let n = sqlx::query("DELETE FROM project_members WHERE org_id = $1 AND project_id = $2 AND user_id = $3")
        .bind(ctx.org_id())
        .bind(ctx.project_id())
        .bind(user_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::not_found());
    }
    audit::log(&mut tx, Some(ctx.org_id()), &c.actor(), "project_member.remove", "project", Some(ctx.project_id()), json!({ "user_id": user_id }))
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- 项目群组授权

fn grant_json(gid: Uuid, name: &str, role: &str, t: &DateTime<Utc>) -> Value {
    json!({ "group": { "id": gid, "name": name }, "role": role, "created_at": ts(t) })
}

type ProjectGroupRow = (Uuid, String, Option<Uuid>, String, DateTime<Utc>, i64, Option<DateTime<Utc>>, String);

/// 本项目最近更新的这么多个页面里找各群组的 last_page_at（上界，不随群组历史页面数增长）
const GROUP_RECENT_SCAN: i64 = 1000;

/// 本项目的群组（项目群组在前）与已授权的组织级群组。
/// last_page_at：本项目里最近一次有页面发给该群组的时间（page_groups 关联的本项目未删除页面的 updated_at 最大值，发布与更新都会刷新；
/// 只看本项目，不暴露其他项目的发页时间）；active：last_page_at 在 ACTIVE_GROUP_SECS 内。
pub async fn list_project_groups(State(st): State<AppState>, c: Caller, P(id): P<Uuid>) -> J {
    let ctx = require_project(&st.db, &c, id, ProjectRole::Viewer, PUBLISH_OR_MANAGE).await?;
    // 沿 pages_project_updated_idx 取本项目最近更新的 GROUP_RECENT_SCAN 个页面，再按 page_groups 主键 (page_id, group_id) 逐页探测
    // （LATERAL + OFFSET 0：阻止规划器改成对整个 page_groups 的哈希连接）。
    // ponytail: 群组在本项目的最后一页比最近 1000 个页面都旧时 last_page_at 为 null（active 只在 4 小时内超过 1000 次发布/更新时才会漏）；
    // 真需要精确值再给 page_groups 加时间列
    let rows: Vec<ProjectGroupRow> = sqlx::query_as(
        "WITH recent AS (
           SELECT p.id, p.updated_at FROM pages p WHERE p.project_id = $2 AND p.deleted_at IS NULL ORDER BY p.updated_at DESC LIMIT $3
         ), last AS (
           SELECT x.group_id, max(r.updated_at) AS at FROM recent r
             CROSS JOIN LATERAL (SELECT x.group_id FROM page_groups x WHERE x.page_id = r.id AND x.org_id = $1 OFFSET 0) x
            GROUP BY x.group_id
         )
         SELECT g.id, g.name, g.project_id, pg.role, pg.created_at,
                (SELECT count(*) FROM group_members gm WHERE gm.org_id = g.org_id AND gm.group_id = g.id) AS member_count,
                l.at AS last_page_at, g.description
           FROM project_groups pg JOIN groups g ON g.org_id = pg.org_id AND g.id = pg.group_id
           LEFT JOIN last l ON l.group_id = g.id
          WHERE pg.org_id = $1 AND pg.project_id = $2
          ORDER BY g.project_id IS NULL, last_page_at DESC NULLS LAST, pg.created_at DESC",
    )
    .bind(ctx.org_id())
    .bind(ctx.project_id())
    .bind(GROUP_RECENT_SCAN)
    .fetch_all(&st.db)
    .await?;
    let since = Utc::now() - chrono::Duration::seconds(ACTIVE_GROUP_SECS);
    let items: Vec<Value> = rows
        .iter()
        .map(|(g, n, pid, r, t, mc, last, desc)| {
            let mut v = grant_json(*g, n, r, t);
            v["group"]["project_id"] = json!(pid);
            for (k, x) in [
                ("id", json!(g)),
                ("name", json!(n)),
                ("description", json!(desc)),
                ("project_id", json!(pid)),
                ("member_count", json!(mc)),
                ("last_page_at", json!(last.as_ref().map(ts))),
                ("active", json!(last.is_some_and(|l| l > since))),
            ] {
                v[k] = x;
            }
            v
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

pub async fn grant_project_group(State(st): State<AppState>, c: Caller, P((id, group_id)): P<(Uuid, Uuid)>, JsonBody(r): JsonBody<RoleReq>) -> J {
    let ctx = require_project(&st.db, &c, id, ProjectRole::Admin, Allow::Session).await?;
    let role = parse_project_role(&r.role)?;
    let mut tx = st.db.begin().await?;
    let row: Option<(String, Option<Uuid>)> = sqlx::query_as("SELECT name, project_id FROM groups WHERE org_id = $1 AND id = $2")
        .bind(ctx.org_id())
        .bind(group_id)
        .fetch_optional(&mut *tx)
        .await?;
    let (name, owner) = row.ok_or_else(AppError::not_found)?;
    if owner.is_some_and(|p| p != ctx.project_id()) {
        return Err(AppError::conflict("group_belongs_to_other_project", "这是其他项目的项目群组，不能授权给本项目"));
    }
    if owner.is_some() && role == ProjectRole::Admin {
        return Err(AppError::field("role", "项目群组的角色只能是 viewer/editor"));
    }
    let created: DateTime<Utc> = sqlx::query_scalar(
        "INSERT INTO project_groups (org_id, project_id, group_id, role) VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, group_id) DO UPDATE SET role = EXCLUDED.role RETURNING created_at",
    )
    .bind(ctx.org_id())
    .bind(ctx.project_id())
    .bind(group_id)
    .bind(role.as_str())
    .fetch_one(&mut *tx)
    .await?;
    audit::log(
        &mut tx,
        Some(ctx.org_id()),
        &c.actor(),
        "project_group.grant",
        "project",
        Some(ctx.project_id()),
        json!({ "group_id": group_id, "role": role.as_str() }),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(grant_json(group_id, &name, role.as_str(), &created)))
}

pub async fn revoke_project_group(State(st): State<AppState>, c: Caller, P((id, group_id)): P<(Uuid, Uuid)>) -> AppResult<StatusCode> {
    let ctx = require_project(&st.db, &c, id, ProjectRole::Admin, Allow::Session).await?;
    let mut tx = st.db.begin().await?;
    let own: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM groups WHERE org_id = $1 AND id = $2 AND project_id = $3)")
        .bind(ctx.org_id())
        .bind(group_id)
        .bind(ctx.project_id())
        .fetch_one(&mut *tx)
        .await?;
    if own {
        return Err(AppError::conflict("own_project_group", "本项目的项目群组不能单独撤销授权，请直接删除该群组"));
    }
    let n = sqlx::query("DELETE FROM project_groups WHERE org_id = $1 AND project_id = $2 AND group_id = $3")
        .bind(ctx.org_id())
        .bind(ctx.project_id())
        .bind(group_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::not_found());
    }
    audit::log(&mut tx, Some(ctx.org_id()), &c.actor(), "project_group.revoke", "project", Some(ctx.project_id()), json!({ "group_id": group_id }))
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
