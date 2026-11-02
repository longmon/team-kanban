//! 需求页面：创建权限、编号并发唯一、指派与「等我处理」、认领自动建群组、状态流转、附件安全、补充说明、关联页面、publish 带 requirement、旧数据不变
mod common;

use common::*;
use serde_json::{Value, json};
use tower::ServiceExt;

struct W {
    owner: C,    // 组织 owner = 项目 admin
    pm: C,       // 项目 editor：产品经理，需求发起人
    dev: C,      // 项目 viewer：被直接指派
    team: C,     // 项目 viewer：被指派群组的成员
    viewer: C,   // 项目 viewer：与需求无关
    stranger: C, // 本组织成员，但不在项目里
    outsider: C, // 另一个组织
    org: String,
    proj: String,
    grp: String, // 组织级群组「后端组」，授权给项目 viewer
}

async fn world(h: &H) -> W {
    let owner = register(h, "owner@example.com").await;
    let pm = register(h, "pm@example.com").await;
    let dev = register(h, "dev@example.com").await;
    let team = register(h, "team@example.com").await;
    let viewer = register(h, "viewer@example.com").await;
    let stranger = register(h, "stranger@example.com").await;
    let outsider = register(h, "outsider@example.com").await;
    let org = create_org(h, &owner, "acme").await;
    for u in [&pm, &dev, &team, &viewer, &stranger] {
        join_org(h, &owner, &org, u, "member").await;
    }
    let proj = create_project(h, &owner, &org, "p").await;
    add_project_member(h, &owner, &proj, &pm, "editor").await;
    for u in [&dev, &viewer] {
        add_project_member(h, &owner, &proj, u, "viewer").await;
    }
    let grp = create_group(h, &owner, &org, "后端组").await;
    h.req(&owner, "POST", &format!("/api/groups/{grp}/members"), Some(json!({ "user_id": team.user_id }))).await.ok(201);
    h.req(&owner, "PUT", &format!("/api/projects/{proj}/groups/{grp}"), Some(json!({ "role": "viewer" }))).await.ok(200);
    let other = create_org(h, &outsider, "other").await;
    create_project(h, &outsider, &other, "op").await;
    W { owner, pm, dev, team, viewer, stranger, outsider, org, proj, grp }
}

fn req_body(w: &W, title: &str) -> Value {
    json!({ "project_id": w.proj, "title": title, "kind": "openui", "page_type": "requirement", "visibility": "project",
        "requirement": { "body": "## 背景\n需要支持退款", "priority": "P1", "due_at": "2026-12-01T18:00:00+08:00",
                         "assignees": { "users": ["dev@example.com"], "groups": [w.grp] } } })
}

async fn create_req(h: &H, w: &W, title: &str) -> String {
    publish_with(h, &w.pm, req_body(w, title)).await
}

async fn detail(h: &H, c: &C, id: &str) -> Value {
    h.req(c, "GET", &format!("/api/requirements/{id}"), None).await.ok(200)
}

async fn listed(h: &H, c: &C, id: &str) -> Value {
    let r = h.req(c, "GET", "/api/pages?page_type=requirement", None).await.ok(200);
    r["items"].as_array().unwrap().iter().find(|p| p["id"] == id).cloned().unwrap_or(Value::Null)
}

#[tokio::test]
async fn create_permissions_and_numbering() {
    let h = H::new().await;
    let w = world(&h).await;
    // 项目 viewer 不能建需求
    assert_eq!(h.req(&w.dev, "POST", "/api/pages", Some(req_body(&w, "x"))).await.status, 403);
    let p = h.req(&w.pm, "POST", "/api/pages", Some(req_body(&w, "支付退款"))).await.ok(201);
    assert_eq!(p["category"], "collab");
    assert_eq!(p["accept_responses"], false);
    assert_eq!(p["requirement"]["code"], "REQ-1");
    assert_eq!(p["requirement"]["status"], "open");
    assert_eq!(p["requirement"]["priority"], "P1");
    assert_eq!(p["requirement"]["acceptor"], true);
    assert_eq!(p["requirement"]["assignees"].as_array().unwrap().len(), 2);
    // 校验：正文不能走 content、可见范围只能 project/org、kind 只能 openui、非需求页不能带 requirement
    let mut b = req_body(&w, "x");
    b["content"] = json!("root = Stack([])x");
    assert_eq!(h.req(&w.pm, "POST", "/api/pages", Some(b)).await.status, 400);
    let mut b = req_body(&w, "x");
    b["visibility"] = json!("public");
    assert_eq!(h.req(&w.pm, "POST", "/api/pages", Some(b)).await.code(), "validation_failed");
    let mut b = req_body(&w, "x");
    b["kind"] = json!("html");
    assert_eq!(h.req(&w.pm, "POST", "/api/pages", Some(b)).await.status, 400);
    let mut b = req_body(&w, "x");
    b["requirement"]["priority"] = json!("P9");
    assert_eq!(h.req(&w.pm, "POST", "/api/pages", Some(b)).await.status, 400);
    let r = h
        .req(&w.pm, "POST", "/api/pages", Some(json!({ "project_id": w.proj, "title": "r", "kind": "openui", "content": "root = Stack([])",
            "page_type": "report", "visibility": "project", "requirement": { "body": "x" } })))
        .await;
    assert_eq!(r.status, 400);
    // 指派对象必须能看到需求：不在项目里的成员、没授权给项目的群组 → 400
    let mut b = req_body(&w, "x");
    b["requirement"]["assignees"] = json!({ "users": ["stranger@example.com"] });
    assert!(h.req(&w.pm, "POST", "/api/pages", Some(b)).await.text().contains("不是本项目成员"));
    let lone = create_group(&h, &w.owner, &w.org, "没授权的组").await;
    let mut b = req_body(&w, "x");
    b["requirement"]["assignees"] = json!({ "groups": [lone] });
    assert_eq!(h.req(&w.pm, "POST", "/api/pages", Some(b)).await.status, 400);
    // PAT publish scope 可以代产品经理建需求；read_responses 不行
    let (pat, _) = create_pat(&h, &w.pm, &["publish"], None, None).await;
    let p2 = h.req(&pat, "POST", "/api/pages", Some(req_body(&w, "第二个"))).await.ok(201);
    assert_eq!(p2["requirement"]["code"], "REQ-2");
    let (ro, _) = create_pat(&h, &w.pm, &["read_responses"], None, None).await;
    assert_eq!(h.req(&ro, "POST", "/api/pages", Some(req_body(&w, "x"))).await.status, 403);
    // 其他项目编号从 1 开始
    let proj2 = create_project(&h, &w.owner, &w.org, "p2").await;
    let mut b = req_body(&w, "别的项目");
    b["project_id"] = json!(proj2);
    b["requirement"]["assignees"] = json!({});
    assert_eq!(h.req(&w.owner, "POST", "/api/pages", Some(b)).await.ok(201)["requirement"]["number"], 1);
}

#[tokio::test]
async fn numbering_is_unique_under_concurrency() {
    let h = H::new().await;
    let w = world(&h).await;
    let mut tasks = vec![];
    for i in 0..12 {
        let app = h.app.clone();
        let req = h.build(&w.pm, "POST", "/api/pages", Some(req_body(&w, &format!("并发 {i}")).to_string()), &[]);
        tasks.push(tokio::spawn(async move {
            let res = app.oneshot(req).await.unwrap();
            assert_eq!(res.status(), 201);
            let b = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
            serde_json::from_slice::<Value>(&b).unwrap()["requirement"]["number"].as_i64().unwrap()
        }));
    }
    let mut nums = vec![];
    for t in tasks {
        nums.push(t.await.unwrap());
    }
    nums.sort();
    assert_eq!(nums, (1..=12).collect::<Vec<_>>());
}

#[tokio::test]
async fn assignment_and_todo() {
    let h = H::new().await;
    let w = world(&h).await;
    let id = create_req(&h, &w, "支付退款").await;
    // 被指派者（本人、群组成员）mine = true；无关的人 false，但能看（visibility=project）
    assert_eq!(listed(&h, &w.dev, &id).await["requirement"]["mine"], true);
    assert_eq!(listed(&h, &w.team, &id).await["requirement"]["mine"], true);
    assert_eq!(listed(&h, &w.viewer, &id).await["requirement"]["mine"], false);
    assert_eq!(listed(&h, &w.viewer, &id).await["requirement"]["acceptor"], false);
    assert_eq!(listed(&h, &w.outsider, &id).await, Value::Null);
    assert_eq!(h.req(&w.outsider, "GET", &format!("/api/requirements/{id}"), None).await.status, 404);
    assert_eq!(h.req(&w.stranger, "GET", &format!("/api/requirements/{id}"), None).await.status, 404);
    // 改指派：只有项目 editor 及以上；改完 dev 不再是被指派者
    assert_eq!(h.req(&w.dev, "PATCH", &format!("/api/requirements/{id}"), Some(json!({ "assignees": { "users": [] } }))).await.status, 403);
    let d = h
        .req(&w.pm, "PATCH", &format!("/api/requirements/{id}"), Some(json!({ "assignees": { "users": ["viewer@example.com"] }, "priority": null, "title": "支付退款 v2" })))
        .await
        .ok(200);
    assert_eq!(d["assignees"]["users"][0]["display_name"], "viewer");
    assert_eq!(d["priority"], Value::Null);
    assert_eq!(d["title"], "支付退款 v2");
    assert_eq!(listed(&h, &w.dev, &id).await["requirement"]["mine"], false);
    assert_eq!(listed(&h, &w.viewer, &id).await["requirement"]["mine"], true);
    let actions: Vec<&str> = d["events"].as_array().unwrap().iter().map(|e| e["action"].as_str().unwrap()).collect();
    assert_eq!(actions, ["created", "edited", "assigned"]);
}

#[tokio::test]
async fn claim_creates_group() {
    let h = H::new().await;
    let w = world(&h).await;
    let id = create_req(&h, &w, "支付退款").await;
    // 与需求无关的 viewer 不能认领；被指派群组成员可以（用 PAT 也行，需要 publish）
    assert_eq!(h.req(&w.viewer, "POST", &format!("/api/requirements/{id}/claim"), None).await.status, 403);
    // 同名冲突：组织里已有同名的组织级群组 → 自动加 (2)
    create_group(&h, &w.owner, &w.org, "REQ-1 支付退款").await;
    let (pat, pat_id) = create_pat(&h, &w.team, &["publish"], None, None).await;
    let d = h.req(&pat, "POST", &format!("/api/requirements/{id}/claim"), None).await.ok(200);
    assert_eq!(d["status"], "analyzing");
    assert_eq!(d["claimed_by"]["display_name"], "team");
    assert_eq!(d["group"]["name"], "REQ-1 支付退款 (2)");
    let gid = s(&d["group"]["id"]);
    // 成员 = 认领人 + 被指派成员 + 被指派群组成员快照 + 发起人
    let mut members: Vec<String> = h
        .req(&w.owner, "GET", &format!("/api/groups/{gid}/members"), None)
        .await
        .ok(200)["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| s(&m["user"]["email"]))
        .collect();
    members.sort();
    assert_eq!(members, ["dev@example.com", "pm@example.com", "team@example.com"]);
    // 自动授权给项目 viewer，是本项目的项目群组
    let role: String = sqlx::query_scalar("SELECT role FROM project_groups WHERE group_id = $1::uuid").bind(&gid).fetch_one(&h.db).await.unwrap();
    assert_eq!(role, "viewer");
    let pid: String = sqlx::query_scalar("SELECT project_id::text FROM groups WHERE id = $1::uuid").bind(&gid).fetch_one(&h.db).await.unwrap();
    assert_eq!(pid, w.proj);
    // 审计：group.create（via=requirement、经哪个令牌）+ requirement.claim
    let (actor_pat, meta): (Option<String>, Value) =
        sqlx::query_as("SELECT actor_pat_id::text, meta FROM audit_log WHERE action = 'group.create' AND target_id = $1::uuid").bind(&gid).fetch_one(&h.db).await.unwrap();
    assert_eq!(actor_pat.as_deref(), Some(pat_id.as_str()));
    assert_eq!(meta["via"], "requirement");
    assert_eq!(meta["requirement_id"], json!(id));
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action = 'requirement.claim'").fetch_one(&h.db).await.unwrap();
    assert_eq!(n, 1);
    // 重复认领 409；已有群组时手动建群组 409
    assert_eq!(h.req(&w.dev, "POST", &format!("/api/requirements/{id}/claim"), None).await.code(), "not_claimable");
    assert_eq!(h.req(&w.dev, "POST", &format!("/api/requirements/{id}/group"), None).await.code(), "group_exists");
    // 历史
    let actions: Vec<&str> = d["events"].as_array().unwrap().iter().map(|e| e["action"].as_str().unwrap()).collect();
    assert_eq!(actions, ["created", "claimed", "group_created"]);
    assert_eq!(d["events"][1]["via_token"], true);

    // 不认领时手动建群组；read_responses 令牌不能写
    let id2 = create_req(&h, &w, "导出报表").await;
    let (ro, _) = create_pat(&h, &w.dev, &["read_responses"], None, None).await;
    assert_eq!(h.req(&ro, "POST", &format!("/api/requirements/{id2}/group"), None).await.status, 403);
    assert_eq!(h.req(&ro, "GET", &format!("/api/requirements/{id2}"), None).await.status, 200);
    let d2 = h.req(&w.dev, "POST", &format!("/api/requirements/{id2}/group"), None).await.ok(201);
    assert_eq!(d2["group"]["name"], "REQ-2 导出报表");
    assert_eq!(d2["status"], "open");
}

async fn status(h: &H, c: &C, id: &str, to: &str, note: Option<&str>) -> R {
    h.req(c, "POST", &format!("/api/requirements/{id}/status"), Some(json!({ "status": to, "note": note }))).await
}

#[tokio::test]
async fn status_flow_and_acceptance() {
    let h = H::new().await;
    let w = world(&h).await;
    let id = create_req(&h, &w, "支付退款").await;
    // 待认领 → 分析中只能经认领
    assert_eq!(status(&h, &w.dev, &id, "analyzing", None).await.code(), "use_claim");
    h.req(&w.dev, "POST", &format!("/api/requirements/{id}/claim"), None).await.ok(200);
    assert_eq!(status(&h, &w.viewer, &id, "developing", None).await.status, 403);
    assert_eq!(status(&h, &w.dev, &id, "developing", None).await.ok(200)["status"], "developing");
    // 被指派者不能直接完成、也不能验收
    assert_eq!(status(&h, &w.dev, &id, "done", None).await.status, 403);
    let d = status(&h, &w.dev, &id, "in_review", Some("做完了")).await.ok(200);
    assert_eq!(d["me"]["transitions"], json!([]));
    assert_eq!(status(&h, &w.team, &id, "done", None).await.status, 403);
    assert_eq!(listed(&h, &w.pm, &id).await["requirement"]["status"], "in_review");
    // 验收不通过必须写原因
    assert_eq!(status(&h, &w.pm, &id, "developing", None).await.status, 400);
    status(&h, &w.pm, &id, "developing", Some("缺少退款对账")).await.ok(200);
    status(&h, &w.dev, &id, "in_review", None).await.ok(200);
    let d = status(&h, &w.pm, &id, "done", Some("验收通过")).await.ok(200);
    assert_eq!(d["status"], "done");
    // 非法流转 409；已完成只能由验收人重新打开到开发中
    assert_eq!(status(&h, &w.pm, &id, "open", None).await.code(), "invalid_transition");
    assert_eq!(status(&h, &w.dev, &id, "developing", None).await.status, 403);
    // 拒绝必须写原因；项目管理员也是验收人
    let id2 = create_req(&h, &w, "导出").await;
    assert_eq!(status(&h, &w.dev, &id2, "rejected", None).await.status, 400);
    status(&h, &w.dev, &id2, "rejected", Some("不做")).await.ok(200);
    assert_eq!(status(&h, &w.dev, &id2, "open", None).await.status, 403);
    status(&h, &w.owner, &id2, "open", None).await.ok(200);
    status(&h, &w.dev, &id2, "on_hold", None).await.ok(200);
    status(&h, &w.dev, &id2, "open", None).await.ok(200);
    // 历史：谁、从→到、说明
    let ev = detail(&h, &w.pm, &id).await["events"].clone();
    let tos: Vec<String> = ev.as_array().unwrap().iter().filter(|e| e["action"] == "status").map(|e| format!("{}>{}", s(&e["from_status"]), s(&e["to_status"]))).collect();
    assert_eq!(tos, ["analyzing>developing", "developing>in_review", "in_review>developing", "developing>in_review", "in_review>done"]);
    let rej = ev.as_array().unwrap().iter().find(|e| e["note"] == "缺少退款对账").unwrap();
    assert_eq!(rej["actor"]["display_name"], "pm");
    // 关闭页面后任何写入 409
    h.req(&w.pm, "POST", &format!("/api/pages/{id2}/close"), None).await.ok(200);
    assert_eq!(status(&h, &w.pm, &id2, "on_hold", None).await.code(), "page_closed");
}

fn pdf() -> Vec<u8> {
    b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF".to_vec()
}
fn png() -> Vec<u8> {
    let mut v = b"\x89PNG\r\n\x1a\n".to_vec();
    v.extend_from_slice(&[0u8; 32]);
    v
}

async fn upload(h: &H, c: &C, id: &str, name: &str, body: Vec<u8>) -> R {
    h.bytes(c, "POST", &format!("/api/requirements/{id}/files?name={}", name.replace('/', "%2F").replace(' ', "%20")), body).await
}

#[tokio::test]
async fn attachments() {
    let h = H::with(|c| c.upload_max_bytes = 4096).await;
    let w = world(&h).await;
    let id = create_req(&h, &w, "支付退款").await;
    // 白名单 + 嗅探
    let f = upload(&h, &w.pm, &id, "../../etc/需求 说明.pdf", pdf()).await.ok(201);
    assert_eq!(f["name"], "需求 说明.pdf");
    assert_eq!(f["content_type"], "application/pdf");
    assert_eq!(f["inline_url"], Value::Null);
    assert_eq!(upload(&h, &w.pm, &id, "a.exe", b"MZ".to_vec()).await.code(), "file_type_not_allowed");
    assert_eq!(upload(&h, &w.pm, &id, "fake.png", b"<html>hi</html>".to_vec()).await.code(), "file_type_not_allowed");
    assert_eq!(upload(&h, &w.pm, &id, "fake.pdf", b"hello".to_vec()).await.code(), "file_type_not_allowed");
    assert_eq!(upload(&h, &w.pm, &id, "empty.txt", vec![]).await.status, 400);
    assert_eq!(upload(&h, &w.pm, &id, "big.txt", vec![b'a'; 5000]).await.code(), "file_too_large");
    // 与需求无关的 viewer 不能上传（能看能下载）
    assert_eq!(upload(&h, &w.viewer, &id, "a.pdf", pdf()).await.status, 403);
    // 存储路径用随机 key，不含原文件名；失败的上传不留临时文件
    let files: Vec<String> = std::fs::read_dir(&h.uploads).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    assert_eq!(files.len(), 1, "{files:?}");
    assert!(!files[0].contains("pdf") && !files[0].contains('.') && files[0].len() >= 40);
    // 下载：attachment + nosniff + CSP sandbox，RFC 5987 文件名
    let fid = s(&f["id"]);
    let r = h.req(&w.viewer, "GET", &format!("/api/requirements/{id}/files/{fid}"), None).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, pdf());
    assert!(r.header("content-disposition").starts_with("attachment;"), "{}", r.header("content-disposition"));
    assert!(r.header("content-disposition").contains("filename*=UTF-8''%E9%9C%80"));
    assert_eq!(r.header("content-type"), "application/octet-stream");
    assert_eq!(r.header("x-content-type-options"), "nosniff");
    assert!(r.header("content-security-policy").contains("sandbox"));
    // inline 只对 raster 图片生效
    assert!(h.req(&w.viewer, "GET", &format!("/api/requirements/{id}/files/{fid}?inline=1"), None).await.header("content-disposition").starts_with("attachment"));
    let img = upload(&h, &w.dev, &id, "shot.png", png()).await.ok(201);
    let r = h.req(&w.viewer, "GET", &format!("/api/requirements/{}/files/{}?inline=1", id, s(&img["id"])), None).await;
    assert!(r.header("content-disposition").starts_with("inline"));
    assert_eq!(r.header("content-type"), "image/png");
    let svg = upload(&h, &w.dev, &id, "logo.svg", b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>".to_vec()).await.ok(201);
    assert_eq!(svg["inline_url"], Value::Null);
    let r = h.req(&w.viewer, "GET", &format!("/api/requirements/{}/files/{}?inline=1", id, s(&svg["id"])), None).await;
    assert!(r.header("content-disposition").starts_with("attachment"));
    assert_eq!(r.header("content-type"), "application/octet-stream");
    // 看不到需求的人 404（含 PAT 越界、跨组织）；PAT 任意 scope 能下载
    assert_eq!(h.req(&w.outsider, "GET", &format!("/api/requirements/{id}/files/{fid}"), None).await.status, 404);
    assert_eq!(h.req(&w.stranger, "GET", &format!("/api/requirements/{id}/files/{fid}"), None).await.status, 404);
    let (ro, _) = create_pat(&h, &w.dev, &["read_responses"], None, None).await;
    assert_eq!(h.req(&ro, "GET", &format!("/api/requirements/{id}/files/{fid}"), None).await.status, 200);
    // 文件 id 换到别的需求下不可下载
    let id2 = create_req(&h, &w, "另一个").await;
    assert_eq!(h.req(&w.pm, "GET", &format!("/api/requirements/{id2}/files/{fid}"), None).await.status, 404);
    // 删除：上传者以外的普通参与者不能删；删后文件也没了
    assert_eq!(h.req(&w.team, "DELETE", &format!("/api/requirements/{id}/files/{fid}"), None).await.status, 403);
    h.req(&w.pm, "DELETE", &format!("/api/requirements/{}/files/{}", id, s(&img["id"])), None).await;
    let n = std::fs::read_dir(&h.uploads).unwrap().count();
    assert_eq!(n, 2);
    // 关闭页面后：无关成员不可下载；发布者仍可
    h.req(&w.pm, "POST", &format!("/api/pages/{id}/close"), None).await.ok(200);
    assert_eq!(h.req(&w.viewer, "GET", &format!("/api/requirements/{id}/files/{fid}"), None).await.status, 404);
    assert_eq!(h.req(&w.dev, "GET", &format!("/api/requirements/{id}/files/{fid}"), None).await.status, 404);
    assert_eq!(h.req(&w.pm, "GET", &format!("/api/requirements/{id}/files/{fid}"), None).await.status, 200);
    assert_eq!(upload(&h, &w.pm, &id, "a.pdf", pdf()).await.code(), "page_closed");
    // 需求页面不支持临时链接
    assert_eq!(h.req(&w.pm, "POST", &format!("/api/pages/{id2}/share-links"), Some(json!({ "expires_in": 3600 }))).await.status, 400);
}

#[tokio::test]
async fn docs_and_links() {
    let h = H::new().await;
    let w = world(&h).await;
    let id = create_req(&h, &w, "支付退款").await;
    // 补充说明：被指派者可加，无关 viewer 不行
    assert_eq!(h.req(&w.viewer, "POST", &format!("/api/requirements/{id}/docs"), Some(json!({ "title": "x", "body": "y" }))).await.status, 403);
    let doc = h.req(&w.dev, "POST", &format!("/api/requirements/{id}/docs"), Some(json!({ "title": "接口草案", "body": "- POST /refund" }))).await.ok(201);
    assert_eq!(h.req(&w.dev, "POST", &format!("/api/requirements/{id}/docs"), Some(json!({ "title": "x", "body": "  " }))).await.status, 400);
    let d = detail(&h, &w.viewer, &id).await;
    assert_eq!(d["docs"][0]["title"], "接口草案");
    assert_eq!(d["docs"][0]["created_by"]["display_name"], "dev");
    assert_eq!(d["docs"][0]["can_delete"], false);
    assert_eq!(h.req(&w.team, "DELETE", &format!("/api/requirements/{}/docs/{}", id, s(&doc["id"])), None).await.status, 403);

    // 关联页面：同组织且自己能看到的才能挂
    let report = publish(&h, &w.pm, &w.proj, "project", &[]).await;
    let hidden_grp = create_group(&h, &w.owner, &w.org, "保密组").await;
    let secret = publish_with(&h, &w.owner, json!({ "project_id": w.proj, "title": "绝密方案", "kind": "openui", "content": "root = Stack([])",
        "page_type": "report", "visibility": "groups", "group_ids": [hidden_grp] })).await;
    let foreign_proj = s(&h.req(&w.outsider, "GET", "/api/me/projects", None).await.ok(200)["items"][0]["id"]);
    let foreign = publish(&h, &w.outsider, &foreign_proj, "project", &[]).await;
    assert_eq!(h.req(&w.dev, "POST", &format!("/api/requirements/{id}/links"), Some(json!({ "page_id": foreign }))).await.status, 404);
    assert_eq!(h.req(&w.dev, "POST", &format!("/api/requirements/{id}/links"), Some(json!({ "page_id": secret }))).await.status, 404);
    assert_eq!(h.req(&w.viewer, "POST", &format!("/api/requirements/{id}/links"), Some(json!({ "page_id": report }))).await.status, 403);
    h.req(&w.dev, "POST", &format!("/api/requirements/{id}/links"), Some(json!({ "page_id": report }))).await.ok(200);
    // 项目管理员（能看保密页）挂上；看不到的人只得到占位，不泄露标题
    h.req(&w.owner, "POST", &format!("/api/requirements/{id}/links"), Some(json!({ "page_id": secret }))).await.ok(200);
    let d = detail(&h, &w.dev, &id).await;
    let links = d["links"].as_array().unwrap();
    assert_eq!(links.len(), 2);
    assert_eq!(links[0]["visible"], true);
    assert_eq!(links[0]["title"], "页面");
    assert_eq!(links[1], json!({ "page_id": secret, "visible": false, "linked_at": links[1]["linked_at"] }));
    assert!(!d.to_string().contains("绝密方案"));
    assert_eq!(detail(&h, &w.owner, &id).await["links"][1]["title"], "绝密方案");
    // 取消关联
    assert_eq!(h.req(&w.dev, "DELETE", &format!("/api/requirements/{id}/links/{report}"), None).await.status, 204);
    assert_eq!(h.req(&w.dev, "DELETE", &format!("/api/requirements/{id}/links/{report}"), None).await.status, 404);
}

#[tokio::test]
async fn publish_with_requirement_links_to_group() {
    let h = H::new().await;
    let w = world(&h).await;
    let id = create_req(&h, &w, "支付退款").await;
    let gid = s(&h.req(&w.dev, "POST", &format!("/api/requirements/{id}/claim"), None).await.ok(200)["group"]["id"]);
    // agent（产品经理的令牌）发分析文档：发到需求群组并自动挂到需求下
    let (pat, _) = create_pat(&h, &w.pm, &["publish"], None, None).await;
    let page = h
        .req(&pat, "POST", "/api/pages", Some(json!({ "project_id": w.proj, "title": "退款接口设计", "kind": "openui", "content": "root = Stack([])",
            "page_type": "knowledge", "visibility": "groups", "group_ids": [gid], "requirement_id": id })))
        .await
        .ok(201);
    let d = detail(&h, &w.dev, &id).await;
    assert_eq!(d["links"][0]["page_id"], page["id"]);
    assert_eq!(d["links"][0]["title"], "退款接口设计");
    // 需求群组成员（被指派群组成员）能看到这个页面；无关 viewer 看不到
    assert_eq!(h.req(&w.team, "GET", &format!("/api/pages/{}/view", s(&page["id"])), None).await.status, 200);
    assert_eq!(h.req(&w.viewer, "GET", &format!("/api/pages/{}/view", s(&page["id"])), None).await.status, 404);
    // 需求在别的项目 → 400；看不到的需求 → 400（不泄露）
    let proj2 = create_project(&h, &w.owner, &w.org, "p2").await;
    let r = h.req(&w.owner, "POST", "/api/pages", Some(json!({ "project_id": proj2, "title": "x", "kind": "openui", "content": "root = Stack([])",
        "page_type": "report", "visibility": "project", "requirement_id": id }))).await;
    assert_eq!(r.status, 400, "{}", r.text());
    let r = h.req(&w.outsider, "POST", "/api/pages", Some(json!({ "project_id": w.proj, "title": "x", "kind": "openui", "content": "root = Stack([])",
        "page_type": "report", "visibility": "project", "requirement_id": id }))).await;
    assert_eq!(r.status, 404);
}

#[tokio::test]
async fn old_data_unchanged() {
    let h = H::new().await;
    let w = world(&h).await;
    let page = publish(&h, &w.pm, &w.proj, "project", &[]).await;
    let before = h.req(&w.pm, "GET", &format!("/api/pages/{page}"), None).await.ok(200);
    let groups_before: i64 = sqlx::query_scalar("SELECT count(*) FROM groups").fetch_one(&h.db).await.unwrap();
    let id = create_req(&h, &w, "支付退款").await;
    let after = h.req(&w.pm, "GET", &format!("/api/pages/{page}"), None).await.ok(200);
    assert_eq!(before, after);
    assert_eq!(after["requirement"], Value::Null);
    let groups_after: i64 = sqlx::query_scalar("SELECT count(*) FROM groups").fetch_one(&h.db).await.unwrap();
    assert_eq!(groups_before, groups_after, "建需求不建群组，认领时才建");
    // 需求页 PATCH /pages 不能改正文、不能改成公开
    assert_eq!(h.req(&w.pm, "PATCH", &format!("/api/pages/{id}"), Some(json!({ "content": "root = Stack([])" }))).await.status, 400);
    assert_eq!(h.req(&w.pm, "PATCH", &format!("/api/pages/{id}"), Some(json!({ "visibility": "public" }))).await.status, 400);
    h.req(&w.pm, "PATCH", &format!("/api/pages/{id}"), Some(json!({ "visibility": "org" }))).await.ok(200);
    // 组织成员（非项目成员）在 org 可见时能看需求
    assert_eq!(h.req(&w.stranger, "GET", &format!("/api/requirements/{id}"), None).await.status, 200);
}
