//! 全站超级管理员（api.md §15）：环境变量引导、权限、建账号并分配、禁用/启用、重置密码、建组织、审计
mod common;

use common::*;
use relay::{bootstrap_superadmins, config::parse_emails};
use serde_json::{Value, json};

async fn login(h: &H, email: &str, password: &str) -> R {
    h.req(&C::anon(), "POST", "/api/auth/login", Some(json!({ "email": email, "password": password }))).await
}

async fn login_ok(h: &H, email: &str, password: &str) -> C {
    let ip = fresh_ip();
    let r = h.req(&C { ip: ip.clone(), ..Default::default() }, "POST", "/api/auth/login", Some(json!({ "email": email, "password": password }))).await;
    assert_eq!(r.status, 200, "{}", r.text());
    session_from(&r, &ip)
}

/// 注册并经引导设为超管
async fn superadmin(h: &H, email: &str) -> C {
    let c = register(h, email).await;
    bootstrap_superadmins(&h.db, &[email.to_string()]).await.unwrap();
    c
}

async fn audit_actions(h: &H, target: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT action FROM audit_log WHERE target_id = $1::uuid ORDER BY id").bind(target).fetch_all(&h.db).await.unwrap()
}

async fn password_hash(h: &H, email: &str) -> String {
    sqlx::query_scalar("SELECT password_hash FROM users WHERE email = $1").bind(email).fetch_one(&h.db).await.unwrap()
}

#[tokio::test]
async fn env_bootstrap_is_idempotent() {
    assert_eq!(parse_emails(" B@y.com, a@x.com,,a@x.com\n"), vec!["a@x.com".to_string(), "b@y.com".to_string()]);
    assert!(parse_emails("").is_empty());
    let h = H::new().await;
    let a = register(&h, "a@x.com").await;
    // 未登录用户的 /auth/me 里 is_superadmin=false；未注册的邮箱返回给调用方告警
    assert_eq!(h.req(&a, "GET", "/api/auth/me", None).await.ok(200)["user"]["is_superadmin"], false);
    let emails = parse_emails("a@x.com,nobody@x.com");
    let (n, missing) = bootstrap_superadmins(&h.db, &emails).await.unwrap();
    assert_eq!((n, missing), (1, vec!["nobody@x.com".to_string()]));
    let (n, _) = bootstrap_superadmins(&h.db, &emails).await.unwrap();
    assert_eq!(n, 0, "幂等：第二次不再改动");
    assert_eq!(h.req(&a, "GET", "/api/auth/me", None).await.ok(200)["user"]["is_superadmin"], true);
    assert_eq!(bootstrap_superadmins(&h.db, &[]).await.unwrap().0, 0);
    h.req(&a, "GET", "/api/admin/users", None).await.ok(200);
}

#[tokio::test]
async fn non_superadmin_and_pat_forbidden() {
    let h = H::new().await;
    let sa = superadmin(&h, "sa@example.com").await;
    let u = register(&h, "u@example.com").await;
    let org = create_org(&h, &u, "o").await; // 组织 owner 也不是超管
    let (pat, _) = create_pat(&h, &sa, &["publish", "read_responses", "manage"], None, None).await;
    let paths: Vec<(&str, String, Option<Value>)> = vec![
        ("GET", "/api/admin/users".into(), None),
        ("POST", "/api/admin/users".into(), Some(json!({ "email": "x@example.com", "display_name": "X" }))),
        ("GET", format!("/api/admin/users/{}", u.user_id), None),
        ("PATCH", format!("/api/admin/users/{}", u.user_id), Some(json!({ "disabled": true }))),
        ("POST", format!("/api/admin/users/{}/reset-password", u.user_id), Some(json!({}))),
        ("PUT", format!("/api/admin/users/{}/orgs/{org}", sa.user_id), Some(json!({ "role": "owner" }))),
        ("GET", "/api/admin/orgs".into(), None),
        ("POST", "/api/admin/orgs".into(), Some(json!({ "name": "n", "slug": "n", "owner_user_id": u.user_id }))),
        ("GET", format!("/api/admin/orgs/{org}/structure"), None),
    ];
    for (m, p, b) in &paths {
        assert_eq!(h.req(&u, m, p, b.clone()).await.status, 403, "{m} {p} 非超管");
        assert_eq!(h.req(&pat, m, p, b.clone()).await.status, 403, "{m} {p} 超管的 PAT");
        assert_eq!(h.req(&C::anon(), m, p, b.clone()).await.status, 401, "{m} {p} 匿名");
    }
    // 上面全被拒：没有留下任何副作用
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM users").fetch_one(&h.db).await.unwrap();
    assert_eq!(n, 2);
    assert!(login(&h, "u@example.com", "password-123").await.status == 200);
}

#[tokio::test]
async fn create_user_with_multi_org_assignments() {
    let h = H::new().await;
    let sa = superadmin(&h, "sa@example.com").await;
    let o1_owner = register(&h, "o1@example.com").await;
    let o1 = create_org(&h, &o1_owner, "o1").await;
    let p1 = create_project(&h, &o1_owner, &o1, "p1").await;
    let pg1 = s(&h.req(&o1_owner, "POST", &format!("/api/projects/{p1}/groups"), Some(json!({ "name": "p1-group" }))).await.ok(201)["id"]);
    let og1 = create_group(&h, &o1_owner, &o1, "org-group").await;
    let o2_owner = register(&h, "o2@example.com").await;
    let o2 = create_org(&h, &o2_owner, "o2").await;
    let p2 = create_project(&h, &o2_owner, &o2, "p2").await;

    // 超管不必是成员也能看组织结构
    let st = h.req(&sa, "GET", &format!("/api/admin/orgs/{o1}/structure"), None).await.ok(200);
    assert_eq!(st["projects"].as_array().unwrap().len(), 1);
    assert_eq!(st["groups"].as_array().unwrap().len(), 2);

    // 校验：项目跨组织、群组不属于所选项目、组织重复、owner 之外的非法角色 → 400，不留账号
    for bad in [
        json!([{ "org_id": o1, "role": "member", "projects": [{ "project_id": p2, "role": "viewer" }] }]),
        json!([{ "org_id": o1, "role": "member", "group_ids": [pg1] }]),
        json!([{ "org_id": o1, "role": "member" }, { "org_id": o1, "role": "admin" }]),
        json!([{ "org_id": o1, "role": "boss" }]),
        json!([{ "org_id": sa.user_id, "role": "member" }]),
    ] {
        let r = h.req(&sa, "POST", "/api/admin/users", Some(json!({ "email": "new@example.com", "display_name": "New", "orgs": bad }))).await;
        assert_eq!(r.status, 400, "{bad} → {}", r.text());
    }
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE email = 'new@example.com'").fetch_one(&h.db).await.unwrap();
    assert_eq!(n, 0);

    let r = h
        .req(
            &sa,
            "POST",
            "/api/admin/users",
            Some(json!({
                "email": "New@Example.com", "display_name": "New",
                "orgs": [
                    { "org_id": o1, "role": "admin", "projects": [{ "project_id": p1, "role": "editor" }], "group_ids": [pg1, og1] },
                    { "org_id": o2, "role": "owner", "projects": [{ "project_id": p2, "role": "viewer" }] },
                ],
            })),
        )
        .await
        .ok(201);
    let pw = s(&r["generated_password"]);
    assert!(pw.len() >= 16);
    let uid = s(&r["user"]["id"]);
    assert_eq!(r["user"]["must_change_password"], true);
    assert_eq!(r["user"]["is_superadmin"], false);

    let d = h.req(&sa, "GET", &format!("/api/admin/users/{uid}"), None).await.ok(200);
    let orgs = d["orgs"].as_array().unwrap();
    assert_eq!(orgs.len(), 2);
    let a1 = orgs.iter().find(|o| o["org"]["id"] == o1.as_str()).unwrap();
    assert_eq!(a1["role"], "admin");
    assert_eq!(a1["projects"][0]["role"], "editor");
    assert_eq!(a1["groups"].as_array().unwrap().len(), 2);
    let a2 = orgs.iter().find(|o| o["org"]["id"] == o2.as_str()).unwrap();
    assert_eq!(a2["role"], "owner");
    assert!(!d.to_string().contains(&pw));

    // 新账号登录后先改密码
    let nc = login_ok(&h, "new@example.com", &pw).await;
    assert_eq!(h.req(&nc, "GET", "/api/me/projects", None).await.code(), "password_change_required");

    // 再建同邮箱：409 email_registered，details 带 user_id，便于跳到详情
    let r = h.req(&sa, "POST", "/api/admin/users", Some(json!({ "email": "new@example.com", "display_name": "Dup" }))).await;
    assert_eq!(r.status, 409);
    assert_eq!(r.code(), "email_registered");
    assert_eq!(r.json()["error"]["details"]["user_id"], uid.as_str());

    // 审计：全局一条 admin.user_create（不含密码），每个组织一条 admin.member_set（组织审计里可见）
    let acts = audit_actions(&h, &uid).await;
    assert_eq!(acts.iter().filter(|a| *a == "admin.member_set").count(), 2);
    assert!(acts.contains(&"admin.user_create".to_string()));
    let all: Vec<Value> = sqlx::query_scalar("SELECT meta FROM audit_log").fetch_all(&h.db).await.unwrap();
    assert!(!serde_json::to_string(&all).unwrap().contains(&pw));
    let org_audit = h.req(&o1_owner, "GET", &format!("/api/orgs/{o1}/audit?action=admin.member_set"), None).await.ok(200);
    assert_eq!(org_audit["items"][0]["actor"]["user"]["id"], sa.user_id.as_str());

    // 列表：搜索与筛选
    let l = h.req(&sa, "GET", "/api/admin/users?q=new", None).await.ok(200);
    assert_eq!(l["items"].as_array().unwrap().len(), 1);
    assert_eq!(l["items"][0]["org_count"], 2);
    let l = h.req(&sa, "GET", "/api/admin/users?status=must_change", None).await.ok(200);
    assert_eq!(l["items"].as_array().unwrap().len(), 1);
    let l = h.req(&sa, "GET", "/api/admin/users?status=superadmin", None).await.ok(200);
    assert_eq!(l["items"][0]["id"], sa.user_id.as_str());
    assert_eq!(h.req(&sa, "GET", "/api/admin/users?status=bogus", None).await.status, 400);
    let l = h.req(&sa, "GET", "/api/admin/users?limit=2", None).await.ok(200);
    assert!(l["next_cursor"].is_string());
}

#[tokio::test]
async fn assign_registered_user_without_touching_password() {
    let h = H::new().await;
    let sa = superadmin(&h, "sa@example.com").await;
    let owner = register(&h, "owner@example.com").await;
    let org = create_org(&h, &owner, "o").await;
    let p = create_project(&h, &owner, &org, "p").await;
    let g = create_group(&h, &owner, &org, "g").await;
    let u = register(&h, "u@example.com").await;
    let before = password_hash(&h, "u@example.com").await;
    let uid = u.user_id.clone();

    // 未加入组织前不能分配项目/群组
    assert_eq!(h.req(&sa, "PUT", &format!("/api/admin/users/{uid}/projects/{p}"), Some(json!({ "role": "viewer" }))).await.code(), "not_org_member");
    assert_eq!(h.req(&sa, "PUT", &format!("/api/admin/users/{uid}/groups/{g}"), None).await.code(), "not_org_member");

    assert_eq!(h.req(&sa, "PUT", &format!("/api/admin/users/{uid}/orgs/{org}"), Some(json!({ "role": "member" }))).await.status, 204);
    assert_eq!(h.req(&sa, "PUT", &format!("/api/admin/users/{uid}/projects/{p}"), Some(json!({ "role": "editor" }))).await.status, 204);
    assert_eq!(h.req(&sa, "PUT", &format!("/api/admin/users/{uid}/groups/{g}"), None).await.status, 204);
    assert_eq!(h.req(&sa, "PUT", &format!("/api/admin/users/{uid}/groups/{g}"), None).await.status, 204, "幂等");
    assert_eq!(h.req(&sa, "PUT", &format!("/api/admin/users/{uid}/projects/{p}"), Some(json!({ "role": "admin" }))).await.status, 204);

    // 密码与 must_change 都没变，原会话仍可用，用户直接看到组织
    assert_eq!(password_hash(&h, "u@example.com").await, before);
    let me = h.req(&u, "GET", "/api/auth/me", None).await.ok(200);
    assert_eq!(me["user"]["must_change_password"], false);
    assert_eq!(me["orgs"][0]["id"], org.as_str());
    let d = h.req(&sa, "GET", &format!("/api/admin/users/{uid}"), None).await.ok(200);
    assert_eq!(d["orgs"][0]["projects"][0]["role"], "admin");
    assert_eq!(d["orgs"][0]["groups"][0]["id"], g.as_str());

    // 角色改 owner 后，原 owner 可以被降级；最后一个 owner 不能降级/移除
    assert_eq!(h.req(&sa, "PUT", &format!("/api/admin/users/{uid}/orgs/{org}"), Some(json!({ "role": "owner" }))).await.status, 204);
    assert_eq!(h.req(&sa, "PUT", &format!("/api/admin/users/{}/orgs/{org}", owner.user_id), Some(json!({ "role": "member" }))).await.status, 204);
    assert_eq!(h.req(&sa, "PUT", &format!("/api/admin/users/{uid}/orgs/{org}"), Some(json!({ "role": "admin" }))).await.code(), "last_owner");
    assert_eq!(h.req(&sa, "DELETE", &format!("/api/admin/users/{uid}/orgs/{org}"), None).await.code(), "last_owner");

    // 移除项目、群组；移出组织级联
    assert_eq!(h.req(&sa, "DELETE", &format!("/api/admin/users/{uid}/projects/{p}"), None).await.status, 204);
    assert_eq!(h.req(&sa, "DELETE", &format!("/api/admin/users/{uid}/projects/{p}"), None).await.status, 404);
    assert_eq!(h.req(&sa, "DELETE", &format!("/api/admin/users/{uid}/groups/{g}"), None).await.status, 204);
    assert_eq!(h.req(&sa, "PUT", &format!("/api/admin/users/{uid}/groups/{g}"), None).await.status, 204);
    assert_eq!(h.req(&sa, "PUT", &format!("/api/admin/users/{}/orgs/{org}", owner.user_id), Some(json!({ "role": "owner" }))).await.status, 204);
    assert_eq!(h.req(&sa, "DELETE", &format!("/api/admin/users/{uid}/orgs/{org}"), None).await.status, 204);
    let gn: i64 = sqlx::query_scalar("SELECT count(*) FROM group_members WHERE user_id = $1::uuid").bind(&uid).fetch_one(&h.db).await.unwrap();
    assert_eq!(gn, 0);
    let acts = audit_actions(&h, &uid).await;
    assert!(acts.contains(&"admin.member_set".to_string()) && acts.contains(&"admin.member_remove".to_string()));
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action = 'admin.group_member_add'").fetch_one(&h.db).await.unwrap();
    assert_eq!(n, 2, "幂等的重复添加不记审计");
    // 不存在的组织/用户 404
    assert_eq!(h.req(&sa, "PUT", &format!("/api/admin/users/{uid}/orgs/{uid}"), Some(json!({ "role": "member" }))).await.status, 404);
    assert_eq!(h.req(&sa, "PUT", &format!("/api/admin/users/{org}/orgs/{org}"), Some(json!({ "role": "member" }))).await.status, 404);
}

#[tokio::test]
async fn disable_kicks_out_and_enable_restores() {
    let h = H::new().await;
    let sa = superadmin(&h, "sa@example.com").await;
    let u = register(&h, "u@example.com").await;
    let org = create_org(&h, &u, "o").await;
    let (pat, pat_id) = create_pat(&h, &u, &["publish", "read_responses"], None, None).await;
    let (revoked, revoked_id) = create_pat(&h, &u, &["publish"], None, None).await;
    h.req(&u, "DELETE", &format!("/api/tokens/{revoked_id}"), None).await.ok(204);
    h.req(&pat, "GET", "/api/me/projects", None).await.ok(200);

    // 不能禁用自己
    assert_eq!(h.req(&sa, "PATCH", &format!("/api/admin/users/{}", sa.user_id), Some(json!({ "disabled": true }))).await.code(), "cannot_disable_self");

    let r = h.req(&sa, "PATCH", &format!("/api/admin/users/{}", u.user_id), Some(json!({ "disabled": true }))).await.ok(200);
    assert_eq!(r["user"]["disabled"], true);
    // 会话被删（踢下线）、PAT 被拒（数据仍在）、登录返回 account_disabled（密码错误仍是 invalid_credentials）
    assert_eq!(h.req(&u, "GET", "/api/auth/me", None).await.status, 401);
    assert_eq!(h.req(&pat, "GET", "/api/me/projects", None).await.status, 401);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM personal_access_tokens WHERE id = $1::uuid AND revoked_at IS NULL").bind(&pat_id).fetch_one(&h.db).await.unwrap();
    assert_eq!(n, 1);
    let r = login(&h, "u@example.com", "password-123").await;
    assert_eq!((r.status, r.code()), (403, "account_disabled".to_string()));
    assert_eq!(login(&h, "u@example.com", "wrong-password-1").await.code(), "invalid_credentials");
    let l = h.req(&sa, "GET", "/api/admin/users?status=disabled", None).await.ok(200);
    assert_eq!(l["items"].as_array().unwrap().len(), 1);
    // 禁用的账号仍是组织成员（数据不动）
    let m: i64 = sqlx::query_scalar("SELECT count(*) FROM memberships WHERE org_id = $1::uuid").bind(&org).fetch_one(&h.db).await.unwrap();
    assert_eq!(m, 1);

    let r = h.req(&sa, "PATCH", &format!("/api/admin/users/{}", u.user_id), Some(json!({ "disabled": false }))).await.ok(200);
    assert_eq!(r["user"]["disabled"], false);
    login_ok(&h, "u@example.com", "password-123").await;
    h.req(&pat, "GET", "/api/me/projects", None).await.ok(200); // 未过期未吊销的 PAT 恢复
    assert_eq!(h.req(&revoked, "GET", "/api/me/projects", None).await.status, 401); // 已吊销的仍无效
    assert_eq!(h.req(&u, "GET", "/api/auth/me", None).await.status, 401, "被踢的旧会话不会复活");
    let acts = audit_actions(&h, &u.user_id).await;
    assert!(acts.contains(&"admin.user_disable".to_string()) && acts.contains(&"admin.user_enable".to_string()));
}

#[tokio::test]
async fn superadmin_grant_revoke_and_last_one() {
    let h = H::new().await;
    let sa = superadmin(&h, "sa@example.com").await;
    let b = register(&h, "b@example.com").await;
    // 唯一的超管不能撤销自己
    assert_eq!(h.req(&sa, "PATCH", &format!("/api/admin/users/{}", sa.user_id), Some(json!({ "is_superadmin": false }))).await.code(), "last_superadmin");
    h.req(&sa, "PATCH", &format!("/api/admin/users/{}", b.user_id), Some(json!({ "is_superadmin": true, "display_name": "Bee" }))).await.ok(200);
    assert_eq!(h.req(&b, "GET", "/api/auth/me", None).await.ok(200)["user"]["display_name"], "Bee");
    h.req(&b, "GET", "/api/admin/users", None).await.ok(200);
    // b 撤销 sa；之后 b 是唯一的，不能撤销自己；sa 已无权限
    h.req(&b, "PATCH", &format!("/api/admin/users/{}", sa.user_id), Some(json!({ "is_superadmin": false }))).await.ok(200);
    assert_eq!(h.req(&sa, "GET", "/api/admin/users", None).await.status, 403);
    assert_eq!(h.req(&b, "PATCH", &format!("/api/admin/users/{}", b.user_id), Some(json!({ "is_superadmin": false }))).await.code(), "last_superadmin");
    // 禁用的超管不算可用超管：再授予 sa，禁用 sa 后 b 仍不能撤销自己
    h.req(&b, "PATCH", &format!("/api/admin/users/{}", sa.user_id), Some(json!({ "is_superadmin": true }))).await.ok(200);
    h.req(&b, "PATCH", &format!("/api/admin/users/{}", sa.user_id), Some(json!({ "disabled": true }))).await.ok(200);
    assert_eq!(h.req(&b, "PATCH", &format!("/api/admin/users/{}", b.user_id), Some(json!({ "is_superadmin": false }))).await.code(), "last_superadmin");
    assert_eq!(h.req(&b, "PATCH", &format!("/api/admin/users/{}", b.user_id), Some(json!({}))).await.status, 400);
    let acts = audit_actions(&h, &sa.user_id).await;
    assert!(acts.contains(&"admin.superadmin_grant".to_string()) && acts.contains(&"admin.superadmin_revoke".to_string()));
    assert!(audit_actions(&h, &b.user_id).await.contains(&"admin.user_update".to_string()));
}

#[tokio::test]
async fn reset_password_once_and_force_change() {
    let h = H::new().await;
    let sa = superadmin(&h, "sa@example.com").await;
    let u = register(&h, "u@example.com").await;
    assert_eq!(h.req(&sa, "POST", &format!("/api/admin/users/{}/reset-password", sa.user_id), Some(json!({}))).await.code(), "cannot_reset_self");
    let r = h.req(&sa, "POST", &format!("/api/admin/users/{}/reset-password", u.user_id), Some(json!({}))).await.ok(200);
    let pw = s(&r["generated_password"]);
    assert!(pw.len() >= 16);
    // 旧会话被踢、旧密码失效、新密码登录后必须先改密码
    assert_eq!(h.req(&u, "GET", "/api/auth/me", None).await.status, 401);
    assert_eq!(login(&h, "u@example.com", "password-123").await.status, 401);
    let nc = login_ok(&h, "u@example.com", &pw).await;
    assert_eq!(h.req(&nc, "GET", "/api/auth/me", None).await.ok(200)["user"]["must_change_password"], true);
    assert_eq!(h.req(&nc, "GET", "/api/orgs", None).await.code(), "password_change_required");
    // 详情、列表、审计都不再出现明文
    let d = h.req(&sa, "GET", &format!("/api/admin/users/{}", u.user_id), None).await.ok(200);
    assert!(!d.to_string().contains(&pw));
    let meta: Value = sqlx::query_scalar("SELECT meta FROM audit_log WHERE action = 'admin.password_reset'").fetch_one(&h.db).await.unwrap();
    assert_eq!(meta, json!({ "password": "generated" }));
    // 手填密码按强度校验；手填时不回显
    assert_eq!(h.req(&sa, "POST", &format!("/api/admin/users/{}/reset-password", u.user_id), Some(json!({ "password": "short" }))).await.status, 400);
    let r = h.req(&sa, "POST", &format!("/api/admin/users/{}/reset-password", u.user_id), Some(json!({ "password": "manual-pass-123" }))).await.ok(200);
    assert!(r["generated_password"].is_null());
    login_ok(&h, "u@example.com", "manual-pass-123").await;
}

#[tokio::test]
async fn create_org_with_owner() {
    let h = H::new().await;
    let sa = superadmin(&h, "sa@example.com").await;
    let u = register(&h, "u@example.com").await;
    // 二选一校验
    assert_eq!(h.req(&sa, "POST", "/api/admin/orgs", Some(json!({ "name": "A", "slug": "a" }))).await.status, 400);
    // 已有账号做 owner；超管本人不成为成员
    let r = h.req(&sa, "POST", "/api/admin/orgs", Some(json!({ "name": "A", "slug": "a", "owner_user_id": u.user_id }))).await.ok(201);
    let a = s(&r["org"]["id"]);
    assert!(r["generated_password"].is_null());
    let me = h.req(&u, "GET", "/api/auth/me", None).await.ok(200);
    assert_eq!(me["orgs"][0]["my_role"], "owner");
    assert_eq!(h.req(&sa, "GET", "/api/auth/me", None).await.ok(200)["orgs"].as_array().unwrap().len(), 0);
    assert_eq!(h.req(&sa, "POST", "/api/admin/orgs", Some(json!({ "name": "A", "slug": "a", "owner_user_id": u.user_id }))).await.code(), "slug_taken");
    // 同时新建 owner 账号：一次性密码只出现一次；邮箱已注册 → 409
    let r = h
        .req(&sa, "POST", "/api/admin/orgs", Some(json!({ "name": "B", "slug": "b", "owner": { "email": "boss@example.com", "display_name": "Boss" } })))
        .await
        .ok(201);
    let pw = s(&r["generated_password"]);
    assert_eq!(r["owner"]["email"], "boss@example.com");
    let boss = login_ok(&h, "boss@example.com", &pw).await;
    assert_eq!(h.req(&boss, "GET", "/api/auth/me", None).await.ok(200)["orgs"][0]["my_role"], "owner");
    let r = h.req(&sa, "POST", "/api/admin/orgs", Some(json!({ "name": "C", "slug": "c", "owner": { "email": "u@example.com", "display_name": "U" } }))).await;
    assert_eq!(r.code(), "email_registered");
    let l = h.req(&sa, "GET", "/api/admin/orgs", None).await.ok(200);
    assert_eq!(l["items"].as_array().unwrap().len(), 2);
    let la = l["items"].as_array().unwrap().iter().find(|o| o["id"] == a.as_str()).unwrap().clone();
    assert_eq!(la["owners"][0]["email"], "u@example.com");
    assert_eq!(la["member_count"], 1);
    assert_eq!(h.req(&sa, "GET", "/api/admin/orgs?q=b", None).await.ok(200)["items"].as_array().unwrap().len(), 1);
    assert_eq!(audit_actions(&h, &a).await, vec!["admin.org_create".to_string()]);
}

#[tokio::test]
async fn ordinary_users_unaffected() {
    // 旧用户：is_superadmin=false、未禁用；注册/登录/PAT/改密流程不变
    let h = H::new().await;
    let u = register(&h, "u@example.com").await;
    let me = h.req(&u, "GET", "/api/auth/me", None).await.ok(200);
    assert_eq!(me["user"]["is_superadmin"], false);
    let (pat, _) = create_pat(&h, &u, &["publish"], None, None).await;
    h.req(&pat, "GET", "/api/me/projects", None).await.ok(200);
    login_ok(&h, "u@example.com", "password-123").await;
    let (sup, dis): (bool, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as("SELECT is_superadmin, disabled_at FROM users WHERE email = 'u@example.com'").fetch_one(&h.db).await.unwrap();
    assert!(!sup && dis.is_none());
}
