//! 页面：CRUD、四种可见性、临时链接、提交、长轮询、SSE、CSV、html 与 PAGES_ORIGIN
mod common;

use std::time::Duration;

use common::*;
use futures_util::StreamExt;
use serde_json::{Value, json};
use tower::ServiceExt;

struct World {
    owner: C,
    viewer: C,
    member: C,
    grouped: C,
    outsider: C,
    org: String,
    proj: String,
    grp: String,
}

async fn world(h: &H) -> World {
    let owner = register(h, "owner@example.com").await;
    let viewer = register(h, "viewer@example.com").await;
    let member = register(h, "member@example.com").await;
    let grouped = register(h, "grouped@example.com").await;
    let outsider = register(h, "outsider@example.com").await;
    let org = create_org(h, &owner, "acme").await;
    for u in [&viewer, &member, &grouped] {
        join_org(h, &owner, &org, u, "member").await;
    }
    let proj = create_project(h, &owner, &org, "p").await;
    add_project_member(h, &owner, &proj, &viewer, "viewer").await;
    let grp = create_group(h, &owner, &org, "g").await;
    h.req(&owner, "POST", &format!("/api/groups/{grp}/members"), Some(json!({ "user_id": grouped.user_id }))).await.ok(201);
    World { owner, viewer, member, grouped, outsider, org, proj, grp }
}

#[tokio::test]
async fn visibility_matrix() {
    let h = H::new().await;
    let w = world(&h).await;
    let anon = C::anon();
    let pages: Vec<(&str, String)> = vec![
        ("public", publish(&h, &w.owner, &w.proj, "public", &[]).await),
        ("org", publish(&h, &w.owner, &w.proj, "org", &[]).await),
        ("project", publish(&h, &w.owner, &w.proj, "project", &[]).await),
        ("groups", publish(&h, &w.owner, &w.proj, "groups", &[&w.grp]).await),
    ];
    // (身份, [public, org, project, groups] 能否查看)
    let who: Vec<(&str, &C, [bool; 4])> = vec![
        ("owner", &w.owner, [true, true, true, true]),
        ("viewer", &w.viewer, [true, true, true, false]),
        ("member", &w.member, [true, true, false, false]),
        ("grouped", &w.grouped, [true, true, false, true]),
        ("outsider", &w.outsider, [true, false, false, false]),
        ("anon", &anon, [true, false, false, false]),
    ];
    for (name, c, expect) in &who {
        for (i, (vis, page)) in pages.iter().enumerate() {
            let r = h.req(c, "GET", &format!("/api/pages/{page}/view"), None).await;
            let want = if expect[i] { 200 } else { 404 };
            assert_eq!(r.status, want, "{name} 查看 {vis}: {}", r.text());
            // 提交与查看同权
            let body = json!({ "data": { "v": vis }, "nickname": "n" });
            let r = h.req(c, "POST", &format!("/api/pages/{page}/responses"), Some(body)).await;
            assert_eq!(r.status, if expect[i] { 201 } else { 404 }, "{name} 提交 {vis}: {}", r.text());
        }
    }
    // view 内容
    let v = h.req(&w.viewer, "GET", &format!("/api/pages/{}/view", pages[0].1), None).await.ok(200);
    assert_eq!(v["content"]["kind"], "openui");
    assert_eq!(v["content"]["spec"], "root = Stack([])");
    assert_eq!(v["viewer"]["type"], "user");
    assert_eq!(v["can_manage"], false);
    assert_eq!(v["can_view_results"], false);
    assert_eq!(v["share_link"], Value::Null);
    let v = h.req(&anon, "GET", &format!("/api/pages/{}/view", pages[0].1), None).await.ok(200);
    assert_eq!(v["viewer"]["type"], "anonymous");
    assert_eq!(h.req(&w.owner, "GET", &format!("/api/pages/{}/view", pages[3].1), None).await.ok(200)["can_manage"], true);

    // 匿名提交需要昵称；登录用户的昵称被忽略
    let r = h.req(&C::anon(), "POST", &format!("/api/pages/{}/responses", pages[0].1), Some(json!({ "data": {} }))).await;
    assert_eq!((r.status, r.code()), (400, "nickname_required".into()));
    let r = h.req(&C::anon(), "POST", &format!("/api/pages/{}/responses", pages[0].1), Some(json!({ "data": {}, "nickname": " \u{7} " }))).await;
    assert_eq!(r.code(), "nickname_required");
    let r = h.req(&C::anon(), "POST", &format!("/api/pages/{}/responses", pages[0].1), Some(json!({ "data": [1], "nickname": "n" }))).await;
    assert_eq!(r.status, 400);

    // 页面列表：viewer 看不到 groups 页面；member（无项目角色）什么也看不到
    let ids = |v: Value| v["items"].as_array().unwrap().iter().map(|p| s(&p["id"])).collect::<Vec<_>>();
    let vl = ids(h.req(&w.viewer, "GET", "/api/pages", None).await.ok(200));
    assert_eq!(vl.len(), 3);
    assert!(!vl.contains(&pages[3].1));
    assert_eq!(ids(h.req(&w.member, "GET", "/api/pages", None).await.ok(200)).len(), 0);
    assert_eq!(ids(h.req(&w.owner, "GET", &format!("/api/pages?project_id={}", w.proj), None).await.ok(200)).len(), 4);
    let p1 = h.req(&w.owner, "GET", "/api/pages?limit=3", None).await.ok(200);
    let cur = s(&p1["next_cursor"]);
    assert_eq!(ids(h.req(&w.owner, "GET", &format!("/api/pages?limit=3&cursor={cur}"), None).await.ok(200)).len(), 1);

    // 管理接口：能看见但非管理者 → 403；看不见 → 404
    assert_eq!(h.req(&w.viewer, "GET", &format!("/api/pages/{}", pages[2].1), None).await.status, 403);
    assert_eq!(h.req(&w.viewer, "DELETE", &format!("/api/pages/{}", pages[2].1), None).await.status, 403);
    assert_eq!(h.req(&w.viewer, "GET", &format!("/api/pages/{}", pages[3].1), None).await.status, 404);
    assert_eq!(h.req(&w.viewer, "GET", &format!("/api/pages/{}/responses", pages[2].1), None).await.status, 403);

    // results_visible_to=viewers 时 viewer 可看实时结果
    h.req(&w.owner, "PATCH", &format!("/api/pages/{}", pages[2].1), Some(json!({ "results_visible_to": "viewers" }))).await.ok(200);
    assert_eq!(h.req(&w.viewer, "GET", &format!("/api/pages/{}/view", pages[2].1), None).await.ok(200)["can_view_results"], true);

    // 关闭提交
    h.req(&w.owner, "PATCH", &format!("/api/pages/{}", pages[0].1), Some(json!({ "accept_responses": false }))).await.ok(200);
    let v = h.req(&anon, "GET", &format!("/api/pages/{}/view", pages[0].1), None).await.ok(200);
    assert_eq!((v["can_submit"].clone(), v["submit_block_reason"].clone()), (json!(false), json!("responses_closed")));
    let r = submit_anon(&h, &pages[0].1).await;
    assert_eq!((r.status, r.code()), (409, "responses_closed".into()));

    // 改 visibility：groups → project 清空受众；org 被删后页面不可见
    let pg = h.req(&w.owner, "PATCH", &format!("/api/pages/{}", pages[3].1), Some(json!({ "visibility": "project" }))).await.ok(200);
    assert_eq!(pg["group_ids"], json!([]));
    assert_eq!(h.req(&w.grouped, "GET", &format!("/api/pages/{}/view", pages[3].1), None).await.status, 404);
    h.req(&w.owner, "DELETE", &format!("/api/orgs/{}", w.org), Some(json!({ "confirm_slug": "acme" }))).await.ok(204);
    assert_eq!(h.req(&anon, "GET", &format!("/api/pages/{}/view", pages[1].1), None).await.status, 404);
    assert_eq!(h.req(&w.owner, "GET", &format!("/api/pages/{}", pages[1].1), None).await.status, 404);
}

#[tokio::test]
async fn page_crud_and_validation() {
    let h = H::new().await;
    let w = world(&h).await;
    let base = json!({ "project_id": w.proj, "title": "t", "kind": "openui", "content": "root = Stack([])", "visibility": "project" });
    let bad = |k: &str, v: Value| {
        let mut b = base.clone();
        b[k] = v;
        b
    };
    for b in [
        bad("kind", json!("pdf")),
        bad("visibility", json!("secret")),
        bad("title", json!("")),
        bad("content", json!("x".repeat(512 * 1024 + 1))),
        bad("group_ids", json!([w.grp])),
        bad("visibility", json!("groups")),
        bad("results_visible_to", json!("all")),
    ] {
        let r = h.req(&w.owner, "POST", "/api/pages", Some(b)).await;
        assert_eq!((r.status, r.code()), (400, "validation_failed".into()), "{}", r.text());
    }
    // viewer 不能发布
    assert_eq!(h.req(&w.viewer, "POST", "/api/pages", Some(base.clone())).await.status, 403);
    // html 允许更大（6 MiB 请求体上限内）
    let big = json!({ "project_id": w.proj, "title": "h", "kind": "html", "content": "x".repeat(1024 * 1024), "visibility": "project" });
    h.req(&w.owner, "POST", "/api/pages", Some(big)).await.ok(201);
    // 其它接口 64 KiB 上限
    let r = h.req(&w.owner, "PATCH", "/api/auth/me", Some(json!({ "display_name": "x".repeat(70 * 1024) }))).await;
    assert_eq!((r.status, r.code()), (413, "payload_too_large".into()));

    let id = publish_with(&h, &w.owner, base.clone()).await;
    let got = h.req(&w.owner, "GET", &format!("/api/pages/{id}"), None).await.ok(200);
    assert_eq!((got["version"].clone(), got["content"].clone(), got["can_manage"].clone()), (json!(1), json!("root = Stack([])"), json!(true)));
    assert_eq!(got["url"], format!("{PUBLIC}/pages/{id}"));
    assert_eq!(got["created_by"]["id"], w.owner.user_id.as_str());
    // 相同内容不升版本，不同内容 +1
    let r = h.req(&w.owner, "PATCH", &format!("/api/pages/{id}"), Some(json!({ "content": "root = Stack([])" }))).await.ok(200);
    assert_eq!(r["version"], 1);
    let r = h.req(&w.owner, "PATCH", &format!("/api/pages/{id}"), Some(json!({ "content": "root = Stack([Text(\"x\")])" }))).await.ok(200);
    assert_eq!(r["version"], 2);
    assert_eq!(h.req(&w.owner, "PATCH", &format!("/api/pages/{id}"), Some(json!({}))).await.status, 400);
    let r = h.req(&w.owner, "PATCH", &format!("/api/pages/{id}"), Some(json!({ "visibility": "groups", "group_ids": [w.grp] }))).await.ok(200);
    assert_eq!(r["group_ids"], json!([w.grp]));
    assert_eq!(h.req(&w.owner, "PATCH", &format!("/api/pages/{id}"), Some(json!({ "group_ids": [] }))).await.status, 400);
    // 审计记录可见性旧→新
    let meta: Value = sqlx::query_scalar("SELECT meta FROM audit_log WHERE action = 'page.update' ORDER BY id DESC LIMIT 1").fetch_one(&h.db).await.unwrap();
    assert_eq!(meta["visibility"], json!({ "old": "project", "new": "groups" }));
    assert!(!meta.to_string().contains("Stack"), "审计不得记录页面内容");
    // 删除
    h.req(&w.owner, "DELETE", &format!("/api/pages/{id}"), None).await.ok(204);
    assert_eq!(h.req(&w.owner, "GET", &format!("/api/pages/{id}"), None).await.status, 404);
    let _ = (&w.member, &w.grouped, &w.outsider);
}

#[tokio::test]
async fn share_links() {
    let h = H::new().await;
    let w = world(&h).await;
    let page = publish(&h, &w.owner, &w.proj, "project", &[]).await;
    // viewer 不能管理临时链接
    assert_eq!(h.req(&w.viewer, "POST", &format!("/api/pages/{page}/share-links"), Some(json!({ "expires_in": 3600 }))).await.status, 403);
    assert_eq!(h.req(&w.owner, "POST", &format!("/api/pages/{page}/share-links"), Some(json!({ "expires_in": 10 }))).await.status, 400);
    assert_eq!(h.req(&w.owner, "POST", &format!("/api/pages/{page}/share-links"), Some(json!({ "expires_in": 3600, "password": "abc" }))).await.status, 400);

    let r = h.req(&w.owner, "POST", &format!("/api/pages/{page}/share-links"), Some(json!({ "expires_in": 3600, "max_uses": 2, "password": "s3cret", "label": "微信群" }))).await.ok(201);
    let token = s(&r["url"]).rsplit('/').next().unwrap().to_string();
    assert!(s(&r["url"]).starts_with(&format!("{PUBLIC}/s/")));
    assert_eq!(r["share_link"]["token_prefix"], &token[..6]);
    assert_eq!((r["share_link"]["has_password"].clone(), r["share_link"]["status"].clone()), (json!(true), json!("active")));

    let anon = C::anon();
    let r = h.req(&anon, "GET", &format!("/api/s/{token}"), None).await;
    assert_eq!((r.status, r.code()), (401, "share_password_required".into()));
    let r = h.req(&anon, "POST", &format!("/api/s/{token}/unlock"), Some(json!({ "password": "wrong" }))).await;
    assert_eq!((r.status, r.code()), (401, "share_password_invalid".into()));
    let grant = s(&h.req(&anon, "POST", &format!("/api/s/{token}/unlock"), Some(json!({ "password": "s3cret" }))).await.ok(200)["grant"]);
    let g = [("x-share-grant", grant.as_str())];
    let r = h.req(&anon, "GET", &format!("/api/s/{token}"), None).await;
    assert_eq!(r.status, 401);
    let bad_grant = format!("{grant}x");
    assert_eq!(h.raw(&anon, "GET", &format!("/api/s/{token}"), None, &[("x-share-grant", &bad_grant)]).await.status, 401);
    let v = h.raw(&anon, "GET", &format!("/api/s/{token}"), None, &g).await.ok(200);
    assert_eq!(v["share_link"]["remaining_uses"], 2);
    assert_eq!(v["share_link"]["label"], "微信群");
    assert_eq!(v["can_submit"], true);

    // 绕过 visibility：外部用户（不在组织内）凭链接提交；登录用户提交记录 user_id
    let body = r#"{"data":{"a":1},"nickname":"游客"}"#.to_string();
    h.raw(&anon, "POST", &format!("/api/s/{token}/responses"), Some(body.clone()), &g).await.ok(201);
    h.raw(&w.outsider, "POST", &format!("/api/s/{token}/responses"), Some(r#"{"data":{"a":2}}"#.into()), &g).await.ok(201);
    let r = h.raw(&anon, "POST", &format!("/api/s/{token}/responses"), Some(body.clone()), &g).await;
    assert_eq!((r.status, r.code()), (409, "share_link_exhausted".into()));
    // 用完后在过期前仍可查看
    let v = h.raw(&anon, "GET", &format!("/api/s/{token}"), None, &g).await.ok(200);
    assert_eq!((v["can_submit"].clone(), v["submit_block_reason"].clone(), v["share_link"]["remaining_uses"].clone()), (json!(false), json!("share_link_exhausted"), json!(0)));
    // 链接只授予此页面：outsider 正常访问仍 404
    assert_eq!(h.req(&w.outsider, "GET", &format!("/api/pages/{page}/view"), None).await.status, 404);
    // 提交记录
    let res = h.req(&w.owner, "GET", &format!("/api/pages/{page}/responses"), None).await.ok(200);
    assert_eq!(res["responses"][0]["respondent"], json!({ "type": "anonymous", "nickname": "游客" }));
    assert_eq!(res["responses"][0]["share_link"]["label"], "微信群");
    assert_eq!(res["responses"][1]["respondent"]["type"], "user");
    assert!(!res.to_string().contains("outsider@example.com"), "不得返回提交者 email");

    // 过期 → 410
    let link_id: uuid::Uuid = sqlx::query_scalar("SELECT id FROM share_links").fetch_one(&h.db).await.unwrap();
    sqlx::query("UPDATE share_links SET expires_at = now() - interval '1 second' WHERE id = $1").bind(link_id).execute(&h.db).await.unwrap();
    let r = h.raw(&anon, "GET", &format!("/api/s/{token}"), None, &g).await;
    assert_eq!((r.status, r.code()), (410, "share_link_expired".into()));
    let r = h.raw(&anon, "POST", &format!("/api/s/{token}/responses"), Some(body.clone()), &g).await;
    assert_eq!(r.code(), "share_link_expired");

    // 无密码、不限次数的链接；吊销 → 410
    let r = h.req(&w.owner, "POST", &format!("/api/pages/{page}/share-links"), Some(json!({ "expires_in": 600 }))).await.ok(201);
    let (id2, token2) = (s(&r["share_link"]["id"]), s(&r["url"]).rsplit('/').next().unwrap().to_string());
    let v = h.req(&anon, "GET", &format!("/api/s/{token2}"), None).await.ok(200);
    assert_eq!(v["share_link"]["remaining_uses"], Value::Null);
    for _ in 0..3 {
        h.req(&anon, "POST", &format!("/api/s/{token2}/responses"), Some(json!({ "data": {}, "nickname": "n" }))).await.ok(201);
    }
    // 列表：默认只含有效链接
    assert_eq!(h.req(&w.owner, "GET", &format!("/api/pages/{page}/share-links"), None).await.ok(200)["items"].as_array().unwrap().len(), 1);
    let all = h.req(&w.owner, "GET", &format!("/api/pages/{page}/share-links?include_inactive=true"), None).await.ok(200);
    assert_eq!(all["items"].as_array().unwrap().len(), 2);
    assert_eq!(all["items"][1]["status"], "expired");
    assert_eq!(h.req(&w.viewer, "DELETE", &format!("/api/share-links/{id2}"), None).await.status, 403);
    h.req(&w.owner, "DELETE", &format!("/api/share-links/{id2}"), None).await.ok(204);
    let r = h.req(&anon, "GET", &format!("/api/s/{token2}"), None).await;
    assert_eq!((r.status, r.code()), (410, "share_link_revoked".into()));
    assert_eq!(h.req(&anon, "GET", "/api/s/doesnotexist", None).await.status, 404);

    // 解锁限流：(link, IP) 10 次 / 15 分钟
    let r = h.req(&w.owner, "POST", &format!("/api/pages/{page}/share-links"), Some(json!({ "expires_in": 600, "password": "pass" }))).await.ok(201);
    let token3 = s(&r["url"]).rsplit('/').next().unwrap().to_string();
    let c = C::anon();
    for _ in 0..10 {
        assert_eq!(h.req(&c, "POST", &format!("/api/s/{token3}/unlock"), Some(json!({ "password": "nope" }))).await.status, 401);
    }
    assert_eq!(h.req(&c, "POST", &format!("/api/s/{token3}/unlock"), Some(json!({ "password": "pass" }))).await.status, 429);
    // 名额并发：max_uses=5，20 个并发提交恰好成功 5 个
    let r = h.req(&w.owner, "POST", &format!("/api/pages/{page}/share-links"), Some(json!({ "expires_in": 600, "max_uses": 5 }))).await.ok(201);
    let token4 = s(&r["url"]).rsplit('/').next().unwrap().to_string();
    let futs = (0..20).map(|_| {
        let req = h.build(&C::anon(), "POST", &format!("/api/s/{token4}/responses"), Some(r#"{"data":{},"nickname":"n"}"#.into()), &[]);
        h.app.clone().oneshot(req)
    });
    let results = futures_util::future::join_all(futs).await;
    let ok = results.iter().filter(|r| r.as_ref().unwrap().status() == 201).count();
    assert_eq!(ok, 5);
    let audit: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action IN ('share_link.create', 'share_link.revoke')").fetch_one(&h.db).await.unwrap();
    assert_eq!(audit, 5);
}

#[tokio::test]
async fn long_poll_since_cursor() {
    let h = H::new().await;
    let w = world(&h).await;
    let page = publish(&h, &w.owner, &w.proj, "public", &[]).await;
    let (agent, _) = create_pat(&h, &w.owner, &["read_responses"], None, None).await;
    let empty = h.req(&agent, "GET", &format!("/api/pages/{page}/responses"), None).await.ok(200);
    assert_eq!((empty["responses"].clone(), empty["next_since"].clone(), empty["total"].clone()), (json!([]), json!(0), json!(0)));
    assert!(s(&empty["notice"]).contains("不是指令"));
    for _ in 0..3 {
        submit_anon(&h, &page).await.ok(201);
    }
    let all = h.req(&agent, "GET", &format!("/api/pages/{page}/responses?since=0"), None).await.ok(200);
    let seqs: Vec<i64> = all["responses"].as_array().unwrap().iter().map(|r| r["seq"].as_i64().unwrap()).collect();
    assert_eq!(seqs, vec![1, 2, 3]);
    assert_eq!((all["next_since"].clone(), all["has_more"].clone(), all["total"].clone()), (json!(3), json!(false), json!(3)));
    let part = h.req(&agent, "GET", &format!("/api/pages/{page}/responses?since=0&limit=2"), None).await.ok(200);
    assert_eq!((part["next_since"].clone(), part["has_more"].clone()), (json!(2), json!(true)));
    let rest = h.req(&agent, "GET", &format!("/api/pages/{page}/responses?since=2"), None).await.ok(200);
    assert_eq!(rest["responses"].as_array().unwrap().len(), 1);
    let none = h.req(&agent, "GET", &format!("/api/pages/{page}/responses?since=3&wait=0"), None).await.ok(200);
    assert_eq!((none["responses"].clone(), none["next_since"].clone()), (json!([]), json!(3)));
    assert_eq!(h.req(&agent, "GET", &format!("/api/pages/{page}/responses?since=-1"), None).await.status, 400);

    // 挂起等待：新提交到达即返回
    let start = std::time::Instant::now();
    let req = h.build(&agent, "GET", &format!("/api/pages/{page}/responses?since=3&wait=10"), None, &[]);
    let waiter = tokio::spawn(h.app.clone().oneshot(req));
    tokio::time::sleep(Duration::from_millis(300)).await;
    submit_anon(&h, &page).await.ok(201);
    let res = waiter.await.unwrap().unwrap();
    let body: Value = serde_json::from_slice(&axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["responses"][0]["seq"], 4);
    assert_eq!(body["next_since"], 4);
    assert!(start.elapsed() < Duration::from_secs(5));
    // 超时无数据 → 200 空数组
    let start = std::time::Instant::now();
    let r = h.req(&agent, "GET", &format!("/api/pages/{page}/responses?since=4&wait=1"), None).await.ok(200);
    assert_eq!(r["responses"], json!([]));
    assert!(start.elapsed() >= Duration::from_millis(900));
}

async fn read_until(body: &mut axum::body::BodyDataStream, buf: &mut String, needle: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !buf.contains(needle) {
            let chunk = body.next().await.expect("stream ended").unwrap();
            buf.push_str(&String::from_utf8_lossy(&chunk));
        }
    })
    .await
    .unwrap_or_else(|_| panic!("等待 {needle:?} 超时，已收到：{buf}"));
}

#[tokio::test]
async fn sse_stream() {
    let h = H::new().await;
    let w = world(&h).await;
    let page = publish(&h, &w.owner, &w.proj, "public", &[]).await;
    submit_anon(&h, &page).await.ok(201);
    // 普通查看者在 results_visible_to=managers 时不能订阅
    assert_eq!(h.req(&w.viewer, "GET", &format!("/api/pages/{page}/responses/stream"), None).await.status, 403);

    let res = h.app.clone().oneshot(h.build(&w.owner, "GET", &format!("/api/pages/{page}/responses/stream?since=0"), None, &[])).await.unwrap();
    assert_eq!(res.status(), 200);
    assert!(res.headers()["content-type"].to_str().unwrap().starts_with("text/event-stream"));
    let mut body = res.into_body().into_data_stream();
    let mut buf = String::new();
    read_until(&mut body, &mut buf, "retry: 3000").await;
    read_until(&mut body, &mut buf, "id: 1\n").await;
    assert!(buf.contains("event: response"));
    submit_anon(&h, &page).await.ok(201);
    read_until(&mut body, &mut buf, "id: 2\n").await;
    h.req(&w.owner, "PATCH", &format!("/api/pages/{page}"), Some(json!({ "accept_responses": false }))).await.ok(200);
    read_until(&mut body, &mut buf, "event: page").await;
    assert!(buf.contains(r#""accept_responses":false"#));
    h.req(&w.owner, "DELETE", &format!("/api/pages/{page}"), None).await.ok(204);
    read_until(&mut body, &mut buf, "event: end").await;
    assert!(buf.contains(r#"{"reason":"not_found"}"#));

    // Last-Event-ID 优先于 since；share 版需要 results_visible_to=viewers
    let page = publish(&h, &w.owner, &w.proj, "project", &[]).await;
    for _ in 0..3 {
        h.req(&w.viewer, "POST", &format!("/api/pages/{page}/responses"), Some(json!({ "data": {} }))).await.ok(201);
    }
    let r = h.req(&w.owner, "POST", &format!("/api/pages/{page}/share-links"), Some(json!({ "expires_in": 600 }))).await.ok(201);
    let token = s(&r["url"]).rsplit('/').next().unwrap().to_string();
    assert_eq!(h.req(&C::anon(), "GET", &format!("/api/s/{token}/responses/stream"), None).await.status, 403);
    h.req(&w.owner, "PATCH", &format!("/api/pages/{page}"), Some(json!({ "results_visible_to": "viewers" }))).await.ok(200);
    let req = h.build(&C::anon(), "GET", &format!("/api/s/{token}/responses/stream?since=0"), None, &[("last-event-id", "2")]);
    let mut body = h.app.clone().oneshot(req).await.unwrap().into_body().into_data_stream();
    let mut buf = String::new();
    read_until(&mut body, &mut buf, "id: 3\n").await;
    assert!(!buf.contains("id: 1\n") && !buf.contains("id: 2\n"));
    // 吊销链接 → 下次事件时 end
    let link_id = s(&r["share_link"]["id"]);
    h.req(&w.owner, "DELETE", &format!("/api/share-links/{link_id}"), None).await.ok(204);
    h.req(&w.viewer, "POST", &format!("/api/pages/{page}/responses"), Some(json!({ "data": {} }))).await.ok(201);
    read_until(&mut body, &mut buf, "event: end").await;
}

#[tokio::test]
async fn csv_export() {
    let h = H::new().await;
    let w = world(&h).await;
    let page = publish(&h, &w.owner, &w.proj, "public", &[]).await;
    let openui = json!({ "data": { "action": "提交", "form": "vote", "values": { "choice": "B", "tags": ["x", "y"] }, "params": {} }, "nickname": "=HYPERLINK(\"evil\")" });
    h.req(&C::anon(), "POST", &format!("/api/pages/{page}/responses"), Some(openui)).await.ok(201);
    h.req(&w.viewer, "POST", &format!("/api/pages/{page}/responses"), Some(json!({ "data": { "values": { "comment": "a,b\n\"c\"", "seq": 7 } } }))).await.ok(201);
    assert_eq!(h.req(&w.viewer, "GET", &format!("/api/pages/{page}/responses.csv"), None).await.status, 403);
    let r = h.req(&w.owner, "GET", &format!("/api/pages/{page}/responses.csv"), None).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("content-type"), "text/csv; charset=utf-8");
    assert_eq!(r.header("content-disposition"), format!("attachment; filename=\"responses-{page}.csv\""));
    let text = r.text();
    assert!(text.starts_with('\u{FEFF}'));
    let mut lines = text.trim_start_matches('\u{FEFF}').split("\r\n");
    assert_eq!(
        lines.next().unwrap(),
        "seq,created_at,respondent_type,respondent_name,user_id,share_link_label,page_version,action,form,choice,tags,comment,values.seq"
    );
    let row1 = lines.next().unwrap();
    assert!(row1.starts_with("1,"), "{row1}");
    assert!(row1.contains(r#",anonymous,"'=HYPERLINK(""evil"")","#), "CSV 注入防护：{row1}");
    assert!(row1.ends_with(",提交,vote,B,x; y,,"), "{row1}");
    assert!(text.contains("\"\"c\"\"\",7\r\n"), "与固定列同名的字段加 values. 前缀：{text}");
    assert!(text.contains("\"a,b\n\"\"c\"\"\""), "{text}");
    assert!(text.contains(",user,viewer,"));
}

#[tokio::test]
async fn html_pages_origin() {
    let h = H::with(|c| c.pages_origin = Some("http://pages.test".into())).await;
    let w = world(&h).await;
    let html = "<html><body><form data-kanban><input name=a></form></body></html>";
    let page = publish_with(&h, &w.owner, json!({ "project_id": w.proj, "title": "h", "kind": "html", "content": html, "visibility": "public" })).await;
    let v = h.req(&C::anon(), "GET", &format!("/api/pages/{page}/view"), None).await.ok(200);
    assert_eq!(v["content"]["frame_origin"], "http://pages.test");
    let url = s(&v["content"]["frame_url"]);
    let path = url.strip_prefix("http://pages.test").unwrap().to_string();
    assert!(path.starts_with(&format!("/h/{page}/1?exp=")));

    let pages_host = [("host", "pages.test")];
    let r = h.raw(&C::anon(), "GET", &path, None, &pages_host).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("content-security-policy"), format!("sandbox allow-scripts allow-forms; frame-ancestors {PUBLIC}"));
    assert_eq!(r.header("cache-control"), "private, max-age=600");
    assert_eq!(r.header("referrer-policy"), "no-referrer");
    let body = r.text();
    let script = body.find("window.kanban").expect("注入桥接脚本");
    assert!(body.contains("window.kanban=window.relay="), "保留 window.relay 别名");
    assert!(script < body.find("</body>").unwrap());
    assert!(body.contains(r#"var P="http://relay.test""#));

    // 篡改签名 / 改版本 / 主站访问 /h / pages 主机访问 /api → 404
    let tampered = format!("{path}AA");
    assert_eq!(h.raw(&C::anon(), "GET", &tampered, None, &pages_host).await.status, 404);
    assert_eq!(h.raw(&C::anon(), "GET", &path.replace("/1?", "/2?"), None, &pages_host).await.status, 404);
    assert_eq!(h.raw(&C::anon(), "GET", &path, None, &[("host", "relay.test")]).await.status, 404);
    assert_eq!(h.raw(&C::anon(), "GET", "/api/auth/me", None, &pages_host).await.status, 404);
    // 更新内容后旧版本 URL 失效
    h.req(&w.owner, "PATCH", &format!("/api/pages/{page}"), Some(json!({ "content": "<p>v2</p>" }))).await.ok(200);
    assert_eq!(h.raw(&C::anon(), "GET", &path, None, &pages_host).await.status, 404);
    // 主站安全头
    let r = h.raw(&C::anon(), "GET", "/api/auth/me", None, &[("host", "relay.test")]).await;
    assert!(r.header("content-security-policy").contains("frame-src http://pages.test"));
    assert_eq!(r.header("referrer-policy"), "no-referrer");
    assert_eq!(r.header("x-content-type-options"), "nosniff");
}

#[tokio::test]
async fn page_types_read_only() {
    let h = H::new().await;
    let w = world(&h).await;
    let base = json!({ "project_id": w.proj, "title": "t", "kind": "openui", "content": "root = Stack([])", "visibility": "public" });
    let with = |extra: Value| {
        let mut b = base.clone();
        b.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        b
    };
    // 不传 page_type（旧客户端）→ general，收集类，行为不变
    let general = h.req(&w.owner, "POST", "/api/pages", Some(base.clone())).await.ok(201);
    assert_eq!((general["page_type"].clone(), general["category"].clone(), general["accept_responses"].clone()), (json!("general"), json!("collect"), json!(true)));
    submit_anon(&h, &s(&general["id"])).await.ok(201);
    // 只读类：accept_responses 省略时为 false；显式 true → 400
    let report = h.req(&w.owner, "POST", "/api/pages", Some(with(json!({ "page_type": "report" })))).await.ok(201);
    assert_eq!((report["category"].clone(), report["accept_responses"].clone()), (json!("read"), json!(false)));
    let rid = s(&report["id"]);
    let r = h.req(&w.owner, "POST", "/api/pages", Some(with(json!({ "page_type": "flowchart", "accept_responses": true })))).await;
    assert_eq!((r.status, r.json()["error"]["details"]["fields"]["accept_responses"].is_string()), (400, true));
    let vote = h.req(&w.owner, "POST", "/api/pages", Some(with(json!({ "page_type": "vote" })))).await.ok(201);
    assert_eq!((vote["category"].clone(), vote["accept_responses"].clone()), (json!("collect"), json!(true)));
    // 非法类型 / 协作类（P1 未开放）→ 400
    for t in ["nope", "task_tree"] {
        let r = h.req(&w.owner, "POST", "/api/pages", Some(with(json!({ "page_type": t })))).await;
        assert_eq!((r.status, r.code()), (400, "validation_failed".into()), "{t}");
    }
    // 查看：read_only，不能提交
    let v = h.req(&C::anon(), "GET", &format!("/api/pages/{rid}/view"), None).await.ok(200);
    assert_eq!((v["page"]["page_type"].clone(), v["page"]["category"].clone()), (json!("report"), json!("read")));
    assert_eq!((v["can_submit"].clone(), v["submit_block_reason"].clone()), (json!(false), json!("read_only")));
    let r = submit_anon(&h, &rid).await;
    assert_eq!((r.status, r.code()), (409, "read_only_page".into()));
    let r = h.req(&w.owner, "POST", &format!("/api/pages/{rid}/responses"), Some(json!({ "data": {} }))).await;
    assert_eq!((r.status, r.code()), (409, "read_only_page".into()));
    // 临时链接同样拒绝
    let link = h.req(&w.owner, "POST", &format!("/api/pages/{rid}/share-links"), Some(json!({ "expires_in": 3600 }))).await.ok(201);
    let token = s(&link["url"]).rsplit('/').next().unwrap().to_string();
    assert_eq!(h.req(&C::anon(), "GET", &format!("/api/s/{token}"), None).await.ok(200)["submit_block_reason"], "read_only");
    let r = h.req(&C::anon(), "POST", &format!("/api/s/{token}/responses"), Some(json!({ "data": {}, "nickname": "n" }))).await;
    assert_eq!((r.status, r.code()), (409, "read_only_page".into()));
    // 更新：不能开提交、不能改类型；其它字段照常
    let r = h.req(&w.owner, "PATCH", &format!("/api/pages/{rid}"), Some(json!({ "accept_responses": true }))).await;
    assert_eq!(r.status, 400);
    let r = h.req(&w.owner, "PATCH", &format!("/api/pages/{rid}"), Some(json!({ "page_type": "vote" }))).await;
    assert_eq!(r.status, 400);
    h.req(&w.owner, "PATCH", &format!("/api/pages/{rid}"), Some(json!({ "title": "新标题", "accept_responses": false }))).await.ok(200);
    // 数据库 CHECK 兜底
    let err = sqlx::query("UPDATE pages SET accept_responses = true WHERE id = $1::uuid").bind(&rid).execute(&h.db).await.unwrap_err();
    assert!(err.to_string().contains("pages_read_only_check"), "{err}");
    // 列表筛选与字段
    let ids = |v: Value| v["items"].as_array().unwrap().iter().map(|p| s(&p["page_type"])).collect::<Vec<_>>();
    assert_eq!(ids(h.req(&w.owner, "GET", "/api/pages?page_type=report,knowledge", None).await.ok(200)), vec!["report"]);
    assert_eq!(ids(h.req(&w.owner, "GET", "/api/pages?page_type=vote,general", None).await.ok(200)), vec!["vote", "general"]);
    assert_eq!(ids(h.req(&w.owner, "GET", "/api/pages", None).await.ok(200)).len(), 3);
    assert_eq!(h.req(&w.owner, "GET", "/api/pages?page_type=bad", None).await.status, 400);
}

#[tokio::test]
async fn page_type_default_for_existing_rows() {
    let h = H::new().await;
    let w = world(&h).await;
    // 模拟旧代码：INSERT 不带 page_type 列
    let id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO pages (id, org_id, project_id, title, kind, content, visibility, created_by)
         VALUES ($1, $2::uuid, $3::uuid, 'old', 'openui', 'root = Stack([])', 'public', $4::uuid)",
    )
    .bind(id)
    .bind(&w.org)
    .bind(&w.proj)
    .bind(&w.owner.user_id)
    .execute(&h.db)
    .await
    .unwrap();
    let v = h.req(&C::anon(), "GET", &format!("/api/pages/{id}/view"), None).await.ok(200);
    assert_eq!((v["page"]["page_type"].clone(), v["can_submit"].clone()), (json!("general"), json!(true)));
    submit_anon(&h, &id.to_string()).await.ok(201);
}

#[tokio::test]
async fn long_poll_not_woken_by_page_event() {
    let h = H::new().await;
    let w = world(&h).await;
    let page = publish(&h, &w.owner, &w.proj, "public", &[]).await;
    let (agent, _) = create_pat(&h, &w.owner, &["read_responses"], None, None).await;
    // 页面更新（Event::Page）不应让长轮询提前返回空结果
    let start = std::time::Instant::now();
    let req = h.build(&agent, "GET", &format!("/api/pages/{page}/responses?since=0&wait=2"), None, &[]);
    let waiter = tokio::spawn(h.app.clone().oneshot(req));
    tokio::time::sleep(Duration::from_millis(300)).await;
    h.req(&w.owner, "PATCH", &format!("/api/pages/{page}"), Some(json!({ "content": "root = Stack([Text(\"v2\")])" }))).await.ok(200);
    let res = waiter.await.unwrap().unwrap();
    let body: Value = serde_json::from_slice(&axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["responses"], json!([]));
    assert!(start.elapsed() >= Duration::from_millis(1900), "提前返回：{:?}", start.elapsed());
    // 页面更新之后的新提交仍能唤醒
    let start = std::time::Instant::now();
    let req = h.build(&agent, "GET", &format!("/api/pages/{page}/responses?since=0&wait=10"), None, &[]);
    let waiter = tokio::spawn(h.app.clone().oneshot(req));
    tokio::time::sleep(Duration::from_millis(200)).await;
    h.req(&w.owner, "PATCH", &format!("/api/pages/{page}"), Some(json!({ "content": "root = Stack([Text(\"v3\")])" }))).await.ok(200);
    tokio::time::sleep(Duration::from_millis(200)).await;
    submit_anon(&h, &page).await.ok(201);
    let res = waiter.await.unwrap().unwrap();
    let body: Value = serde_json::from_slice(&axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["responses"][0]["seq"], 1);
    assert!(start.elapsed() < Duration::from_secs(5));
}
