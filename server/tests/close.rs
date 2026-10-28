//! 关闭页面（api.md §7.7）：关闭后只有发布者与项目管理员可见、任何人不能提交；重新打开恢复
mod common;

use std::time::Duration;

use common::*;
use serde_json::{Value, json};
use tower::ServiceExt;

struct W {
    owner: C,
    publisher: C,
    editor2: C,
    padmin: C,
    viewer: C,
    member: C,
    grouped: C,
    outsider: C,
    org: String,
    proj: String,
    grp: String,
}

async fn world(h: &H) -> W {
    let owner = register(h, "owner@example.com").await;
    let publisher = register(h, "publisher@example.com").await;
    let editor2 = register(h, "editor2@example.com").await;
    let padmin = register(h, "padmin@example.com").await;
    let viewer = register(h, "viewer@example.com").await;
    let member = register(h, "member@example.com").await;
    let grouped = register(h, "grouped@example.com").await;
    let outsider = register(h, "outsider@example.com").await;
    let org = create_org(h, &owner, "acme").await;
    for u in [&publisher, &editor2, &padmin, &viewer, &member, &grouped] {
        join_org(h, &owner, &org, u, "member").await;
    }
    let proj = create_project(h, &owner, &org, "p").await;
    add_project_member(h, &owner, &proj, &publisher, "editor").await;
    add_project_member(h, &owner, &proj, &editor2, "editor").await;
    add_project_member(h, &owner, &proj, &padmin, "admin").await;
    add_project_member(h, &owner, &proj, &viewer, "viewer").await;
    let grp = create_group(h, &owner, &org, "g").await;
    h.req(&owner, "POST", &format!("/api/groups/{grp}/members"), Some(json!({ "user_id": grouped.user_id }))).await.ok(201);
    W { owner, publisher, editor2, padmin, viewer, member, grouped, outsider, org, proj, grp }
}

async fn vote(h: &H, w: &W, visibility: &str, groups: &[&str]) -> String {
    publish_with(
        h,
        &w.publisher,
        json!({ "project_id": w.proj, "title": "选方案", "kind": "openui", "page_type": "vote", "content": "root = Stack([])",
                "visibility": visibility, "group_ids": groups }),
    )
    .await
}

fn ids(v: &Value) -> Vec<String> {
    v["items"].as_array().unwrap().iter().map(|p| s(&p["id"])).collect()
}

fn share_token(r: &Value) -> String {
    s(&r["url"]).rsplit('/').next().unwrap().to_string()
}

#[tokio::test]
async fn close_hides_and_blocks_then_reopen_restores() {
    let h = H::new().await;
    let w = world(&h).await;
    let anon = C::anon();
    let page = vote(&h, &w, "org", &[]).await;
    let gpage = vote(&h, &w, "groups", &[&w.grp]).await;
    let ppage = vote(&h, &w, "public", &[]).await;
    // 旧行为：未关闭页面 closed_at 为 null，正常可见可交
    let v = h.req(&w.member, "GET", &format!("/api/pages/{page}/view"), None).await.ok(200);
    assert_eq!((v["page"]["closed_at"].clone(), v["can_submit"].clone(), v["can_close"].clone()), (Value::Null, json!(true), json!(false)));
    // can_close：发布者、项目 admin 为 true；非发布者的 editor 为 false
    for (c, want) in [(&w.publisher, true), (&w.padmin, true), (&w.owner, true), (&w.editor2, false)] {
        assert_eq!(h.req(c, "GET", &format!("/api/pages/{page}/view"), None).await.ok(200)["can_close"], want);
        let l = h.req(c, "GET", "/api/pages", None).await.ok(200);
        assert_eq!(l["items"].as_array().unwrap().iter().find(|p| p["id"] == page.as_str()).unwrap()["can_close"], want);
    }
    h.req(&w.viewer, "POST", &format!("/api/pages/{page}/responses"), Some(json!({ "data": { "c": "A" } }))).await.ok(201);
    let link = h.req(&w.publisher, "POST", &format!("/api/pages/{page}/share-links"), Some(json!({ "expires_in": 3600 }))).await.ok(201);
    let tok = share_token(&link);
    let expired = h.req(&w.publisher, "POST", &format!("/api/pages/{page}/share-links"), Some(json!({ "expires_in": 3600 }))).await.ok(201);
    let pw = h.req(&w.publisher, "POST", &format!("/api/pages/{page}/share-links"), Some(json!({ "expires_in": 3600, "password": "abcd" }))).await.ok(201);
    sqlx::query("UPDATE share_links SET expires_at = now() - interval '1 second' WHERE id = $1::uuid")
        .bind(s(&expired["share_link"]["id"]))
        .execute(&h.db)
        .await
        .unwrap();
    h.req(&anon, "GET", &format!("/api/s/{tok}"), None).await.ok(200);

    // 谁能关：editor 非发布者 / viewer / 组织成员 → 403；看不见的 → 404；匿名 401
    for c in [&w.editor2, &w.viewer, &w.member] {
        assert_eq!(h.req(c, "POST", &format!("/api/pages/{page}/close"), None).await.status, 403);
    }
    assert_eq!(h.req(&w.outsider, "POST", &format!("/api/pages/{page}/close"), None).await.status, 404);
    assert_eq!(h.req(&anon, "POST", &format!("/api/pages/{page}/close"), None).await.status, 401);
    // read_responses 令牌不能关
    let (rr, _) = create_pat(&h, &w.publisher, &["read_responses"], None, None).await;
    assert_eq!(h.req(&rr, "POST", &format!("/api/pages/{page}/close"), None).await.status, 403);

    // 发布者用 publish 令牌关闭；幂等
    let (agent, pat_id) = create_pat(&h, &w.publisher, &["publish", "read_responses"], None, None).await;
    let p = h.req(&agent, "POST", &format!("/api/pages/{page}/close"), None).await.ok(200);
    assert!(p["closed_at"].is_string());
    h.req(&agent, "POST", &format!("/api/pages/{page}/close"), None).await.ok(200);
    for x in [&gpage, &ppage] {
        h.req(&w.padmin, "POST", &format!("/api/pages/{x}/close"), None).await.ok(200);
    }

    // 非管理者一律 404：成员、群组受众、公开/匿名、项目 viewer、editor 非发布者、外部人
    for (name, c, pg) in [
        ("member", &w.member, &page),
        ("viewer", &w.viewer, &page),
        ("editor2", &w.editor2, &page),
        ("grouped", &w.grouped, &gpage),
        ("anon-public", &anon, &ppage),
        ("outsider-public", &w.outsider, &ppage),
    ] {
        let r = h.req(c, "GET", &format!("/api/pages/{pg}/view"), None).await;
        assert_eq!((r.status, r.code()), (404, "not_found".into()), "{name} 查看");
        let r = h.req(c, "POST", &format!("/api/pages/{pg}/responses"), Some(json!({ "data": {}, "nickname": "n" }))).await;
        assert_eq!(r.status, 404, "{name} 提交");
        assert_eq!(h.req(c, "GET", &format!("/api/pages/{pg}/responses/stream"), None).await.status, 404, "{name} SSE");
    }
    // editor 非发布者的管理接口也 404（与页面不存在一致）
    assert_eq!(h.req(&w.editor2, "GET", &format!("/api/pages/{page}"), None).await.status, 404);
    let (e2pat, _) = create_pat(&h, &w.editor2, &["read_responses"], None, None).await;
    assert_eq!(h.req(&e2pat, "GET", &format!("/api/pages/{page}/responses"), None).await.status, 404);
    // 临时链接：查看 / 解锁 / 提交 / SSE 均 404（含已过期的链接，不泄露存在性）
    assert_eq!(h.req(&anon, "GET", &format!("/api/s/{tok}"), None).await.code(), "not_found");
    assert_eq!(h.req(&anon, "GET", &format!("/api/s/{}", share_token(&expired)), None).await.status, 404);
    assert_eq!(h.req(&anon, "POST", &format!("/api/s/{}/unlock", share_token(&pw)), Some(json!({ "password": "abcd" }))).await.status, 404);
    assert_eq!(h.req(&anon, "POST", &format!("/api/s/{tok}/responses"), Some(json!({ "data": {}, "nickname": "n" }))).await.status, 404);
    assert_eq!(h.req(&anon, "GET", &format!("/api/s/{tok}/responses/stream"), None).await.status, 404);
    // 发布者自己用临时链接也 404（走 /pages/{id}）
    assert_eq!(h.req(&w.publisher, "GET", &format!("/api/s/{tok}"), None).await.status, 404);

    // 管理者可看：发布者、项目 admin、组织 owner；不可提交
    for c in [&w.publisher, &w.padmin, &w.owner] {
        let v = h.req(c, "GET", &format!("/api/pages/{page}/view"), None).await.ok(200);
        assert!(v["page"]["closed_at"].is_string());
        assert_eq!((v["can_submit"].clone(), v["submit_block_reason"].clone()), (json!(false), json!("page_closed")));
        let r = h.req(c, "POST", &format!("/api/pages/{page}/responses"), Some(json!({ "data": {} }))).await;
        assert_eq!((r.status, r.code()), (409, "page_closed".into()));
    }
    // 结果仍可看 / 导出；改页面、建临时链接 → 409；临时链接列表仍可看（链接不删除）
    let csv = h.req(&w.padmin, "GET", &format!("/api/pages/{page}/responses.csv"), None).await;
    assert_eq!(csv.status, 200);
    assert!(csv.text().contains("viewer"));
    let r = h.req(&w.publisher, "PATCH", &format!("/api/pages/{page}"), Some(json!({ "title": "x" }))).await;
    assert_eq!((r.status, r.code()), (409, "page_closed".into()));
    let r = h.req(&w.publisher, "POST", &format!("/api/pages/{page}/share-links"), Some(json!({ "expires_in": 3600 }))).await;
    assert_eq!((r.status, r.code()), (409, "page_closed".into()));
    let links = h.req(&w.publisher, "GET", &format!("/api/pages/{page}/share-links"), None).await.ok(200);
    assert_eq!(links["items"].as_array().unwrap().len(), 2);

    // get_responses：已关闭 → status=closed，长轮询不等待，历史提交照常返回
    let t0 = std::time::Instant::now();
    let r = h.req(&agent, "GET", &format!("/api/pages/{page}/responses?since=0&wait=20"), None).await.ok(200);
    assert!(t0.elapsed() < Duration::from_secs(3));
    assert_eq!(r["status"], "closed");
    assert!(r["closed_at"].is_string());
    assert_eq!(r["responses"].as_array().unwrap().len(), 1);
    let r = h.req(&agent, "GET", &format!("/api/pages/{page}/responses?since=1&wait=20"), None).await.ok(200);
    assert_eq!((r["status"].clone(), r["responses"].clone()), (json!("closed"), json!([])));
    assert!(t0.elapsed() < Duration::from_secs(3));

    // 列表 / 搜索：非管理者消失；管理者可见且带 closed_at
    for c in [&w.member, &w.viewer, &w.editor2, &w.grouped] {
        let l = ids(&h.req(c, "GET", "/api/pages", None).await.ok(200));
        assert!(!l.contains(&page) && !l.contains(&gpage) && !l.contains(&ppage), "{l:?}");
        assert!(ids(&h.req(c, "GET", "/api/pages?q=选方案", None).await.ok(200)).is_empty());
    }
    let pl = h.req(&w.publisher, "GET", "/api/pages", None).await.ok(200);
    let mine = pl["items"].as_array().unwrap().iter().find(|p| p["id"] == page.as_str()).unwrap();
    assert!(mine["closed_at"].is_string());
    assert_eq!(ids(&h.req(&w.padmin, "GET", "/api/pages?q=选方案", None).await.ok(200)).len(), 3);

    // 动态流：管理者看到「关闭了」，其他人看不到该页任何事件
    let feed = async |c: &C| h.req(c, "GET", "/api/activity", None).await.ok(200)["items"].as_array().unwrap().clone();
    let pf = feed(&w.publisher).await;
    let closed_ev = pf.iter().find(|e| e["type"] == "closed" && e["page"]["id"] == page.as_str()).expect("关闭事件");
    assert_eq!(closed_ev["actor"]["name"], "publisher");
    for c in [&w.viewer, &w.editor2, &w.member] {
        assert!(!feed(c).await.iter().any(|e| e["page"]["id"] == page.as_str()));
    }

    // 审计：actor 与 actor_pat_id
    let audit = h.req(&w.owner, "GET", &format!("/api/orgs/{}/audit", w.org), None).await.ok(200);
    let close_log: Vec<&Value> = audit["items"].as_array().unwrap().iter().filter(|e| e["action"] == "page.close" && e["target_id"] == page.as_str()).collect();
    assert_eq!(close_log.len(), 1, "幂等关闭不重复记审计");
    assert_eq!(close_log[0]["actor"]["user"]["id"], w.publisher.user_id.as_str());
    assert_eq!(close_log[0]["actor"]["pat"]["id"], pat_id.as_str());

    // 重新打开：非管理者 403；项目 admin 打开 → 恢复可见可交、临时链接按自身有效期恢复
    assert_eq!(h.req(&w.editor2, "POST", &format!("/api/pages/{page}/reopen"), None).await.status, 404);
    let p = h.req(&w.padmin, "POST", &format!("/api/pages/{page}/reopen"), None).await.ok(200);
    assert_eq!(p["closed_at"], Value::Null);
    assert_eq!(h.req(&w.viewer, "POST", &format!("/api/pages/{page}/reopen"), None).await.status, 403);
    let v = h.req(&w.member, "GET", &format!("/api/pages/{page}/view"), None).await.ok(200);
    assert_eq!(v["can_submit"], true);
    h.req(&w.member, "POST", &format!("/api/pages/{page}/responses"), Some(json!({ "data": { "c": "B" } }))).await.ok(201);
    h.req(&anon, "GET", &format!("/api/s/{tok}"), None).await.ok(200);
    h.req(&C::anon(), "POST", &format!("/api/s/{tok}/responses"), Some(json!({ "data": {}, "nickname": "n" }))).await.ok(201);
    assert_eq!(h.req(&anon, "GET", &format!("/api/s/{}", share_token(&expired)), None).await.code(), "share_link_expired");
    assert!(ids(&h.req(&w.viewer, "GET", "/api/pages", None).await.ok(200)).contains(&page));
    let r = h.req(&agent, "GET", &format!("/api/pages/{page}/responses?since=0"), None).await.ok(200);
    assert_eq!((r["status"].clone(), r["total"].clone()), (json!("open"), json!(3)));
    let audit = h.req(&w.owner, "GET", &format!("/api/orgs/{}/audit", w.org), None).await.ok(200);
    let re = audit["items"].as_array().unwrap().iter().find(|e| e["action"] == "page.reopen").unwrap();
    assert_eq!((re["actor"]["user"]["id"].clone(), re["actor"]["pat"].clone()), (json!(w.padmin.user_id), Value::Null));
    // 重新打开后动态里不再有关闭事件
    assert!(!feed(&w.publisher).await.iter().any(|e| e["type"] == "closed" && e["page"]["id"] == page.as_str()));
}

#[tokio::test]
async fn long_poll_returns_immediately_when_closed() {
    let h = H::new().await;
    let w = world(&h).await;
    let page = vote(&h, &w, "org", &[]).await;
    let (agent, _) = create_pat(&h, &w.publisher, &["publish", "read_responses"], None, None).await;
    let start = std::time::Instant::now();
    let req = h.build(&agent, "GET", &format!("/api/pages/{page}/responses?since=0&wait=20"), None, &[]);
    let waiter = tokio::spawn(h.app.clone().oneshot(req));
    tokio::time::sleep(Duration::from_millis(300)).await;
    h.req(&agent, "POST", &format!("/api/pages/{page}/close"), None).await.ok(200);
    let res = waiter.await.unwrap().unwrap();
    let body: Value = serde_json::from_slice(&axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!((body["status"].clone(), body["responses"].clone()), (json!("closed"), json!([])));
    assert!(start.elapsed() < Duration::from_secs(5), "{:?}", start.elapsed());
    // 重新打开后长轮询照常等待新提交
    h.req(&agent, "POST", &format!("/api/pages/{page}/reopen"), None).await.ok(200);
    let req = h.build(&agent, "GET", &format!("/api/pages/{page}/responses?since=0&wait=10"), None, &[]);
    let waiter = tokio::spawn(h.app.clone().oneshot(req));
    tokio::time::sleep(Duration::from_millis(300)).await;
    h.req(&w.member, "POST", &format!("/api/pages/{page}/responses"), Some(json!({ "data": { "c": "A" } }))).await.ok(201);
    let res = waiter.await.unwrap().unwrap();
    let body: Value = serde_json::from_slice(&axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!((body["status"].clone(), body["responses"][0]["seq"].clone()), (json!("open"), json!(1)));
}

#[tokio::test]
async fn closed_task_tree_rejects_writes() {
    let h = H::new().await;
    let w = world(&h).await;
    let page = publish_with(
        &h,
        &w.publisher,
        json!({ "project_id": w.proj, "title": "任务", "kind": "openui", "page_type": "task_tree", "visibility": "project",
                "tasks": [{ "key": "a", "title": "A", "assignee": "viewer@example.com" }, { "key": "b", "title": "B", "assignee": "me" }] }),
    )
    .await;
    let t = h.req(&w.publisher, "GET", &format!("/api/pages/{page}/tasks"), None).await.ok(200);
    let id = |k: &str| s(&t["tasks"].as_array().unwrap().iter().find(|x| x["key"] == k).unwrap()["id"]);
    // b 提交评审，等项目管理员评审
    h.req(&w.publisher, "PATCH", &format!("/api/tasks/{}", id("b")), Some(json!({ "status": "in_review" }))).await.ok(200);
    h.req(&w.publisher, "POST", &format!("/api/pages/{page}/close"), None).await.ok(200);
    // 负责人（项目 viewer）看不到 → 404
    let r = h.req(&w.viewer, "PATCH", &format!("/api/tasks/{}", id("a")), Some(json!({ "status": "in_progress" }))).await;
    assert_eq!(r.status, 404);
    assert_eq!(h.req(&w.viewer, "GET", &format!("/api/pages/{page}/tasks"), None).await.status, 404);
    // 管理者：勾选、评审、加节点 → 409 page_closed；任务可读但 can_edit/can_review 为 false
    let r = h.req(&w.publisher, "PATCH", &format!("/api/tasks/{}", id("a")), Some(json!({ "status": "in_progress" }))).await;
    assert_eq!((r.status, r.code()), (409, "page_closed".into()));
    let r = h.req(&w.padmin, "POST", &format!("/api/tasks/{}/review", id("b")), Some(json!({ "decision": "approve" }))).await;
    assert_eq!((r.status, r.code()), (409, "page_closed".into()));
    let r = h.req(&w.publisher, "POST", &format!("/api/pages/{page}/tasks"), Some(json!({ "title": "C" }))).await;
    assert_eq!((r.status, r.code()), (409, "page_closed".into()));
    let t2 = h.req(&w.padmin, "GET", &format!("/api/pages/{page}/tasks"), None).await.ok(200);
    assert!(t2["tasks"].as_array().unwrap().iter().all(|x| x["can_edit"] == false && x["can_review"] == false));
    // 重新打开后恢复
    h.req(&w.padmin, "POST", &format!("/api/pages/{page}/reopen"), None).await.ok(200);
    h.req(&w.padmin, "POST", &format!("/api/tasks/{}/review", id("b")), Some(json!({ "decision": "approve" }))).await.ok(200);
    h.req(&w.viewer, "PATCH", &format!("/api/tasks/{}", id("a")), Some(json!({ "status": "in_progress" }))).await.ok(200);
}

#[tokio::test]
async fn closed_html_frame_only_for_managers() {
    let h = H::with(|c| c.pages_origin = Some("http://pages.test".into())).await;
    let w = world(&h).await;
    let html = "<html><body><form data-kanban><input name=a></form></body></html>";
    let page = publish_with(&h, &w.publisher, json!({ "project_id": w.proj, "title": "h", "kind": "html", "content": html, "visibility": "public" })).await;
    let host = [("host", "pages.test")];
    let frame = async |c: &C| {
        let v = h.req(c, "GET", &format!("/api/pages/{page}/view"), None).await.ok(200);
        s(&v["content"]["frame_url"]).strip_prefix("http://pages.test").unwrap().to_string()
    };
    let before = frame(&C::anon()).await;
    assert_eq!(h.raw(&C::anon(), "GET", &before, None, &host).await.status, 200);
    h.req(&w.publisher, "POST", &format!("/api/pages/{page}/close"), None).await.ok(200);
    // 关闭前签发的地址失效；伪造 c=1 也不行（签名不同）
    assert_eq!(h.raw(&C::anon(), "GET", &before, None, &host).await.status, 404);
    assert_eq!(h.raw(&C::anon(), "GET", &format!("{before}&c=1"), None, &host).await.status, 404);
    // 管理者拿到的地址带 c=1，可加载
    let mgr = frame(&w.padmin).await;
    assert!(mgr.ends_with("&c=1"));
    let r = h.raw(&C::anon(), "GET", &mgr, None, &host).await;
    assert!(r.status == 200 && r.text().contains("<input name=a>"));
    // 重新打开后普通地址恢复
    h.req(&w.publisher, "POST", &format!("/api/pages/{page}/reopen"), None).await.ok(200);
    assert_eq!(h.raw(&C::anon(), "GET", &frame(&C::anon()).await, None, &host).await.status, 200);
}
