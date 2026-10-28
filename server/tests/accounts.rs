//! 组织管理员直接建账号、首次登录强制改密、重置一次性密码（api.md §3、§4.2）
mod common;

use common::*;
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

async fn create_account(h: &H, c: &C, org: &str, body: Value) -> R {
    h.req(c, "POST", &format!("/api/orgs/{org}/members/accounts"), Some(body)).await
}

async fn password_hash(h: &H, email: &str) -> String {
    sqlx::query_scalar("SELECT password_hash FROM users WHERE email = $1").bind(email).fetch_one(&h.db).await.unwrap()
}

#[tokio::test]
async fn admin_creates_account_with_projects_and_groups() {
    let h = H::new().await;
    let owner = register(&h, "owner@example.com").await;
    let org = create_org(&h, &owner, "o").await;
    let p1 = create_project(&h, &owner, &org, "p1").await;
    let p2 = create_project(&h, &owner, &org, "p2").await;
    let og = create_group(&h, &owner, &org, "org-group").await;
    let pg = s(&h.req(&owner, "POST", &format!("/api/projects/{p1}/groups"), Some(json!({ "name": "p1-group" }))).await.ok(201)["id"]);
    let pg2 = s(&h.req(&owner, "POST", &format!("/api/projects/{p2}/groups"), Some(json!({ "name": "p2-group" }))).await.ok(201)["id"]);
    let admin = register(&h, "admin@example.com").await;
    invite(&h, &owner, &org, json!({ "target_type": "org", "role": "admin" }), &admin).await;
    let member = register(&h, "member@example.com").await;
    invite(&h, &owner, &org, json!({ "target_type": "org", "role": "member" }), &member).await;

    // 普通成员 403；PAT（哪怕 manage scope）403
    let body = json!({ "email": "new@example.com", "display_name": "New", "role": "member" });
    assert_eq!(create_account(&h, &member, &org, body.clone()).await.status, 403);
    let (pat, _) = create_pat(&h, &owner, &["publish", "read_responses", "manage"], None, None).await;
    assert_eq!(create_account(&h, &pat, &org, body.clone()).await.status, 403);
    // 非成员组织 404
    let other = register(&h, "other@example.com").await;
    let org2 = create_org(&h, &other, "o2").await;
    assert_eq!(create_account(&h, &owner, &org2, body.clone()).await.status, 404);

    // admin 不能授予 admin（与组织邀请一致，只有 owner 能）；owner 角色不能这样建
    let r = create_account(&h, &admin, &org, json!({ "email": "x@example.com", "display_name": "X", "role": "admin" })).await;
    assert_eq!(r.status, 403);
    let r = create_account(&h, &owner, &org, json!({ "email": "x@example.com", "display_name": "X", "role": "owner" })).await;
    assert_eq!(r.status, 400);
    // 手填密码按注册强度校验
    let r = create_account(&h, &admin, &org, json!({ "email": "x@example.com", "display_name": "X", "role": "member", "password": "short" })).await;
    assert_eq!(r.status, 400);

    // 项目/群组必须属于本组织；项目群组只能是所选项目的
    let foreign_p = create_project(&h, &other, &org2, "fp").await;
    let foreign_g = create_group(&h, &other, &org2, "fg").await;
    for bad in [
        json!({ "projects": [{ "project_id": foreign_p, "role": "viewer" }] }),
        json!({ "group_ids": [foreign_g] }),
        json!({ "group_ids": [pg2], "projects": [{ "project_id": p1, "role": "viewer" }] }),
        json!({ "projects": [{ "project_id": p1, "role": "owner" }] }),
    ] {
        let mut b = json!({ "email": "x@example.com", "display_name": "X", "role": "member" });
        b.as_object_mut().unwrap().extend(bad.as_object().unwrap().clone());
        assert_eq!(create_account(&h, &admin, &org, b).await.status, 400);
    }
    // 校验失败的请求没有留下账号
    assert_eq!(login(&h, "x@example.com", "whatever-123").await.status, 401);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE email = 'x@example.com'").fetch_one(&h.db).await.unwrap();
    assert_eq!(n, 0);

    // admin 建 member 成功：系统生成密码，只在响应里出现一次
    let r = create_account(
        &h,
        &admin,
        &org,
        json!({
            "email": " New@Example.com ", "display_name": "New", "role": "member",
            "projects": [{ "project_id": p1, "role": "editor" }], "group_ids": [og, pg],
        }),
    )
    .await
    .ok(201);
    let pw = s(&r["generated_password"]);
    assert!(pw.len() >= 16, "{pw}");
    assert_eq!(r["member"]["user"]["email"], "new@example.com");
    assert_eq!(r["member"]["role"], "member");
    assert_eq!(r["member"]["must_change_password"], true);
    let uid = s(&r["member"]["user"]["id"]);
    let pm: String = sqlx::query_scalar("SELECT role FROM project_members WHERE project_id = $1::uuid AND user_id = $2::uuid")
        .bind(&p1)
        .bind(&uid)
        .fetch_one(&h.db)
        .await
        .unwrap();
    assert_eq!(pm, "editor");
    let gn: i64 = sqlx::query_scalar("SELECT count(*) FROM group_members WHERE user_id = $1::uuid").bind(&uid).fetch_one(&h.db).await.unwrap();
    assert_eq!(gn, 2);
    let verified: bool = sqlx::query_scalar("SELECT email_verified_at IS NOT NULL FROM users WHERE id = $1::uuid").bind(&uid).fetch_one(&h.db).await.unwrap();
    assert!(verified);

    // 明文密码不在审计、不在成员列表；审计有角色/项目/群组
    let audit = h.req(&owner, "GET", &format!("/api/orgs/{org}/audit?action=member.account_create"), None).await.ok(200);
    let e = &audit["items"][0];
    assert_eq!(e["target_id"], uid.as_str());
    assert_eq!(e["actor"]["user"]["id"], admin.user_id.as_str());
    assert_eq!(e["meta"]["role"], "member");
    assert_eq!(e["meta"]["projects"][0]["role"], "editor");
    assert_eq!(e["meta"]["group_ids"].as_array().unwrap().len(), 2);
    assert_eq!(e["meta"]["password"], "generated");
    assert!(!audit.to_string().contains(&pw));
    let members = h.req(&admin, "GET", &format!("/api/orgs/{org}/members?q=new"), None).await.ok(200);
    assert!(!members.to_string().contains(&pw));
    assert_eq!(members["items"][0]["must_change_password"], true);
    // 普通成员看不到待改密标记
    let members = h.req(&member, "GET", &format!("/api/orgs/{org}/members?q=new"), None).await.ok(200);
    assert!(members["items"][0].get("must_change_password").is_none());

    // owner 可以建 admin，手填密码不回显
    let r = create_account(&h, &owner, &org, json!({ "email": "boss@example.com", "display_name": "Boss", "role": "admin", "password": "manual-pass-123" }))
        .await
        .ok(201);
    assert!(r["generated_password"].is_null());
    assert_eq!(r["member"]["role"], "admin");
    login_ok(&h, "boss@example.com", "manual-pass-123").await;
}

#[tokio::test]
async fn existing_email_conflicts_without_touching_user() {
    let h = H::new().await;
    let owner = register(&h, "owner@example.com").await;
    let org = create_org(&h, &owner, "o").await;
    let member = register(&h, "member@example.com").await;
    invite(&h, &owner, &org, json!({ "target_type": "org", "role": "member" }), &member).await;
    register(&h, "outsider@example.com").await;
    let before = password_hash(&h, "outsider@example.com").await;

    let r = create_account(&h, &owner, &org, json!({ "email": "member@example.com", "display_name": "M", "role": "member", "password": "new-pass-1234" })).await;
    assert_eq!((r.status, r.code().as_str()), (409, "already_member"));
    let r = create_account(&h, &owner, &org, json!({ "email": "Outsider@example.com", "display_name": "O", "role": "member", "password": "new-pass-1234" })).await;
    assert_eq!((r.status, r.code().as_str()), (409, "email_registered"));
    assert!(!r.text().contains("outsider"), "不回显外部用户信息：{}", r.text());
    // 外部用户密码、组织关系都没变，旧密码照常登录
    assert_eq!(password_hash(&h, "outsider@example.com").await, before);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'outsider@example.com'")
        .fetch_one(&h.db)
        .await
        .unwrap();
    assert_eq!(n, 0);
    login_ok(&h, "outsider@example.com", "password-123").await;
    assert_eq!(login(&h, "outsider@example.com", "new-pass-1234").await.status, 401);
}

#[tokio::test]
async fn first_login_must_change_password() {
    let h = H::new().await;
    let owner = register(&h, "owner@example.com").await;
    let org = create_org(&h, &owner, "o").await;
    let p1 = create_project(&h, &owner, &org, "p1").await;
    let r = create_account(&h, &owner, &org, json!({ "email": "new@example.com", "display_name": "New", "role": "member", "projects": [{ "project_id": p1, "role": "viewer" }] }))
        .await
        .ok(201);
    let pw = s(&r["generated_password"]);

    let u = login_ok(&h, "new@example.com", &pw).await;
    let me = h.req(&u, "GET", "/api/auth/me", None).await.ok(200);
    assert_eq!(me["user"]["must_change_password"], true);
    // 改密码前其它 API 一律 403 password_change_required（含建 PAT、查项目、建组织）
    for (m, p, b) in [
        ("GET", format!("/api/orgs/{org}/projects"), None),
        ("GET", format!("/api/projects/{p1}"), None),
        ("GET", "/api/tokens".to_string(), None),
        ("POST", "/api/tokens".to_string(), Some(json!({ "name": "t", "scopes": ["publish"] }))),
        ("POST", "/api/orgs".to_string(), Some(json!({ "name": "x", "slug": "x" }))),
        ("PATCH", "/api/auth/me".to_string(), Some(json!({ "display_name": "Hack" }))),
    ] {
        let r = h.req(&u, m, &p, b).await;
        assert_eq!((r.status, r.code().as_str()), (403, "password_change_required"), "{m} {p}");
    }
    // 新密码不能和初始密码相同
    let r = h.req(&u, "POST", "/api/auth/password/change", Some(json!({ "current_password": pw, "new_password": pw }))).await;
    assert_eq!(r.status, 400);
    h.req(&u, "POST", "/api/auth/password/change", Some(json!({ "current_password": pw, "new_password": "my-own-pass-123" }))).await.ok(204);
    let me = h.req(&u, "GET", "/api/auth/me", None).await.ok(200);
    assert_eq!(me["user"]["must_change_password"], false);
    h.req(&u, "GET", &format!("/api/projects/{p1}"), None).await.ok(200);
    h.req(&u, "GET", &format!("/api/orgs/{org}/projects"), None).await.ok(200);
    // 旧密码失效
    assert_eq!(login(&h, "new@example.com", &pw).await.status, 401);
    login_ok(&h, "new@example.com", "my-own-pass-123").await;

    // 登出在改密前也可用
    let r = create_account(&h, &owner, &org, json!({ "email": "n2@example.com", "display_name": "N2", "role": "member" })).await.ok(201);
    let u2 = login_ok(&h, "n2@example.com", &s(&r["generated_password"])).await;
    h.req(&u2, "POST", "/api/auth/logout", None).await.ok(204);
}

#[tokio::test]
async fn reset_one_time_password_only_before_first_change() {
    let h = H::new().await;
    let owner = register(&h, "owner@example.com").await;
    let org = create_org(&h, &owner, "o").await;
    let admin = register(&h, "admin@example.com").await;
    invite(&h, &owner, &org, json!({ "target_type": "org", "role": "admin" }), &admin).await;
    let legacy = register(&h, "legacy@example.com").await;
    invite(&h, &owner, &org, json!({ "target_type": "org", "role": "member" }), &legacy).await;
    let r = create_account(&h, &admin, &org, json!({ "email": "new@example.com", "display_name": "New", "role": "member" })).await.ok(201);
    let uid = s(&r["member"]["user"]["id"]);
    let pw1 = s(&r["generated_password"]);
    let u = login_ok(&h, "new@example.com", &pw1).await;

    let reset = |c: C, user: String, body: Value| {
        let h = &h;
        let org = org.clone();
        async move { h.req(&c, "POST", &format!("/api/orgs/{org}/members/{user}/reset-password"), Some(body)).await }
    };
    // 普通成员 / PAT 不能重置
    assert_eq!(reset(legacy.clone(), uid.clone(), json!({})).await.status, 403);
    let (pat, _) = create_pat(&h, &admin, &["manage"], None, None).await;
    assert_eq!(reset(pat, uid.clone(), json!({})).await.status, 403);
    // 旧用户（正常使用的账号）不能被重置
    let before = password_hash(&h, "legacy@example.com").await;
    let r = reset(admin.clone(), legacy.user_id.clone(), json!({})).await;
    assert_eq!((r.status, r.code().as_str()), (409, "password_in_use"));
    assert_eq!(password_hash(&h, "legacy@example.com").await, before);

    // 重置成功：新一次性密码，旧会话失效，仍要改密
    let r = reset(admin.clone(), uid.clone(), json!({})).await.ok(200);
    let pw2 = s(&r["generated_password"]);
    assert_ne!(pw1, pw2);
    assert_eq!(h.req(&u, "GET", "/api/auth/me", None).await.status, 401);
    assert_eq!(login(&h, "new@example.com", &pw1).await.status, 401);
    let u = login_ok(&h, "new@example.com", &pw2).await;
    let audit = h.req(&owner, "GET", &format!("/api/orgs/{org}/audit?action=member.password_reset"), None).await.ok(200);
    assert_eq!(audit["items"][0]["target_id"], uid.as_str());
    assert!(!audit.to_string().contains(&pw2));

    // 改过密码后不能再重置
    h.req(&u, "POST", "/api/auth/password/change", Some(json!({ "current_password": pw2, "new_password": "my-own-pass-123" }))).await.ok(204);
    let r = reset(admin.clone(), uid.clone(), json!({ "password": "another-pass-123" })).await;
    assert_eq!((r.status, r.code().as_str()), (409, "password_in_use"));
    login_ok(&h, "new@example.com", "my-own-pass-123").await;
}

#[tokio::test]
async fn legacy_users_unaffected() {
    let h = H::new().await;
    let u = register(&h, "old@example.com").await;
    let me = h.req(&u, "GET", "/api/auth/me", None).await.ok(200);
    assert_eq!(me["user"]["must_change_password"], false);
    let org = create_org(&h, &u, "o").await;
    h.req(&u, "GET", &format!("/api/orgs/{org}/projects"), None).await.ok(200);
    // 旧用户改密码可以与当前相同（行为不变）
    h.req(&u, "POST", "/api/auth/password/change", Some(json!({ "current_password": "password-123", "new_password": "password-123" }))).await.ok(204);
    let (pat, _) = create_pat(&h, &u, &["publish"], None, None).await;
    h.req(&pat, "GET", "/api/orgs", None).await.ok(200);
}
