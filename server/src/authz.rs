//! 授权层「能不能」唯一入口（design §5）。Ctx 字段私有、只能在本文件构造：拿不到 Ctx 就拿不到可信的 org_id。
//! 统一 404：不存在 / 已删除 / 跨租户 / 无查看权限；只有「看得见但不能做」才 403。
use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::{
    auth::Caller,
    config::Config,
    error::{AppError, AppResult},
    util::{b64, b64_decode, hmac_sign, hmac_verify, sha256},
};

// ---------------------------------------------------------------- 角色

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum OrgRole {
    Member,
    Admin,
    Owner,
}

impl OrgRole {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "owner" => Self::Owner,
            "admin" => Self::Admin,
            "member" => Self::Member,
            _ => return None,
        })
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Admin => "admin",
            Self::Member => "member",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ProjectRole {
    Viewer,
    Editor,
    Admin,
}

impl ProjectRole {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "admin" => Self::Admin,
            "editor" => Self::Editor,
            "viewer" => Self::Viewer,
            _ => return None,
        })
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Editor => "editor",
            Self::Viewer => "viewer",
        }
    }
}

/// SQL 片段：有效项目角色（design §4.1）。参数为列/占位符表达式，m 为 memberships 的别名或 NULL 行
pub fn role_expr(org: &str, proj: &str, uid: &str, org_role: &str) -> String {
    format!(
        "CASE WHEN {org_role} IN ('owner', 'admin') THEN 'admin' ELSE (
           SELECT r FROM (
             SELECT pm.role AS r FROM project_members pm
              WHERE pm.org_id = {org} AND pm.project_id = {proj} AND pm.user_id = {uid}
             UNION ALL
             SELECT pg.role FROM project_groups pg
               JOIN group_members gm ON gm.org_id = pg.org_id AND gm.group_id = pg.group_id
              WHERE pg.org_id = {org} AND pg.project_id = {proj} AND gm.user_id = {uid}
           ) x ORDER BY CASE r WHEN 'admin' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END LIMIT 1) END"
    )
}

// ---------------------------------------------------------------- 接入方式

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scope {
    Publish,
    ReadResponses,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Publish => "publish",
            Scope::ReadResponses => "read_responses",
        }
    }
}

/// 端点允许的接入方式：仅 cookie，或 cookie + 具备任一 scope 的 PAT
#[derive(Clone, Copy)]
pub enum Allow {
    Session,
    Pat(&'static [Scope]),
}

pub const PUBLISH: Allow = Allow::Pat(&[Scope::Publish]);
pub const READ_RESPONSES: Allow = Allow::Pat(&[Scope::ReadResponses]);
pub const ANY_SCOPE: Allow = Allow::Pat(&[Scope::Publish, Scope::ReadResponses]);

fn user_of(c: &Caller) -> AppResult<Uuid> {
    c.p.user_id().ok_or_else(AppError::unauthenticated)
}

/// PAT scope 检查：仅 cookie 的端点或 scope 不足 → 403。
/// 带 id 的资源先做存在性/租户检查再调用本函数，保证跨租户一律 404
pub fn check_allow(c: &Caller, allow: Allow) -> AppResult<()> {
    if let Some(pat) = c.p.pat() {
        let ok = match allow {
            Allow::Session => false,
            Allow::Pat(scopes) => scopes.iter().any(|s| pat.scopes.iter().any(|x| x == s.as_str())),
        };
        if !ok {
            return Err(AppError::forbidden());
        }
    }
    Ok(())
}

/// 认证 + scope 检查（无资源 id 的端点），返回 user_id。匿名 401；PAT scope 不足 403
pub fn require_user(c: &Caller, allow: Allow) -> AppResult<Uuid> {
    let uid = user_of(c)?;
    check_allow(c, allow)?;
    Ok(uid)
}

/// PAT 限定范围：越界 404。project_id = None 表示组织级资源
fn pat_bounds(c: &Caller, org_id: Uuid, project_id: Option<Uuid>) -> AppResult<()> {
    if let Some(pat) = c.p.pat() {
        if pat.org_id.is_some_and(|o| o != org_id) {
            return Err(AppError::not_found());
        }
        if let (Some(pp), Some(p)) = (pat.project_id, project_id)
            && pp != p {
                return Err(AppError::not_found());
            }
    }
    Ok(())
}

// ---------------------------------------------------------------- 组织

pub struct OrgCtx {
    org_id: Uuid,
    user_id: Uuid,
    role: OrgRole,
}

impl OrgCtx {
    pub fn org_id(&self) -> Uuid {
        self.org_id
    }
    pub fn user_id(&self) -> Uuid {
        self.user_id
    }
    pub fn role(&self) -> OrgRole {
        self.role
    }
}

pub async fn require_org(db: &PgPool, c: &Caller, org_id: Uuid, min: OrgRole, allow: Allow) -> AppResult<OrgCtx> {
    let user_id = user_of(c)?;
    pat_bounds(c, org_id, None)?;
    let role: Option<String> = sqlx::query_scalar(
        "SELECT m.role FROM memberships m JOIN orgs o ON o.id = m.org_id AND o.deleted_at IS NULL
          WHERE m.org_id = $1 AND m.user_id = $2",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let role = role.as_deref().and_then(OrgRole::parse).ok_or_else(AppError::not_found)?;
    check_allow(c, allow)?;
    if role < min {
        return Err(AppError::forbidden());
    }
    Ok(OrgCtx { org_id, user_id, role })
}

// ---------------------------------------------------------------- 项目

pub struct ProjectCtx {
    org_id: Uuid,
    project_id: Uuid,
    user_id: Uuid,
    role: ProjectRole,
}

impl ProjectCtx {
    pub fn org_id(&self) -> Uuid {
        self.org_id
    }
    pub fn project_id(&self) -> Uuid {
        self.project_id
    }
    pub fn user_id(&self) -> Uuid {
        self.user_id
    }
    pub fn role(&self) -> ProjectRole {
        self.role
    }
}

pub async fn require_project(db: &PgPool, c: &Caller, project_id: Uuid, min: ProjectRole, allow: Allow) -> AppResult<ProjectCtx> {
    let user_id = user_of(c)?;
    let sql = format!(
        "SELECT p.org_id, {} AS role FROM projects p
           JOIN orgs o ON o.id = p.org_id AND o.deleted_at IS NULL
           LEFT JOIN memberships m ON m.org_id = p.org_id AND m.user_id = $2
          WHERE p.id = $1 AND p.deleted_at IS NULL",
        role_expr("p.org_id", "p.id", "$2", "m.role")
    );
    let row: Option<(Uuid, Option<String>)> = sqlx::query_as(&sql).bind(project_id).bind(user_id).fetch_optional(db).await?;
    let (org_id, role) = row.ok_or_else(AppError::not_found)?;
    let role = role.as_deref().and_then(ProjectRole::parse).ok_or_else(AppError::not_found)?;
    pat_bounds(c, org_id, Some(project_id))?;
    check_allow(c, allow)?;
    if role < min {
        return Err(AppError::forbidden());
    }
    Ok(ProjectCtx { org_id, project_id, user_id, role })
}

// ---------------------------------------------------------------- 群组

pub struct GroupCtx {
    org_id: Uuid,
    group_id: Uuid,
    user_id: Uuid,
}

impl GroupCtx {
    pub fn org_id(&self) -> Uuid {
        self.org_id
    }
    pub fn group_id(&self) -> Uuid {
        self.group_id
    }
    pub fn user_id(&self) -> Uuid {
        self.user_id
    }
}

pub async fn require_group(db: &PgPool, c: &Caller, group_id: Uuid, min: OrgRole, allow: Allow) -> AppResult<GroupCtx> {
    let user_id = user_of(c)?;
    let row: Option<(Uuid, Option<String>)> = sqlx::query_as(
        "SELECT g.org_id, m.role FROM groups g
           JOIN orgs o ON o.id = g.org_id AND o.deleted_at IS NULL
           LEFT JOIN memberships m ON m.org_id = g.org_id AND m.user_id = $2
          WHERE g.id = $1",
    )
    .bind(group_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let (org_id, role) = row.ok_or_else(AppError::not_found)?;
    let role = role.as_deref().and_then(OrgRole::parse).ok_or_else(AppError::not_found)?;
    pat_bounds(c, org_id, None)?;
    check_allow(c, allow)?;
    if role < min {
        return Err(AppError::forbidden());
    }
    Ok(GroupCtx { org_id, group_id, user_id })
}

// ---------------------------------------------------------------- 页面

/// 页面类型的行为大类（不入库，由 page_type 推导）：read 只读 / collect 收集回复 / collab 协作任务
pub fn page_category(page_type: &str) -> &'static str {
    match page_type {
        "report" | "knowledge" | "flowchart" | "architecture" => "read",
        "requirement" | "task" | "task_tree" => "collab",
        _ => "collect",
    }
}

#[derive(FromRow, Debug, Clone)]
pub struct PageRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub project_id: Uuid,
    pub title: String,
    pub kind: String,
    pub page_type: String,
    pub version: i32,
    pub visibility: String,
    pub accept_responses: bool,
    pub results_visible_to: String,
    pub response_seq: i64,
    pub updated_at: DateTime<Utc>,
    pub project_name: String,
    pub org_name: String,
    pub org_role: Option<String>,
    pub role: Option<String>,
    pub in_group: bool,
}

impl PageRow {
    fn project_role(&self) -> Option<ProjectRole> {
        self.role.as_deref().and_then(ProjectRole::parse)
    }
    fn is_manager(&self) -> bool {
        self.project_role() >= Some(ProjectRole::Editor)
    }
    /// 不经临时链接时能否查看（design §5.3）
    fn can_view(&self, user: Option<Uuid>) -> bool {
        self.is_manager()
            || match self.visibility.as_str() {
                "public" => true,
                "org" => user.is_some() && self.org_role.is_some(),
                "project" => self.role.is_some(),
                "groups" => user.is_some() && self.in_group,
                _ => false,
            }
    }
}

async fn load_page(db: &PgPool, page_id: Uuid, user: Option<Uuid>) -> AppResult<Option<PageRow>> {
    let sql = format!(
        "SELECT p.id, p.org_id, p.project_id, p.title, p.kind, p.page_type, p.version, p.visibility, p.accept_responses,
                p.results_visible_to, p.response_seq, p.updated_at, pr.name AS project_name, o.name AS org_name,
                m.role AS org_role, {} AS role,
                EXISTS (SELECT 1 FROM page_groups pg
                          JOIN group_members gm ON gm.org_id = pg.org_id AND gm.group_id = pg.group_id
                         WHERE pg.org_id = p.org_id AND pg.page_id = p.id AND gm.user_id = $2) AS in_group
           FROM pages p
           JOIN projects pr ON pr.org_id = p.org_id AND pr.id = p.project_id AND pr.deleted_at IS NULL
           JOIN orgs o ON o.id = p.org_id AND o.deleted_at IS NULL
           LEFT JOIN memberships m ON m.org_id = p.org_id AND m.user_id = $2
          WHERE p.id = $1 AND p.deleted_at IS NULL",
        role_expr("p.org_id", "p.project_id", "$2", "m.role")
    );
    Ok(sqlx::query_as(&sql).bind(page_id).bind(user).fetch_optional(db).await?)
}

/// 页面管理者（项目 admin/editor）上下文
pub struct PageCtx {
    org_id: Uuid,
    project_id: Uuid,
    page_id: Uuid,
    user_id: Uuid,
    page: PageRow,
}

impl PageCtx {
    pub fn org_id(&self) -> Uuid {
        self.org_id
    }
    pub fn project_id(&self) -> Uuid {
        self.project_id
    }
    pub fn page_id(&self) -> Uuid {
        self.page_id
    }
    pub fn user_id(&self) -> Uuid {
        self.user_id
    }
    pub fn page(&self) -> &PageRow {
        &self.page
    }
}

pub async fn require_page_manage(db: &PgPool, c: &Caller, page_id: Uuid, allow: Allow) -> AppResult<PageCtx> {
    let user_id = user_of(c)?;
    let page = load_page(db, page_id, Some(user_id)).await?.ok_or_else(AppError::not_found)?;
    pat_bounds(c, page.org_id, Some(page.project_id))?;
    let can_view = page.can_view(Some(user_id));
    if !can_view {
        return Err(AppError::not_found());
    }
    check_allow(c, allow)?;
    if !page.is_manager() {
        return Err(AppError::forbidden());
    }
    Ok(PageCtx { org_id: page.org_id, project_id: page.project_id, page_id, user_id, page })
}

// ---------------------------------------------------------------- 临时链接

#[derive(FromRow, Debug, Clone)]
pub struct ShareRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub page_id: Uuid,
    pub label: String,
    pub expires_at: DateTime<Utc>,
    pub max_uses: Option<i32>,
    pub use_count: i32,
    pub password_hash: Option<String>,
    pub revoked_at: Option<DateTime<Utc>>,
}

/// 按 token 定位临时链接，检查吊销/过期（不检查密码）
pub async fn share_by_token(db: &PgPool, token: &str) -> AppResult<ShareRow> {
    let link: ShareRow = sqlx::query_as(
        "SELECT id, org_id, page_id, label, expires_at, max_uses, use_count, password_hash, revoked_at
           FROM share_links WHERE token_hash = $1",
    )
    .bind(sha256(token))
    .fetch_optional(db)
    .await?
    .ok_or_else(AppError::not_found)?;
    if link.revoked_at.is_some() {
        return Err(AppError::gone("share_link_revoked", "临时链接已吊销"));
    }
    if link.expires_at <= Utc::now() {
        return Err(AppError::gone("share_link_expired", "临时链接已过期"));
    }
    Ok(link)
}

pub const GRANT_SECS: i64 = 12 * 3600;

pub fn issue_grant(cfg: &Config, link_id: Uuid) -> (String, DateTime<Utc>) {
    let exp = Utc::now().timestamp() + GRANT_SECS;
    let g = format!("{}.{}", b64(format!("{link_id}.{exp}").as_bytes()), hmac_sign(&cfg.secret_key, &format!("g|{link_id}|{exp}")));
    (g, DateTime::from_timestamp(exp, 0).unwrap_or_default())
}

fn verify_grant(cfg: &Config, grant: Option<&str>, link_id: Uuid) -> bool {
    let Some((body, sig)) = grant.and_then(|g| g.split_once('.')) else { return false };
    let Some(body) = b64_decode(body).and_then(|b| String::from_utf8(b).ok()) else { return false };
    let Some((id, exp)) = body.split_once('.') else { return false };
    let Ok(exp) = exp.parse::<i64>() else { return false };
    id == link_id.to_string() && exp > Utc::now().timestamp() && hmac_verify(&cfg.secret_key, &format!("g|{id}|{exp}"), sig)
}

/// 管理临时链接（吊销）：链接 → 页面 → require_page_manage
pub async fn require_share_link_manage(db: &PgPool, c: &Caller, link_id: Uuid, allow: Allow) -> AppResult<PageCtx> {
    user_of(c)?;
    let page_id: Option<Uuid> = sqlx::query_scalar("SELECT page_id FROM share_links WHERE id = $1").bind(link_id).fetch_optional(db).await?;
    require_page_manage(db, c, page_id.ok_or_else(AppError::not_found)?, allow).await
}

// ---------------------------------------------------------------- 查看 / 提交

pub enum Target<'a> {
    Page(Uuid),
    Share { token: &'a str, grant: Option<&'a str> },
}

pub struct PageAccess {
    page: PageRow,
    share: Option<ShareRow>,
    user_id: Option<Uuid>,
    can_submit: bool,
    block_reason: Option<&'static str>,
    can_view_results: bool,
    can_manage: bool,
}

impl PageAccess {
    pub fn page(&self) -> &PageRow {
        &self.page
    }
    pub fn org_id(&self) -> Uuid {
        self.page.org_id
    }
    pub fn page_id(&self) -> Uuid {
        self.page.id
    }
    pub fn share(&self) -> Option<&ShareRow> {
        self.share.as_ref()
    }
    pub fn user_id(&self) -> Option<Uuid> {
        self.user_id
    }
    pub fn can_submit(&self) -> bool {
        self.can_submit
    }
    pub fn block_reason(&self) -> Option<&'static str> {
        self.block_reason
    }
    pub fn can_view_results(&self) -> bool {
        self.can_view_results
    }
    pub fn can_manage(&self) -> bool {
        self.can_manage
    }
}

/// design §5.3。不检查 nickname（提交时由 handler 检查）
pub async fn page_access(db: &PgPool, cfg: &Config, c: &Caller, target: Target<'_>) -> AppResult<PageAccess> {
    let user = c.p.user_id();
    let (page, share) = match target {
        Target::Share { token, grant } => {
            let link = share_by_token(db, token).await?;
            let page = load_page(db, link.page_id, user).await?.filter(|p| p.org_id == link.org_id).ok_or_else(AppError::not_found)?;
            if link.password_hash.is_some() && !verify_grant(cfg, grant, link.id) {
                return Err(AppError::new(axum::http::StatusCode::UNAUTHORIZED, "share_password_required", "需要输入访问密码"));
            }
            (page, Some(link))
        }
        Target::Page(id) => {
            let page = load_page(db, id, user).await?.ok_or_else(AppError::not_found)?;
            pat_bounds(c, page.org_id, Some(page.project_id))?;
            (page, None)
        }
    };
    let can_manage = page.is_manager();
    if share.is_none() && !page.can_view(user) {
        return Err(AppError::not_found());
    }
    let block_reason = if page_category(&page.page_type) == "read" {
        Some("read_only")
    } else if c.p.is_pat() {
        Some("not_allowed")
    } else if !page.accept_responses {
        Some("responses_closed")
    } else if share.as_ref().is_some_and(|l| l.max_uses.is_some_and(|m| l.use_count >= m)) {
        Some("share_link_exhausted")
    } else {
        None
    };
    Ok(PageAccess {
        can_view_results: can_manage || page.results_visible_to == "viewers",
        can_submit: block_reason.is_none(),
        block_reason,
        can_manage,
        user_id: user,
        page,
        share,
    })
}

// ---------------------------------------------------------------- 邀请

pub struct InviteCtx {
    org_id: Uuid,
    invite_id: Uuid,
}

impl InviteCtx {
    pub fn org_id(&self) -> Uuid {
        self.org_id
    }
    pub fn invite_id(&self) -> Uuid {
        self.invite_id
    }
}

/// 撤销邀请：需要创建该邀请所需的同等权限
pub async fn require_invite_manage(db: &PgPool, c: &Caller, invite_id: Uuid) -> AppResult<InviteCtx> {
    user_of(c)?;
    let row: Option<(Uuid, String, Option<Uuid>, String)> =
        sqlx::query_as("SELECT org_id, target_type, project_id, role FROM invites WHERE id = $1").bind(invite_id).fetch_optional(db).await?;
    let (org_id, target_type, project_id, role) = row.ok_or_else(AppError::not_found)?;
    match (target_type.as_str(), project_id) {
        ("project", Some(pid)) => {
            let ctx = require_project(db, c, pid, ProjectRole::Viewer, Allow::Session).await?;
            if ctx.org_id != org_id {
                return Err(AppError::not_found());
            }
            if ctx.role < ProjectRole::Admin {
                return Err(AppError::forbidden());
            }
        }
        _ => {
            let ctx = require_org(db, c, org_id, OrgRole::Member, Allow::Session).await?;
            let need = if target_type == "org" && role == "admin" { OrgRole::Owner } else { OrgRole::Admin };
            if ctx.role < need {
                return Err(AppError::forbidden());
            }
        }
    }
    Ok(InviteCtx { org_id, invite_id })
}
