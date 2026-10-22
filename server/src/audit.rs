//! 审计日志：与业务写入同一事务。meta 不得含 token、密码、页面内容、提交数据
use serde_json::Value;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::{auth::Actor, error::AppResult};

pub async fn log(
    conn: &mut PgConnection,
    org_id: Option<Uuid>,
    actor: &Actor,
    action: &str,
    target_type: &str,
    target_id: Option<Uuid>,
    meta: Value,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO audit_log (org_id, actor_user_id, actor_pat_id, action, target_type, target_id, ip, meta)
         VALUES ($1, $2, $3, $4, $5, $6, $7::inet, $8)",
    )
    .bind(org_id)
    .bind(actor.user_id)
    .bind(actor.pat_id)
    .bind(action)
    .bind(target_type)
    .bind(target_id)
    .bind(&actor.ip)
    .bind(meta)
    .execute(conn)
    .await?;
    Ok(())
}
