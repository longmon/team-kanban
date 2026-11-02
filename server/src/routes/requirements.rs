//! 需求页面（page_type = requirement，docs/api.md §7.8）：正文、指派、状态流转、需求群组、附件、补充说明、关联页面、历史。
//! 需求本身是一行 pages（发布/改标题/关闭/删除走页面接口），扩展字段在 requirements 等表（0012）。
//! 状态：open 待认领 → analyzing 分析中 → developing 开发中 → in_review 待验收 →（发起人/项目管理员验收）done 已完成；
//! 另有 rejected 已拒绝、on_hold 搁置。认领（claim）时自动建需求群组。
use std::path::PathBuf;

use axum::{
    Json,
    body::Body,
    extract::State,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgConnection};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

use super::{brief, pages, tasks};
use crate::{
    AppState, audit,
    auth::Caller,
    authz::{ANY_SCOPE, Allow, PUBLISH, Target, check_allow, page_access, page_closed, role_expr},
    error::{AppError, AppResult, JsonBody, P, Q},
    util::{new_id, random_token, text_field, ts, ts_opt},
};

type J = AppResult<Json<Value>>;

pub const MAX_FILES: i64 = 50;
const MAX_LINKS: i64 = 50;
const MAX_DOCS: i64 = 100;
const MAX_ASSIGNEES: usize = 50;
const BODY_MAX: usize = 256 * 1024;
const STATUS: [&str; 7] = ["open", "analyzing", "developing", "in_review", "done", "rejected", "on_hold"];

// ---------------------------------------------------------------- 输入与校验

/// 指派对象：成员（user_id / 邮箱 / "me"）与群组（UUID）。成员须有本项目角色，群组须已授权给本项目（被指派者要能看到需求）
#[derive(Deserialize, Default, Clone)]
pub struct AssigneesInput {
    users: Option<Vec<String>>,
    groups: Option<Vec<Uuid>>,
}

/// POST /pages（page_type=requirement）的 requirement 字段
#[derive(Deserialize, Default)]
pub struct ReqInput {
    body: Option<String>,
    priority: Option<String>,
    due_at: Option<String>,
    assignees: Option<AssigneesInput>,
}

fn check_body(v: &str) -> AppResult<String> {
    if v.len() > BODY_MAX {
        return Err(AppError::field("body", "不能超过 256 KiB"));
    }
    Ok(v.to_string())
}

fn check_priority(v: Option<&str>) -> AppResult<Option<String>> {
    match v.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(p @ ("P0" | "P1" | "P2" | "P3")) => Ok(Some(p.to_string())),
        Some(_) => Err(AppError::field("priority", "取值必须是 P0/P1/P2/P3")),
    }
}

fn check_due(v: Option<&str>) -> AppResult<Option<DateTime<Utc>>> {
    match v.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => DateTime::parse_from_rfc3339(s).map(|t| Some(t.with_timezone(&Utc))).map_err(|_| AppError::field("due_at", "必须是带时区的 RFC 3339 时间")),
    }
}

/// 需求页面的可见范围只允许 project / org（需求是内部协作，不公开、不按群组限定）
pub fn check_visibility(v: &str) -> AppResult<()> {
    if matches!(v, "project" | "org") { Ok(()) } else { Err(AppError::field("visibility", "需求页面的可见范围只能是 project 或 org")) }
}

/// 替换指派对象，返回 (成员, 群组)
async fn set_assignees(db: &mut PgConnection, org_id: Uuid, project_id: Uuid, page_id: Uuid, me: Uuid, a: &AssigneesInput) -> AppResult<(Vec<Uuid>, Vec<Uuid>)> {
    let refs: Vec<String> = a.users.clone().unwrap_or_default().iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let mut groups = a.groups.clone().unwrap_or_default();
    groups.sort();
    groups.dedup();
    if refs.len() + groups.len() > MAX_ASSIGNEES {
        return Err(AppError::field("assignees", "指派对象（成员 + 群组）最多 50 个"));
    }
    let map = tasks::resolve_members(db, org_id, me, "assignees", &refs).await?;
    let mut users: Vec<Uuid> = map.into_values().collect();
    users.sort();
    users.dedup();
    let no_role: Vec<(String,)> = sqlx::query_as(&format!(
        "SELECT u.display_name FROM unnest($3::uuid[]) x(uid) JOIN users u ON u.id = x.uid
           LEFT JOIN memberships m ON m.org_id = $1 AND m.user_id = x.uid
          WHERE ({}) IS NULL",
        role_expr("$1", "$2", "x.uid", "m.role")
    ))
    .bind(org_id)
    .bind(project_id)
    .bind(&users)
    .fetch_all(&mut *db)
    .await?;
    if let Some((name,)) = no_role.first() {
        return Err(AppError::field("assignees", &format!("「{name}」不是本项目成员，看不到需求；请先把他加入项目")));
    }
    if !groups.is_empty() {
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM project_groups WHERE org_id = $1 AND project_id = $2 AND group_id = ANY($3)")
            .bind(org_id)
            .bind(project_id)
            .bind(&groups)
            .fetch_one(&mut *db)
            .await?;
        if n as usize != groups.len() {
            return Err(AppError::field("assignees", "群组不存在，或没有授权给本项目（被指派的群组要能看到需求）"));
        }
    }
    sqlx::query("DELETE FROM requirement_assignees WHERE org_id = $1 AND page_id = $2").bind(org_id).bind(page_id).execute(&mut *db).await?;
    sqlx::query(
        "INSERT INTO requirement_assignees (org_id, page_id, user_id, group_id)
         SELECT $1, $2, u, NULL FROM unnest($3::uuid[]) u UNION ALL SELECT $1, $2, NULL, g FROM unnest($4::uuid[]) g",
    )
    .bind(org_id)
    .bind(page_id)
    .bind(&users)
    .bind(&groups)
    .execute(db)
    .await?;
    Ok((users, groups))
}

async fn event(db: &mut PgConnection, w: &Who, action: &str, from_to: Option<(&str, &str)>, note: Option<&str>, meta: Option<Value>) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO requirement_events (id, org_id, page_id, actor_user_id, actor_pat_id, action, from_status, to_status, note, meta)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(new_id())
    .bind(w.org_id)
    .bind(w.page_id)
    .bind(w.user_id)
    .bind(w.pat_id)
    .bind(action)
    .bind(from_to.map(|x| x.0))
    .bind(from_to.map(|x| x.1))
    .bind(note)
    .bind(meta)
    .execute(db)
    .await?;
    Ok(())
}

/// 发布需求页面时（pages::create_page 同一事务）写扩展字段：分配编号、正文、指派、创建历史。返回编号
pub async fn create_ext(db: &mut PgConnection, c: &Caller, org_id: Uuid, project_id: Uuid, page_id: Uuid, uid: Uuid, r: &ReqInput) -> AppResult<i32> {
    let body = check_body(r.body.as_deref().unwrap_or(""))?;
    let priority = check_priority(r.priority.as_deref())?;
    let due = check_due(r.due_at.as_deref())?;
    let number: i32 = sqlx::query_scalar(
        "INSERT INTO requirement_counters (org_id, project_id, last_no) VALUES ($1, $2, 1)
         ON CONFLICT (project_id) DO UPDATE SET last_no = requirement_counters.last_no + 1 RETURNING last_no",
    )
    .bind(org_id)
    .bind(project_id)
    .fetch_one(&mut *db)
    .await?;
    sqlx::query("INSERT INTO requirements (page_id, org_id, project_id, number, body, priority, due_at) VALUES ($1, $2, $3, $4, $5, $6, $7)")
        .bind(page_id)
        .bind(org_id)
        .bind(project_id)
        .bind(number)
        .bind(&body)
        .bind(&priority)
        .bind(due)
        .execute(&mut *db)
        .await?;
    let (users, groups) = set_assignees(db, org_id, project_id, page_id, uid, &r.assignees.clone().unwrap_or_default()).await?;
    let w = Who::bare(org_id, project_id, page_id, uid, c);
    event(db, &w, "created", None, None, Some(json!({ "users": users, "groups": groups }))).await?;
    Ok(number)
}

// ---------------------------------------------------------------- 身份

/// 调用者对需求的身份
pub struct Who {
    org_id: Uuid,
    project_id: Uuid,
    page_id: Uuid,
    user_id: Option<Uuid>,
    pat_id: Option<Uuid>,
    /// 页面发布者（产品经理）
    initiator: bool,
    /// 项目管理员（含组织 owner/admin）
    admin: bool,
    /// 项目 editor 及以上
    editor: bool,
    /// 被指派（本人或所在群组）
    assignee: bool,
    closed: bool,
    number: i32,
    status: String,
    group_id: Option<Uuid>,
    title: String,
    created_by: Uuid,
}

impl Who {
    fn bare(org_id: Uuid, project_id: Uuid, page_id: Uuid, uid: Uuid, c: &Caller) -> Who {
        Who {
            org_id,
            project_id,
            page_id,
            user_id: Some(uid),
            pat_id: c.p.pat().map(|p| p.id),
            initiator: true,
            admin: false,
            editor: true,
            assignee: false,
            closed: false,
            number: 0,
            status: "open".into(),
            group_id: None,
            title: String::new(),
            created_by: uid,
        }
    }
    /// 认领、改状态：被指派者、发起人、项目管理员
    fn participant(&self) -> bool {
        self.assignee || self.initiator || self.admin
    }
    /// 验收（待验收 → 已完成 等）：发起人或项目管理员
    fn acceptor(&self) -> bool {
        self.initiator || self.admin
    }
    /// 上传附件、追加说明、关联页面：参与者或项目 editor
    fn contributor(&self) -> bool {
        self.participant() || self.editor
    }
    fn uid(&self) -> Uuid {
        self.user_id.unwrap_or_default()
    }
    fn code(&self) -> String {
        format!("REQ-{}", self.number)
    }
    fn writable(&self) -> AppResult<()> {
        if self.closed { Err(page_closed()) } else { Ok(()) }
    }
}

/// 需求可见性 = 页面可见性（page_access：visibility、关闭页面规则、PAT 范围），看不到 / 不是需求一律 404
pub async fn load_who(st: &AppState, c: &Caller, id: Uuid, allow: Allow) -> AppResult<Who> {
    let a = page_access(&st.db, &st.cfg, c, Target::Page(id)).await?;
    let p = a.page();
    if p.page_type != "requirement" {
        return Err(AppError::not_found());
    }
    let uid = a.user_id().ok_or_else(AppError::unauthenticated)?;
    check_allow(c, allow)?;
    let (number, status, group_id, assignee): (i32, String, Option<Uuid>, bool) = sqlx::query_as(
        "SELECT r.number, r.status, r.group_id,
                EXISTS (SELECT 1 FROM requirement_assignees a WHERE a.org_id = r.org_id AND a.page_id = r.page_id
                          AND (a.user_id = $3 OR EXISTS (SELECT 1 FROM group_members gm WHERE gm.org_id = a.org_id AND gm.group_id = a.group_id AND gm.user_id = $3)))
           FROM requirements r WHERE r.org_id = $1 AND r.page_id = $2",
    )
    .bind(p.org_id)
    .bind(p.id)
    .bind(uid)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(AppError::not_found)?;
    let role = p.role.as_deref();
    Ok(Who {
        org_id: p.org_id,
        project_id: p.project_id,
        page_id: p.id,
        user_id: Some(uid),
        pat_id: c.p.pat().map(|x| x.id),
        initiator: p.created_by == uid,
        admin: role == Some("admin"),
        editor: matches!(role, Some("admin" | "editor")),
        assignee,
        closed: p.closed_at.is_some(),
        number,
        status,
        group_id,
        title: p.title.clone(),
        created_by: p.created_by,
    })
}

// ---------------------------------------------------------------- 状态机

/// (from, to) 是否允许，及需要的身份：Some(true) = 验收人（发起人/项目管理员），Some(false) = 参与者。
/// open → analyzing 只能经认领（claim）
fn rule(from: &str, to: &str) -> Option<bool> {
    match (from, to) {
        ("open", "rejected" | "on_hold") => Some(false),
        ("analyzing", "open" | "developing" | "rejected" | "on_hold") => Some(false),
        ("developing", "analyzing" | "in_review" | "rejected" | "on_hold") => Some(false),
        ("developing", "done") | ("in_review", "done" | "developing") => Some(true),
        ("on_hold", "open" | "analyzing" | "developing") => Some(false),
        ("rejected", "open") | ("done", "developing") => Some(true),
        _ => None,
    }
}

/// 拒绝、验收不通过（待验收 → 开发中）必须写说明
fn note_required(from: &str, to: &str) -> bool {
    to == "rejected" || (from == "in_review" && to == "developing")
}

fn transitions(w: &Who) -> Vec<&'static str> {
    STATUS.iter().copied().filter(|to| rule(&w.status, to).is_some_and(|acc| if acc { w.acceptor() } else { w.participant() })).collect()
}

// ---------------------------------------------------------------- 列表字段

/// 页面列表 / 单页 JSON 的 requirement 列（x 为 page_select 输出别名，$1 = 调用者）：编号、状态、优先级、指派、是否指派给我、是否验收人
pub fn req_sql(x: &str) -> String {
    format!(
        "CASE WHEN {x}.page_type = 'requirement' THEN (
           SELECT json_build_object('number', rq.number, 'code', 'REQ-' || rq.number, 'status', rq.status, 'priority', rq.priority,
             'due_at', rq.due_at, 'group_id', rq.group_id,
             'assignees', COALESCE((SELECT json_agg(json_build_object('type', CASE WHEN ra.user_id IS NULL THEN 'group' ELSE 'user' END,
                                                    'id', COALESCE(ra.user_id, ra.group_id), 'name', COALESCE(au.display_name, ag.name))
                                    ORDER BY ra.group_id NULLS FIRST, au.display_name)
                 FROM requirement_assignees ra LEFT JOIN users au ON au.id = ra.user_id
                 LEFT JOIN groups ag ON ag.org_id = ra.org_id AND ag.id = ra.group_id
                WHERE ra.org_id = rq.org_id AND ra.page_id = rq.page_id), '[]'::json),
             'mine', EXISTS (SELECT 1 FROM requirement_assignees ra WHERE ra.org_id = rq.org_id AND ra.page_id = rq.page_id
                      AND (ra.user_id = $1 OR EXISTS (SELECT 1 FROM group_members rgm WHERE rgm.org_id = ra.org_id AND rgm.group_id = ra.group_id AND rgm.user_id = $1))),
             'acceptor', ({x}.is_creator OR {x}.role = 'admin'))
             FROM requirements rq WHERE rq.org_id = {x}.org_id AND rq.page_id = {x}.id) END AS requirement"
    )
}

// ---------------------------------------------------------------- 详情

#[derive(FromRow)]
struct FileRow {
    id: Uuid,
    name: String,
    content_type: String,
    size: i64,
    sha256: Vec<u8>,
    storage_key: String,
    uploaded_by: Uuid,
    uploader_name: String,
    created_at: DateTime<Utc>,
}

/// 只有这些 raster 图片允许 ?inline=1 内联预览（svg 一律当附件下载）
const INLINE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

fn file_json(st: &AppState, w: &Who, f: &FileRow) -> Value {
    let url = format!("{}/api/requirements/{}/files/{}", st.cfg.public_url, w.page_id, f.id);
    let inline = INLINE_TYPES.contains(&f.content_type.as_str()).then(|| format!("/api/requirements/{}/files/{}?inline=1", w.page_id, f.id));
    json!({
        "id": f.id, "name": f.name, "content_type": f.content_type, "size": f.size,
        "sha256": f.sha256.iter().map(|b| format!("{b:02x}")).collect::<String>(),
        "uploaded_by": brief(f.uploaded_by, &f.uploader_name), "created_at": ts(&f.created_at),
        "download_url": url, "inline_url": inline,
        "can_delete": !w.closed && (f.uploaded_by == w.uid() || w.editor || w.acceptor()),
    })
}

const FILE_SELECT: &str = "SELECT f.id, f.name, f.content_type, f.size, f.sha256, f.storage_key, f.uploaded_by, u.display_name AS uploader_name, f.created_at
   FROM requirement_files f JOIN users u ON u.id = f.uploaded_by";

async fn detail(st: &AppState, c: &Caller, w: &Who) -> J {
    #[allow(clippy::type_complexity)]
    let (body, priority, due_at, created_at, updated_at, claimed_by, claimed_name, claimed_at, group_name, org_slug, org_name, project_name, creator_name, visibility, closed_at):
        (String, Option<String>, Option<DateTime<Utc>>, DateTime<Utc>, DateTime<Utc>, Option<Uuid>, Option<String>, Option<DateTime<Utc>>, Option<String>, String, String, String, String, String, Option<DateTime<Utc>>) =
        sqlx::query_as(
            "SELECT r.body, r.priority, r.due_at, p.created_at, GREATEST(p.updated_at, r.updated_at), r.claimed_by, cu.display_name, r.claimed_at,
                    g.name, o.slug, o.name, pr.name, u.display_name, p.visibility, p.closed_at
               FROM requirements r
               JOIN pages p ON p.org_id = r.org_id AND p.id = r.page_id
               JOIN orgs o ON o.id = r.org_id
               JOIN projects pr ON pr.org_id = r.org_id AND pr.id = r.project_id
               JOIN users u ON u.id = p.created_by
               LEFT JOIN users cu ON cu.id = r.claimed_by
               LEFT JOIN groups g ON g.org_id = r.org_id AND g.id = r.group_id
              WHERE r.org_id = $1 AND r.page_id = $2",
        )
        .bind(w.org_id)
        .bind(w.page_id)
        .fetch_one(&st.db)
        .await?;
    let assignees: Vec<(Option<Uuid>, Option<Uuid>, String)> = sqlx::query_as(
        "SELECT a.user_id, a.group_id, COALESCE(u.display_name, g.name) FROM requirement_assignees a
           LEFT JOIN users u ON u.id = a.user_id LEFT JOIN groups g ON g.org_id = a.org_id AND g.id = a.group_id
          WHERE a.org_id = $1 AND a.page_id = $2 ORDER BY 3",
    )
    .bind(w.org_id)
    .bind(w.page_id)
    .fetch_all(&st.db)
    .await?;
    let docs: Vec<(Uuid, String, String, Uuid, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT d.id, d.title, d.body, d.created_by, u.display_name, d.created_at FROM requirement_docs d JOIN users u ON u.id = d.created_by
          WHERE d.org_id = $1 AND d.page_id = $2 ORDER BY d.created_at, d.id",
    )
    .bind(w.org_id)
    .bind(w.page_id)
    .fetch_all(&st.db)
    .await?;
    let files: Vec<FileRow> = sqlx::query_as(&format!("{FILE_SELECT} WHERE f.org_id = $1 AND f.page_id = $2 ORDER BY f.created_at, f.id"))
        .bind(w.org_id)
        .bind(w.page_id)
        .fetch_all(&st.db)
        .await?;
    // 关联页面：调用者按列表可见性能看到的给标题，看不到的只给占位（不泄露标题、类型）
    let links: Vec<(Uuid, DateTime<Utc>)> =
        sqlx::query_as("SELECT linked_page_id, created_at FROM requirement_links WHERE org_id = $1 AND page_id = $2 ORDER BY created_at, linked_page_id")
            .bind(w.org_id)
            .bind(w.page_id)
            .fetch_all(&st.db)
            .await?;
    let ids: Vec<Uuid> = links.iter().map(|l| l.0).collect();
    let visible: Vec<(Uuid, String, String, Option<String>, Option<DateTime<Utc>>, DateTime<Utc>)> = sqlx::query_as(&format!(
        "SELECT id, title, page_type, summary, closed_at, updated_at FROM ({} WHERE p.id = ANY($2) AND p.deleted_at IS NULL AND m.user_id IS NOT NULL
            AND ($3::uuid IS NULL OR p.project_id = $3)) y WHERE {}",
        pages::page_select(),
        pages::VISIBLE
    ))
    .bind(w.uid())
    .bind(&ids)
    .bind(c.p.pat().and_then(|p| p.project_id))
    .fetch_all(&st.db)
    .await?;
    let links: Vec<Value> = links
        .iter()
        .map(|(id, at)| match visible.iter().find(|v| v.0 == *id) {
            Some(v) => json!({ "page_id": id, "visible": true, "title": v.1, "page_type": v.2, "summary": v.3, "closed_at": ts_opt(&v.4),
                               "updated_at": ts(&v.5), "url": format!("{}/pages/{id}", st.cfg.public_url), "linked_at": ts(at) }),
            None => json!({ "page_id": id, "visible": false, "linked_at": ts(at) }),
        })
        .collect();
    let events: Vec<(Uuid, String, Option<String>, Option<String>, Option<String>, Option<Value>, DateTime<Utc>, Option<Uuid>, Option<String>, Option<Uuid>)> =
        sqlx::query_as(
            "SELECT e.id, e.action, e.from_status, e.to_status, e.note, e.meta, e.created_at, e.actor_user_id, u.display_name, e.actor_pat_id
               FROM requirement_events e LEFT JOIN users u ON u.id = e.actor_user_id
              WHERE e.org_id = $1 AND e.page_id = $2 ORDER BY e.created_at, e.id",
        )
        .bind(w.org_id)
        .bind(w.page_id)
        .fetch_all(&st.db)
        .await?;
    let can_edit = w.editor && !w.closed;
    Ok(Json(json!({
        "id": w.page_id, "number": w.number, "code": w.code(), "title": w.title,
        "url": format!("{}/pages/{}", st.cfg.public_url, w.page_id),
        "org": { "id": w.org_id, "name": org_name, "slug": org_slug }, "project": { "id": w.project_id, "name": project_name },
        "status": w.status, "priority": priority, "due_at": ts_opt(&due_at), "body": body, "visibility": visibility,
        "created_by": brief(w.created_by, &creator_name), "created_at": ts(&created_at), "updated_at": ts(&updated_at), "closed_at": ts_opt(&closed_at),
        "claimed_by": claimed_by.zip(claimed_name).map(|(id, n)| brief(id, &n)), "claimed_at": ts_opt(&claimed_at),
        "assignees": {
            "users": assignees.iter().filter_map(|a| a.0.map(|id| brief(id, &a.2))).collect::<Vec<_>>(),
            "groups": assignees.iter().filter_map(|a| a.1.map(|id| json!({ "id": id, "name": a.2 }))).collect::<Vec<_>>(),
        },
        "group": w.group_id.zip(group_name).map(|(id, n)| json!({ "id": id, "name": n, "url": format!("{}/o/{org_slug}/groups/{id}", st.cfg.public_url) })),
        "docs": docs.iter().map(|d| json!({ "id": d.0, "title": d.1, "body": d.2, "created_by": brief(d.3, &d.4), "created_at": ts(&d.5),
                                           "can_delete": !w.closed && (d.3 == w.uid() || w.editor) })).collect::<Vec<_>>(),
        "files": files.iter().map(|f| file_json(st, w, f)).collect::<Vec<_>>(),
        "links": links,
        "events": events.iter().map(|e| json!({ "id": e.0, "action": e.1, "from_status": e.2, "to_status": e.3, "note": e.4, "meta": e.5, "at": ts(&e.6),
                                               "actor": e.7.zip(e.8.clone()).map(|(id, n)| brief(id, &n)), "via_token": e.9.is_some() })).collect::<Vec<_>>(),
        "me": {
            "user_id": w.user_id, "is_assignee": w.assignee, "is_initiator": w.initiator,
            "can_edit": can_edit, "can_claim": !w.closed && w.status == "open" && w.participant(),
            "can_create_group": !w.closed && w.group_id.is_none() && w.participant(),
            "can_accept": !w.closed && w.acceptor(), "can_contribute": !w.closed && w.contributor(),
            "transitions": if w.closed { vec![] } else { transitions(w) },
        },
        "limits": { "max_files": MAX_FILES, "max_file_bytes": st.cfg.upload_max_bytes, "max_links": MAX_LINKS, "max_docs": MAX_DOCS },
    })))
}

pub async fn get_requirement(State(st): State<AppState>, c: Caller, P(id): P<Uuid>) -> J {
    let w = load_who(&st, &c, id, ANY_SCOPE).await?;
    detail(&st, &c, &w).await
}

// ---------------------------------------------------------------- 编辑

fn nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

#[derive(Deserialize)]
pub struct UpdateReq {
    title: Option<String>,
    body: Option<String>,
    /// 传 null 清除
    #[serde(default, deserialize_with = "nullable")]
    priority: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    due_at: Option<Option<String>>,
    /// 整体替换
    assignees: Option<AssigneesInput>,
}

/// PATCH /requirements/{id}：项目 editor 及以上（同页面管理权限）
pub async fn update_requirement(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, JsonBody(r): JsonBody<UpdateReq>) -> J {
    let w = load_who(&st, &c, id, PUBLISH).await?;
    if !w.editor {
        return Err(AppError::forbidden());
    }
    w.writable()?;
    super::require_any(&[r.title.is_some(), r.body.is_some(), r.priority.is_some(), r.due_at.is_some(), r.assignees.is_some()])?;
    let title = r.title.as_deref().map(|t| text_field("title", t, 1, 200)).transpose()?;
    let body = r.body.as_deref().map(check_body).transpose()?;
    let priority = r.priority.as_ref().map(|p| check_priority(p.as_deref())).transpose()?;
    let due = r.due_at.as_ref().map(|d| check_due(d.as_deref())).transpose()?;
    let mut tx = st.db.begin().await?;
    if let Some(t) = &title {
        sqlx::query("UPDATE pages SET title = $3, updated_at = now() WHERE org_id = $1 AND id = $2").bind(w.org_id).bind(w.page_id).bind(t).execute(&mut *tx).await?;
    }
    sqlx::query(
        "UPDATE requirements SET body = COALESCE($3, body), priority = CASE WHEN $4 THEN $5 ELSE priority END,
                due_at = CASE WHEN $6 THEN $7 ELSE due_at END, updated_at = now() WHERE org_id = $1 AND page_id = $2",
    )
    .bind(w.org_id)
    .bind(w.page_id)
    .bind(&body)
    .bind(priority.is_some())
    .bind(priority.clone().flatten())
    .bind(due.is_some())
    .bind(due.flatten())
    .execute(&mut *tx)
    .await?;
    let fields: Vec<&str> = [("title", title.is_some()), ("body", body.is_some()), ("priority", priority.is_some()), ("due_at", due.is_some())]
        .into_iter()
        .filter_map(|(n, p)| p.then_some(n))
        .collect();
    if !fields.is_empty() {
        event(&mut tx, &w, "edited", None, None, Some(json!({ "fields": fields }))).await?;
    }
    if let Some(a) = &r.assignees {
        let (users, groups) = set_assignees(&mut tx, w.org_id, w.project_id, w.page_id, w.uid(), a).await?;
        event(&mut tx, &w, "assigned", None, None, Some(json!({ "users": users, "groups": groups }))).await?;
    }
    audit::log(&mut tx, Some(w.org_id), &c.actor(), "requirement.update", "page", Some(w.page_id), json!({ "fields": fields, "assignees": r.assignees.is_some() }))
        .await?;
    tx.commit().await?;
    let w = load_who(&st, &c, id, ANY_SCOPE).await?;
    detail(&st, &c, &w).await
}

// ---------------------------------------------------------------- 认领 / 状态 / 群组

/// 锁住需求行并读当前状态与群组（并发认领、改状态串行化）
async fn lock(db: &mut PgConnection, w: &Who) -> AppResult<(String, Option<Uuid>)> {
    Ok(sqlx::query_as("SELECT status, group_id FROM requirements WHERE org_id = $1 AND page_id = $2 FOR UPDATE").bind(w.org_id).bind(w.page_id).fetch_one(db).await?)
}

/// 以服务端身份为需求建项目群组（不要求调用者是项目管理员，权限来自「需求参与者」，见 docs/design.md §5.6）：
/// 名称 `REQ-12 <标题前 40 字>`，同名时追加「 (2)」「 (3)」…；授权本项目 viewer（只读，不扩大可发布范围）；
/// 成员 = 操作人 + 被指派成员 + 被指派群组当前成员（快照）+ 发起人（仍是组织成员者）。写 group.create 审计（meta.via = requirement）
async fn make_group(db: &mut PgConnection, c: &Caller, w: &Who) -> AppResult<(Uuid, String)> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('groups-name:' || $1::text, 0))").bind(w.org_id).execute(&mut *db).await?;
    let prefix: String = w.title.chars().take(40).collect();
    let base = format!("{} {}", w.code(), prefix.trim());
    let mut name = None;
    for i in 1..=50 {
        let cand = if i == 1 { base.clone() } else { format!("{base} ({i})") };
        let taken: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM groups WHERE org_id = $1 AND lower(name) = lower($2) AND (project_id IS NULL OR project_id = $3))",
        )
        .bind(w.org_id)
        .bind(&cand)
        .bind(w.project_id)
        .fetch_one(&mut *db)
        .await?;
        if !taken {
            name = Some(cand);
            break;
        }
    }
    let name = name.unwrap_or_else(|| format!("{base} {}", &new_id().simple().to_string()[24..]));
    let members: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT x.uid FROM (
             SELECT $3::uuid AS uid UNION ALL SELECT $4::uuid
             UNION ALL SELECT a.user_id FROM requirement_assignees a WHERE a.org_id = $1 AND a.page_id = $2 AND a.user_id IS NOT NULL
             UNION ALL SELECT gm.user_id FROM requirement_assignees a JOIN group_members gm ON gm.org_id = a.org_id AND gm.group_id = a.group_id
                        WHERE a.org_id = $1 AND a.page_id = $2) x
           JOIN memberships m ON m.org_id = $1 AND m.user_id = x.uid
          ORDER BY 1",
    )
    .bind(w.org_id)
    .bind(w.page_id)
    .bind(w.uid())
    .bind(w.created_by)
    .fetch_all(&mut *db)
    .await?;
    let gid = new_id();
    sqlx::query("INSERT INTO groups (id, org_id, project_id, name, description, created_by) VALUES ($1, $2, $3, $4, $5, $6)")
        .bind(gid)
        .bind(w.org_id)
        .bind(w.project_id)
        .bind(&name)
        .bind(format!("需求 {} 的群组（认领时自动创建），相关文档发到这里", w.code()))
        .bind(w.uid())
        .execute(&mut *db)
        .await?;
    sqlx::query("INSERT INTO project_groups (org_id, project_id, group_id, role) VALUES ($1, $2, $3, 'viewer')")
        .bind(w.org_id)
        .bind(w.project_id)
        .bind(gid)
        .execute(&mut *db)
        .await?;
    sqlx::query("INSERT INTO group_members (org_id, group_id, user_id) SELECT $1, $2, unnest($3::uuid[])")
        .bind(w.org_id)
        .bind(gid)
        .bind(&members)
        .execute(&mut *db)
        .await?;
    sqlx::query("UPDATE requirements SET group_id = $3, updated_at = now() WHERE org_id = $1 AND page_id = $2").bind(w.org_id).bind(w.page_id).bind(gid).execute(&mut *db).await?;
    audit::log(
        db,
        Some(w.org_id),
        &c.actor(),
        "group.create",
        "group",
        Some(gid),
        json!({ "project_id": w.project_id, "role": "viewer", "member_ids": members, "via": "requirement", "requirement_id": w.page_id, "system": true }),
    )
    .await?;
    event(db, w, "group_created", None, None, Some(json!({ "group_id": gid, "name": name, "member_count": members.len() }))).await?;
    Ok((gid, name))
}

/// POST /requirements/{id}/claim：被指派者 / 发起人 / 项目管理员；待认领 → 分析中，没有需求群组时自动创建
pub async fn claim(State(st): State<AppState>, c: Caller, P(id): P<Uuid>) -> J {
    let w = load_who(&st, &c, id, PUBLISH).await?;
    w.writable()?;
    if !w.participant() {
        return Err(AppError::forbidden());
    }
    let mut tx = st.db.begin().await?;
    let (status, group) = lock(&mut tx, &w).await?;
    if status != "open" {
        return Err(AppError::conflict("not_claimable", "需求不是「待认领」状态，不能认领"));
    }
    sqlx::query("UPDATE requirements SET status = 'analyzing', claimed_by = $3, claimed_at = now(), updated_at = now() WHERE org_id = $1 AND page_id = $2")
        .bind(w.org_id)
        .bind(w.page_id)
        .bind(w.uid())
        .execute(&mut *tx)
        .await?;
    event(&mut tx, &w, "claimed", Some(("open", "analyzing")), None, None).await?;
    let made = if group.is_none() { Some(make_group(&mut tx, &c, &w).await?) } else { None };
    audit::log(&mut tx, Some(w.org_id), &c.actor(), "requirement.claim", "page", Some(w.page_id), json!({ "group_created": made.as_ref().map(|g| g.0) })).await?;
    tx.commit().await?;
    let w = load_who(&st, &c, id, ANY_SCOPE).await?;
    detail(&st, &c, &w).await
}

/// POST /requirements/{id}/group：不认领时手动建需求群组（参与者）
pub async fn create_group(State(st): State<AppState>, c: Caller, P(id): P<Uuid>) -> AppResult<(StatusCode, Json<Value>)> {
    let w = load_who(&st, &c, id, PUBLISH).await?;
    w.writable()?;
    if !w.participant() {
        return Err(AppError::forbidden());
    }
    let mut tx = st.db.begin().await?;
    if lock(&mut tx, &w).await?.1.is_some() {
        return Err(AppError::conflict("group_exists", "需求已经有群组了"));
    }
    make_group(&mut tx, &c, &w).await?;
    tx.commit().await?;
    let w = load_who(&st, &c, id, ANY_SCOPE).await?;
    Ok((StatusCode::CREATED, detail(&st, &c, &w).await?))
}

#[derive(Deserialize)]
pub struct StatusReq {
    status: String,
    note: Option<String>,
}

/// POST /requirements/{id}/status：按 rule 校验流转与身份
pub async fn set_status(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, JsonBody(r): JsonBody<StatusReq>) -> J {
    let w = load_who(&st, &c, id, PUBLISH).await?;
    w.writable()?;
    if !STATUS.contains(&r.status.as_str()) {
        return Err(AppError::field("status", &format!("取值必须是 {}", STATUS.join("/"))));
    }
    let note = text_field("note", r.note.as_deref().unwrap_or(""), 0, 2000)?;
    if !w.participant() && !w.editor {
        return Err(AppError::forbidden());
    }
    let mut tx = st.db.begin().await?;
    let (from, _) = lock(&mut tx, &w).await?;
    let need_acceptor = match rule(&from, &r.status) {
        Some(a) => a,
        None if from == "open" && r.status == "analyzing" => return Err(AppError::conflict("use_claim", "待认领 → 分析中请用「认领」")),
        None => return Err(AppError::conflict("invalid_transition", &format!("不能从 {from} 改为 {}", r.status))),
    };
    if (need_acceptor && !w.acceptor()) || (!need_acceptor && !w.participant()) {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            if need_acceptor { "只有需求发起人或项目管理员能验收 / 重新打开" } else { "只有被指派者、发起人或项目管理员能改状态" },
        ));
    }
    if note_required(&from, &r.status) && note.is_empty() {
        return Err(AppError::field("note", "拒绝或验收不通过时必须写明原因"));
    }
    sqlx::query("UPDATE requirements SET status = $3, updated_at = now() WHERE org_id = $1 AND page_id = $2").bind(w.org_id).bind(w.page_id).bind(&r.status).execute(&mut *tx).await?;
    let note = (!note.is_empty()).then_some(note);
    event(&mut tx, &w, "status", Some((&from, &r.status)), note.as_deref(), None).await?;
    audit::log(&mut tx, Some(w.org_id), &c.actor(), "requirement.status", "page", Some(w.page_id), json!({ "from": from, "to": r.status })).await?;
    tx.commit().await?;
    let w = load_who(&st, &c, id, ANY_SCOPE).await?;
    detail(&st, &c, &w).await
}

// ---------------------------------------------------------------- 补充说明

#[derive(Deserialize)]
pub struct DocReq {
    title: String,
    body: String,
}

pub async fn add_doc(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, JsonBody(r): JsonBody<DocReq>) -> AppResult<(StatusCode, Json<Value>)> {
    let w = load_who(&st, &c, id, PUBLISH).await?;
    w.writable()?;
    if !w.contributor() {
        return Err(AppError::forbidden());
    }
    let title = text_field("title", &r.title, 1, 200)?;
    if r.body.trim().is_empty() || r.body.len() > BODY_MAX {
        return Err(AppError::field("body", "不能为空且不超过 256 KiB"));
    }
    let mut tx = st.db.begin().await?;
    lock(&mut tx, &w).await?;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM requirement_docs WHERE org_id = $1 AND page_id = $2").bind(w.org_id).bind(w.page_id).fetch_one(&mut *tx).await?;
    if n >= MAX_DOCS {
        return Err(AppError::conflict("too_many_docs", "补充说明最多 100 篇"));
    }
    let doc_id = new_id();
    sqlx::query("INSERT INTO requirement_docs (id, org_id, page_id, title, body, created_by) VALUES ($1, $2, $3, $4, $5, $6)")
        .bind(doc_id)
        .bind(w.org_id)
        .bind(w.page_id)
        .bind(&title)
        .bind(&r.body)
        .bind(w.uid())
        .execute(&mut *tx)
        .await?;
    audit::log(&mut tx, Some(w.org_id), &c.actor(), "requirement.doc_add", "page", Some(w.page_id), json!({ "doc_id": doc_id })).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({ "id": doc_id, "title": title }))))
}

pub async fn delete_doc(State(st): State<AppState>, c: Caller, P((id, doc_id)): P<(Uuid, Uuid)>) -> AppResult<StatusCode> {
    let w = load_who(&st, &c, id, PUBLISH).await?;
    w.writable()?;
    let mut tx = st.db.begin().await?;
    let author: Uuid = sqlx::query_scalar("SELECT created_by FROM requirement_docs WHERE org_id = $1 AND page_id = $2 AND id = $3")
        .bind(w.org_id)
        .bind(w.page_id)
        .bind(doc_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(AppError::not_found)?;
    if author != w.uid() && !w.editor {
        return Err(AppError::forbidden());
    }
    sqlx::query("DELETE FROM requirement_docs WHERE org_id = $1 AND page_id = $2 AND id = $3").bind(w.org_id).bind(w.page_id).bind(doc_id).execute(&mut *tx).await?;
    audit::log(&mut tx, Some(w.org_id), &c.actor(), "requirement.doc_delete", "page", Some(w.page_id), json!({ "doc_id": doc_id })).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- 关联页面

#[derive(Deserialize)]
pub struct LinkReq {
    page_id: Uuid,
}

/// 关联一个调用者能看到的同组织页面（看不到 / 跨组织一律 404，不泄露是否存在）
async fn insert_link(db: &mut PgConnection, st: &AppState, c: &Caller, w: &Who, target: Uuid) -> AppResult<()> {
    if target == w.page_id {
        return Err(AppError::field("page_id", "不能关联需求自己"));
    }
    let t = page_access(&st.db, &st.cfg, c, Target::Page(target)).await?;
    if t.org_id() != w.org_id {
        return Err(AppError::not_found());
    }
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM requirement_links WHERE org_id = $1 AND page_id = $2").bind(w.org_id).bind(w.page_id).fetch_one(&mut *db).await?;
    if n >= MAX_LINKS {
        return Err(AppError::conflict("too_many_links", "关联页面最多 50 个"));
    }
    sqlx::query("INSERT INTO requirement_links (org_id, page_id, linked_page_id, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING")
        .bind(w.org_id)
        .bind(w.page_id)
        .bind(target)
        .bind(w.uid())
        .execute(&mut *db)
        .await?;
    audit::log(db, Some(w.org_id), &c.actor(), "requirement.link_add", "page", Some(w.page_id), json!({ "linked_page_id": target })).await?;
    Ok(())
}

pub async fn add_link(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, JsonBody(r): JsonBody<LinkReq>) -> J {
    let w = load_who(&st, &c, id, PUBLISH).await?;
    w.writable()?;
    if !w.contributor() {
        return Err(AppError::forbidden());
    }
    let mut tx = st.db.begin().await?;
    lock(&mut tx, &w).await?;
    insert_link(&mut tx, &st, &c, &w, r.page_id).await?;
    tx.commit().await?;
    detail(&st, &c, &w).await
}

pub async fn delete_link(State(st): State<AppState>, c: Caller, P((id, target)): P<(Uuid, Uuid)>) -> AppResult<StatusCode> {
    let w = load_who(&st, &c, id, PUBLISH).await?;
    w.writable()?;
    if !w.contributor() {
        return Err(AppError::forbidden());
    }
    let mut tx = st.db.begin().await?;
    let n = sqlx::query("DELETE FROM requirement_links WHERE org_id = $1 AND page_id = $2 AND linked_page_id = $3")
        .bind(w.org_id)
        .bind(w.page_id)
        .bind(target)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::not_found());
    }
    audit::log(&mut tx, Some(w.org_id), &c.actor(), "requirement.link_remove", "page", Some(w.page_id), json!({ "linked_page_id": target })).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// publish_page 带 requirement_id：发布者须能看到需求、是参与者或项目 editor、需求与页面同项目。返回需求 Who（事务里再关联）
pub async fn check_publish_link(st: &AppState, c: &Caller, req_id: Uuid, project_id: Uuid) -> AppResult<Who> {
    let w = load_who(st, c, req_id, PUBLISH).await.map_err(|e| if e.status == StatusCode::NOT_FOUND { AppError::field("requirement_id", "需求不存在或你看不到") } else { e })?;
    w.writable()?;
    if !w.contributor() {
        return Err(AppError::forbidden());
    }
    if w.project_id != project_id {
        return Err(AppError::field("requirement_id", "需求与页面必须在同一个项目"));
    }
    Ok(w)
}

/// 新发布的页面挂到需求的关联页面下（pages::create_page 同一事务；新页面在事务里尚未提交，直接插入关联）
pub async fn link_new_page(db: &mut PgConnection, c: &Caller, w: &Who, page_id: Uuid) -> AppResult<()> {
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM requirement_links WHERE org_id = $1 AND page_id = $2").bind(w.org_id).bind(w.page_id).fetch_one(&mut *db).await?;
    if n >= MAX_LINKS {
        return Err(AppError::conflict("too_many_links", "需求的关联页面已满 50 个"));
    }
    sqlx::query("INSERT INTO requirement_links (org_id, page_id, linked_page_id, created_by) VALUES ($1, $2, $3, $4)")
        .bind(w.org_id)
        .bind(w.page_id)
        .bind(page_id)
        .bind(w.uid())
        .execute(&mut *db)
        .await?;
    audit::log(db, Some(w.org_id), &c.actor(), "requirement.link_add", "page", Some(w.page_id), json!({ "linked_page_id": page_id, "via": "publish" })).await?;
    Ok(())
}

// ---------------------------------------------------------------- 附件

/// 扩展名白名单 → (嗅探规则, 存储/下载用的 Content-Type)
fn allowed(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "xls" => "application/vnd.ms-excel",
        "ppt" => "application/vnd.ms-powerpoint",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "zip" => "application/zip",
        "7z" => "application/x-7z-compressed",
        "rar" => "application/vnd.rar",
        "gz" | "tgz" => "application/gzip",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "txt" | "log" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "json" => "application/json",
        _ => return None,
    })
}

/// 文件头是否与扩展名一致（head = 文件前最多 8 KiB）
fn sniff_ok(ext: &str, head: &[u8]) -> bool {
    let text = || !head.contains(&0) && (std::str::from_utf8(head).is_ok() || std::str::from_utf8(&head[..head.len().saturating_sub(3)]).is_ok());
    match ext {
        "pdf" => head.starts_with(b"%PDF-"),
        "doc" | "xls" | "ppt" => head.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]),
        "docx" | "xlsx" | "pptx" | "zip" => head.starts_with(b"PK\x03\x04") || head.starts_with(b"PK\x05\x06"),
        "7z" => head.starts_with(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]),
        "rar" => head.starts_with(b"Rar!\x1A\x07"),
        "gz" | "tgz" => head.starts_with(&[0x1F, 0x8B]),
        "png" => head.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => head.starts_with(&[0xFF, 0xD8, 0xFF]),
        "gif" => head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a"),
        "webp" => head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP",
        "svg" => text() && String::from_utf8_lossy(head).to_ascii_lowercase().contains("<svg"),
        "txt" | "log" | "md" | "csv" | "json" => text(),
        _ => false,
    }
}

/// 文件名清洗：只取最后一段（去掉 / \ 路径）、去控制字符与 <>:"|?*、去首尾空白和点，≤200 字符；空了用 "file"
pub fn clean_name(raw: &str) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let s: String = last.chars().filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')).collect();
    let s = s.trim().trim_matches('.').trim();
    let s: String = s.chars().take(200).collect();
    if s.is_empty() { "file".into() } else { s }
}

fn ext_of(name: &str) -> String {
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

fn path_of(st: &AppState, key: &str) -> PathBuf {
    st.cfg.upload_dir.join(key)
}

#[derive(Deserialize)]
pub struct UploadQuery {
    name: String,
}

fn bad_type() -> AppError {
    AppError::new(StatusCode::BAD_REQUEST, "file_type_not_allowed", "文件类型不在白名单，或文件内容与扩展名不符")
}

/// POST /requirements/{id}/files?name=原文件名：请求体为文件原始字节（不是 multipart）。参与者或项目 editor
pub async fn upload(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, Q(q): Q<UploadQuery>, body: Body) -> AppResult<(StatusCode, Json<Value>)> {
    let w = load_who(&st, &c, id, PUBLISH).await?;
    w.writable()?;
    if !w.contributor() {
        return Err(AppError::forbidden());
    }
    let name = clean_name(&q.name);
    let ext = ext_of(&name);
    let ctype = allowed(&ext).ok_or_else(bad_type)?;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM requirement_files WHERE org_id = $1 AND page_id = $2").bind(w.org_id).bind(w.page_id).fetch_one(&st.db).await?;
    if n >= MAX_FILES {
        return Err(AppError::conflict("too_many_files", "每个需求最多 50 个附件"));
    }
    let max = st.cfg.upload_max_bytes;
    tokio::fs::create_dir_all(&st.cfg.upload_dir).await.map_err(AppError::internal)?;
    let key = random_token();
    let tmp = path_of(&st, &format!("{key}.part"));
    let res = async {
        let mut f = tokio::fs::File::create(&tmp).await.map_err(AppError::internal)?;
        let mut stream = body.into_data_stream();
        let (mut size, mut head, mut sha) = (0u64, Vec::new(), Sha256::new());
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| AppError::new(StatusCode::BAD_REQUEST, "upload_failed", "上传中断"))?;
            size += chunk.len() as u64;
            if size > max {
                return Err(AppError::new(StatusCode::PAYLOAD_TOO_LARGE, "file_too_large", format!("单个附件不能超过 {} MB", max >> 20)));
            }
            if head.len() < 8192 {
                head.extend_from_slice(&chunk[..chunk.len().min(8192 - head.len())]);
            }
            sha.update(&chunk);
            f.write_all(&chunk).await.map_err(AppError::internal)?;
        }
        f.flush().await.map_err(AppError::internal)?;
        if size == 0 {
            return Err(AppError::field("file", "文件为空"));
        }
        if !sniff_ok(&ext, &head) {
            return Err(bad_type());
        }
        Ok((size, sha.finalize().to_vec()))
    }
    .await;
    let (size, digest) = match res {
        Ok(v) => v,
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e);
        }
    };
    let dest = path_of(&st, &key);
    if let Err(e) = tokio::fs::rename(&tmp, &dest).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(AppError::internal(e));
    }
    let fid = new_id();
    let saved = async {
        let mut tx = st.db.begin().await?;
        sqlx::query(
            "INSERT INTO requirement_files (id, org_id, page_id, name, content_type, size, sha256, storage_key, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(fid)
        .bind(w.org_id)
        .bind(w.page_id)
        .bind(&name)
        .bind(ctype)
        .bind(size as i64)
        .bind(&digest)
        .bind(&key)
        .bind(w.uid())
        .execute(&mut *tx)
        .await?;
        audit::log(&mut tx, Some(w.org_id), &c.actor(), "requirement.file_upload", "page", Some(w.page_id), json!({ "file_id": fid, "name": name, "size": size, "content_type": ctype }))
            .await?;
        tx.commit().await?;
        AppResult::Ok(())
    }
    .await;
    if let Err(e) = saved {
        let _ = tokio::fs::remove_file(&dest).await;
        return Err(e);
    }
    let row: FileRow = sqlx::query_as(&format!("{FILE_SELECT} WHERE f.org_id = $1 AND f.id = $2")).bind(w.org_id).bind(fid).fetch_one(&st.db).await?;
    Ok((StatusCode::CREATED, Json(file_json(&st, &w, &row))))
}

/// RFC 5987 百分号编码（filename*=UTF-8''…）
fn pct(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

#[derive(Deserialize)]
pub struct DownloadQuery {
    inline: Option<String>,
}

/// GET /requirements/{id}/files/{file_id}：能看需求的人（含 PAT 任意 scope）。一律 attachment，只有安全 raster 图片 ?inline=1 时内联；nosniff + CSP sandbox
pub async fn download(State(st): State<AppState>, c: Caller, P((id, fid)): P<(Uuid, Uuid)>, Q(q): Q<DownloadQuery>) -> AppResult<Response> {
    let w = load_who(&st, &c, id, ANY_SCOPE).await?;
    let f: FileRow = sqlx::query_as(&format!("{FILE_SELECT} WHERE f.org_id = $1 AND f.page_id = $2 AND f.id = $3"))
        .bind(w.org_id)
        .bind(w.page_id)
        .bind(fid)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(AppError::not_found)?;
    let file = match tokio::fs::File::open(path_of(&st, &f.storage_key)).await {
        Ok(x) => x,
        Err(e) => {
            tracing::warn!("附件文件缺失 {}: {e}", f.id);
            return Err(AppError::not_found());
        }
    };
    let inline = q.inline.as_deref().is_some_and(|v| v == "1" || v == "true") && INLINE_TYPES.contains(&f.content_type.as_str());
    let ascii: String = f.name.chars().map(|ch| if ch.is_ascii_alphanumeric() || "-_. ".contains(ch) { ch } else { '_' }).collect();
    let disp = format!("{}; filename=\"{ascii}\"; filename*=UTF-8''{}", if inline { "inline" } else { "attachment" }, pct(&f.name));
    let stream = futures_util::stream::unfold(Some(file), |file| async move {
        let mut file = file?;
        let mut buf = vec![0u8; 64 * 1024];
        match file.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok::<_, std::io::Error>(axum::body::Bytes::from(buf)), Some(file)))
            }
            Err(e) => Some((Err(e), None)),
        }
    });
    let mut res = Body::from_stream(stream).into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(if inline { &f.content_type } else { "application/octet-stream" }).map_err(AppError::internal)?);
    h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_str(&disp).map_err(AppError::internal)?);
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(f.size as u64));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; sandbox"));
    Ok(res)
}

pub async fn delete_file(State(st): State<AppState>, c: Caller, P((id, fid)): P<(Uuid, Uuid)>) -> AppResult<StatusCode> {
    let w = load_who(&st, &c, id, PUBLISH).await?;
    w.writable()?;
    let mut tx = st.db.begin().await?;
    let (uploader, key): (Uuid, String) = sqlx::query_as("SELECT uploaded_by, storage_key FROM requirement_files WHERE org_id = $1 AND page_id = $2 AND id = $3")
        .bind(w.org_id)
        .bind(w.page_id)
        .bind(fid)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(AppError::not_found)?;
    if uploader != w.uid() && !w.editor && !w.acceptor() {
        return Err(AppError::forbidden());
    }
    sqlx::query("DELETE FROM requirement_files WHERE org_id = $1 AND id = $2").bind(w.org_id).bind(fid).execute(&mut *tx).await?;
    audit::log(&mut tx, Some(w.org_id), &c.actor(), "requirement.file_delete", "page", Some(w.page_id), json!({ "file_id": fid })).await?;
    tx.commit().await?;
    // 提交后再删文件：删失败只留孤儿文件，不会出现「记录在、文件没了」
    if let Err(e) = tokio::fs::remove_file(path_of(&st, &key)).await
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!("删除附件文件失败 {fid}: {e}");
    }
    Ok(StatusCode::NO_CONTENT)
}

/// 后台清理：需求页面软删 7 天后删除其附件记录与文件（软删期间保留，便于误删排查）。每次最多 500 个
pub async fn sweep_deleted_files(st: &AppState) {
    let keys: Result<Vec<String>, _> = sqlx::query_scalar(
        "DELETE FROM requirement_files WHERE id IN (
           SELECT f.id FROM requirement_files f JOIN pages p ON p.org_id = f.org_id AND p.id = f.page_id
            WHERE p.deleted_at < now() - interval '7 days' LIMIT 500)
         RETURNING storage_key",
    )
    .fetch_all(&st.db)
    .await;
    match keys {
        Ok(keys) => {
            for k in keys {
                if let Err(e) = tokio::fs::remove_file(path_of(st, &k)).await
                    && e.kind() != std::io::ErrorKind::NotFound
                {
                    tracing::warn!("清理附件文件失败 {k}: {e}");
                }
            }
        }
        Err(e) => tracing::warn!("清理附件失败: {e}"),
    }
}
