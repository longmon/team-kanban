//! 任务树页面（page_type = task_tree，docs/api.md §7.6）：任务节点、状态流转、评审、历史。
//! 状态：todo → in_progress → in_review →（评审人通过）done；驳回 → in_progress（必须写理由）。
//! 任务状态变化不产生页面新版本；PATCH /pages/{id} 重发整棵树时按节点 key 合并（syncs 状态保留，去掉的节点软删）。
use std::collections::{HashMap, HashSet};

use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;

use super::brief;
use crate::{
    AppState,
    auth::Caller,
    authz::{ANY_SCOPE, PUBLISH, PageAccess, Target, check_allow, page_access, page_closed},
    error::{AppError, AppResult, JsonBody, P, Q},
    util::{new_id, text_field, ts, ts_opt},
};

type J = AppResult<Json<Value>>;

pub const MAX_DEPTH: usize = 6;
pub const MAX_NODES: usize = 500;
const MAX_EVIDENCE: usize = 10;
const MAX_REVIEWERS: usize = 50;

// ---------------------------------------------------------------- 输入与校验

/// 发布/重发时的一个任务节点（children 嵌套）
#[derive(Deserialize, Clone)]
pub struct TaskInput {
    /// 稳定 id：重发时按它合并；省略时服务端生成
    key: Option<String>,
    title: String,
    description: Option<String>,
    /// 负责人：组织成员的 user_id 或邮箱；"me" = 调用者（agent 即其令牌所属账号）
    assignee: Option<String>,
    /// 负责人显示名补充（如 agent 名称）
    assignee_label: Option<String>,
    due_at: Option<String>,
    children: Option<Vec<TaskInput>>,
}

/// 评审人：成员（user_id 或邮箱）与群组（UUID）；都为空 = 由项目管理员评审
#[derive(Deserialize, Default)]
pub struct ReviewersInput {
    users: Option<Vec<String>>,
    groups: Option<Vec<Uuid>>,
}

/// 扁平化后的节点（前序：父在子前）
pub struct Flat {
    key: String,
    parent_key: Option<String>,
    position: i32,
    title: String,
    description: String,
    assignee: Option<String>,
    assignee_label: Option<String>,
    due_at: Option<DateTime<Utc>>,
}

fn key_ok(k: &str) -> bool {
    (1..=64).contains(&k.len()) && k.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

fn gen_key() -> String {
    format!("t{}", new_id().simple())
}

fn check_due(v: Option<&str>) -> AppResult<Option<DateTime<Utc>>> {
    match v.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => DateTime::parse_from_rfc3339(s)
            .map(|t| Some(t.with_timezone(&Utc)))
            .map_err(|_| AppError::field("due_at", "必须是带时区的 RFC 3339 时间")),
    }
}

fn check_label(v: Option<&str>) -> AppResult<Option<String>> {
    match v.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => text_field("assignee_label", s, 1, 50).map(Some),
    }
}

fn check_desc(v: Option<&str>) -> AppResult<String> {
    text_field("description", v.unwrap_or(""), 0, 5000)
}

/// 证据链接：≤10 条，只允许 http/https，不含空白与控制字符，各 ≤2000 字符
fn check_evidence(v: &[String]) -> AppResult<Vec<String>> {
    if v.len() > MAX_EVIDENCE {
        return Err(AppError::field("evidence", "最多 10 条"));
    }
    v.iter()
        .map(|u| {
            let u = u.trim();
            let lower = u.to_ascii_lowercase();
            let scheme = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://"));
            if scheme.is_some_and(|rest| !rest.is_empty()) && u.len() <= 2000 && !u.chars().any(|c| c.is_whitespace() || c.is_control()) {
                Ok(u.to_string())
            } else {
                Err(AppError::field("evidence", "每条必须是 http:// 或 https:// 开头的链接"))
            }
        })
        .collect()
}

/// 校验并扁平化整棵树：深度 ≤ MAX_DEPTH、节点 ≤ MAX_NODES、key 唯一
fn flatten(input: &[TaskInput]) -> AppResult<Vec<Flat>> {
    fn walk(items: &[TaskInput], parent: Option<&str>, depth: usize, out: &mut Vec<Flat>, seen: &mut HashSet<String>) -> AppResult<()> {
        if depth > MAX_DEPTH && !items.is_empty() {
            return Err(AppError::field("tasks", &format!("层级不能超过 {MAX_DEPTH} 层")));
        }
        for (i, t) in items.iter().enumerate() {
            if out.len() >= MAX_NODES {
                return Err(AppError::field("tasks", &format!("任务节点不能超过 {MAX_NODES} 个")));
            }
            let key = match t.key.as_deref().map(str::trim) {
                Some(k) if key_ok(k) => k.to_string(),
                Some(_) => return Err(AppError::field("tasks", "key 只能是 1..64 位字母、数字、_ . -")),
                None => gen_key(),
            };
            if !seen.insert(key.clone()) {
                return Err(AppError::field("tasks", &format!("key 重复：{key}")));
            }
            out.push(Flat {
                key: key.clone(),
                parent_key: parent.map(str::to_string),
                position: i as i32,
                title: text_field("title", &t.title, 1, 200)?,
                description: check_desc(t.description.as_deref())?,
                assignee: t.assignee.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string),
                assignee_label: check_label(t.assignee_label.as_deref())?,
                due_at: check_due(t.due_at.as_deref())?,
            });
            if let Some(ch) = &t.children {
                walk(ch, Some(&key), depth + 1, out, seen)?;
            }
        }
        Ok(())
    }
    let mut out = vec![];
    walk(input, None, 1, &mut out, &mut HashSet::new())?;
    Ok(out)
}

/// user_id / 邮箱 / "me" → 组织成员 user_id；找不到 400（field 指明是哪个）
async fn resolve_members(db: &mut PgConnection, org_id: Uuid, me: Uuid, field: &str, refs: &[String]) -> AppResult<HashMap<String, Uuid>> {
    let mut out = HashMap::new();
    let mut ids = vec![];
    let mut emails = vec![];
    for r in refs {
        if r.eq_ignore_ascii_case("me") {
            out.insert(r.clone(), me);
        } else if let Ok(id) = Uuid::parse_str(r) {
            ids.push(id);
        } else {
            emails.push(r.to_lowercase());
        }
    }
    let rows: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT u.id, u.email FROM users u JOIN memberships m ON m.user_id = u.id AND m.org_id = $1
          WHERE u.id = ANY($2) OR u.email = ANY($3)",
    )
    .bind(org_id)
    .bind(&ids)
    .bind(&emails)
    .fetch_all(&mut *db)
    .await?;
    for r in refs {
        if out.contains_key(r) {
            continue;
        }
        let hit = rows.iter().find(|(id, email)| Uuid::parse_str(r).is_ok_and(|x| x == *id) || email.eq_ignore_ascii_case(r));
        match hit {
            Some((id, _)) => {
                out.insert(r.clone(), *id);
            }
            None => return Err(AppError::field(field, &format!("「{r}」不是本组织成员"))),
        }
    }
    Ok(out)
}

/// 替换页面评审人。群组须是本组织的组织级群组或本项目的项目群组
pub async fn set_reviewers(db: &mut PgConnection, org_id: Uuid, project_id: Uuid, page_id: Uuid, me: Uuid, r: &ReviewersInput) -> AppResult<()> {
    let users: Vec<String> = r.users.clone().unwrap_or_default().iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let mut groups = r.groups.clone().unwrap_or_default();
    groups.sort();
    groups.dedup();
    if users.len() + groups.len() > MAX_REVIEWERS {
        return Err(AppError::field("reviewers", "评审人（成员 + 群组）最多 50 个"));
    }
    let map = resolve_members(db, org_id, me, "reviewers", &users).await?;
    let mut uids: Vec<Uuid> = map.into_values().collect();
    uids.sort();
    uids.dedup();
    if !groups.is_empty() {
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM groups WHERE org_id = $1 AND id = ANY($2) AND (project_id IS NULL OR project_id = $3)")
            .bind(org_id)
            .bind(&groups)
            .bind(project_id)
            .fetch_one(&mut *db)
            .await?;
        if n as usize != groups.len() {
            return Err(AppError::field("reviewers", "群组不存在，或不是本组织的组织级群组 / 本项目的项目群组"));
        }
    }
    sqlx::query("DELETE FROM page_reviewers WHERE org_id = $1 AND page_id = $2").bind(org_id).bind(page_id).execute(&mut *db).await?;
    sqlx::query(
        "INSERT INTO page_reviewers (org_id, page_id, user_id, group_id)
         SELECT $1, $2, u, NULL FROM unnest($3::uuid[]) u UNION ALL SELECT $1, $2, NULL, g FROM unnest($4::uuid[]) g",
    )
    .bind(org_id)
    .bind(page_id)
    .bind(&uids)
    .bind(&groups)
    .execute(db)
    .await?;
    Ok(())
}

/// 校验任务树输入（发布/重发前，开事务之前调用）
pub fn parse_tree(input: &[TaskInput]) -> AppResult<Vec<Flat>> {
    flatten(input)
}

// ---------------------------------------------------------------- 写入（重发合并）

#[derive(FromRow)]
struct Existing {
    id: Uuid,
    key: String,
    parent_id: Option<Uuid>,
    position: i32,
    title: String,
    description: String,
    assignee_user_id: Option<Uuid>,
    assignee_label: Option<String>,
    due_at: Option<DateTime<Utc>>,
    deleted: bool,
}

/// 按 key 合并整棵树（创建时 existing 为空）：新 key 插入（todo），已有 key 更新字段与位置（状态保留，软删的恢复），
/// 不在输入里的未删节点软删。所有变化写 task_events。调用方已锁 pages 行
pub async fn sync_tree(db: &mut PgConnection, org_id: Uuid, page_id: Uuid, actor: (Uuid, Option<Uuid>), flats: Vec<Flat>) -> AppResult<bool> {
    let refs: Vec<String> = flats.iter().filter_map(|f| f.assignee.clone()).collect::<HashSet<_>>().into_iter().collect();
    let who = resolve_members(db, org_id, actor.0, "tasks", &refs).await?;
    let existing: Vec<Existing> = sqlx::query_as(
        "SELECT id, key, parent_id, position, title, description, assignee_user_id, assignee_label, due_at, deleted_at IS NOT NULL AS deleted
           FROM tasks WHERE org_id = $1 AND page_id = $2",
    )
    .bind(org_id)
    .bind(page_id)
    .fetch_all(&mut *db)
    .await?;
    let by_key: HashMap<&str, &Existing> = existing.iter().map(|e| (e.key.as_str(), e)).collect();
    let mut ids: HashMap<String, Uuid> = existing.iter().map(|e| (e.key.clone(), e.id)).collect();
    for f in &flats {
        ids.entry(f.key.clone()).or_insert_with(new_id);
    }
    // 批量写入的列（同一顺序）
    #[derive(Default)]
    struct Cols {
        id: Vec<Uuid>,
        key: Vec<String>,
        parent: Vec<Option<Uuid>>,
        pos: Vec<i32>,
        title: Vec<String>,
        desc: Vec<String>,
        assignee: Vec<Option<Uuid>>,
        label: Vec<Option<String>>,
        due: Vec<Option<DateTime<Utc>>>,
    }
    let (mut ins, mut upd) = (Cols::default(), Cols::default());
    // 事件：(task_id, action, meta)
    let mut events: Vec<(Uuid, &str, Option<String>)> = vec![];
    let mut keep = HashSet::new();
    for f in &flats {
        let id = ids[&f.key];
        keep.insert(id);
        let parent = f.parent_key.as_ref().map(|k| ids[k]);
        let assignee = f.assignee.as_ref().map(|r| who[r]);
        let cols = match by_key.get(f.key.as_str()) {
            None => {
                events.push((id, "created", None));
                &mut ins
            }
            Some(e) => {
                let mut changed = vec![];
                for (name, diff) in [
                    ("title", e.title != f.title),
                    ("description", e.description != f.description),
                    ("assignee", e.assignee_user_id != assignee || e.assignee_label != f.assignee_label),
                    ("due_at", e.due_at != f.due_at),
                    ("parent", e.parent_id != parent),
                    ("position", e.position != f.position),
                ] {
                    if diff {
                        changed.push(name);
                    }
                }
                if e.deleted {
                    events.push((id, "restored", None));
                }
                if changed.is_empty() && !e.deleted {
                    continue;
                }
                if !changed.is_empty() {
                    events.push((id, "edited", Some(json!({ "fields": changed, "via": "republish" }).to_string())));
                }
                &mut upd
            }
        };
        cols.id.push(id);
        cols.key.push(f.key.clone());
        cols.parent.push(parent);
        cols.pos.push(f.position);
        cols.title.push(f.title.clone());
        cols.desc.push(f.description.clone());
        cols.assignee.push(assignee);
        cols.label.push(f.assignee_label.clone());
        cols.due.push(f.due_at);
    }
    let gone: Vec<Uuid> = existing.iter().filter(|e| !e.deleted && !keep.contains(&e.id)).map(|e| e.id).collect();
    for g in &gone {
        events.push((*g, "deleted", Some(json!({ "via": "republish" }).to_string())));
    }
    // 外键在语句结束时检查：同一条 INSERT 里父子顺序无关
    if !ins.id.is_empty() {
        sqlx::query(
            "INSERT INTO tasks (id, org_id, page_id, key, parent_id, position, title, description, assignee_user_id, assignee_label, due_at, created_by)
             SELECT u.id, $1, $2, u.key, u.parent, u.pos, u.title, u.descr, u.assignee, u.label, u.due, $12
               FROM unnest($3::uuid[], $4::text[], $5::uuid[], $6::int[], $7::text[], $8::text[], $9::uuid[], $10::text[], $11::timestamptz[])
                    AS u(id, key, parent, pos, title, descr, assignee, label, due)",
        )
        .bind(org_id)
        .bind(page_id)
        .bind(&ins.id)
        .bind(&ins.key)
        .bind(&ins.parent)
        .bind(&ins.pos)
        .bind(&ins.title)
        .bind(&ins.desc)
        .bind(&ins.assignee)
        .bind(&ins.label)
        .bind(&ins.due)
        .bind(actor.0)
        .execute(&mut *db)
        .await?;
    }
    if !upd.id.is_empty() {
        sqlx::query(
            "UPDATE tasks t SET parent_id = u.parent, position = u.pos, title = u.title, description = u.descr, assignee_user_id = u.assignee,
                    assignee_label = u.label, due_at = u.due, deleted_at = NULL, updated_at = now()
               FROM unnest($3::uuid[], $4::uuid[], $5::int[], $6::text[], $7::text[], $8::uuid[], $9::text[], $10::timestamptz[])
                    AS u(id, parent, pos, title, descr, assignee, label, due)
              WHERE t.org_id = $1 AND t.page_id = $2 AND t.id = u.id",
        )
        .bind(org_id)
        .bind(page_id)
        .bind(&upd.id)
        .bind(&upd.parent)
        .bind(&upd.pos)
        .bind(&upd.title)
        .bind(&upd.desc)
        .bind(&upd.assignee)
        .bind(&upd.label)
        .bind(&upd.due)
        .execute(&mut *db)
        .await?;
    }
    if !gone.is_empty() {
        sqlx::query("UPDATE tasks SET deleted_at = now(), updated_at = now() WHERE org_id = $1 AND page_id = $2 AND id = ANY($3)")
            .bind(org_id)
            .bind(page_id)
            .bind(&gone)
            .execute(&mut *db)
            .await?;
    }
    if !events.is_empty() {
        let ev_ids: Vec<Uuid> = events.iter().map(|_| new_id()).collect();
        let tids: Vec<Uuid> = events.iter().map(|e| e.0).collect();
        let actions: Vec<&str> = events.iter().map(|e| e.1).collect();
        let metas: Vec<Option<String>> = events.iter().map(|e| e.2.clone()).collect();
        sqlx::query(
            "INSERT INTO task_events (id, org_id, page_id, task_id, actor_user_id, actor_pat_id, action, meta)
             SELECT u.id, $1, $2, u.tid, $3, $4, u.action, u.meta::jsonb FROM unnest($5::uuid[], $6::uuid[], $7::text[], $8::text[]) AS u(id, tid, action, meta)",
        )
        .bind(org_id)
        .bind(page_id)
        .bind(actor.0)
        .bind(actor.1)
        .bind(&ev_ids)
        .bind(&tids)
        .bind(&actions)
        .bind(&metas)
        .execute(&mut *db)
        .await?;
    }
    Ok(!events.is_empty())
}

// ---------------------------------------------------------------- 读取

/// SQL 布尔表达式：uid 是否该任务页的评审人（page_reviewers 里的成员或群组成员；一页没设评审人时 = 项目 admin）。
/// role 为调用者有效项目角色的表达式
pub fn reviewer_sql(org: &str, page: &str, uid: &str, role: &str) -> String {
    format!(
        "({uid}::uuid IS NOT NULL AND (
            EXISTS (SELECT 1 FROM page_reviewers rv WHERE rv.org_id = {org} AND rv.page_id = {page}
                      AND (rv.user_id = {uid} OR EXISTS (SELECT 1 FROM group_members rg
                                                          WHERE rg.org_id = rv.org_id AND rg.group_id = rv.group_id AND rg.user_id = {uid})))
            OR ({role} = 'admin' AND NOT EXISTS (SELECT 1 FROM page_reviewers rv WHERE rv.org_id = {org} AND rv.page_id = {page}))))"
    )
}

/// 列表卡片的 task_stats 列（task_tree 页面才算）。x 为带 id/org_id/page_type/role 的页面别名，$1 = 调用者
pub fn task_stats_sql(x: &str) -> String {
    format!(
        "CASE WHEN {x}.page_type = 'task_tree' THEN (
           SELECT json_build_object(
             'total', count(*), 'done', count(*) FILTER (WHERE ts.status = 'done'),
             'in_review', count(*) FILTER (WHERE ts.status = 'in_review'),
             'my_todo', count(*) FILTER (WHERE ts.assignee_user_id = $1 AND ts.status IN ('todo', 'in_progress')),
             'my_review', CASE WHEN {} THEN count(*) FILTER (WHERE ts.status = 'in_review' AND ts.submitted_by IS DISTINCT FROM $1) ELSE 0 END)
             FROM tasks ts WHERE ts.org_id = {x}.org_id AND ts.page_id = {x}.id AND ts.deleted_at IS NULL) END AS task_stats",
        reviewer_sql(&format!("{x}.org_id"), &format!("{x}.id"), "$1", &format!("{x}.role"))
    )
}

/// 调用者对任务页的身份
pub struct Who {
    pub org_id: Uuid,
    pub page_id: Uuid,
    pub user_id: Option<Uuid>,
    pub pat_id: Option<Uuid>,
    /// 项目管理员或页面发布者：可改任意节点、加根节点
    pub manage: bool,
    pub reviewer: bool,
    /// 页面已关闭：任务一律不能改（勾选、评审、加节点）
    pub closed: bool,
}

pub async fn who(st: &AppState, c: &Caller, a: &PageAccess) -> AppResult<Who> {
    let p = a.page();
    // 临时链接访问一律只读
    let user = a.user_id().filter(|_| a.share().is_none());
    let (publisher, reviewer): (bool, bool) = sqlx::query_as(&format!(
        "SELECT COALESCE(p.created_by = $3, false), {} FROM pages p WHERE p.org_id = $1 AND p.id = $2",
        reviewer_sql("p.org_id", "p.id", "$3", "$4::text")
    ))
    .bind(p.org_id)
    .bind(p.id)
    .bind(user)
    .bind(&p.role)
    .fetch_one(&st.db)
    .await?;
    Ok(Who {
        org_id: p.org_id,
        page_id: p.id,
        user_id: user,
        pat_id: c.p.pat().map(|x| x.id),
        manage: user.is_some() && (publisher || p.role.as_deref() == Some("admin")),
        reviewer,
        closed: p.closed_at.is_some(),
    })
}

#[derive(FromRow)]
struct TaskRow {
    id: Uuid,
    key: String,
    parent_id: Option<Uuid>,
    position: i32,
    title: String,
    description: String,
    status: String,
    assignee_user_id: Option<Uuid>,
    assignee_name: Option<String>,
    assignee_label: Option<String>,
    due_at: Option<DateTime<Utc>>,
    submit_note: Option<String>,
    evidence: Option<Value>,
    submitted_by: Option<Uuid>,
    submitter_name: Option<String>,
    submitted_at: Option<DateTime<Utc>>,
    reject_reason: Option<String>,
    reviewed_by: Option<Uuid>,
    reviewer_name: Option<String>,
    reviewed_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl TaskRow {
    fn can_edit(&self, w: &Who) -> bool {
        !w.closed && (w.manage || (w.user_id.is_some() && self.assignee_user_id == w.user_id))
    }
    fn can_review(&self, w: &Who) -> bool {
        !w.closed && w.reviewer && self.status == "in_review" && self.submitted_by != w.user_id
    }
    fn json(&self, w: &Who) -> Value {
        let assignee = (self.assignee_user_id.is_some() || self.assignee_label.is_some()).then(|| {
            json!({ "user": self.assignee_user_id.zip(self.assignee_name.as_deref()).map(|(id, n)| brief(id, n)), "label": self.assignee_label })
        });
        let user = |id: Option<Uuid>, n: &Option<String>| id.zip(n.as_deref()).map(|(id, n)| brief(id, n));
        json!({
            "id": self.id, "key": self.key, "parent_id": self.parent_id, "position": self.position,
            "title": self.title, "description": self.description, "status": self.status,
            "assignee": assignee, "due_at": ts_opt(&self.due_at),
            "submit_note": self.submit_note, "evidence": self.evidence.clone().unwrap_or_else(|| json!([])),
            "submitted_by": user(self.submitted_by, &self.submitter_name), "submitted_at": ts_opt(&self.submitted_at),
            "reject_reason": self.reject_reason,
            "reviewed_by": user(self.reviewed_by, &self.reviewer_name), "reviewed_at": ts_opt(&self.reviewed_at),
            "created_at": ts(&self.created_at), "updated_at": ts(&self.updated_at),
            "can_edit": self.can_edit(w), "can_review": self.can_review(w),
        })
    }
}

async fn load_tasks(db: &mut PgConnection, org_id: Uuid, page_id: Uuid, only: Option<Uuid>) -> AppResult<Vec<TaskRow>> {
    Ok(sqlx::query_as(
        "SELECT t.id, t.key, t.parent_id, t.position, t.title, t.description, t.status, t.assignee_user_id, au.display_name AS assignee_name,
                t.assignee_label, t.due_at, t.submit_note, t.evidence, t.submitted_by, su.display_name AS submitter_name, t.submitted_at,
                t.reject_reason, t.reviewed_by, ru.display_name AS reviewer_name, t.reviewed_at, t.created_at, t.updated_at
           FROM tasks t
           LEFT JOIN users au ON au.id = t.assignee_user_id
           LEFT JOIN users su ON su.id = t.submitted_by
           LEFT JOIN users ru ON ru.id = t.reviewed_by
          WHERE t.org_id = $1 AND t.page_id = $2 AND t.deleted_at IS NULL AND ($3::uuid IS NULL OR t.id = $3)
          ORDER BY t.position, t.key",
    )
    .bind(org_id)
    .bind(page_id)
    .bind(only)
    .fetch_all(db)
    .await?)
}

/// 任务树 JSON（view 与 GET /pages/{id}/tasks 共用）。filter：mine / review / rejected / open
pub async fn tree_json(st: &AppState, w: &Who, filter: Option<&str>) -> AppResult<Value> {
    let mut conn = st.db.acquire().await?;
    let rows = load_tasks(&mut conn, w.org_id, w.page_id, None).await?;
    let (total, done, in_review) = (
        rows.len(),
        rows.iter().filter(|t| t.status == "done").count(),
        rows.iter().filter(|t| t.status == "in_review").count(),
    );
    let keep = |t: &TaskRow| match filter {
        Some("mine") => w.user_id.is_some() && t.assignee_user_id == w.user_id,
        Some("review") => t.can_review(w),
        Some("rejected") => t.reject_reason.is_some() && t.status == "in_progress",
        Some("open") => t.status != "done",
        _ => true,
    };
    let tasks: Vec<Value> = rows.iter().filter(|t| keep(t)).map(|t| t.json(w)).collect();
    let users: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT u.id, u.display_name FROM page_reviewers r JOIN users u ON u.id = r.user_id WHERE r.org_id = $1 AND r.page_id = $2 ORDER BY u.display_name",
    )
    .bind(w.org_id)
    .bind(w.page_id)
    .fetch_all(&mut *conn)
    .await?;
    let groups: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT g.id, g.name FROM page_reviewers r JOIN groups g ON g.id = r.group_id WHERE r.org_id = $1 AND r.page_id = $2 ORDER BY g.name",
    )
    .bind(w.org_id)
    .bind(w.page_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(json!({
        "tasks": tasks,
        "reviewers": {
            "users": users.iter().map(|(id, n)| brief(*id, n)).collect::<Vec<_>>(),
            "groups": groups.iter().map(|(id, n)| json!({ "id": id, "name": n })).collect::<Vec<_>>(),
            "fallback": (users.is_empty() && groups.is_empty()).then_some("project_admins"),
        },
        "progress": { "total": total, "done": done, "in_review": in_review },
        "me": { "user_id": w.user_id, "can_manage": w.manage, "can_review": w.reviewer },
        "limits": { "max_depth": MAX_DEPTH, "max_nodes": MAX_NODES },
    }))
}

fn not_task_page() -> AppError {
    AppError::conflict("not_task_page", "该页面不是任务树页面")
}

/// 按页面定位：查看权限（统一 404），PAT 时再检查 scope
async fn page_ctx(st: &AppState, c: &Caller, page_id: Uuid, allow: crate::authz::Allow) -> AppResult<Who> {
    let a = page_access(&st.db, &st.cfg, c, Target::Page(page_id)).await?;
    check_allow(c, allow)?;
    if a.page().page_type != "task_tree" {
        return Err(not_task_page());
    }
    who(st, c, &a).await
}

/// 按任务定位：任务 → 页面 → 查看权限；任务不存在/已删/看不到一律 404
async fn task_ctx(st: &AppState, c: &Caller, task_id: Uuid, allow: crate::authz::Allow) -> AppResult<Who> {
    let row: Option<(Uuid, Uuid)> =
        sqlx::query_as("SELECT org_id, page_id FROM tasks WHERE id = $1 AND deleted_at IS NULL").bind(task_id).fetch_optional(&st.db).await?;
    let (org_id, page_id) = row.ok_or_else(AppError::not_found)?;
    let w = page_ctx(st, c, page_id, allow).await?;
    if w.org_id != org_id {
        return Err(AppError::not_found());
    }
    Ok(w)
}

#[derive(Deserialize)]
pub struct TasksQuery {
    filter: Option<String>,
}

/// GET /pages/{id}/tasks
pub async fn list_tasks(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, Q(q): Q<TasksQuery>) -> J {
    let w = page_ctx(&st, &c, id, ANY_SCOPE).await?;
    let filter = q.filter.as_deref().filter(|f| !f.is_empty());
    if filter.is_some_and(|f| !matches!(f, "mine" | "review" | "rejected" | "open")) {
        return Err(AppError::field("filter", "取值必须是 mine/review/rejected/open"));
    }
    Ok(Json(tree_json(&st, &w, filter).await?))
}

/// GET /tasks/{id}/events：节点历史（时间正序）
pub async fn task_events(State(st): State<AppState>, c: Caller, P(id): P<Uuid>) -> J {
    let w = task_ctx(&st, &c, id, ANY_SCOPE).await?;
    #[allow(clippy::type_complexity)]
    let rows: Vec<(Uuid, String, Option<String>, Option<String>, Option<String>, Option<Value>, Option<Value>, DateTime<Utc>, Option<Uuid>, Option<String>, bool)> =
        sqlx::query_as(
            "SELECT e.id, e.action, e.from_status, e.to_status, e.note, e.evidence, e.meta, e.created_at, e.actor_user_id, u.display_name,
                    e.actor_pat_id IS NOT NULL
               FROM task_events e LEFT JOIN users u ON u.id = e.actor_user_id
              WHERE e.org_id = $1 AND e.task_id = $2 ORDER BY e.created_at, e.id",
        )
        .bind(w.org_id)
        .bind(id)
        .fetch_all(&st.db)
        .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(eid, action, from, to, note, evidence, meta, at, uid, name, via_pat)| {
            json!({
                "id": eid, "action": action, "from_status": from, "to_status": to, "note": note,
                "evidence": evidence, "meta": meta, "at": ts(&at),
                "actor": uid.zip(name).map(|(id, n)| brief(id, &n)), "via_token": via_pat,
            })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

// ---------------------------------------------------------------- 写入（单个节点）

async fn event(
    db: &mut PgConnection,
    w: &Who,
    task_id: Uuid,
    action: &str,
    from_to: Option<(&str, &str)>,
    note: Option<&str>,
    evidence: Option<&[String]>,
    meta: Option<Value>,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO task_events (id, org_id, page_id, task_id, actor_user_id, actor_pat_id, action, from_status, to_status, note, evidence, meta)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
    )
    .bind(new_id())
    .bind(w.org_id)
    .bind(w.page_id)
    .bind(task_id)
    .bind(w.user_id)
    .bind(w.pat_id)
    .bind(action)
    .bind(from_to.map(|x| x.0))
    .bind(from_to.map(|x| x.1))
    .bind(note)
    .bind(evidence.map(|e| json!(e)))
    .bind(meta)
    .execute(db)
    .await?;
    Ok(())
}

async fn task_out(st: &AppState, w: &Who, id: Uuid) -> J {
    let mut conn = st.db.acquire().await?;
    let row = load_tasks(&mut conn, w.org_id, w.page_id, Some(id)).await?.pop().ok_or_else(AppError::not_found)?;
    Ok(Json(row.json(w)))
}

fn locked_parent() -> AppError {
    AppError::conflict("task_locked", "父任务待评审或已完成，不能再加子任务")
}

/// 新节点的层级（parent 的层级 + 1）
async fn depth_of(db: &mut PgConnection, parent: Uuid) -> AppResult<usize> {
    let d: i32 = sqlx::query_scalar(
        "WITH RECURSIVE up AS (SELECT id, parent_id, 1 AS d FROM tasks WHERE id = $1
                               UNION ALL SELECT t.id, t.parent_id, up.d + 1 FROM tasks t JOIN up ON t.id = up.parent_id WHERE up.d < 20)
         SELECT max(d) FROM up",
    )
    .bind(parent)
    .fetch_one(db)
    .await?;
    Ok(d as usize + 1)
}

#[derive(Deserialize)]
pub struct AddReq {
    parent_id: Option<Uuid>,
    key: Option<String>,
    title: String,
    description: Option<String>,
    assignee: Option<String>,
    assignee_label: Option<String>,
    due_at: Option<String>,
}

/// POST /pages/{id}/tasks：加节点。根节点需管理权（项目 admin/发布者），子节点需能编辑父节点
pub async fn add_task(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, JsonBody(r): JsonBody<AddReq>) -> AppResult<(StatusCode, Json<Value>)> {
    let w = page_ctx(&st, &c, id, PUBLISH).await?;
    if w.closed {
        return Err(page_closed());
    }
    let uid = w.user_id.ok_or_else(AppError::forbidden)?;
    let title = text_field("title", &r.title, 1, 200)?;
    let description = check_desc(r.description.as_deref())?;
    let label = check_label(r.assignee_label.as_deref())?;
    let due = check_due(r.due_at.as_deref())?;
    let key = match r.key.as_deref().map(str::trim) {
        Some(k) if key_ok(k) => k.to_string(),
        Some(_) => return Err(AppError::field("key", "只能是 1..64 位字母、数字、_ . -")),
        None => gen_key(),
    };
    let mut tx = st.db.begin().await?;
    // 锁页面行：与重发合并、并发加节点串行（节点数上限）
    sqlx::query("SELECT 1 FROM pages WHERE org_id = $1 AND id = $2 FOR UPDATE").bind(w.org_id).bind(w.page_id).execute(&mut *tx).await?;
    if let Some(pid) = r.parent_id {
        let parent: Option<(String, Option<Uuid>)> =
            sqlx::query_as("SELECT status, assignee_user_id FROM tasks WHERE org_id = $1 AND page_id = $2 AND id = $3 AND deleted_at IS NULL FOR UPDATE")
                .bind(w.org_id)
                .bind(w.page_id)
                .bind(pid)
                .fetch_optional(&mut *tx)
                .await?;
        let (status, assignee) = parent.ok_or_else(|| AppError::field("parent_id", "父任务不存在"))?;
        if !w.manage && assignee != Some(uid) {
            return Err(AppError::forbidden());
        }
        if matches!(status.as_str(), "in_review" | "done") {
            return Err(locked_parent());
        }
        if depth_of(&mut tx, pid).await? > MAX_DEPTH {
            return Err(AppError::field("parent_id", &format!("层级不能超过 {MAX_DEPTH} 层")));
        }
    } else if !w.manage {
        return Err(AppError::forbidden());
    }
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM tasks WHERE org_id = $1 AND page_id = $2 AND deleted_at IS NULL")
        .bind(w.org_id)
        .bind(w.page_id)
        .fetch_one(&mut *tx)
        .await?;
    if n as usize >= MAX_NODES {
        return Err(AppError::field("tasks", &format!("任务节点不能超过 {MAX_NODES} 个")));
    }
    let assignee = match r.assignee.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(a) => Some(resolve_members(&mut tx, w.org_id, uid, "assignee", &[a.to_string()]).await?[a]),
        None => None,
    };
    let tid = new_id();
    sqlx::query(
        "INSERT INTO tasks (id, org_id, page_id, key, parent_id, position, title, description, assignee_user_id, assignee_label, due_at, created_by)
         VALUES ($1, $2, $3, $4, $5,
                 (SELECT COALESCE(max(position) + 1, 0) FROM tasks WHERE page_id = $3 AND parent_id IS NOT DISTINCT FROM $5 AND deleted_at IS NULL),
                 $6, $7, $8, $9, $10, $11)",
    )
    .bind(tid)
    .bind(w.org_id)
    .bind(w.page_id)
    .bind(&key)
    .bind(r.parent_id)
    .bind(&title)
    .bind(&description)
    .bind(assignee)
    .bind(&label)
    .bind(due)
    .bind(uid)
    .execute(&mut *tx)
    .await
    .map_err(|e| match crate::error::unique_violation(&e) {
        Some("tasks_page_key_key") => AppError::conflict("task_key_taken", "该页面已有同 key 的任务（含已删除的）"),
        _ => e.into(),
    })?;
    event(&mut tx, &w, tid, "created", None, None, None, None).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, task_out(&st, &w, tid).await?))
}

/// 区分「没传」与「传了 null」
fn nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

#[derive(Deserialize)]
pub struct UpdateReq {
    title: Option<String>,
    description: Option<String>,
    /// 传 null 清除负责人
    #[serde(default, deserialize_with = "nullable")]
    assignee: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    assignee_label: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    due_at: Option<Option<String>>,
    /// todo / in_progress / in_review（done 只能由评审通过得到）
    status: Option<String>,
    /// 状态变化的说明；提交评审时即完成说明
    note: Option<String>,
    /// 提交评审时的证据链接
    evidence: Option<Vec<String>>,
    /// 同级内上移 / 下移
    #[serde(rename = "move")]
    mv: Option<String>,
}

#[derive(FromRow)]
struct Locked {
    status: String,
    parent_id: Option<Uuid>,
    position: i32,
    title: String,
    description: String,
    assignee_user_id: Option<Uuid>,
    assignee_label: Option<String>,
    due_at: Option<DateTime<Utc>>,
}

/// PATCH /tasks/{id}：改字段、改状态（含提交评审）、上下移动。负责人 / 项目管理员 / 页面发布者
pub async fn update_task(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, JsonBody(r): JsonBody<UpdateReq>) -> J {
    let w = task_ctx(&st, &c, id, PUBLISH).await?;
    if w.closed {
        return Err(page_closed());
    }
    let uid = w.user_id.ok_or_else(AppError::forbidden)?;
    super::require_any(&[
        r.title.is_some(),
        r.description.is_some(),
        r.assignee.is_some(),
        r.assignee_label.is_some(),
        r.due_at.is_some(),
        r.status.is_some(),
        r.mv.is_some(),
        r.note.is_some(),
        r.evidence.is_some(),
    ])?;
    let title = r.title.as_deref().map(|t| text_field("title", t, 1, 200)).transpose()?;
    let description = r.description.as_deref().map(|d| check_desc(Some(d))).transpose()?;
    let label = r.assignee_label.as_ref().map(|l| check_label(l.as_deref())).transpose()?;
    let due = r.due_at.as_ref().map(|d| check_due(d.as_deref())).transpose()?;
    let note = r.note.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(|n| text_field("note", n, 1, 2000)).transpose()?;
    let evidence = r.evidence.as_deref().map(check_evidence).transpose()?;
    let to = r.status.as_deref();
    match to {
        None if note.is_some() || evidence.is_some() => return Err(AppError::field("note", "note / evidence 只能和 status 一起提交")),
        Some("done") => return Err(AppError::field("status", "已完成需经评审：先改为 in_review（待评审），由评审人通过")),
        Some("todo" | "in_progress" | "in_review") | None => {}
        Some(_) => return Err(AppError::field("status", "取值必须是 todo/in_progress/in_review")),
    }
    if evidence.is_some() && to != Some("in_review") {
        return Err(AppError::field("evidence", "只能在提交评审（status=in_review）时附证据"));
    }
    if r.mv.as_deref().is_some_and(|m| !matches!(m, "up" | "down")) {
        return Err(AppError::field("move", "取值必须是 up/down"));
    }
    let mut tx = st.db.begin().await?;
    let t: Locked = sqlx::query_as(
        "SELECT status, parent_id, position, title, description, assignee_user_id, assignee_label, due_at
           FROM tasks WHERE org_id = $1 AND page_id = $2 AND id = $3 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(w.org_id)
    .bind(w.page_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(AppError::not_found)?;
    if !w.manage && t.assignee_user_id != Some(uid) {
        return Err(AppError::forbidden());
    }
    // ---- 字段
    let assignee = match &r.assignee {
        None => t.assignee_user_id,
        Some(None) => None,
        Some(Some(a)) if a.trim().is_empty() => None,
        Some(Some(a)) => Some(resolve_members(&mut tx, w.org_id, uid, "assignee", &[a.trim().to_string()]).await?[a.trim()]),
    };
    let new_title = title.unwrap_or_else(|| t.title.clone());
    let new_desc = description.unwrap_or_else(|| t.description.clone());
    let new_label = label.unwrap_or_else(|| t.assignee_label.clone());
    let new_due = due.unwrap_or(t.due_at);
    let mut changed = vec![];
    for (name, diff) in [
        ("title", new_title != t.title),
        ("description", new_desc != t.description),
        ("assignee", assignee != t.assignee_user_id || new_label != t.assignee_label),
        ("due_at", new_due != t.due_at),
    ] {
        if diff {
            changed.push(name);
        }
    }
    if !changed.is_empty() {
        sqlx::query(
            "UPDATE tasks SET title = $3, description = $4, assignee_user_id = $5, assignee_label = $6, due_at = $7, updated_at = now()
              WHERE org_id = $1 AND id = $2",
        )
        .bind(w.org_id)
        .bind(id)
        .bind(&new_title)
        .bind(&new_desc)
        .bind(assignee)
        .bind(&new_label)
        .bind(new_due)
        .execute(&mut *tx)
        .await?;
        event(&mut tx, &w, id, "edited", None, None, None, Some(json!({ "fields": changed }))).await?;
    }
    // ---- 移动：与相邻兄弟交换 position（同级 position 互不相同：重发按序号写，新增取 max+1）
    if let Some(mv) = r.mv.as_deref() {
        let sql = if mv == "up" {
            "SELECT id, position FROM tasks WHERE org_id = $1 AND page_id = $2 AND parent_id IS NOT DISTINCT FROM $3 AND deleted_at IS NULL
               AND position < $4 ORDER BY position DESC LIMIT 1 FOR UPDATE"
        } else {
            "SELECT id, position FROM tasks WHERE org_id = $1 AND page_id = $2 AND parent_id IS NOT DISTINCT FROM $3 AND deleted_at IS NULL
               AND position > $4 ORDER BY position LIMIT 1 FOR UPDATE"
        };
        let sib: Option<(Uuid, i32)> = sqlx::query_as(sql).bind(w.org_id).bind(w.page_id).bind(t.parent_id).bind(t.position).fetch_optional(&mut *tx).await?;
        if let Some((sid, spos)) = sib {
            sqlx::query("UPDATE tasks SET position = CASE WHEN id = $2 THEN $3 ELSE $5 END, updated_at = now() WHERE org_id = $1 AND id IN ($2, $4)")
                .bind(w.org_id)
                .bind(id)
                .bind(spos)
                .bind(sid)
                .bind(t.position)
                .execute(&mut *tx)
                .await?;
            event(&mut tx, &w, id, "moved", None, None, None, Some(json!({ "direction": mv }))).await?;
        }
    }
    // ---- 状态
    if let Some(to) = to.filter(|to| *to != t.status) {
        let from = t.status.as_str();
        let action = match (from, to) {
            ("todo", "in_progress") => "started",
            ("in_progress", "todo") => "reverted",
            ("todo" | "in_progress", "in_review") => "submitted",
            ("in_review", _) => return Err(AppError::conflict("task_in_review", "任务待评审中，只能由评审人通过或驳回")),
            ("done", _) => return Err(AppError::conflict("task_done", "任务已完成，不能再改状态")),
            _ => return Err(AppError::conflict("invalid_transition", "不允许的状态变化")),
        };
        if action == "submitted" {
            let open: i64 = sqlx::query_scalar("SELECT count(*) FROM tasks WHERE org_id = $1 AND parent_id = $2 AND deleted_at IS NULL AND status <> 'done'")
                .bind(w.org_id)
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
            if open > 0 {
                return Err(AppError::conflict("children_not_done", &format!("还有 {open} 个子任务未完成，全部完成后才能提交评审")));
            }
            sqlx::query(
                "UPDATE tasks SET status = 'in_review', submit_note = $3, evidence = $4, submitted_by = $5, submitted_at = now(),
                        reject_reason = NULL, updated_at = now() WHERE org_id = $1 AND id = $2",
            )
            .bind(w.org_id)
            .bind(id)
            .bind(&note)
            .bind(evidence.as_ref().map(|e| json!(e)))
            .bind(uid)
            .execute(&mut *tx)
            .await?;
        } else {
            sqlx::query("UPDATE tasks SET status = $3, updated_at = now() WHERE org_id = $1 AND id = $2")
                .bind(w.org_id)
                .bind(id)
                .bind(to)
                .execute(&mut *tx)
                .await?;
        }
        event(&mut tx, &w, id, action, Some((from, to)), note.as_deref(), evidence.as_deref(), None).await?;
    }
    tx.commit().await?;
    task_out(&st, &w, id).await
}

#[derive(Deserialize)]
pub struct ReviewReq {
    /// approve / reject
    decision: String,
    /// 评审意见；驳回时必填
    note: Option<String>,
}

/// POST /tasks/{id}/review：评审人通过 → done；驳回 → in_progress（必须写理由）。不能评审自己提交的任务
pub async fn review_task(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, JsonBody(r): JsonBody<ReviewReq>) -> J {
    let w = task_ctx(&st, &c, id, PUBLISH).await?;
    if w.closed {
        return Err(page_closed());
    }
    let uid = w.user_id.ok_or_else(AppError::forbidden)?;
    let note = r.note.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(|n| text_field("note", n, 1, 2000)).transpose()?;
    let (to, action) = match r.decision.as_str() {
        "approve" => ("done", "approved"),
        "reject" if note.is_none() => return Err(AppError::field("note", "驳回必须填写理由")),
        "reject" => ("in_progress", "rejected"),
        _ => return Err(AppError::field("decision", "取值必须是 approve/reject")),
    };
    if !w.reviewer {
        return Err(AppError::new(StatusCode::FORBIDDEN, "not_reviewer", "只有该任务页的评审人才能评审"));
    }
    let mut tx = st.db.begin().await?;
    let (status, submitted_by): (String, Option<Uuid>) =
        sqlx::query_as("SELECT status, submitted_by FROM tasks WHERE org_id = $1 AND page_id = $2 AND id = $3 AND deleted_at IS NULL FOR UPDATE")
            .bind(w.org_id)
            .bind(w.page_id)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(AppError::not_found)?;
    if status != "in_review" {
        return Err(AppError::conflict("task_not_in_review", "任务不在待评审状态"));
    }
    if submitted_by == Some(uid) {
        return Err(AppError::new(StatusCode::FORBIDDEN, "self_review", "不能评审自己提交完成的任务，请由其他评审人评审"));
    }
    sqlx::query(
        "UPDATE tasks SET status = $3, reviewed_by = $4, reviewed_at = now(), reject_reason = CASE WHEN $3 = 'in_progress' THEN $5 END, updated_at = now()
          WHERE org_id = $1 AND id = $2",
    )
    .bind(w.org_id)
    .bind(id)
    .bind(to)
    .bind(uid)
    .bind(&note)
    .execute(&mut *tx)
    .await?;
    event(&mut tx, &w, id, action, Some(("in_review", to)), note.as_deref(), None, None).await?;
    tx.commit().await?;
    task_out(&st, &w, id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(title: &str, children: Vec<TaskInput>) -> TaskInput {
        TaskInput { key: None, title: title.into(), description: None, assignee: None, assignee_label: None, due_at: None, children: Some(children) }
    }

    #[test]
    fn flatten_limits() {
        // 6 层可以，7 层拒绝
        let mut t = node("6", vec![]);
        for i in (1..6).rev() {
            t = node(&i.to_string(), vec![t]);
        }
        let f = flatten(std::slice::from_ref(&t)).unwrap();
        assert_eq!(f.len(), 6);
        assert_eq!(f[1].parent_key.as_deref(), Some(f[0].key.as_str()));
        assert!(flatten(&[node("0", vec![t])]).is_err());
        // 节点数上限
        let many: Vec<TaskInput> = (0..=MAX_NODES).map(|i| node(&i.to_string(), vec![])).collect();
        assert!(flatten(&many).is_err());
        assert!(flatten(&many[..MAX_NODES]).is_ok());
        // key 重复 / 非法
        let mut a = node("a", vec![]);
        a.key = Some("k".into());
        assert!(flatten(&[a.clone(), a.clone()]).is_err());
        a.key = Some("坏 key".into());
        assert!(flatten(&[a]).is_err());
    }

    #[test]
    fn evidence_only_http() {
        assert!(check_evidence(&["https://ci.example.com/run/1".into(), "HTTP://x.y".into()]).is_ok());
        for bad in ["javascript:alert(1)", "https://", "ftp://x", "https://a b", "data:text/html,1"] {
            assert!(check_evidence(&[bad.into()]).is_err(), "{bad}");
        }
        assert!(check_evidence(&vec!["https://a.b".to_string(); 11]).is_err());
    }
}
