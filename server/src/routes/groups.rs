use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use super::{list, orgs::{ensure_org_member, member_json}, require_any};
use crate::{
    AppState, audit,
    auth::Caller,
    authz::{Allow, OrgRole, PUBLISH, require_group, require_org},
    error::{AppError, AppResult, JsonBody, P, Q, unique_violation},
    util::{PageQuery, new_id, paginate, text_field, time_cursor, ts},
};

type J = AppResult<Json<Value>>;
type GroupRow = (Uuid, Uuid, String, String, i64, DateTime<Utc>);

const GROUP_SELECT: &str = "SELECT g.id, g.org_id, g.name, g.description,
        (SELECT count(*) FROM group_members gm WHERE gm.org_id = g.org_id AND gm.group_id = g.id) AS member_count, g.created_at
   FROM groups g";

fn group_json(r: &GroupRow) -> Value {
    json!({ "id": r.0, "org_id": r.1, "name": r.2, "description": r.3, "member_count": r.4, "created_at": ts(&r.5) })
}

pub async fn group_by_id(db: &PgPool, org_id: Uuid, group_id: Uuid) -> AppResult<Value> {
    let row: GroupRow =
        sqlx::query_as(&format!("{GROUP_SELECT} WHERE g.org_id = $1 AND g.id = $2")).bind(org_id).bind(group_id).fetch_one(db).await?;
    Ok(group_json(&row))
}

fn name_taken(e: sqlx::Error) -> AppError {
    if unique_violation(&e).is_some() { AppError::conflict("name_taken", "群组名已存在") } else { e.into() }
}

pub async fn list_groups(State(st): State<AppState>, c: Caller, P(org_id): P<Uuid>, Q(q): Q<PageQuery>) -> J {
    let ctx = require_org(&st.db, &c, org_id, OrgRole::Member, PUBLISH).await?;
    let rows: Vec<GroupRow> = sqlx::query_as(&format!(
        "{GROUP_SELECT} WHERE g.org_id = $1 AND ($2::uuid IS NULL OR g.id < $2) ORDER BY g.id DESC LIMIT $3"
    ))
    .bind(ctx.org_id())
    .bind(q.cursor_id()?)
    .bind(q.limit() + 1)
    .fetch_all(&st.db)
    .await?;
    let (rows, next) = paginate(rows, q.limit(), |r| r.0.to_string());
    Ok(Json(list(rows.iter().map(group_json).collect(), next)))
}

#[derive(Deserialize)]
pub struct GroupReq {
    name: Option<String>,
    description: Option<String>,
}

pub async fn create_group(State(st): State<AppState>, c: Caller, P(org_id): P<Uuid>, JsonBody(r): JsonBody<GroupReq>) -> AppResult<(StatusCode, Json<Value>)> {
    let ctx = require_org(&st.db, &c, org_id, OrgRole::Admin, Allow::Session).await?;
    let name = text_field("name", r.name.as_deref().unwrap_or(""), 1, 100)?;
    let desc = r.description.as_deref().map(|d| text_field("description", d, 0, 2000)).transpose()?.unwrap_or_default();
    let id = new_id();
    let mut tx = st.db.begin().await?;
    sqlx::query("INSERT INTO groups (id, org_id, name, description, created_by) VALUES ($1, $2, $3, $4, $5)")
        .bind(id)
        .bind(ctx.org_id())
        .bind(&name)
        .bind(&desc)
        .bind(ctx.user_id())
        .execute(&mut *tx)
        .await
        .map_err(name_taken)?;
    audit::log(&mut tx, Some(ctx.org_id()), &c.actor(), "group.create", "group", Some(id), json!({})).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(group_by_id(&st.db, ctx.org_id(), id).await?)))
}

pub async fn get_group(State(st): State<AppState>, c: Caller, P(id): P<Uuid>) -> J {
    let ctx = require_group(&st.db, &c, id, OrgRole::Member, Allow::Session).await?;
    Ok(Json(group_by_id(&st.db, ctx.org_id(), ctx.group_id()).await?))
}

pub async fn update_group(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, JsonBody(r): JsonBody<GroupReq>) -> J {
    let ctx = require_group(&st.db, &c, id, OrgRole::Admin, Allow::Session).await?;
    require_any(&[r.name.is_some(), r.description.is_some()])?;
    let name = r.name.as_deref().map(|n| text_field("name", n, 1, 100)).transpose()?;
    let desc = r.description.as_deref().map(|d| text_field("description", d, 0, 2000)).transpose()?;
    let mut tx = st.db.begin().await?;
    sqlx::query("UPDATE groups SET name = COALESCE($3, name), description = COALESCE($4, description), updated_at = now() WHERE org_id = $1 AND id = $2")
        .bind(ctx.org_id())
        .bind(ctx.group_id())
        .bind(&name)
        .bind(&desc)
        .execute(&mut *tx)
        .await
        .map_err(name_taken)?;
    let fields: Vec<&str> = [name.as_ref().map(|_| "name"), desc.as_ref().map(|_| "description")].into_iter().flatten().collect();
    audit::log(&mut tx, Some(ctx.org_id()), &c.actor(), "group.update", "group", Some(ctx.group_id()), json!({ "fields": fields })).await?;
    tx.commit().await?;
    Ok(Json(group_by_id(&st.db, ctx.org_id(), ctx.group_id()).await?))
}

pub async fn delete_group(State(st): State<AppState>, c: Caller, P(id): P<Uuid>) -> AppResult<StatusCode> {
    let ctx = require_group(&st.db, &c, id, OrgRole::Admin, Allow::Session).await?;
    let mut tx = st.db.begin().await?;
    sqlx::query("DELETE FROM groups WHERE org_id = $1 AND id = $2").bind(ctx.org_id()).bind(ctx.group_id()).execute(&mut *tx).await?;
    audit::log(&mut tx, Some(ctx.org_id()), &c.actor(), "group.delete", "group", Some(ctx.group_id()), json!({})).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_members(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, Q(q): Q<PageQuery>) -> J {
    let ctx = require_group(&st.db, &c, id, OrgRole::Member, Allow::Session).await?;
    let cur = q.cursor_time()?;
    let rows: Vec<(Uuid, String, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT u.id, u.display_name, u.email, gm.created_at FROM group_members gm JOIN users u ON u.id = gm.user_id
          WHERE gm.org_id = $1 AND gm.group_id = $2 AND ($3::timestamptz IS NULL OR (gm.created_at, gm.user_id) < ($3, $4))
          ORDER BY gm.created_at DESC, gm.user_id DESC LIMIT $5",
    )
    .bind(ctx.org_id())
    .bind(ctx.group_id())
    .bind(cur.map(|c| c.0))
    .bind(cur.map(|c| c.1))
    .bind(q.limit() + 1)
    .fetch_all(&st.db)
    .await?;
    let (rows, next) = paginate(rows, q.limit(), |r| time_cursor(&r.3, &r.0));
    Ok(Json(list(rows.iter().map(|(id, n, e, t)| member_json(*id, n, e, None, t)).collect(), next)))
}

#[derive(Deserialize)]
pub struct AddReq {
    user_id: Uuid,
}

pub async fn add_member(State(st): State<AppState>, c: Caller, P(id): P<Uuid>, JsonBody(r): JsonBody<AddReq>) -> AppResult<(StatusCode, Json<Value>)> {
    let ctx = require_group(&st.db, &c, id, OrgRole::Admin, Allow::Session).await?;
    let mut tx = st.db.begin().await?;
    ensure_org_member(&mut tx, ctx.org_id(), r.user_id).await?;
    let row: Result<(Uuid, String, String, DateTime<Utc>), _> = sqlx::query_as(
        "WITH ins AS (INSERT INTO group_members (org_id, group_id, user_id) VALUES ($1, $2, $3) RETURNING user_id, created_at)
         SELECT u.id, u.display_name, u.email, ins.created_at FROM ins JOIN users u ON u.id = ins.user_id",
    )
    .bind(ctx.org_id())
    .bind(ctx.group_id())
    .bind(r.user_id)
    .fetch_one(&mut *tx)
    .await;
    let row = row.map_err(|e| if unique_violation(&e).is_some() { AppError::conflict("already_member", "已是群组成员") } else { e.into() })?;
    audit::log(&mut tx, Some(ctx.org_id()), &c.actor(), "group_member.add", "group", Some(ctx.group_id()), json!({ "user_id": r.user_id })).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(member_json(row.0, &row.1, &row.2, None, &row.3))))
}

pub async fn remove_member(State(st): State<AppState>, c: Caller, P((id, user_id)): P<(Uuid, Uuid)>) -> AppResult<StatusCode> {
    let ctx = require_group(&st.db, &c, id, OrgRole::Member, Allow::Session).await?;
    if user_id != ctx.user_id() {
        require_org(&st.db, &c, ctx.org_id(), OrgRole::Admin, Allow::Session).await?;
    }
    let mut tx = st.db.begin().await?;
    let n = sqlx::query("DELETE FROM group_members WHERE org_id = $1 AND group_id = $2 AND user_id = $3")
        .bind(ctx.org_id())
        .bind(ctx.group_id())
        .bind(user_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::not_found());
    }
    audit::log(&mut tx, Some(ctx.org_id()), &c.actor(), "group_member.remove", "group", Some(ctx.group_id()), json!({ "user_id": user_id }))
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
