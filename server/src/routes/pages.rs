//! 页面管理、查看（view / 临时链接）、临时链接管理
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use super::{brief, list, require_any};
use crate::{
    AppState, audit,
    auth::Caller,
    authz::{
        ANY_SCOPE, PUBLISH, PageAccess, ProjectRole, Target, issue_grant, page_access, page_category, require_page_manage, require_project,
        require_share_link_manage, require_user, role_expr, share_by_token,
    },
    error::{AppError, AppResult, JsonBody, P, Q},
    notify::Event,
    ratelimit::MIN15,
    util::{PageQuery, hash_password, hmac_sign, new_id, paginate, random_token, sha256, text_field, ts, ts_opt, verify_password},
};

type J = AppResult<Json<Value>>;

#[derive(FromRow)]
struct PageListRow {
    id: Uuid,
    org_id: Uuid,
    project_id: Uuid,
    title: String,
    kind: String,
    page_type: String,
    generated_by: Option<String>,
    version: i32,
    visibility: String,
    accept_responses: bool,
    results_visible_to: String,
    response_seq: i64,
    created_by: Uuid,
    creator_name: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    group_ids: Vec<Uuid>,
    role: Option<String>,
    my_submitted: bool,
    closes_at: Option<DateTime<Utc>>,
    summary: Option<String>,
    highlights: Option<Value>,
    respondent_count: i64,
    eligible_count: Option<i64>,
}

/// $1 = 调用者 user_id
fn page_select() -> String {
    format!(
        "SELECT p.id, p.org_id, p.project_id, p.title, p.kind, p.page_type, p.generated_by, p.version, p.visibility, p.accept_responses, p.results_visible_to,
                p.response_seq, p.created_by, u.display_name AS creator_name, p.created_at, p.updated_at, p.closes_at, p.summary, p.highlights,
                COALESCE((SELECT array_agg(pg.group_id ORDER BY pg.group_id) FROM page_groups pg
                           WHERE pg.org_id = p.org_id AND pg.page_id = p.id), '{{}}') AS group_ids,
                {} AS role,
                EXISTS (SELECT 1 FROM page_groups pg JOIN group_members gm ON gm.org_id = pg.org_id AND gm.group_id = pg.group_id
                         WHERE pg.org_id = p.org_id AND pg.page_id = p.id AND gm.user_id = $1) AS in_group,
                EXISTS (SELECT 1 FROM responses r WHERE r.page_id = p.id AND r.user_id = $1 AND r.page_version = p.version) AS my_submitted
           FROM pages p
           JOIN projects pr ON pr.org_id = p.org_id AND pr.id = p.project_id AND pr.deleted_at IS NULL
           JOIN orgs o ON o.id = p.org_id AND o.deleted_at IS NULL
           JOIN users u ON u.id = p.created_by
           LEFT JOIN memberships m ON m.org_id = p.org_id AND m.user_id = $1",
        role_expr("p.org_id", "p.project_id", "$1", "m.role")
    )
}

/// 能看到页面且可以提交的组织内用户集合（SELECT user_id，已去重）。参数为外层列表达式；public 为空集（计数给 null）。
/// org → 组织成员；project → 有项目角色者（组织 owner/admin + 项目成员 + 授权群组成员）；groups → 页面受众群组成员
fn eligible_sql(org: &str, proj: &str, page: &str, vis: &str) -> String {
    format!(
        "SELECT em.user_id FROM memberships em
          WHERE em.org_id = {org} AND ({vis} = 'org' OR ({vis} = 'project' AND em.role IN ('owner', 'admin')))
         UNION
         SELECT epm.user_id FROM project_members epm WHERE {vis} = 'project' AND epm.project_id = {proj}
         UNION
         SELECT egm.user_id FROM project_groups epg JOIN group_members egm ON egm.org_id = epg.org_id AND egm.group_id = epg.group_id
          WHERE {vis} = 'project' AND epg.org_id = {org} AND epg.project_id = {proj}
         UNION
         SELECT ggm.user_id FROM page_groups gpg JOIN group_members ggm ON ggm.org_id = gpg.org_id AND ggm.group_id = gpg.group_id
          WHERE {vis} = 'groups' AND gpg.org_id = {org} AND gpg.page_id = {page}"
    )
}

/// respondent_count / eligible_count 两列；x 为带 id/org_id/project_id/visibility/version 列的页面别名
fn counts_sql(x: &str) -> String {
    format!(
        "(SELECT count(DISTINCT cr.user_id) + count(DISTINCT cr.nickname) FILTER (WHERE cr.user_id IS NULL)
            FROM responses cr WHERE cr.page_id = {x}.id AND cr.page_version = {x}.version) AS respondent_count,
         CASE WHEN {x}.visibility = 'public' THEN NULL ELSE (SELECT count(*) FROM ({}) ce) END AS eligible_count",
        eligible_sql(&format!("{x}.org_id"), &format!("{x}.project_id"), &format!("{x}.id"), &format!("{x}.visibility"))
    )
}

/// list_pages / activity 共用的可见性条件（作用于 page_select 的输出列）
const VISIBLE: &str = "(role IN ('admin', 'editor') OR (role IS NOT NULL AND (visibility <> 'groups' OR in_group)))";

impl PageListRow {
    fn json(&self, public_url: &str) -> Value {
        json!({
            "id": self.id, "org_id": self.org_id, "project_id": self.project_id,
            "title": self.title, "kind": self.kind, "version": self.version,
            "page_type": self.page_type, "category": page_category(&self.page_type), "generated_by": self.generated_by,
            "visibility": self.visibility, "group_ids": self.group_ids,
            "accept_responses": self.accept_responses, "results_visible_to": self.results_visible_to,
            "response_count": self.response_seq,
            "url": format!("{public_url}/pages/{}", self.id),
            "created_by": brief(self.created_by, &self.creator_name),
            "created_at": ts(&self.created_at), "updated_at": ts(&self.updated_at),
            "can_manage": matches!(self.role.as_deref(), Some("admin" | "editor")),
            "my_submitted": self.my_submitted,
            "closes_at": ts_opt(&self.closes_at), "summary": self.summary, "highlights": self.highlights,
            "respondent_count": self.respondent_count, "eligible_count": self.eligible_count,
        })
    }
}

async fn page_by_id(st: &AppState, org_id: Uuid, page_id: Uuid, uid: Uuid) -> AppResult<Value> {
    let row: PageListRow =
        sqlx::query_as(&format!("SELECT x.*, {} FROM ({} WHERE p.org_id = $2 AND p.id = $3 AND p.deleted_at IS NULL) x", counts_sql("x"), page_select()))
        .bind(uid)
        .bind(org_id)
        .bind(page_id)
        .fetch_one(&st.db)
        .await?;
    Ok(row.json(&st.cfg.public_url))
}

#[derive(Deserialize)]
pub struct ListQuery {
    project_id: Option<Uuid>,
    /// 逗号分隔的 page_type 列表
    page_type: Option<String>,
    /// 标题模糊搜索
    q: Option<String>,
}

pub async fn list_pages(State(st): State<AppState>, c: Caller, Q(page): Q<PageQuery>, Q(q): Q<ListQuery>) -> J {
    let uid = require_user(&c, ANY_SCOPE)?;
    let pat = c.p.pat();
    let types = q
        .page_type
        .as_deref()
        .map(|t| t.split(',').map(str::trim).filter(|t| !t.is_empty()).map(|t| check_page_type(t).map(|_| t.to_string())).collect::<AppResult<Vec<_>>>())
        .transpose()?
        .filter(|t| !t.is_empty());
    let title_q = match q.q.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) if t.chars().count() > 100 => return Err(AppError::field("q", "长度不能超过 100 字符")),
        t => t.map(|t| format!("%{}%", t.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))),
    };
    // ponytail: 跨所有项目扫描再按角色过滤；单用户页面数很大时给 project_id 走索引
    // 计数只对 LIMIT 之后的当前页行计算
    let sql = format!(
        "SELECT x.*, {} FROM (SELECT * FROM ({} WHERE p.deleted_at IS NULL AND m.user_id IS NOT NULL
             AND ($2::uuid IS NULL OR p.org_id = $2) AND ($3::uuid IS NULL OR p.project_id = $3)
             AND ($4::uuid IS NULL OR p.project_id = $4) AND ($5::uuid IS NULL OR p.id < $5)
             AND ($7::text[] IS NULL OR p.page_type = ANY($7))
             AND ($8::text IS NULL OR p.title ILIKE $8 ESCAPE '\\')) y
          WHERE {VISIBLE}
          ORDER BY id DESC LIMIT $6) x ORDER BY x.id DESC",
        counts_sql("x"),
        page_select()
    );
    let rows: Vec<PageListRow> = sqlx::query_as(&sql)
        .bind(uid)
        .bind(pat.and_then(|p| p.org_id))
        .bind(pat.and_then(|p| p.project_id))
        .bind(q.project_id)
        .bind(page.cursor_id()?)
        .bind(page.limit() + 1)
        .bind(types)
        .bind(title_q)
        .fetch_all(&st.db)
        .await?;
    let (rows, next) = paginate(rows, page.limit(), |r| r.id.to_string());
    Ok(Json(list(rows.iter().map(|r| r.json(&st.cfg.public_url)).collect(), next)))
}

#[derive(Deserialize)]
pub struct ActivityQuery {
    limit: Option<i64>,
    project_id: Option<Uuid>,
}

#[derive(FromRow)]
struct ActivityRow {
    etype: String,
    at: DateTime<Utc>,
    version: i32,
    page_id: Uuid,
    title: String,
    page_type: String,
    project_id: Uuid,
    project_name: String,
    actor_name: Option<String>,
    nickname: Option<String>,
    can_view_results: bool,
}

/// 动态流每个组织每类事件最多检查的最近事件数
const ACTIVITY_SCAN: i64 = 1000;

/// 最近动态：调用者能看到的页面（与 list_pages 同一可见性 SQL）上的发布/改版/提交事件，按时间倒序
pub async fn activity(State(st): State<AppState>, c: Caller, Q(q): Q<ActivityQuery>) -> J {
    let uid = require_user(&c, ANY_SCOPE)?;
    let pat = c.p.pat();
    let limit = q.limit.unwrap_or(30);
    if !(1..=50).contains(&limit) {
        return Err(AppError::field("limit", "范围 1..50"));
    }
    // 每个所在组织、每类事件各沿 (org_id, created_at DESC) 索引取最近 ACTIVITY_SCAN 条，逐条过可见性，够 limit 条即停；再合并取前 limit 条。
    // 可见性子查询带 OFFSET 0：阻止规划器把它摊平成对整个组织页面的哈希连接（那样会全扫 responses）。
    // ponytail: 扫描窗口封顶保证最坏耗时；调用者可见的事件都比窗口旧时动态会变少，真遇到再给页面可见性做物化
    let vis = |ev: &str| {
        format!(
            "CROSS JOIN LATERAL ({} WHERE p.org_id = mm.org_id AND p.id = {ev}.page_id AND p.deleted_at IS NULL AND m.user_id IS NOT NULL
                AND ($3::uuid IS NULL OR p.project_id = $3) AND ($4::uuid IS NULL OR p.project_id = $4) OFFSET 0) x",
            page_select()
        )
    };
    let page_cols = "x.title, x.page_type, x.project_id, (x.role IN ('admin', 'editor') OR x.results_visible_to = 'viewers') AS can_view_results";
    let sql = format!(
        "SELECT e.etype, e.at, e.version, e.page_id, e.title, e.page_type, e.project_id, pr.name AS project_name,
                u.display_name AS actor_name, e.nickname, e.can_view_results
           FROM memberships mm
           JOIN orgs mo ON mo.id = mm.org_id AND mo.deleted_at IS NULL
           CROSS JOIN LATERAL (
             (SELECT CASE WHEN v.version = 1 THEN 'published' ELSE 'updated' END AS etype, v.created_at AS at, v.version, v.page_id,
                     v.created_by AS actor_id, NULL::text AS nickname, {page_cols}
                FROM (SELECT page_id, version, created_by, created_at FROM page_versions
                       WHERE org_id = mm.org_id ORDER BY created_at DESC LIMIT {ACTIVITY_SCAN}) v {}
               WHERE {VISIBLE}
               ORDER BY v.created_at DESC LIMIT $5)
             UNION ALL
             (SELECT 'submitted', r.created_at, r.page_version, r.page_id, r.user_id, r.nickname, {page_cols}
                FROM (SELECT page_id, page_version, user_id, nickname, created_at FROM responses
                       WHERE org_id = mm.org_id ORDER BY created_at DESC LIMIT {ACTIVITY_SCAN}) r {}
               WHERE {VISIBLE}
               ORDER BY r.created_at DESC LIMIT $5)) e
           JOIN projects pr ON pr.id = e.project_id
           LEFT JOIN users u ON u.id = e.actor_id
          WHERE mm.user_id = $1 AND ($2::uuid IS NULL OR mm.org_id = $2)
          ORDER BY e.at DESC LIMIT $5",
        vis("v"),
        vis("r")
    );
    let rows: Vec<ActivityRow> = sqlx::query_as(&sql)
        .bind(uid)
        .bind(pat.and_then(|p| p.org_id))
        .bind(pat.and_then(|p| p.project_id))
        .bind(q.project_id)
        .bind(limit)
        .fetch_all(&st.db)
        .await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            // 提交者名字仅对能看该页结果的调用者给出
            let actor = match (&r.actor_name, &r.nickname) {
                _ if r.etype == "submitted" && !r.can_view_results => Value::Null,
                (Some(n), _) => json!({ "kind": "user", "name": n }),
                (None, Some(n)) => json!({ "kind": "anonymous", "name": n }),
                _ => Value::Null,
            };
            json!({
                "type": r.etype, "at": ts(&r.at), "version": r.version, "actor": actor,
                "page": { "id": r.page_id, "title": r.title, "page_type": r.page_type, "project": { "id": r.project_id, "name": r.project_name } },
            })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

// ---------------------------------------------------------------- 校验

fn check_kind(kind: &str) -> AppResult<()> {
    if matches!(kind, "openui" | "html") { Ok(()) } else { Err(AppError::field("kind", "取值必须是 openui/html")) }
}

const PAGE_TYPES: [&str; 9] = ["general", "report", "knowledge", "flowchart", "architecture", "vote", "requirement", "task", "task_tree"];

fn check_page_type(t: &str) -> AppResult<()> {
    if PAGE_TYPES.contains(&t) { Ok(()) } else { Err(AppError::field("page_type", &format!("取值必须是 {}", PAGE_TYPES.join("/")))) }
}

/// 生成页面的 AI 模型名称：去首尾空白后 1..100 字符、不含控制字符；空/缺省 → None
fn check_model(v: Option<&str>) -> AppResult<Option<String>> {
    let t = v.unwrap_or("").trim();
    if t.is_empty() {
        return Ok(None);
    }
    if t.chars().count() > 100 || t.chars().any(char::is_control) {
        return Err(AppError::field("model", "长度需在 1..100 字符且不含控制字符"));
    }
    Ok(Some(t.to_string()))
}

/// 区分「没传」(None) 与「传了 null」(Some(None))
fn nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

/// 截止时间：带时区的 RFC 3339，必须晚于现在
fn check_closes_at(v: Option<&str>) -> AppResult<Option<DateTime<Utc>>> {
    let Some(v) = v else { return Ok(None) };
    let t = DateTime::parse_from_rfc3339(v.trim()).map_err(|_| AppError::field("closes_at", "必须是带时区的 RFC 3339 时间"))?.with_timezone(&Utc);
    if t <= Utc::now() {
        return Err(AppError::field("closes_at", "不能早于当前时间"));
    }
    Ok(Some(t))
}

/// 卡片摘要：trim 后 1..300 字符；空白视为清除
fn check_summary(v: Option<&str>) -> AppResult<Option<String>> {
    match v.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => text_field("summary", t, 1, 300).map(Some),
        None => Ok(None),
    }
}

/// 关键数字：≤4 项，每项恰好 {label, value}，trim 后 1..20 字符；null / [] 视为清除
fn check_highlights(v: Option<&Value>) -> AppResult<Option<Value>> {
    let bad = || AppError::field("highlights", "必须是不超过 4 项的数组，每项为 {label, value}，均为 1..20 字符的字符串");
    let items = match v {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Array(a)) if a.len() <= 4 => a,
        _ => return Err(bad()),
    };
    let mut out = vec![];
    for it in items {
        let o = it.as_object().filter(|o| o.len() == 2).ok_or_else(bad)?;
        let f = |k: &str| {
            o.get(k).and_then(Value::as_str).map(str::trim).filter(|t| (1..=20).contains(&t.chars().count())).map(str::to_string).ok_or_else(bad)
        };
        out.push(json!({ "label": f("label")?, "value": f("value")? }));
    }
    Ok((!out.is_empty()).then_some(Value::Array(out)))
}

fn read_only_accept() -> AppError {
    AppError::field("accept_responses", "只读类型页面不能开启提交")
}

fn check_content(kind: &str, content: &str) -> AppResult<()> {
    let max = if kind == "html" { 5 * 1024 * 1024 } else { 512 * 1024 };
    if content.is_empty() || content.len() > max {
        return Err(AppError::field("content", &format!("不能为空且不超过 {} KiB", max / 1024)));
    }
    Ok(())
}

fn check_visibility(v: &str) -> AppResult<()> {
    if matches!(v, "public" | "org" | "project" | "groups") {
        Ok(())
    } else {
        Err(AppError::field("visibility", "取值必须是 public/org/project/groups"))
    }
}

fn check_results(v: &str) -> AppResult<()> {
    if matches!(v, "managers" | "viewers") { Ok(()) } else { Err(AppError::field("results_visible_to", "取值必须是 managers/viewers")) }
}

/// visibility=groups 时 group_ids 非空，且每个都是本组织的组织级群组或本项目（project_id）的项目群组；否则必须为空
async fn check_groups(db: &mut sqlx::PgConnection, org_id: Uuid, project_id: Uuid, visibility: &str, ids: Option<&[Uuid]>) -> AppResult<Vec<Uuid>> {
    let mut ids = ids.unwrap_or_default().to_vec();
    ids.sort();
    ids.dedup();
    if visibility != "groups" {
        return if ids.is_empty() { Ok(ids) } else { Err(AppError::field("group_ids", "仅 visibility=groups 时可指定")) };
    }
    if ids.is_empty() {
        return Err(AppError::field("group_ids", "visibility=groups 时必须指定至少一个群组"));
    }
    let (n, other): (i64, i64) = sqlx::query_as(
        "SELECT count(*), count(*) FILTER (WHERE project_id IS NOT NULL AND project_id <> $3) FROM groups WHERE org_id = $1 AND id = ANY($2)",
    )
    .bind(org_id)
    .bind(&ids)
    .bind(project_id)
    .fetch_one(db)
    .await?;
    if n as usize != ids.len() {
        return Err(AppError::field("group_ids", "群组不存在或不属于该组织"));
    }
    if other > 0 {
        return Err(AppError::new(
            axum::http::StatusCode::BAD_REQUEST,
            "group_not_in_project",
            "group_ids 含其他项目的项目群组；只能发给组织级群组或本项目的项目群组",
        ));
    }
    Ok(ids)
}

async fn set_groups(db: &mut sqlx::PgConnection, org_id: Uuid, page_id: Uuid, ids: &[Uuid]) -> AppResult<()> {
    sqlx::query("DELETE FROM page_groups WHERE org_id = $1 AND page_id = $2").bind(org_id).bind(page_id).execute(&mut *db).await?;
    sqlx::query("INSERT INTO page_groups (org_id, page_id, group_id) SELECT $1, $2, unnest($3::uuid[])")
        .bind(org_id)
        .bind(page_id)
        .bind(ids)
        .execute(db)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------- CRUD

#[derive(Deserialize)]
pub struct CreateReq {
    project_id: Uuid,
    title: String,
    kind: String,
    page_type: Option<String>,
    model: Option<String>,
    content: String,
    visibility: String,
    group_ids: Option<Vec<Uuid>>,
    accept_responses: Option<bool>,
    results_visible_to: Option<String>,
    closes_at: Option<String>,
    summary: Option<String>,
    highlights: Option<Value>,
}

pub async fn create_page(State(st): State<AppState>, c: Caller, JsonBody(r): JsonBody<CreateReq>) -> AppResult<(StatusCode, Json<Value>)> {
    let ctx = require_project(&st.db, &c, r.project_id, ProjectRole::Editor, PUBLISH).await?;
    let title = text_field("title", &r.title, 1, 200)?;
    check_kind(&r.kind)?;
    let page_type = r.page_type.as_deref().unwrap_or("general");
    check_page_type(page_type)?;
    let model = check_model(r.model.as_deref())?;
    let closes_at = check_closes_at(r.closes_at.as_deref())?;
    let summary = check_summary(r.summary.as_deref())?;
    let highlights = check_highlights(r.highlights.as_ref())?;
    let read_only = match page_category(page_type) {
        "collab" => return Err(AppError::field("page_type", "该类型尚未开放")),
        c => c == "read",
    };
    if read_only && r.accept_responses == Some(true) {
        return Err(read_only_accept());
    }
    check_content(&r.kind, &r.content)?;
    check_visibility(&r.visibility)?;
    let results = r.results_visible_to.unwrap_or_else(|| "managers".into());
    check_results(&results)?;
    let id = new_id();
    let mut tx = st.db.begin().await?;
    let groups = check_groups(&mut tx, ctx.org_id(), ctx.project_id(), &r.visibility, r.group_ids.as_deref()).await?;
    sqlx::query(
        "INSERT INTO pages (id, org_id, project_id, title, kind, content, visibility, accept_responses, results_visible_to, created_by, created_via_pat, page_type, generated_by,
                            closes_at, summary, highlights)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)",
    )
    .bind(id)
    .bind(ctx.org_id())
    .bind(ctx.project_id())
    .bind(&title)
    .bind(&r.kind)
    .bind(&r.content)
    .bind(&r.visibility)
    .bind(r.accept_responses.unwrap_or(!read_only))
    .bind(&results)
    .bind(ctx.user_id())
    .bind(c.p.pat().map(|p| p.id))
    .bind(page_type)
    .bind(&model)
    .bind(closes_at)
    .bind(&summary)
    .bind(&highlights)
    .execute(&mut *tx)
    .await?;
    set_groups(&mut tx, ctx.org_id(), id, &groups).await?;
    snapshot(&mut tx, ctx.org_id(), id, ctx.user_id()).await?;
    audit::log(
        &mut tx,
        Some(ctx.org_id()),
        &c.actor(),
        "page.publish",
        "page",
        Some(id),
        json!({ "project_id": ctx.project_id(), "kind": r.kind, "page_type": page_type, "model": model, "visibility": r.visibility, "group_ids": groups }),
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(page_by_id(&st, ctx.org_id(), id, ctx.user_id()).await?)))
}

pub async fn get_page(State(st): State<AppState>, c: Caller, P(id): P<Uuid>) -> J {
    let ctx = require_page_manage(&st.db, &c, id, ANY_SCOPE).await?;
    let mut v = page_by_id(&st, ctx.org_id(), ctx.page_id(), ctx.user_id()).await?;
    let content: String =
        sqlx::query_scalar("SELECT content FROM pages WHERE org_id = $1 AND id = $2").bind(ctx.org_id()).bind(ctx.page_id()).fetch_one(&st.db).await?;
    v["content"] = json!(content);
    Ok(Json(v))
}

#[derive(Deserialize)]
pub struct UpdateReq {
    /// 不可修改；传了即 400
    page_type: Option<Value>,
    /// 提供时覆盖 generated_by（页面被别的模型改过）
    model: Option<String>,
    title: Option<String>,
    content: Option<String>,
    visibility: Option<String>,
    group_ids: Option<Vec<Uuid>>,
    accept_responses: Option<bool>,
    results_visible_to: Option<String>,
    /// 以下三项：传 null 清除，不传不变
    #[serde(default, deserialize_with = "nullable")]
    closes_at: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    summary: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    highlights: Option<Option<Value>>,
}

pub async fn update_page(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, JsonBody(r): JsonBody<UpdateReq>) -> J {
    let ctx = require_page_manage(&st.db, &c, id, PUBLISH).await?;
    if r.page_type.is_some() {
        return Err(AppError::field("page_type", "创建后不可修改"));
    }
    let model = check_model(r.model.as_deref())?;
    require_any(&[
        model.is_some(),
        r.title.is_some(),
        r.content.is_some(),
        r.visibility.is_some(),
        r.group_ids.is_some(),
        r.accept_responses.is_some(),
        r.results_visible_to.is_some(),
        r.closes_at.is_some(),
        r.summary.is_some(),
        r.highlights.is_some(),
    ])?;
    let closes_at = r.closes_at.as_ref().map(|v| check_closes_at(v.as_deref())).transpose()?;
    let summary = r.summary.as_ref().map(|v| check_summary(v.as_deref())).transpose()?;
    let highlights = r.highlights.as_ref().map(|v| check_highlights(v.as_ref())).transpose()?;
    let title = r.title.as_deref().map(|t| text_field("title", t, 1, 200)).transpose()?;
    if let Some(v) = &r.visibility {
        check_visibility(v)?;
    }
    if let Some(v) = &r.results_visible_to {
        check_results(v)?;
    }
    let mut tx = st.db.begin().await?;
    let (kind, page_type, old_content, old_vis, old_accept): (String, String, String, String, bool) = sqlx::query_as(
        "SELECT kind, page_type, content, visibility, accept_responses FROM pages WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(ctx.org_id())
    .bind(ctx.page_id())
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(AppError::not_found)?;
    if r.accept_responses == Some(true) && page_category(&page_type) == "read" {
        return Err(read_only_accept());
    }
    let old_groups = ctx.page_group_ids(&mut tx).await?;
    let new_vis = r.visibility.clone().unwrap_or_else(|| old_vis.clone());
    let new_groups = match (&r.group_ids, new_vis == old_vis) {
        (None, true) => old_groups.clone(),
        (ids, _) => check_groups(&mut tx, ctx.org_id(), ctx.project_id(), &new_vis, ids.as_deref()).await?,
    };
    let content = match &r.content {
        Some(cnt) => {
            check_content(&kind, cnt)?;
            (cnt != &old_content).then_some(cnt)
        }
        None => None,
    };
    sqlx::query(
        "UPDATE pages SET title = COALESCE($3, title), content = COALESCE($4, content),
                version = version + CASE WHEN $4::text IS NULL THEN 0 ELSE 1 END,
                visibility = $5, accept_responses = COALESCE($6, accept_responses),
                results_visible_to = COALESCE($7, results_visible_to), generated_by = COALESCE($8, generated_by),
                closes_at = CASE WHEN $9 THEN $10 ELSE closes_at END, summary = CASE WHEN $11 THEN $12 ELSE summary END,
                highlights = CASE WHEN $13 THEN $14 ELSE highlights END, updated_at = now()
          WHERE org_id = $1 AND id = $2",
    )
    .bind(ctx.org_id())
    .bind(ctx.page_id())
    .bind(&title)
    .bind(content)
    .bind(&new_vis)
    .bind(r.accept_responses)
    .bind(&r.results_visible_to)
    .bind(&model)
    .bind(closes_at.is_some())
    .bind(closes_at.flatten())
    .bind(summary.is_some())
    .bind(summary.clone().flatten())
    .bind(highlights.is_some())
    .bind(highlights.clone().flatten())
    .execute(&mut *tx)
    .await?;
    if new_groups != old_groups {
        set_groups(&mut tx, ctx.org_id(), ctx.page_id(), &new_groups).await?;
    }
    if content.is_some() {
        snapshot(&mut tx, ctx.org_id(), ctx.page_id(), ctx.user_id()).await?;
    }
    let mut fields = vec![];
    for (name, present) in [
        ("title", title.is_some()),
        ("content", content.is_some()),
        ("visibility", new_vis != old_vis),
        ("group_ids", new_groups != old_groups),
        ("accept_responses", r.accept_responses.is_some()),
        ("results_visible_to", r.results_visible_to.is_some()),
        ("model", model.is_some()),
        ("closes_at", closes_at.is_some()),
        ("summary", summary.is_some()),
        ("highlights", highlights.is_some()),
    ] {
        if present {
            fields.push(name);
        }
    }
    let mut meta = json!({ "fields": fields });
    if new_vis != old_vis {
        meta["visibility"] = json!({ "old": old_vis, "new": new_vis });
    }
    if new_groups != old_groups {
        meta["group_ids"] = json!({ "old": old_groups, "new": new_groups });
    }
    audit::log(&mut tx, Some(ctx.org_id()), &c.actor(), "page.update", "page", Some(ctx.page_id()), meta).await?;
    tx.commit().await?;
    if content.is_some() || r.accept_responses.is_some_and(|a| a != old_accept) {
        st.notify.send(ctx.page_id(), Event::Page);
    }
    Ok(Json(page_by_id(&st, ctx.org_id(), ctx.page_id(), ctx.user_id()).await?))
}

/// 把页面当前版本写入 page_versions（创建页面、content 变化后在同一事务调用）
async fn snapshot(db: &mut sqlx::PgConnection, org_id: Uuid, page_id: Uuid, uid: Uuid) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO page_versions (org_id, page_id, version, title, kind, content, created_by)
         SELECT org_id, id, version, title, kind, content, $3 FROM pages WHERE org_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(page_id)
    .bind(uid)
    .execute(db)
    .await?;
    Ok(())
}

impl crate::authz::PageCtx {
    async fn page_group_ids(&self, db: &mut sqlx::PgConnection) -> AppResult<Vec<Uuid>> {
        Ok(sqlx::query_scalar("SELECT group_id FROM page_groups WHERE org_id = $1 AND page_id = $2 ORDER BY group_id")
            .bind(self.org_id())
            .bind(self.page_id())
            .fetch_all(db)
            .await?)
    }
}

pub async fn delete_page(State(st): State<AppState>, c: Caller, P(id): P<Uuid>) -> AppResult<StatusCode> {
    let ctx = require_page_manage(&st.db, &c, id, PUBLISH).await?;
    let mut tx = st.db.begin().await?;
    sqlx::query("UPDATE pages SET deleted_at = now(), updated_at = now() WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL")
        .bind(ctx.org_id())
        .bind(ctx.page_id())
        .execute(&mut *tx)
        .await?;
    audit::log(&mut tx, Some(ctx.org_id()), &c.actor(), "page.delete", "page", Some(ctx.page_id()), json!({})).await?;
    tx.commit().await?;
    st.notify.send(ctx.page_id(), Event::Deleted);
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- 查看

pub const FRAME_TTL: i64 = 600;

pub fn frame_url(st: &AppState, page_id: Uuid, version: i32) -> String {
    let exp = Utc::now().timestamp() + FRAME_TTL;
    let sig = hmac_sign(&st.cfg.secret_key, &format!("h|{page_id}|{version}|{exp}"));
    format!("{}/h/{page_id}/{version}?exp={exp}&sig={sig}", st.cfg.frame_origin())
}

#[derive(FromRow)]
struct MyResponse {
    seq: i64,
    page_version: i32,
    data: Value,
    created_at: DateTime<Utc>,
}

/// version：要查看的版本（None = 当前）；临时链接访问只给当前版本
async fn page_view(st: &AppState, a: &PageAccess, version: Option<i32>) -> J {
    let p = a.page();
    let v = version.unwrap_or(p.version);
    // 当前版本以 pages 为准；历史版本取 page_versions（html 不读 content）
    let (title, spec) = if v == p.version {
        let spec = match p.kind.as_str() {
            "html" => None,
            _ => Some(
                sqlx::query_scalar("SELECT content FROM pages WHERE org_id = $1 AND id = $2").bind(a.org_id()).bind(a.page_id()).fetch_one(&st.db).await?,
            ),
        };
        (p.title.clone(), spec)
    } else {
        let row: Option<(String, Option<String>)> =
            sqlx::query_as("SELECT title, CASE WHEN kind = 'html' THEN NULL ELSE content END FROM page_versions WHERE page_id = $1 AND version = $2")
                .bind(a.page_id())
                .bind(v)
                .fetch_optional(&st.db)
                .await?;
        row.ok_or_else(AppError::not_found)?
    };
    let content = match spec {
        None => json!({ "kind": "html", "frame_url": frame_url(st, p.id, v), "frame_origin": st.cfg.frame_origin(), "version": v, "title": title }),
        Some(spec) => json!({ "kind": "openui", "spec": spec, "version": v, "title": title }),
    };
    let viewer = match a.user_id() {
        Some(uid) => {
            let name: String = sqlx::query_scalar("SELECT display_name FROM users WHERE id = $1").bind(uid).fetch_one(&st.db).await?;
            json!({ "type": "user", "user_id": uid, "display_name": name })
        }
        None => json!({ "type": "anonymous" }),
    };
    // 分享访问：my_submitted 恒为 false、my_response/versions 为 null
    let member = a.user_id().filter(|_| a.share().is_none());
    let (my_submitted, my_response, versions) = match member {
        Some(uid) => {
            let mine = |ver: i32| {
                sqlx::query_as::<_, MyResponse>(
                    "SELECT seq, page_version, data, created_at FROM responses
                      WHERE page_id = $1 AND user_id = $2 AND page_version = $3 ORDER BY seq DESC LIMIT 1",
                )
                .bind(a.page_id())
                .bind(uid)
                .bind(ver)
                .fetch_optional(&st.db)
            };
            let resp = mine(v).await?;
            let submitted = if v == p.version { resp.is_some() } else { mine(p.version).await?.is_some() };
            // ponytail: 全量返回版本列表；版本数上千时再分页
            let mut vs: Vec<(i32, DateTime<Utc>)> =
                sqlx::query_as("SELECT version, created_at FROM page_versions WHERE page_id = $1 ORDER BY version DESC").bind(a.page_id()).fetch_all(&st.db).await?;
            // 旧代码并存/回滚期间写的当前版本可能没有快照行
            if vs.first().is_none_or(|x| x.0 != p.version) {
                vs.insert(0, (p.version, p.updated_at));
            }
            let resp = resp.map(|r| json!({ "seq": r.seq, "page_version": r.page_version, "data": r.data, "created_at": ts(&r.created_at) }));
            (submitted, resp, Some(vs.iter().map(|(n, t)| json!({ "version": n, "created_at": ts(t) })).collect::<Vec<_>>()))
        }
        None => (false, None, None),
    };
    // 登录用户（非临时链接）每个版本限交一次
    let block_reason = a.block_reason().or(my_submitted.then_some("already_submitted"));
    // 参与情况：仅组织内登录用户、非临时链接访问时给出（外部人不应看到组织规模），否则整体 null；
    // 未交名单再限能看结果者（public 页面无「应交」集合，同为 null）
    let participation = if a.user_id().is_some() && a.share().is_none() && p.org_role.is_some() {
        let (respondent_count, eligible_count): (i64, Option<i64>) =
            sqlx::query_as(&format!("SELECT {} FROM pages x WHERE x.org_id = $1 AND x.id = $2", counts_sql("x")))
                .bind(a.org_id())
                .bind(a.page_id())
                .fetch_one(&st.db)
                .await?;
        let pending = if a.can_view_results() && eligible_count.is_some() {
            let rows: Vec<(Uuid, String)> = sqlx::query_as(&format!(
                "SELECT u.id, u.display_name FROM pages x
                   CROSS JOIN LATERAL ({}) e
                   JOIN users u ON u.id = e.user_id
                  WHERE x.org_id = $1 AND x.id = $2
                    AND NOT EXISTS (SELECT 1 FROM responses r WHERE r.page_id = x.id AND r.user_id = e.user_id AND r.page_version = x.version)
                  ORDER BY u.display_name, u.id LIMIT 50",
                eligible_sql("x.org_id", "x.project_id", "x.id", "x.visibility")
            ))
            .bind(a.org_id())
            .bind(a.page_id())
            .fetch_all(&st.db)
            .await?;
            Some(rows.iter().map(|(id, n)| brief(*id, n)).collect::<Vec<_>>())
        } else {
            None
        };
        json!({ "eligible_count": eligible_count, "respondent_count": respondent_count, "pending": pending })
    } else {
        Value::Null
    };
    let share = a.share().map(|l| {
        json!({ "id": l.id, "label": l.label, "expires_at": ts(&l.expires_at), "remaining_uses": l.max_uses.map(|m| (m - l.use_count).max(0)) })
    });
    Ok(Json(json!({
        "page": {
            "id": p.id, "title": p.title, "kind": p.kind, "version": p.version,
            "page_type": p.page_type, "category": page_category(&p.page_type), "generated_by": p.generated_by,
            "accept_responses": p.accept_responses, "results_visible_to": p.results_visible_to, "updated_at": ts(&p.updated_at),
            "closes_at": ts_opt(&p.closes_at), "summary": p.summary, "highlights": p.highlights,
            "project": { "id": p.project_id, "name": p.project_name }, "org": { "id": p.org_id, "name": p.org_name },
        },
        "content": content,
        "viewer": viewer,
        "can_submit": block_reason.is_none(),
        "submit_block_reason": block_reason,
        "can_view_results": a.can_view_results(),
        "can_manage": a.can_manage(),
        "my_submitted": my_submitted,
        "my_response": my_response,
        "versions": versions,
        "share_link": share,
        "participation": participation,
    })))
}

pub fn grant_header(h: &HeaderMap) -> Option<&str> {
    h.get("x-share-grant").and_then(|v| v.to_str().ok())
}

#[derive(Deserialize)]
pub struct ViewQuery {
    version: Option<i32>,
}

pub async fn view_page(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, Q(q): Q<ViewQuery>) -> J {
    let a = page_access(&st.db, &st.cfg, &c, Target::Page(id)).await?;
    if c.p.is_pat() {
        return Err(AppError::forbidden());
    }
    page_view(&st, &a, q.version).await
}

pub async fn view_share(State(st): State<AppState>, c: Caller, h: HeaderMap, P(token): P<String>) -> J {
    let a = page_access(&st.db, &st.cfg, &c, Target::Share { token: &token, grant: grant_header(&h) }).await?;
    if c.p.is_pat() {
        return Err(AppError::forbidden());
    }
    page_view(&st, &a, None).await
}

#[derive(Deserialize)]
pub struct UnlockReq {
    password: String,
}

pub async fn unlock_share(State(st): State<AppState>, c: Caller, P(token): P<String>, JsonBody(r): JsonBody<UnlockReq>) -> J {
    let link = share_by_token(&st.db, &token).await?;
    st.rl.hit(&format!("unlock:{}:{}", link.id, c.ip), 10, MIN15)?;
    if link.password_hash.is_some() && !verify_password(r.password, link.password_hash.clone()).await {
        return Err(AppError::new(StatusCode::UNAUTHORIZED, "share_password_invalid", "访问密码错误"));
    }
    let (grant, exp) = issue_grant(&st.cfg, link.id);
    Ok(Json(json!({ "grant": grant, "expires_at": ts(&exp) })))
}

// ---------------------------------------------------------------- 临时链接管理

#[derive(FromRow)]
struct ShareLinkRow {
    id: Uuid,
    page_id: Uuid,
    label: String,
    token_prefix: String,
    expires_at: DateTime<Utc>,
    max_uses: Option<i32>,
    use_count: i32,
    has_password: bool,
    created_by: Uuid,
    creator_name: String,
    created_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
}

const LINK_SELECT: &str = "SELECT s.id, s.page_id, s.label, s.token_prefix, s.expires_at, s.max_uses, s.use_count,
        (s.password_hash IS NOT NULL) AS has_password, s.created_by, u.display_name AS creator_name, s.created_at, s.revoked_at
   FROM share_links s JOIN users u ON u.id = s.created_by";

impl ShareLinkRow {
    fn json(&self) -> Value {
        let status = if self.revoked_at.is_some() {
            "revoked"
        } else if self.expires_at <= Utc::now() {
            "expired"
        } else if self.max_uses.is_some_and(|m| self.use_count >= m) {
            "exhausted"
        } else {
            "active"
        };
        json!({
            "id": self.id, "page_id": self.page_id, "label": self.label, "token_prefix": self.token_prefix,
            "expires_at": ts(&self.expires_at), "max_uses": self.max_uses, "use_count": self.use_count,
            "has_password": self.has_password, "created_by": brief(self.created_by, &self.creator_name),
            "created_at": ts(&self.created_at), "revoked_at": ts_opt(&self.revoked_at), "status": status,
        })
    }
}

#[derive(Deserialize)]
pub struct LinksQuery {
    include_inactive: Option<bool>,
}

pub async fn list_share_links(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, Q(q): Q<LinksQuery>) -> J {
    let ctx = require_page_manage(&st.db, &c, id, PUBLISH).await?;
    let rows: Vec<ShareLinkRow> = sqlx::query_as(&format!(
        "{LINK_SELECT} WHERE s.org_id = $1 AND s.page_id = $2
            AND ($3 OR (s.revoked_at IS NULL AND s.expires_at > now() AND (s.max_uses IS NULL OR s.use_count < s.max_uses)))
          ORDER BY s.id DESC"
    ))
    .bind(ctx.org_id())
    .bind(ctx.page_id())
    .bind(q.include_inactive.unwrap_or(false))
    .fetch_all(&st.db)
    .await?;
    Ok(Json(json!({ "items": rows.iter().map(ShareLinkRow::json).collect::<Vec<_>>() })))
}

#[derive(Deserialize)]
pub struct CreateLinkReq {
    expires_in: i64,
    max_uses: Option<i32>,
    password: Option<String>,
    label: Option<String>,
}

pub async fn create_share_link(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, JsonBody(r): JsonBody<CreateLinkReq>) -> AppResult<(StatusCode, Json<Value>)> {
    let ctx = require_page_manage(&st.db, &c, id, PUBLISH).await?;
    if !(300..=7_776_000).contains(&r.expires_in) {
        return Err(AppError::field("expires_in", "范围 300..7776000 秒"));
    }
    if r.max_uses.is_some_and(|m| !(1..=1_000_000).contains(&m)) {
        return Err(AppError::field("max_uses", "范围 1..1000000，或 null 表示不限"));
    }
    let label = text_field("label", r.label.as_deref().unwrap_or(""), 0, 100)?;
    let password_hash = match r.password.filter(|p| !p.is_empty()) {
        Some(p) if (4..=128).contains(&p.chars().count()) => Some(hash_password(p).await?),
        Some(_) => return Err(AppError::field("password", "长度需在 4..128 字符")),
        None => None,
    };
    let token = random_token();
    let link_id = new_id();
    let mut tx = st.db.begin().await?;
    sqlx::query(
        "INSERT INTO share_links (id, org_id, page_id, token_hash, token_prefix, label, expires_at, max_uses, password_hash, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7), $8, $9, $10)",
    )
    .bind(link_id)
    .bind(ctx.org_id())
    .bind(ctx.page_id())
    .bind(sha256(&token))
    .bind(&token[..6])
    .bind(&label)
    .bind(r.expires_in as f64)
    .bind(r.max_uses)
    .bind(&password_hash)
    .bind(ctx.user_id())
    .execute(&mut *tx)
    .await?;
    audit::log(
        &mut tx,
        Some(ctx.org_id()),
        &c.actor(),
        "share_link.create",
        "share_link",
        Some(link_id),
        json!({ "page_id": ctx.page_id(), "expires_in": r.expires_in, "max_uses": r.max_uses, "has_password": password_hash.is_some() }),
    )
    .await?;
    tx.commit().await?;
    let row = link_by_id(&st.db, ctx.org_id(), link_id).await?;
    Ok((StatusCode::CREATED, Json(json!({ "share_link": row.json(), "url": format!("{}/s/{token}", st.cfg.public_url) }))))
}

async fn link_by_id(db: &PgPool, org_id: Uuid, id: Uuid) -> AppResult<ShareLinkRow> {
    Ok(sqlx::query_as(&format!("{LINK_SELECT} WHERE s.org_id = $1 AND s.id = $2")).bind(org_id).bind(id).fetch_one(db).await?)
}

pub async fn revoke_share_link(State(st): State<AppState>, c: Caller, P(id): P<Uuid>) -> AppResult<StatusCode> {
    let ctx = require_share_link_manage(&st.db, &c, id, PUBLISH).await?;
    let mut tx = st.db.begin().await?;
    let n = sqlx::query("UPDATE share_links SET revoked_at = now() WHERE org_id = $1 AND page_id = $2 AND id = $3 AND revoked_at IS NULL")
        .bind(ctx.org_id())
        .bind(ctx.page_id())
        .bind(id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n > 0 {
        audit::log(&mut tx, Some(ctx.org_id()), &c.actor(), "share_link.revoke", "share_link", Some(id), json!({ "page_id": ctx.page_id() })).await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
