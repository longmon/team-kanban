//! 组织/项目/群组/邀请、PAT scope 与范围、跨租户 404 矩阵
mod common;

use common::*;
use serde_json::{Value, json};

#[tokio::test]
async fn orgs_projects_groups_invites() {
    let h = H::new().await;
    let owner = register(&h, "owner@example.com").await;
    let org = create_org(&h, &owner, "acme").await;
    let r = h.req(&owner, "POST", "/api/orgs", Some(json!({ "name": "x", "slug": "acme" }))).await;
    assert_eq!((r.status, r.code()), (409, "slug_taken".into()));
    let r = h.req(&owner, "POST", "/api/orgs", Some(json!({ "name": "x", "slug": "Bad--Slug" }))).await;
    assert_eq!(r.status, 400);
    assert_eq!(h.req(&owner, "GET", &format!("/api/orgs/{org}"), None).await.ok(200)["my_role"], "owner");
    assert_eq!(h.req(&owner, "GET", "/api/orgs", None).await.ok(200)["items"].as_array().unwrap().len(), 1);

    // 邀请 admin、member
    let admin = register(&h, "admin@example.com").await;
    let member = register(&h, "member@example.com").await;
    join_org(&h, &owner, &org, &admin, "admin").await;
    let accepted = invite(&h, &admin, &org, json!({ "target_type": "org", "role": "member", "max_uses": 5 }), &member).await;
    assert_eq!(accepted["org"]["my_role"], "member");
    assert_eq!(accepted["project"], Value::Null);
    // admin 不能邀请 admin
    let r = h.req(&admin, "POST", &format!("/api/orgs/{org}/invites"), Some(json!({ "target_type": "org", "role": "admin" }))).await;
    assert_eq!(r.status, 403);
    // member 不能发组织邀请、不能建群组、不能看审计
    let r = h.req(&member, "POST", &format!("/api/orgs/{org}/invites"), Some(json!({ "target_type": "org", "role": "member" }))).await;
    assert_eq!(r.status, 403);
    assert_eq!(h.req(&member, "POST", &format!("/api/orgs/{org}/groups"), Some(json!({ "name": "g" }))).await.status, 403);
    assert_eq!(h.req(&member, "GET", &format!("/api/orgs/{org}/audit"), None).await.status, 403);

    // 成员列表与搜索、分页
    let m = h.req(&member, "GET", &format!("/api/orgs/{org}/members"), None).await.ok(200);
    assert_eq!(m["items"].as_array().unwrap().len(), 3);
    let m = h.req(&member, "GET", &format!("/api/orgs/{org}/members?q=adm"), None).await.ok(200);
    assert_eq!(m["items"][0]["user"]["email"], "admin@example.com");
    let p1 = h.req(&member, "GET", &format!("/api/orgs/{org}/members?limit=2"), None).await.ok(200);
    let cur = s(&p1["next_cursor"]);
    let p2 = h.req(&member, "GET", &format!("/api/orgs/{org}/members?limit=2&cursor={cur}"), None).await.ok(200);
    assert_eq!(p2["items"].as_array().unwrap().len(), 1);
    assert_eq!(p2["next_cursor"], Value::Null);

    // 角色修改规则与最后一个 owner
    let r = h.req(&admin, "PATCH", &format!("/api/orgs/{org}/members/{}", owner.user_id), Some(json!({ "role": "member" }))).await;
    assert_eq!(r.status, 403);
    let r = h.req(&admin, "PATCH", &format!("/api/orgs/{org}/members/{}", member.user_id), Some(json!({ "role": "owner" }))).await;
    assert_eq!(r.status, 403);
    let r = h.req(&owner, "PATCH", &format!("/api/orgs/{org}/members/{}", owner.user_id), Some(json!({ "role": "admin" }))).await;
    assert_eq!((r.status, r.code()), (409, "last_owner".into()));
    let r = h.req(&owner, "DELETE", &format!("/api/orgs/{org}/members/{}", owner.user_id), None).await;
    assert_eq!((r.status, r.code()), (409, "last_owner".into()));
    h.req(&owner, "PATCH", &format!("/api/orgs/{org}/members/{}", admin.user_id), Some(json!({ "role": "owner" }))).await.ok(200);
    h.req(&owner, "PATCH", &format!("/api/orgs/{org}/members/{}", owner.user_id), Some(json!({ "role": "admin" }))).await.ok(200);
    h.req(&admin, "PATCH", &format!("/api/orgs/{org}/members/{}", owner.user_id), Some(json!({ "role": "owner" }))).await.ok(200);
    // 再把 admin 降回 admin（此时有两个 owner，允许）
    h.req(&owner, "PATCH", &format!("/api/orgs/{org}/members/{}", admin.user_id), Some(json!({ "role": "admin" }))).await.ok(200);

    // 项目：member 创建者成为项目 admin
    let proj = create_project(&h, &member, &org, "web").await;
    assert_eq!(h.req(&member, "GET", &format!("/api/projects/{proj}"), None).await.ok(200)["my_role"], "admin");
    let r = h.req(&member, "POST", &format!("/api/orgs/{org}/projects"), Some(json!({ "name": "x", "slug": "web" }))).await;
    assert_eq!(r.code(), "slug_taken");
    // owner 看得见所有项目；另一个普通成员看不见
    let other = register(&h, "other@example.com").await;
    join_org(&h, &owner, &org, &other, "member").await;
    assert_eq!(h.req(&owner, "GET", &format!("/api/orgs/{org}/projects"), None).await.ok(200)["items"].as_array().unwrap().len(), 1);
    assert_eq!(h.req(&other, "GET", &format!("/api/orgs/{org}/projects"), None).await.ok(200)["items"].as_array().unwrap().len(), 0);
    assert_eq!(h.req(&other, "GET", &format!("/api/projects/{proj}"), None).await.status, 404);

    // 项目成员：加非组织成员 409；重复 409；改角色；viewer 不能改项目
    let outsider = register(&h, "outsider@example.com").await;
    let r = h.req(&member, "POST", &format!("/api/projects/{proj}/members"), Some(json!({ "user_id": outsider.user_id, "role": "viewer" }))).await;
    assert_eq!((r.status, r.code()), (409, "not_org_member".into()));
    add_project_member(&h, &member, &proj, &other, "viewer").await;
    let r = h.req(&member, "POST", &format!("/api/projects/{proj}/members"), Some(json!({ "user_id": other.user_id, "role": "viewer" }))).await;
    assert_eq!(r.code(), "already_member");
    assert_eq!(h.req(&other, "PATCH", &format!("/api/projects/{proj}"), Some(json!({ "name": "n" }))).await.status, 403);
    let pm = h.req(&member, "PATCH", &format!("/api/projects/{proj}/members/{}", other.user_id), Some(json!({ "role": "editor" }))).await.ok(200);
    assert_eq!(pm["role"], "editor");
    assert_eq!(h.req(&other, "GET", "/api/me/projects", None).await.ok(200)["items"][0]["can_publish"], true);
    h.req(&other, "DELETE", &format!("/api/projects/{proj}/members/{}", other.user_id), None).await.ok(204);
    assert_eq!(h.req(&other, "GET", &format!("/api/projects/{proj}"), None).await.status, 404);

    // 群组与项目授权：群组成员经授权获得项目角色
    let grp = create_group(&h, &admin, &org, "设计组").await;
    let r = h.req(&admin, "POST", &format!("/api/orgs/{org}/groups"), Some(json!({ "name": "设计组" }))).await;
    assert_eq!(r.code(), "name_taken");
    let r = h.req(&admin, "POST", &format!("/api/groups/{grp}/members"), Some(json!({ "user_id": outsider.user_id }))).await;
    assert_eq!(r.code(), "not_org_member");
    h.req(&admin, "POST", &format!("/api/groups/{grp}/members"), Some(json!({ "user_id": other.user_id }))).await.ok(201);
    assert_eq!(h.req(&admin, "POST", &format!("/api/groups/{grp}/members"), Some(json!({ "user_id": other.user_id }))).await.code(), "already_member");
    assert_eq!(h.req(&other, "GET", &format!("/api/groups/{grp}"), None).await.ok(200)["member_count"], 1);
    h.req(&member, "PUT", &format!("/api/projects/{proj}/groups/{grp}"), Some(json!({ "role": "viewer" }))).await.ok(200);
    assert_eq!(h.req(&other, "GET", &format!("/api/projects/{proj}"), None).await.ok(200)["my_role"], "viewer");
    h.req(&member, "PUT", &format!("/api/projects/{proj}/groups/{grp}"), Some(json!({ "role": "editor" }))).await.ok(200);
    assert_eq!(h.req(&other, "GET", &format!("/api/projects/{proj}"), None).await.ok(200)["my_role"], "editor");
    assert_eq!(h.req(&other, "GET", &format!("/api/projects/{proj}/groups"), None).await.ok(200)["items"][0]["role"], "editor");
    h.req(&member, "DELETE", &format!("/api/projects/{proj}/groups/{grp}"), None).await.ok(204);
    assert_eq!(h.req(&other, "GET", &format!("/api/projects/{proj}"), None).await.status, 404);
    h.req(&other, "DELETE", &format!("/api/groups/{grp}/members/{}", other.user_id), None).await.ok(204);

    // 项目邀请：外部用户接受后自动以 member 加入组织
    let acc = invite(&h, &member, &org, json!({ "target_type": "project", "project_id": proj, "role": "editor" }), &outsider).await;
    assert_eq!(acc["org"]["my_role"], "member");
    assert_eq!(acc["project"]["my_role"], "editor");
    // 群组邀请
    let g2 = register(&h, "g2@example.com").await;
    let acc = invite(&h, &admin, &org, json!({ "target_type": "group", "group_id": grp, "role": "member" }), &g2).await;
    assert_eq!(acc["group"]["member_count"], 1);

    // 已是成员接受更高角色的邀请 → 升级，不降级
    let acc = invite(&h, &owner, &org, json!({ "target_type": "org", "role": "admin" }), &g2).await;
    assert_eq!(acc["org"]["my_role"], "admin");
    let acc = invite(&h, &owner, &org, json!({ "target_type": "org", "role": "member" }), &g2).await;
    assert_eq!(acc["org"]["my_role"], "admin");

    // 绑定邮箱的邀请：邮箱不符 / 未验证 → 403
    let r = h.req(&owner, "POST", &format!("/api/orgs/{org}/invites"), Some(json!({ "target_type": "org", "role": "member", "email": "bound@example.com", "max_uses": 9 }))).await.ok(201);
    assert_eq!(r["invite"]["max_uses"], 1);
    let token = s(&r["url"]).rsplit('/').next().unwrap().to_string();
    let pv = h.req(&C::anon(), "GET", &format!("/api/invites/by-token/{token}"), None).await.ok(200);
    assert_eq!(pv["email_bound"], true);
    assert_eq!(pv["org"]["slug"], "acme");
    let wrong = register(&h, "wrong@example.com").await;
    assert_eq!(h.req(&wrong, "POST", &format!("/api/invites/by-token/{token}/accept"), Some(json!({}))).await.code(), "email_mismatch");
    let bound = register(&h, "bound@example.com").await;
    assert_eq!(h.req(&bound, "POST", &format!("/api/invites/by-token/{token}/accept"), Some(json!({}))).await.code(), "email_unverified");
    sqlx::query("UPDATE users SET email_verified_at = now() WHERE email = 'bound@example.com'").execute(&h.db).await.unwrap();
    h.req(&bound, "POST", &format!("/api/invites/by-token/{token}/accept"), Some(json!({}))).await.ok(200);
    let r = h.req(&wrong, "POST", &format!("/api/invites/by-token/{token}/accept"), Some(json!({}))).await;
    assert_eq!((r.status, r.code()), (410, "invite_used_up".into()));

    // 撤销 / 过期
    let r = h.req(&owner, "POST", &format!("/api/orgs/{org}/invites"), Some(json!({ "target_type": "org", "role": "member" }))).await.ok(201);
    let (inv_id, token) = (s(&r["invite"]["id"]), s(&r["url"]).rsplit('/').next().unwrap().to_string());
    assert_eq!(h.req(&member, "DELETE", &format!("/api/invites/{inv_id}"), None).await.status, 403);
    h.req(&admin, "DELETE", &format!("/api/invites/{inv_id}"), None).await.ok(204);
    assert_eq!(h.req(&C::anon(), "GET", &format!("/api/invites/by-token/{token}"), None).await.code(), "invite_revoked");
    let r = h.req(&owner, "POST", &format!("/api/orgs/{org}/invites"), Some(json!({ "target_type": "org", "role": "member" }))).await.ok(201);
    let token = s(&r["url"]).rsplit('/').next().unwrap().to_string();
    sqlx::query("UPDATE invites SET expires_at = now() - interval '1 second' WHERE id = $1::uuid").bind(s(&r["invite"]["id"])).execute(&h.db).await.unwrap();
    assert_eq!(h.req(&wrong, "POST", &format!("/api/invites/by-token/{token}/accept"), Some(json!({}))).await.code(), "invite_expired");
    assert_eq!(h.req(&C::anon(), "GET", "/api/invites/by-token/nonexistent", None).await.status, 404);
    // 列表默认只含有效邀请
    let active = h.req(&owner, "GET", &format!("/api/orgs/{org}/invites"), None).await.ok(200)["items"].as_array().unwrap().len();
    let all = h.req(&owner, "GET", &format!("/api/orgs/{org}/invites?include_inactive=true"), None).await.ok(200)["items"].as_array().unwrap().len();
    assert!(all > active);
    let pi = h.req(&member, "GET", &format!("/api/projects/{proj}/invites?include_inactive=true"), None).await.ok(200);
    assert_eq!(pi["items"].as_array().unwrap().len(), 1);

    // 移除成员级联移出项目/群组
    h.req(&admin, "DELETE", &format!("/api/orgs/{org}/members/{}", outsider.user_id), None).await.ok(204);
    assert_eq!(h.req(&outsider, "GET", &format!("/api/projects/{proj}"), None).await.status, 404);
    // admin 不能移除 owner；member 退出
    assert_eq!(h.req(&admin, "DELETE", &format!("/api/orgs/{org}/members/{}", owner.user_id), None).await.status, 403);
    h.req(&g2, "DELETE", &format!("/api/orgs/{org}/members/{}", g2.user_id), None).await.ok(204);

    // 群组删除
    h.req(&admin, "PATCH", &format!("/api/groups/{grp}"), Some(json!({ "description": "d" }))).await.ok(200);
    h.req(&admin, "DELETE", &format!("/api/groups/{grp}"), None).await.ok(204);
    assert_eq!(h.req(&admin, "GET", &format!("/api/groups/{grp}"), None).await.status, 404);

    // 审计
    let audit = h.req(&owner, "GET", &format!("/api/orgs/{org}/audit?limit=200"), None).await.ok(200);
    let actions: Vec<&str> = audit["items"].as_array().unwrap().iter().map(|e| e["action"].as_str().unwrap()).collect();
    for a in [
        "org.create", "invite.create", "invite.accept", "invite.revoke", "member.role_change", "member.remove", "member.leave", "project.create",
        "project_member.add", "project_member.role_change", "project_member.remove", "project_group.grant", "project_group.revoke", "group.create",
        "group.update", "group.delete", "group_member.add", "group_member.remove",
    ] {
        assert!(actions.contains(&a), "缺少审计 {a}");
    }
    let only = h.req(&owner, "GET", &format!("/api/orgs/{org}/audit?action=group.create"), None).await.ok(200);
    assert_eq!(only["items"].as_array().unwrap().len(), 1);
    assert_eq!(only["items"][0]["actor"]["user"]["id"], admin.user_id.as_str());

    // 项目软删除、组织软删除
    h.req(&member, "DELETE", &format!("/api/projects/{proj}"), None).await.ok(204);
    assert_eq!(h.req(&member, "GET", &format!("/api/projects/{proj}"), None).await.status, 404);
    assert_eq!(h.req(&admin, "DELETE", &format!("/api/orgs/{org}"), Some(json!({ "confirm_slug": "acme" }))).await.status, 403);
    assert_eq!(h.req(&owner, "DELETE", &format!("/api/orgs/{org}"), Some(json!({ "confirm_slug": "nope" }))).await.status, 400);
    h.req(&owner, "DELETE", &format!("/api/orgs/{org}"), Some(json!({ "confirm_slug": "acme" }))).await.ok(204);
    assert_eq!(h.req(&owner, "GET", &format!("/api/orgs/{org}"), None).await.status, 404);
    // slug 可复用
    create_org(&h, &owner, "acme").await;
}

#[tokio::test]
async fn pat_scopes_and_bounds() {
    let h = H::new().await;
    let u = register(&h, "u@example.com").await;
    let org = create_org(&h, &u, "o").await;
    let p1 = create_project(&h, &u, &org, "p1").await;
    let p2 = create_project(&h, &u, &org, "p2").await;
    let grp = create_group(&h, &u, &org, "g").await;

    let (pub_pat, pub_id) = create_pat(&h, &u, &["publish"], None, None).await;
    let (reader, _) = create_pat(&h, &u, &["read_responses"], None, None).await;
    let (scoped, _) = create_pat(&h, &u, &["publish", "read_responses"], Some(&org), Some(&p1)).await;

    // token 形如 arp_ + 43 字符；列表里只有前缀
    assert!(pub_pat.bearer.as_ref().unwrap().starts_with("arp_") && pub_pat.bearer.as_ref().unwrap().len() == 47);
    let list = h.req(&u, "GET", "/api/tokens", None).await.ok(200);
    assert_eq!(list["items"].as_array().unwrap().len(), 3);
    assert!(!list.to_string().contains(pub_pat.bearer.as_ref().unwrap().as_str()));
    // 校验
    assert_eq!(h.req(&u, "POST", "/api/tokens", Some(json!({ "name": "x", "scopes": ["admin"] }))).await.status, 400);
    assert_eq!(h.req(&u, "POST", "/api/tokens", Some(json!({ "name": "x", "scopes": ["publish"], "project_id": p1 }))).await.status, 400);
    assert_eq!(h.req(&u, "POST", "/api/tokens", Some(json!({ "name": "x", "scopes": ["publish"], "expires_in": 60 }))).await.status, 400);

    // pub_pat：发布、改、列、群组列表、临时链接
    let page = publish_with(&h, &pub_pat, json!({ "project_id": p1, "title": "t", "kind": "openui", "content": "root = Stack([])", "visibility": "project" })).await;
    h.req(&pub_pat, "PATCH", &format!("/api/pages/{page}"), Some(json!({ "title": "t2" }))).await.ok(200);
    h.req(&pub_pat, "GET", &format!("/api/orgs/{org}/groups"), None).await.ok(200);
    h.req(&pub_pat, "POST", &format!("/api/pages/{page}/share-links"), Some(json!({ "expires_in": 3600 }))).await.ok(201);
    assert_eq!(h.req(&pub_pat, "GET", "/api/me/projects", None).await.ok(200)["items"][0]["can_read_responses"], false);
    // pub_pat 不能读提交
    assert_eq!(h.req(&pub_pat, "GET", &format!("/api/pages/{page}/responses"), None).await.status, 403);
    assert_eq!(h.req(&pub_pat, "GET", &format!("/api/pages/{page}/responses.csv"), None).await.status, 403);
    // read_responses 不能发布、不能列群组
    let r = h.req(&reader, "POST", "/api/pages", Some(json!({ "project_id": p1, "title": "t", "kind": "openui", "content": "x", "visibility": "project" }))).await;
    assert_eq!((r.status, r.code()), (403, "forbidden".into()));
    assert_eq!(h.req(&reader, "GET", &format!("/api/orgs/{org}/groups"), None).await.status, 403);
    h.req(&reader, "GET", &format!("/api/pages/{page}/responses"), None).await.ok(200);
    h.req(&reader, "GET", &format!("/api/pages/{page}"), None).await.ok(200);
    // 任何 scope 都不能：账号、组织管理、PAT 管理、审计、提交、SSE、view
    for (m, p) in [
        ("GET", "/api/auth/me".to_string()),
        ("GET", format!("/api/orgs/{org}")),
        ("GET", format!("/api/orgs/{org}/audit")),
        ("GET", "/api/tokens".into()),
        ("GET", format!("/api/pages/{page}/view")),
        ("GET", format!("/api/pages/{page}/responses/stream")),
        ("GET", format!("/api/projects/{p1}")),
        ("GET", format!("/api/groups/{grp}")),
    ] {
        assert_eq!(h.req(&pub_pat, m, &p, None).await.status, 403, "{m} {p}");
    }
    assert_eq!(h.req(&pub_pat, "DELETE", &format!("/api/tokens/{pub_id}"), None).await.status, 403);
    // 任意 scope 的 PAT 都能列组织（agent 在空组织里建第一个项目用）；publish-only 不能建项目/群组
    assert_eq!(h.req(&reader, "GET", "/api/orgs", None).await.ok(200)["items"][0]["my_role"], "owner");
    let r = h.req(&pub_pat, "POST", &format!("/api/orgs/{org}/projects"), Some(json!({ "name": "x", "slug": "x" }))).await;
    assert_eq!((r.status, r.code()), (403, "forbidden".into()));
    assert_eq!(h.req(&pub_pat, "POST", &format!("/api/projects/{p1}/groups"), Some(json!({ "name": "x" }))).await.status, 403);
    assert_eq!(h.req(&pub_pat, "POST", &format!("/api/orgs/{org}/groups"), Some(json!({ "name": "x" }))).await.status, 403);
    h.req(&pub_pat, "GET", &format!("/api/projects/{p1}/groups"), None).await.ok(200);
    assert_eq!(h.req(&reader, "GET", &format!("/api/projects/{p1}/groups"), None).await.status, 403);
    let r = h.req(&pub_pat, "POST", &format!("/api/pages/{page}/responses"), Some(json!({ "data": {} }))).await;
    assert_eq!((r.status, r.code()), (409, "not_allowed".into()));

    // 项目范围：只能看到 p1，p2 一律 404
    let mp = h.req(&scoped, "GET", "/api/me/projects", None).await.ok(200);
    assert_eq!(mp["items"].as_array().unwrap().len(), 1);
    assert_eq!(mp["items"][0]["id"], p1.as_str());
    let p2_page = publish(&h, &u, &p2, "project", &[]).await;
    assert_eq!(h.req(&scoped, "GET", &format!("/api/pages/{p2_page}"), None).await.status, 404);
    assert_eq!(h.req(&scoped, "GET", &format!("/api/pages/{p2_page}/responses"), None).await.status, 404);
    let r = h.req(&scoped, "POST", "/api/pages", Some(json!({ "project_id": p2, "title": "t", "kind": "openui", "content": "x", "visibility": "project" }))).await;
    assert_eq!(r.status, 404);
    let listed = h.req(&scoped, "GET", "/api/pages", None).await.ok(200);
    assert!(listed["items"].as_array().unwrap().iter().all(|p| p["project_id"] == p1.as_str()));
    // 带 Authorization 时忽略 cookie：无效 token → 401
    let mixed = C { bearer: Some("arp_invalid".into()), ..u.clone() };
    assert_eq!(h.req(&mixed, "GET", "/api/auth/me", None).await.code(), "unauthenticated");
    let mixed = C { bearer: Some("not-a-pat".into()), ..u.clone() };
    assert_eq!(h.req(&mixed, "GET", "/api/auth/me", None).await.status, 401);

    // 有效权限 = 用户权限 ∩ PAT：用户被降为 viewer 后 PAT 立即不能发布
    let owner2 = register(&h, "o2@example.com").await;
    let org2 = create_org(&h, &owner2, "o2").await;
    let proj2 = create_project(&h, &owner2, &org2, "x").await;
    let v = register(&h, "v@example.com").await;
    join_org(&h, &owner2, &org2, &v, "member").await;
    add_project_member(&h, &owner2, &proj2, &v, "editor").await;
    let (vpat, _) = create_pat(&h, &v, &["publish"], None, None).await;
    publish(&h, &vpat, &proj2, "project", &[]).await;
    h.req(&owner2, "PATCH", &format!("/api/projects/{proj2}/members/{}", v.user_id), Some(json!({ "role": "viewer" }))).await.ok(200);
    let r = h.req(&vpat, "POST", "/api/pages", Some(json!({ "project_id": proj2, "title": "t", "kind": "openui", "content": "x", "visibility": "project" }))).await;
    assert_eq!(r.status, 403);

    // 吊销 / 过期 → 401
    h.req(&u, "DELETE", &format!("/api/tokens/{pub_id}"), None).await.ok(204);
    assert_eq!(h.req(&pub_pat, "GET", "/api/me/projects", None).await.status, 401);
    sqlx::query("UPDATE personal_access_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1::uuid").bind(&u.user_id).execute(&h.db).await.unwrap();
    assert_eq!(h.req(&reader, "GET", "/api/me/projects", None).await.status, 401);
    // created_via_pat / last_used_at 留痕
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM pages WHERE created_via_pat IS NOT NULL").fetch_one(&h.db).await.unwrap();
    assert!(n >= 2);
    let used = h.req(&u, "GET", "/api/tokens?include_revoked=true", None).await.ok(200);
    assert!(used["items"].as_array().unwrap().iter().any(|t| !t["last_used_at"].is_null()));
}

/// design §5.1 硬性要求：用 B 的 session 和 B 的 PAT 请求 A 的每类资源，一律 404
#[tokio::test]
async fn cross_tenant_404_matrix() {
    let h = H::new().await;
    let a = register(&h, "a@example.com").await;
    let a2 = register(&h, "a2@example.com").await;
    let org = create_org(&h, &a, "alpha").await;
    join_org(&h, &a, &org, &a2, "member").await;
    let proj = create_project(&h, &a, &org, "p").await;
    add_project_member(&h, &a, &proj, &a2, "viewer").await;
    let grp = create_group(&h, &a, &org, "g").await;
    h.req(&a, "POST", &format!("/api/groups/{grp}/members"), Some(json!({ "user_id": a2.user_id }))).await.ok(201);
    h.req(&a, "PUT", &format!("/api/projects/{proj}/groups/{grp}"), Some(json!({ "role": "viewer" }))).await.ok(200);
    let page = publish(&h, &a, &proj, "project", &[]).await;
    let link = s(&h.req(&a, "POST", &format!("/api/pages/{page}/share-links"), Some(json!({ "expires_in": 3600 }))).await.ok(201)["share_link"]["id"]);
    let inv = s(&h.req(&a, "POST", &format!("/api/orgs/{org}/invites"), Some(json!({ "target_type": "org", "role": "member" }))).await.ok(201)["invite"]["id"]);
    let (_, a_pat) = create_pat(&h, &a, &["publish"], None, None).await;
    submit_anon(&h, &publish(&h, &a, &proj, "public", &[]).await).await;

    let b = register(&h, "b@example.com").await;
    let b_org = create_org(&h, &b, "beta").await;
    let b_proj = create_project(&h, &b, &b_org, "p").await;
    let (b_pat, _) = create_pat(&h, &b, &["publish", "read_responses"], None, None).await;
    let (b_pat_org, _) = create_pat(&h, &b, &["publish", "read_responses"], Some(&b_org), None).await;

    let u = a2.user_id.clone();
    let page_body = json!({ "project_id": proj, "title": "t", "kind": "openui", "content": "x", "visibility": "project" });
    let cases: Vec<(&str, String, Option<Value>)> = vec![
        ("GET", format!("/api/orgs/{org}"), None),
        ("PATCH", format!("/api/orgs/{org}"), Some(json!({ "name": "x" }))),
        ("DELETE", format!("/api/orgs/{org}"), Some(json!({ "confirm_slug": "alpha" }))),
        ("GET", format!("/api/orgs/{org}/members"), None),
        ("PATCH", format!("/api/orgs/{org}/members/{u}"), Some(json!({ "role": "admin" }))),
        ("DELETE", format!("/api/orgs/{org}/members/{u}"), None),
        ("GET", format!("/api/orgs/{org}/audit"), None),
        ("GET", format!("/api/orgs/{org}/projects"), None),
        ("POST", format!("/api/orgs/{org}/projects"), Some(json!({ "name": "x", "slug": "x" }))),
        ("GET", format!("/api/projects/{proj}"), None),
        ("PATCH", format!("/api/projects/{proj}"), Some(json!({ "name": "x" }))),
        ("DELETE", format!("/api/projects/{proj}"), None),
        ("GET", format!("/api/projects/{proj}/members"), None),
        ("POST", format!("/api/projects/{proj}/members"), Some(json!({ "user_id": b.user_id, "role": "viewer" }))),
        ("PATCH", format!("/api/projects/{proj}/members/{u}"), Some(json!({ "role": "editor" }))),
        ("DELETE", format!("/api/projects/{proj}/members/{u}"), None),
        ("GET", format!("/api/projects/{proj}/groups"), None),
        ("PUT", format!("/api/projects/{proj}/groups/{grp}"), Some(json!({ "role": "viewer" }))),
        ("DELETE", format!("/api/projects/{proj}/groups/{grp}"), None),
        ("GET", format!("/api/projects/{proj}/invites"), None),
        ("GET", format!("/api/orgs/{org}/groups"), None),
        ("POST", format!("/api/orgs/{org}/groups"), Some(json!({ "name": "x" }))),
        ("GET", format!("/api/groups/{grp}"), None),
        ("PATCH", format!("/api/groups/{grp}"), Some(json!({ "name": "x" }))),
        ("DELETE", format!("/api/groups/{grp}"), None),
        ("GET", format!("/api/groups/{grp}/members"), None),
        ("POST", format!("/api/groups/{grp}/members"), Some(json!({ "user_id": b.user_id }))),
        ("DELETE", format!("/api/groups/{grp}/members/{u}"), None),
        ("GET", format!("/api/orgs/{org}/invites"), None),
        ("POST", format!("/api/orgs/{org}/invites"), Some(json!({ "target_type": "org", "role": "member" }))),
        ("DELETE", format!("/api/invites/{inv}"), None),
        ("DELETE", format!("/api/tokens/{a_pat}"), None),
        ("POST", "/api/tokens".into(), Some(json!({ "name": "x", "scopes": ["publish"], "org_id": org }))),
        ("POST", "/api/pages".into(), Some(page_body)),
        ("GET", format!("/api/pages/{page}"), None),
        ("PATCH", format!("/api/pages/{page}"), Some(json!({ "title": "x" }))),
        ("DELETE", format!("/api/pages/{page}"), None),
        ("GET", format!("/api/pages/{page}/view"), None),
        ("GET", format!("/api/pages/{page}/share-links"), None),
        ("POST", format!("/api/pages/{page}/share-links"), Some(json!({ "expires_in": 3600 }))),
        ("DELETE", format!("/api/share-links/{link}"), None),
        ("POST", format!("/api/pages/{page}/responses"), Some(json!({ "data": {}, "nickname": "n" }))),
        ("GET", format!("/api/pages/{page}/responses"), None),
        ("GET", format!("/api/pages/{page}/responses/stream"), None),
        ("GET", format!("/api/pages/{page}/responses.csv"), None),
    ];
    for who in [&b, &b_pat, &b_pat_org] {
        for (m, p, body) in &cases {
            let r = h.req(who, m, p, body.clone()).await;
            assert_eq!(r.status, 404, "{} {m} {p}: {}", if who.bearer.is_some() { "PAT" } else { "session" }, r.text());
            assert_eq!(r.code(), "not_found");
        }
    }
    // 以 B 自己的容器引用 A 的子资源（这些端点仅 cookie 可用，B 的 PAT 在此一律 403，与 A 的 id 无关）
    let own_container: Vec<(&str, String, Value)> = vec![
        ("PUT", format!("/api/projects/{b_proj}/groups/{grp}"), json!({ "role": "viewer" })),
        ("POST", format!("/api/orgs/{b_org}/invites"), json!({ "target_type": "project", "project_id": proj, "role": "viewer" })),
        ("POST", format!("/api/orgs/{b_org}/invites"), json!({ "target_type": "group", "group_id": grp, "role": "member" })),
    ];
    for (m, p, body) in &own_container {
        let r = h.req(&b, m, p, Some(body.clone())).await;
        assert_eq!((r.status, r.code()), (404, "not_found".into()), "{m} {p}");
    }
    // 列表类端点不泄露 A 的数据
    for who in [&b, &b_pat] {
        let pages = h.req(who, "GET", "/api/pages", None).await.ok(200);
        assert_eq!(pages["items"], json!([]));
        let mp = h.req(who, "GET", "/api/me/projects", None).await.ok(200);
        assert!(mp["items"].as_array().unwrap().iter().all(|p| p["org"]["id"] == b_org.as_str()));
        let q = h.req(who, "GET", &format!("/api/pages?project_id={proj}"), None).await.ok(200);
        assert_eq!(q["items"], json!([]));
    }
    // 引用别的组织的群组作为受众 → 400；数据库复合外键兜底
    let r = h.req(&b, "POST", "/api/pages", Some(json!({ "project_id": b_proj, "title": "t", "kind": "openui", "content": "x", "visibility": "groups", "group_ids": [grp] }))).await;
    assert_eq!(r.status, 400);
    let fk = sqlx::query("INSERT INTO project_groups (org_id, project_id, group_id, role) VALUES ($1::uuid, $2::uuid, $3::uuid, 'viewer')")
        .bind(&b_org)
        .bind(&b_proj)
        .bind(&grp)
        .execute(&h.db)
        .await;
    assert!(fk.is_err());
    // A 的数据未被改动
    assert_eq!(h.req(&a, "GET", &format!("/api/orgs/{org}"), None).await.ok(200)["name"], "alpha");
    assert_eq!(h.req(&a, "GET", &format!("/api/pages/{page}"), None).await.ok(200)["title"], "页面");
}

/// MCP 的 list_targets / tkanban targets 只用 PAT 调 /api/me/projects + /api/orgs/{id}/groups：
/// 只返回 PAT 范围内的项目，can_publish 只在有发布权时为 true，范围外组织的群组一律 404
#[tokio::test]
async fn pat_lists_publish_targets() {
    let h = H::new().await;
    let u = register(&h, "t@example.com").await;
    let o1 = create_org(&h, &u, "t1").await;
    let p1 = create_project(&h, &u, &o1, "a").await;
    let p1b = create_project(&h, &u, &o1, "b").await;
    create_group(&h, &u, &o1, "g1").await;
    // 另一个组织里 u 只是 member + 项目 viewer；还有一个 u 无角色的项目
    let owner = register(&h, "t-owner@example.com").await;
    let o2 = create_org(&h, &owner, "t2").await;
    let p2 = create_project(&h, &owner, &o2, "view").await;
    create_project(&h, &owner, &o2, "hidden").await;
    create_group(&h, &owner, &o2, "g2").await;
    join_org(&h, &owner, &o2, &u, "member").await;
    add_project_member(&h, &owner, &p2, &u, "viewer").await;

    let (all, _) = create_pat(&h, &u, &["publish"], None, None).await;
    let items = h.req(&all, "GET", "/api/me/projects", None).await.ok(200)["items"].as_array().unwrap().clone();
    let pick = |id: &str| items.iter().find(|p| p["id"] == id).cloned();
    assert_eq!(items.len(), 3, "无角色的项目不出现：{items:?}");
    assert_eq!(pick(&p1).unwrap()["can_publish"], true);
    assert_eq!(pick(&p2).unwrap()["can_publish"], false);
    assert_eq!(h.req(&all, "GET", &format!("/api/orgs/{o2}/groups"), None).await.ok(200)["items"][0]["name"], "g2");

    // 组织范围：只有 o1 的项目，o2 的群组 404
    let (org_pat, _) = create_pat(&h, &u, &["publish"], Some(&o1), None).await;
    let mp = h.req(&org_pat, "GET", "/api/me/projects", None).await.ok(200);
    assert!(mp["items"].as_array().unwrap().iter().all(|p| p["org"]["id"] == o1.as_str()));
    assert_eq!(mp["items"].as_array().unwrap().len(), 2);
    assert_eq!(h.req(&org_pat, "GET", &format!("/api/orgs/{o2}/groups"), None).await.status, 404);

    // 项目范围：只有 p1b，但仍可列出所属组织的群组（发布到群组需要）
    let (proj_pat, _) = create_pat(&h, &u, &["publish"], Some(&o1), Some(&p1b)).await;
    let mp = h.req(&proj_pat, "GET", "/api/me/projects", None).await.ok(200);
    assert_eq!(mp["items"].as_array().unwrap().len(), 1);
    assert_eq!(mp["items"][0]["id"], p1b.as_str());
    assert_eq!(h.req(&proj_pat, "GET", &format!("/api/orgs/{o1}/groups"), None).await.ok(200)["items"][0]["name"], "g1");
    assert_eq!(h.req(&proj_pat, "GET", &format!("/api/orgs/{o2}/groups"), None).await.status, 404);
}

#[tokio::test]
async fn manage_scope_and_project_groups() {
    let h = H::new().await;
    let owner = register(&h, "owner@example.com").await;
    let padmin = register(&h, "padmin@example.com").await;
    let pviewer = register(&h, "pviewer@example.com").await;
    let mate = register(&h, "mate@example.com").await;
    let outsider = register(&h, "outsider@example.com").await;
    let org = create_org(&h, &owner, "acme").await;
    for u in [&padmin, &pviewer, &mate] {
        join_org(&h, &owner, &org, u, "member").await;
    }
    let other_org = create_org(&h, &outsider, "other").await;

    // manage PAT：成员可建项目（自己成为项目 admin）；项目级 PAT 不能建项目；越界组织 404
    let (mpat, _) = create_pat(&h, &padmin, &["manage"], None, None).await;
    let orgs = h.req(&mpat, "GET", "/api/orgs", None).await.ok(200);
    assert_eq!(orgs["items"].as_array().unwrap().len(), 1);
    let p = h.req(&mpat, "POST", &format!("/api/orgs/{org}/projects"), Some(json!({ "name": "设计", "slug": "design" }))).await.ok(201);
    assert_eq!(p["my_role"], "admin");
    let proj = s(&p["id"]);
    let proj2 = create_project(&h, &owner, &org, "ops").await;
    let (ppat, _) = create_pat(&h, &padmin, &["manage", "publish"], Some(&org), Some(&proj)).await;
    let r = h.req(&ppat, "POST", &format!("/api/orgs/{org}/projects"), Some(json!({ "name": "x", "slug": "x" }))).await;
    assert_eq!((r.status, r.code()), (403, "project_scoped_token".into()));
    assert_eq!(h.req(&mpat, "POST", &format!("/api/orgs/{other_org}/projects"), Some(json!({ "name": "x", "slug": "x" }))).await.status, 404);
    // 组织级群组仍要求 org admin（manage PAT 也一样）
    assert_eq!(h.req(&mpat, "POST", &format!("/api/orgs/{org}/groups"), Some(json!({ "name": "x" }))).await.status, 403);
    let (opat, _) = create_pat(&h, &owner, &["manage"], None, None).await;
    let org_grp = s(&h.req(&opat, "POST", &format!("/api/orgs/{org}/groups"), Some(json!({ "name": "评审组" }))).await.ok(201)["id"]);

    // 项目群组：manage PAT 建，自动授权 viewer、创建者与 members（邮箱/UUID）入组
    add_project_member(&h, &padmin, &proj, &pviewer, "viewer").await;
    let g = h
        .req(&mpat, "POST", &format!("/api/projects/{proj}/groups"), Some(json!({ "name": "前端组", "members": ["MATE@example.com", pviewer.user_id] })))
        .await
        .ok(201);
    assert_eq!((g["project_id"].as_str(), g["role"].as_str(), g["member_count"].as_i64()), (Some(proj.as_str()), Some("viewer"), Some(3)));
    let grp = s(&g["id"]);
    // mate 原本没有项目角色，入组后获得 viewer
    assert_eq!(h.req(&mate, "GET", &format!("/api/projects/{proj}"), None).await.ok(200)["my_role"], "viewer");
    // 非组织成员 → 409；role 只能 viewer/editor；同项目重名 409；不同项目可同名；与组织级群组同名也可以
    let r = h.req(&padmin, "POST", &format!("/api/projects/{proj}/groups"), Some(json!({ "name": "x", "members": ["outsider@example.com"] }))).await;
    assert_eq!((r.status, r.code()), (409, "not_org_member".into()));
    assert_eq!(h.req(&padmin, "POST", &format!("/api/projects/{proj}/groups"), Some(json!({ "name": "x", "role": "admin" }))).await.status, 400);
    let r = h.req(&padmin, "POST", &format!("/api/projects/{proj}/groups"), Some(json!({ "name": "前端组" }))).await;
    assert_eq!((r.status, r.code()), (409, "name_taken".into()));
    let grp2 = s(&h.req(&owner, "POST", &format!("/api/projects/{proj2}/groups"), Some(json!({ "name": "前端组", "role": "editor" }))).await.ok(201)["id"]);
    h.req(&padmin, "POST", &format!("/api/projects/{proj}/groups"), Some(json!({ "name": "评审组" }))).await.ok(201);
    let r = h.req(&owner, "POST", &format!("/api/orgs/{org}/groups"), Some(json!({ "name": "评审组" }))).await;
    assert_eq!((r.status, r.code()), (409, "name_taken".into()));
    // 非项目 admin（项目 viewer、无角色成员）不能建项目群组
    assert_eq!(h.req(&pviewer, "POST", &format!("/api/projects/{proj}/groups"), Some(json!({ "name": "y" }))).await.status, 403);
    assert_eq!(h.req(&mate, "POST", &format!("/api/projects/{proj2}/groups"), Some(json!({ "name": "y" }))).await.status, 404);
    // 项目 admin 能管理自己项目的群组成员；管不了组织级群组
    h.req(&padmin, "DELETE", &format!("/api/groups/{grp}/members/{}", mate.user_id), None).await;
    h.req(&padmin, "POST", &format!("/api/groups/{grp}/members"), Some(json!({ "user_id": mate.user_id }))).await.ok(201);
    assert_eq!(h.req(&padmin, "POST", &format!("/api/groups/{org_grp}/members"), Some(json!({ "user_id": mate.user_id }))).await.status, 403);
    assert_eq!(h.req(&padmin, "PATCH", &format!("/api/groups/{grp2}"), Some(json!({ "name": "z" }))).await.status, 403);

    // 授权：项目群组不能授权给其他项目；本项目群组授权不能单独撤销；组织级群组照旧
    let r = h.req(&owner, "PUT", &format!("/api/projects/{proj}/groups/{grp2}"), Some(json!({ "role": "viewer" }))).await;
    assert_eq!((r.status, r.code()), (409, "group_belongs_to_other_project".into()));
    let r = h.req(&padmin, "DELETE", &format!("/api/projects/{proj}/groups/{grp}"), None).await;
    assert_eq!((r.status, r.code()), (409, "own_project_group".into()));
    h.req(&padmin, "PUT", &format!("/api/projects/{proj}/groups/{grp}"), Some(json!({ "role": "editor" }))).await.ok(200);
    h.req(&padmin, "PUT", &format!("/api/projects/{proj}/groups/{org_grp}"), Some(json!({ "role": "viewer" }))).await.ok(200);
    h.req(&padmin, "DELETE", &format!("/api/projects/{proj}/groups/{org_grp}"), None).await.ok(204);
    h.req(&padmin, "PUT", &format!("/api/projects/{proj}/groups/{org_grp}"), Some(json!({ "role": "viewer" }))).await.ok(200);

    // 组织群组列表：组织级 + 有角色项目的项目群组（带 project）；mate 看不到 ops 项目的群组
    let names = |v: Value| v["items"].as_array().unwrap().iter().map(|g| (s(&g["name"]), g["project_id"].as_str().map(String::from))).collect::<Vec<_>>();
    let all = names(h.req(&owner, "GET", &format!("/api/orgs/{org}/groups"), None).await.ok(200));
    assert_eq!(all.len(), 4);
    let seen = names(h.req(&mate, "GET", &format!("/api/orgs/{org}/groups"), None).await.ok(200));
    assert!(seen.iter().all(|(_, p)| p.as_deref() != Some(proj2.as_str())), "{seen:?}");
    assert_eq!(seen.len(), 3);

    // 发页面：本项目群组、组织级群组可以；别的项目的群组拒绝
    let (pub_pat, _) = create_pat(&h, &padmin, &["publish"], None, None).await;
    let body = |gs: Vec<&str>| json!({ "project_id": proj, "title": "t", "kind": "openui", "content": "root = Stack([])", "visibility": "groups", "group_ids": gs });
    let r = h.req(&pub_pat, "POST", "/api/pages", Some(body(vec![&grp2]))).await;
    assert_eq!((r.status, r.code()), (400, "group_not_in_project".into()));
    let page = publish_with(&h, &pub_pat, body(vec![&grp])).await;
    let r = h.req(&pub_pat, "PATCH", &format!("/api/pages/{page}"), Some(json!({ "group_ids": [grp2] }))).await;
    assert_eq!(r.code(), "group_not_in_project");
    publish_with(&h, &pub_pat, body(vec![&org_grp])).await;

    // 活跃：4 小时内有页面 → active；把页面时间改到 5 小时前 → 不活跃
    let list = h.req(&pub_pat, "GET", &format!("/api/projects/{proj}/groups"), None).await.ok(200);
    let items = list["items"].as_array().unwrap();
    assert_eq!(items.len(), 3);
    // 项目群组在前，组织级在后
    assert!(items[0]["project_id"].is_string() && items[2]["project_id"].is_null(), "{list}");
    let find = |id: &str| items.iter().find(|g| g["id"] == id).unwrap().clone();
    let fg = find(&grp);
    assert_eq!((fg["active"].as_bool(), fg["member_count"].as_i64(), fg["role"].as_str()), (Some(true), Some(3), Some("editor")));
    assert!(fg["last_page_at"].is_string());
    assert_eq!(find(&org_grp)["active"], true);
    let idle = items.iter().find(|g| g["name"] == "评审组" && g["project_id"].is_string()).unwrap();
    assert_eq!((idle["active"].as_bool(), idle["last_page_at"].is_null()), (Some(false), true));
    sqlx::query("UPDATE pages SET created_at = now() - interval '5 hours', updated_at = now() - interval '5 hours' WHERE id = $1")
        .bind(uuid::Uuid::parse_str(&page).unwrap())
        .execute(&h.db)
        .await
        .unwrap();
    let list = h.req(&padmin, "GET", &format!("/api/projects/{proj}/groups"), None).await.ok(200);
    let g = list["items"].as_array().unwrap().iter().find(|g| g["id"] == grp.as_str()).unwrap().clone();
    assert_eq!((g["active"].as_bool(), g["last_page_at"].is_string()), (Some(false), true));

    // 删除项目群组：授权、成员一起消失
    h.req(&padmin, "DELETE", &format!("/api/groups/{grp}"), None).await.ok(204);
    assert_eq!(h.req(&mate, "GET", &format!("/api/projects/{proj}"), None).await.status, 404);
}

#[tokio::test]
async fn audience_without_project_role_sees_groups_page_in_list() {
    let h = H::new().await;
    let owner = register(&h, "owner@example.com").await;
    let grouped = register(&h, "grouped@example.com").await;
    let member = register(&h, "member@example.com").await;
    let org = create_org(&h, &owner, "acme").await;
    join_org(&h, &owner, &org, &grouped, "member").await;
    join_org(&h, &owner, &org, &member, "member").await;
    let proj = create_project(&h, &owner, &org, "p").await;
    // 旧式组织级群组：不授权给项目，只作为页面受众
    let grp = create_group(&h, &owner, &org, "g").await;
    h.req(&owner, "POST", &format!("/api/groups/{grp}/members"), Some(json!({ "user_id": grouped.user_id }))).await.ok(201);
    let gpage = publish(&h, &owner, &proj, "groups", &[&grp]).await;
    let ppage = publish(&h, &owner, &proj, "project", &[]).await;
    let ids = |v: Value| v["items"].as_array().unwrap().iter().map(|p| s(&p["id"])).collect::<Vec<_>>();
    assert_eq!(ids(h.req(&grouped, "GET", "/api/pages", None).await.ok(200)), vec![gpage.clone()]);
    assert!(ids(h.req(&member, "GET", "/api/pages", None).await.ok(200)).is_empty());
    h.req(&grouped, "GET", &format!("/api/pages/{gpage}/view"), None).await.ok(200);
    assert_eq!(h.req(&grouped, "GET", &format!("/api/pages/{ppage}/view"), None).await.status, 404);
    // 动态流同口径
    let act = h.req(&grouped, "GET", "/api/activity", None).await.ok(200);
    assert!(act.to_string().contains(&gpage) && !act.to_string().contains(&ppage), "{act}");
    let act = h.req(&member, "GET", "/api/activity", None).await.ok(200);
    assert!(!act.to_string().contains(&gpage), "{act}");
    // 旧组织级群组 project_id 为 null，授权行为不变
    let g = h.req(&owner, "GET", &format!("/api/groups/{grp}"), None).await.ok(200);
    assert!(g["project_id"].is_null() && g["project"].is_null());
}
