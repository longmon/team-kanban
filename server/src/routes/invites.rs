use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use super::{brief, groups::group_by_id, list, org_json, orgs::project_by_id};
use crate::{
    AppState, audit,
    auth::Caller,
    authz::{Allow, OrgRole, ProjectRole, require_group, require_invite_manage, require_org, require_project},
    error::{AppError, AppResult, JsonBody, P, Q},
    ratelimit::HOUR,
    util::{email_field, new_id, paginate, random_token, sha256, ts, ts_opt},
};

type J = AppResult<Json<Value>>;

#[derive(FromRow)]
pub struct InviteRow {
    id: Uuid,
    org_id: Uuid,
    target_type: String,
    project_id: Option<Uuid>,
    group_id: Option<Uuid>,
    role: String,
    email: Option<String>,
    max_uses: i32,
    use_count: i32,
    created_by: Uuid,
    creator_name: String,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
    org_name: String,
    org_slug: String,
    target_name: String,
    target_deleted: bool,
}

const INVITE_SELECT: &str = "SELECT i.id, i.org_id, i.target_type, i.project_id, i.group_id, i.role, i.email, i.max_uses, i.use_count,
        i.created_by, u.display_name AS creator_name, i.created_at, i.expires_at, i.revoked_at,
        o.name AS org_name, o.slug AS org_slug, COALESCE(p.name, g.name, o.name) AS target_name,
        (p.deleted_at IS NOT NULL) AS target_deleted
   FROM invites i
   JOIN orgs o ON o.id = i.org_id AND o.deleted_at IS NULL
   JOIN users u ON u.id = i.created_by
   LEFT JOIN projects p ON p.org_id = i.org_id AND p.id = i.project_id
   LEFT JOIN groups g ON g.org_id = i.org_id AND g.id = i.group_id";

const ACTIVE: &str = "i.revoked_at IS NULL AND i.expires_at > now() AND i.use_count < i.max_uses";

impl InviteRow {
    /// 失效原因（410）；None = 有效
    pub fn active_error(&self) -> Option<AppError> {
        if self.revoked_at.is_some() {
            Some(AppError::gone("invite_revoked", "邀请已撤销"))
        } else if self.expires_at <= Utc::now() {
            Some(AppError::gone("invite_expired", "邀请已过期"))
        } else if self.use_count >= self.max_uses {
            Some(AppError::gone("invite_used_up", "邀请已用完"))
        } else {
            None
        }
    }

    fn json(&self) -> Value {
        let target_id = self.project_id.or(self.group_id).unwrap_or(self.org_id);
        json!({
            "id": self.id, "org_id": self.org_id, "target_type": self.target_type,
            "target": { "id": target_id, "name": self.target_name },
            "role": self.role, "email": self.email, "max_uses": self.max_uses, "use_count": self.use_count,
            "created_by": brief(self.created_by, &self.creator_name),
            "created_at": ts(&self.created_at), "expires_at": ts(&self.expires_at), "revoked_at": ts_opt(&self.revoked_at),
        })
    }
}

/// 按 token 定位邀请；组织或目标已删除 → 404。不检查是否有效
pub async fn invite_by_token(db: &PgPool, token: &str) -> AppResult<InviteRow> {
    let row: Option<InviteRow> =
        sqlx::query_as(&format!("{INVITE_SELECT} WHERE i.token_hash = $1")).bind(sha256(token)).fetch_optional(db).await?;
    row.filter(|r| !r.target_deleted).ok_or_else(AppError::not_found)
}

#[derive(Deserialize)]
pub struct CreateReq {
    target_type: String,
    project_id: Option<Uuid>,
    group_id: Option<Uuid>,
    role: String,
    email: Option<String>,
    max_uses: Option<i32>,
    expires_in: Option<i64>,
}

pub async fn create_invite(State(st): State<AppState>, c: Caller, P(org_id): P<Uuid>, JsonBody(r): JsonBody<CreateReq>) -> AppResult<(StatusCode, Json<Value>)> {
    let ctx = require_org(&st.db, &c, org_id, OrgRole::Member, Allow::Session).await?;
    let bad_role = || AppError::field("role", "角色与邀请类型不匹配");
    let (project_id, group_id, target_id) = match r.target_type.as_str() {
        "org" => {
            if r.project_id.is_some() || r.group_id.is_some() || !matches!(r.role.as_str(), "admin" | "member") {
                return Err(bad_role());
            }
            let need = if r.role == "admin" { OrgRole::Owner } else { OrgRole::Admin };
            if ctx.role() < need {
                return Err(AppError::forbidden());
            }
            (None, None, ctx.org_id())
        }
        "project" => {
            let pid = r.project_id.ok_or_else(|| AppError::field("project_id", "必填"))?;
            ProjectRole::parse(&r.role).ok_or_else(bad_role)?;
            let p = require_project(&st.db, &c, pid, ProjectRole::Admin, Allow::Session).await?;
            if p.org_id() != ctx.org_id() {
                return Err(AppError::not_found());
            }
            (Some(pid), None, pid)
        }
        "group" => {
            let gid = r.group_id.ok_or_else(|| AppError::field("group_id", "必填"))?;
            if r.role != "member" {
                return Err(bad_role());
            }
            let g = require_group(&st.db, &c, gid, OrgRole::Admin, Allow::Session).await?;
            if g.org_id() != ctx.org_id() {
                return Err(AppError::not_found());
            }
            (None, Some(gid), gid)
        }
        _ => return Err(AppError::field("target_type", "取值必须是 org/project/group")),
    };
    let email = r.email.as_deref().filter(|e| !e.trim().is_empty()).map(email_field).transpose()?;
    let max_uses = if email.is_some() { 1 } else { r.max_uses.unwrap_or(1) };
    if !(1..=1000).contains(&max_uses) {
        return Err(AppError::field("max_uses", "范围 1..1000"));
    }
    let expires_in = r.expires_in.unwrap_or(7 * 86400);
    if !(3600..=2_592_000).contains(&expires_in) {
        return Err(AppError::field("expires_in", "范围 3600..2592000 秒"));
    }
    let id = new_id();
    let token = random_token();
    let mut tx = st.db.begin().await?;
    sqlx::query(
        "INSERT INTO invites (id, org_id, target_type, project_id, group_id, role, email, token_hash, max_uses, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(secs => $11))",
    )
    .bind(id)
    .bind(ctx.org_id())
    .bind(&r.target_type)
    .bind(project_id)
    .bind(group_id)
    .bind(&r.role)
    .bind(&email)
    .bind(sha256(&token))
    .bind(max_uses)
    .bind(ctx.user_id())
    .bind(expires_in as f64)
    .execute(&mut *tx)
    .await?;
    audit::log(
        &mut tx,
        Some(ctx.org_id()),
        &c.actor(),
        "invite.create",
        "invite",
        Some(id),
        json!({ "target_type": r.target_type, "target_id": target_id, "role": r.role, "email_bound": email.is_some(), "max_uses": max_uses }),
    )
    .await?;
    tx.commit().await?;
    let row: InviteRow = sqlx::query_as(&format!("{INVITE_SELECT} WHERE i.org_id = $1 AND i.id = $2")).bind(ctx.org_id()).bind(id).fetch_one(&st.db).await?;
    let url = format!("{}/invite/{token}", st.cfg.public_url);
    if let Some(e) = &email {
        st.mail.send(e, &format!("邀请你加入 {}", row.org_name), format!("{} 邀请你加入「{}」。\n接受邀请：{url}\n", row.creator_name, row.target_name));
    }
    Ok((StatusCode::CREATED, Json(json!({ "invite": row.json(), "url": url }))))
}

#[derive(Deserialize)]
pub struct ListQuery {
    limit: Option<i64>,
    cursor: Option<String>,
    include_inactive: Option<bool>,
}

async fn list_invites(db: &PgPool, org_id: Uuid, project_id: Option<Uuid>, q: &ListQuery) -> J {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let page = crate::util::PageQuery { limit: Some(limit), cursor: q.cursor.clone() };
    let active = if q.include_inactive.unwrap_or(false) { "TRUE" } else { ACTIVE };
    let rows: Vec<InviteRow> = sqlx::query_as(&format!(
        "{INVITE_SELECT} WHERE i.org_id = $1 AND ($2::uuid IS NULL OR (i.target_type = 'project' AND i.project_id = $2))
           AND ($3::uuid IS NULL OR i.id < $3) AND {active} ORDER BY i.id DESC LIMIT $4"
    ))
    .bind(org_id)
    .bind(project_id)
    .bind(page.cursor_id()?)
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let (rows, next) = paginate(rows, limit, |r| r.id.to_string());
    Ok(Json(list(rows.iter().map(InviteRow::json).collect(), next)))
}

pub async fn list_org_invites(State(st): State<AppState>, c: Caller, P(org_id): P<Uuid>, Q(q): Q<ListQuery>) -> J {
    let ctx = require_org(&st.db, &c, org_id, OrgRole::Admin, Allow::Session).await?;
    list_invites(&st.db, ctx.org_id(), None, &q).await
}

pub async fn list_project_invites(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, Q(q): Q<ListQuery>) -> J {
    let ctx = require_project(&st.db, &c, id, ProjectRole::Admin, Allow::Session).await?;
    list_invites(&st.db, ctx.org_id(), Some(ctx.project_id()), &q).await
}

pub async fn revoke_invite(State(st): State<AppState>, c: Caller, P(id): P<Uuid>) -> AppResult<StatusCode> {
    let ctx = require_invite_manage(&st.db, &c, id).await?;
    let mut tx = st.db.begin().await?;
    let n = sqlx::query("UPDATE invites SET revoked_at = now() WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL")
        .bind(ctx.org_id())
        .bind(ctx.invite_id())
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n > 0 {
        audit::log(&mut tx, Some(ctx.org_id()), &c.actor(), "invite.revoke", "invite", Some(ctx.invite_id()), json!({})).await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn preview_invite(State(st): State<AppState>, P(token): P<String>) -> J {
    let inv = invite_by_token(&st.db, &token).await?;
    if let Some(e) = inv.active_error() {
        return Err(e);
    }
    Ok(Json(json!({
        "org": { "name": inv.org_name, "slug": inv.org_slug },
        "target_type": inv.target_type, "target_name": inv.target_name, "role": inv.role,
        "invited_by": inv.creator_name, "email_bound": inv.email.is_some(), "expires_at": ts(&inv.expires_at),
    })))
}

pub async fn accept_invite(State(st): State<AppState>, c: Caller, P(token): P<String>) -> J {
    let uid = c.session_user()?;
    st.rl.hit(&format!("invite_accept:{}", c.ip), 30, HOUR)?;
    let inv = invite_by_token(&st.db, &token).await?;
    if let Some(e) = inv.active_error() {
        return Err(e);
    }
    if let Some(bound) = &inv.email {
        let (email, verified): (String, Option<DateTime<Utc>>) =
            sqlx::query_as("SELECT email, email_verified_at FROM users WHERE id = $1").bind(uid).fetch_one(&st.db).await?;
        if &email != bound {
            return Err(AppError::new(StatusCode::FORBIDDEN, "email_mismatch", "该邀请绑定了其它邮箱"));
        }
        if verified.is_none() {
            return Err(AppError::new(StatusCode::FORBIDDEN, "email_unverified", "请先验证邮箱"));
        }
    }
    let mut tx = st.db.begin().await?;
    let n = sqlx::query(
        "UPDATE invites SET use_count = use_count + 1
          WHERE id = $1 AND revoked_at IS NULL AND expires_at > now() AND use_count < max_uses",
    )
    .bind(inv.id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(AppError::gone("invite_used_up", "邀请已用完"));
    }
    // 已是成员：不降级，邀请角色更高则升级
    let org_role = if inv.target_type == "org" { inv.role.as_str() } else { "member" };
    sqlx::query(
        "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (org_id, user_id) DO UPDATE SET role = CASE WHEN memberships.role = 'member' THEN EXCLUDED.role ELSE memberships.role END",
    )
    .bind(inv.org_id)
    .bind(uid)
    .bind(org_role)
    .execute(&mut *tx)
    .await?;
    if let Some(pid) = inv.project_id {
        sqlx::query(
            "INSERT INTO project_members (org_id, project_id, user_id, role) VALUES ($1, $2, $3, $4)
             ON CONFLICT (project_id, user_id) DO UPDATE SET role = CASE
               WHEN project_members.role = 'admin' OR EXCLUDED.role = 'viewer' THEN project_members.role
               WHEN project_members.role = 'editor' AND EXCLUDED.role = 'editor' THEN project_members.role
               ELSE EXCLUDED.role END",
        )
        .bind(inv.org_id)
        .bind(pid)
        .bind(uid)
        .bind(&inv.role)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(gid) = inv.group_id {
        sqlx::query("INSERT INTO group_members (org_id, group_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING")
            .bind(inv.org_id)
            .bind(gid)
            .bind(uid)
            .execute(&mut *tx)
            .await?;
    }
    audit::log(&mut tx, Some(inv.org_id), &c.actor(), "invite.accept", "invite", Some(inv.id), json!({ "target_type": inv.target_type, "role": inv.role }))
        .await?;
    tx.commit().await?;

    let (name, slug, role, created): (String, String, String, DateTime<Utc>) = sqlx::query_as(
        "SELECT o.name, o.slug, m.role, o.created_at FROM orgs o JOIN memberships m ON m.org_id = o.id AND m.user_id = $2 WHERE o.id = $1",
    )
    .bind(inv.org_id)
    .bind(uid)
    .fetch_one(&st.db)
    .await?;
    let project = match inv.project_id {
        Some(pid) => Some(project_by_id(&st.db, inv.org_id, pid, uid).await?),
        None => None,
    };
    let group = match inv.group_id {
        Some(gid) => Some(group_by_id(&st.db, inv.org_id, gid).await?),
        None => None,
    };
    Ok(Json(json!({ "org": org_json(inv.org_id, &name, &slug, &role, &created), "project": project, "group": group })))
}
