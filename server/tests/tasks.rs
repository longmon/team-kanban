//! 任务树页面：发布、状态流转、评审、权限、上限、历史、重发合并、首页统计与动态
mod common;

use common::*;
use serde_json::{Value, json};

struct W {
    owner: C,     // 组织 owner = 项目 admin
    editor: C,    // 项目 editor，页面发布者
    assignee: C,  // 项目 viewer，任务负责人
    reviewer: C,  // 项目 viewer，指定评审人
    viewer: C,    // 项目 viewer，普通查看者
    outsider: C,  // 另一个组织
    org: String,
    proj: String,
}

async fn world(h: &H) -> W {
    let owner = register(h, "owner@example.com").await;
    let editor = register(h, "editor@example.com").await;
    let assignee = register(h, "assignee@example.com").await;
    let reviewer = register(h, "reviewer@example.com").await;
    let viewer = register(h, "viewer@example.com").await;
    let outsider = register(h, "outsider@example.com").await;
    let org = create_org(h, &owner, "acme").await;
    for u in [&editor, &assignee, &reviewer, &viewer] {
        join_org(h, &owner, &org, u, "member").await;
    }
    let proj = create_project(h, &owner, &org, "p").await;
    add_project_member(h, &owner, &proj, &editor, "editor").await;
    for u in [&assignee, &reviewer, &viewer] {
        add_project_member(h, &owner, &proj, u, "viewer").await;
    }
    let other = create_org(h, &outsider, "other").await;
    create_project(h, &outsider, &other, "op").await;
    W { owner, editor, assignee, reviewer, viewer, outsider, org, proj }
}

fn tree() -> Value {
    json!([
        { "key": "a", "title": "上线支付", "description": "<b>纯文本</b>", "assignee": "assignee@example.com", "due_at": "2026-12-01T10:00:00+08:00",
          "children": [
            { "key": "a1", "title": "接口联调", "assignee": "assignee@example.com" },
            { "key": "a2", "title": "压测", "assignee": "me", "assignee_label": "Claude Opus 5.5" },
          ] },
        { "key": "b", "title": "写文档" },
    ])
}

async fn publish_tree(h: &H, w: &W, extra: Value) -> String {
    let mut body = json!({ "project_id": w.proj, "title": "支付上线", "kind": "openui", "page_type": "task_tree", "visibility": "project",
        "tasks": tree(), "reviewers": { "users": ["reviewer@example.com"] } });
    body.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    publish_with(h, &w.editor, body).await
}

async fn tasks(h: &H, c: &C, page: &str) -> Value {
    h.req(c, "GET", &format!("/api/pages/{page}/tasks"), None).await.ok(200)
}

fn by_key<'a>(t: &'a Value, key: &str) -> &'a Value {
    t["tasks"].as_array().unwrap().iter().find(|x| x["key"] == key).unwrap_or_else(|| panic!("no task {key}: {t}"))
}

fn id_of(t: &Value, key: &str) -> String {
    s(&by_key(t, key)["id"])
}

#[tokio::test]
async fn publish_and_view() {
    let h = H::new().await;
    let w = world(&h).await;
    let page = h
        .req(&w.editor, "POST", "/api/pages", Some(json!({ "project_id": w.proj, "title": "支付上线", "kind": "openui", "page_type": "task_tree",
            "visibility": "project", "tasks": tree(), "reviewers": { "users": ["reviewer@example.com"] } })))
        .await
        .ok(201);
    assert_eq!((page["category"].clone(), page["accept_responses"].clone(), page["version"].clone()), (json!("collab"), json!(false), json!(1)));
    assert_eq!(page["task_stats"], json!({ "total": 4, "done": 0, "in_review": 0, "my_todo": 1, "my_review": 0 }));
    let id = s(&page["id"]);
    // view 带任务树；不能提交
    let v = h.req(&w.assignee, "GET", &format!("/api/pages/{id}/view"), None).await.ok(200);
    assert_eq!((v["can_submit"].clone(), v["submit_block_reason"].clone()), (json!(false), json!("read_only")));
    assert_eq!(v["content"]["spec"], "root = Stack([])");
    let t = &v["task_tree"];
    assert_eq!(t["progress"], json!({ "total": 4, "done": 0, "in_review": 0 }));
    assert_eq!(t["reviewers"]["users"][0]["display_name"], "reviewer");
    assert_eq!(t["me"]["can_manage"], false);
    let a = by_key(t, "a");
    assert_eq!((a["description"].clone(), a["status"].clone(), a["assignee"]["user"]["display_name"].clone()), (json!("<b>纯文本</b>"), json!("todo"), json!("assignee")));
    assert_eq!(a["due_at"], "2026-12-01T02:00:00.000Z");
    assert_eq!((a["can_edit"].clone(), by_key(t, "b")["can_edit"].clone()), (json!(true), json!(false)));
    let a2 = by_key(t, "a2");
    assert_eq!((a2["parent_id"].clone(), a2["assignee"]["label"].clone(), a2["assignee"]["user"]["display_name"].clone()), (a["id"].clone(), json!("Claude Opus 5.5"), json!("editor")));
    assert_eq!(by_key(t, "a1")["position"], 0);
    assert_eq!(by_key(t, "a2")["position"], 1);
    // 发布者有管理权；提交接口拒绝
    assert_eq!(tasks(&h, &w.editor, &id).await["me"]["can_manage"], true);
    let r = h.req(&w.assignee, "POST", &format!("/api/pages/{id}/responses"), Some(json!({ "data": {} }))).await;
    assert_eq!((r.status, r.code()), (409, "read_only_page".into()));
    // 校验：其它协作类仍未开放；tasks 只给 task_tree；说明区只能 openui；accept_responses=true 拒绝；评审人必须是组织成员
    let base = json!({ "project_id": w.proj, "title": "t", "kind": "openui", "content": "root = Stack([])", "visibility": "project" });
    for (extra, field) in [
        (json!({ "page_type": "task" }), "page_type"),
        (json!({ "page_type": "report", "tasks": [] }), "tasks"),
        (json!({ "page_type": "vote", "reviewers": { "users": [] } }), "reviewers"),
        (json!({ "page_type": "task_tree", "kind": "html" }), "kind"),
        (json!({ "page_type": "task_tree", "accept_responses": true }), "accept_responses"),
        (json!({ "page_type": "task_tree", "reviewers": { "users": ["outsider@example.com"] } }), "reviewers"),
        (json!({ "page_type": "task_tree", "tasks": [{ "title": "x", "assignee": "nobody@example.com" }] }), "tasks"),
        (json!({ "page_type": "task_tree", "tasks": [{ "title": "" }] }), "title"),
        (json!({ "page_type": "task_tree", "tasks": [{ "title": "x", "due_at": "2026-12-01 10:00" }] }), "due_at"),
    ] {
        let mut b = base.clone();
        b.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let r = h.req(&w.editor, "POST", "/api/pages", Some(b)).await;
        assert_eq!(r.status, 400, "{extra}: {}", r.text());
        assert!(r.json()["error"]["details"]["fields"][field].is_string(), "{extra}: {}", r.text());
    }
    // 旧类型页面行为不变：任务接口 409、无 task_stats
    let vote = publish(&h, &w.editor, &w.proj, "project", &[]).await;
    let r = h.req(&w.editor, "GET", &format!("/api/pages/{vote}/tasks"), None).await;
    assert_eq!((r.status, r.code()), (409, "not_task_page".into()));
    let v = h.req(&w.editor, "GET", &format!("/api/pages/{vote}/view"), None).await.ok(200);
    assert_eq!((v["task_tree"].clone(), v["can_submit"].clone()), (Value::Null, json!(true)));
}

#[tokio::test]
async fn limits() {
    let h = H::new().await;
    let w = world(&h).await;
    let mut deep = json!({ "title": "6" });
    for i in (1..6).rev() {
        deep = json!({ "title": i.to_string(), "children": [deep] });
    }
    let id = publish_with(&h, &w.editor, json!({ "project_id": w.proj, "title": "t", "kind": "openui", "page_type": "task_tree", "visibility": "project", "tasks": [deep.clone()] })).await;
    let r = h.req(&w.editor, "POST", "/api/pages", Some(json!({ "project_id": w.proj, "title": "t", "kind": "openui", "page_type": "task_tree", "visibility": "project",
        "tasks": [{ "title": "0", "children": [deep] }] }))).await;
    assert_eq!(r.status, 400, "{}", r.text());
    let many: Vec<Value> = (0..501).map(|i| json!({ "title": format!("t{i}") })).collect();
    let r = h.req(&w.editor, "POST", "/api/pages", Some(json!({ "project_id": w.proj, "title": "t", "kind": "openui", "page_type": "task_tree", "visibility": "project", "tasks": many }))).await;
    assert_eq!(r.status, 400, "{}", r.text());
    // 第 6 层下面不能再加子任务
    let t = tasks(&h, &w.editor, &id).await;
    let leaf = t["tasks"].as_array().unwrap().iter().find(|x| x["title"] == "6").unwrap();
    let r = h.req(&w.editor, "POST", &format!("/api/pages/{id}/tasks"), Some(json!({ "parent_id": leaf["id"], "title": "7" }))).await;
    assert_eq!((r.status, r.json()["error"]["details"]["fields"]["parent_id"].is_string()), (400, true), "{}", r.text());
    // 节点数：500 个后不能再加
    let many: Vec<Value> = (0..500).map(|i| json!({ "title": format!("t{i}") })).collect();
    let full = publish_with(&h, &w.editor, json!({ "project_id": w.proj, "title": "t", "kind": "openui", "page_type": "task_tree", "visibility": "project", "tasks": many })).await;
    let r = h.req(&w.editor, "POST", &format!("/api/pages/{full}/tasks"), Some(json!({ "title": "x" }))).await;
    assert_eq!(r.status, 400, "{}", r.text());
}

#[tokio::test]
async fn workflow_and_review() {
    let h = H::new().await;
    let w = world(&h).await;
    let page = publish_tree(&h, &w, json!({})).await;
    let t = tasks(&h, &w.assignee, &page).await;
    let (a, a1, a2) = (id_of(&t, "a"), id_of(&t, "a1"), id_of(&t, "a2"));
    let patch = |c: &C, id: &str, body: Value| {
        let (c, id) = (c.clone(), id.to_string());
        let h = &h;
        async move { h.req(&c, "PATCH", &format!("/api/tasks/{id}"), Some(body)).await }
    };
    let review = |c: &C, id: &str, body: Value| {
        let (c, id) = (c.clone(), id.to_string());
        let h = &h;
        async move { h.req(&c, "POST", &format!("/api/tasks/{id}/review"), Some(body)).await }
    };
    // 负责人开始 → 进行中
    assert_eq!(patch(&w.assignee, &a1, json!({ "status": "in_progress" })).await.ok(200)["status"], "in_progress");
    // 不能直接标 done；非法状态值；证据只允许 http(s)
    for (body, field) in [
        (json!({ "status": "done" }), "status"),
        (json!({ "status": "archived" }), "status"),
        (json!({ "status": "in_review", "evidence": ["javascript:alert(1)"] }), "evidence"),
        (json!({ "status": "in_progress", "evidence": ["https://ci.example.com/1"] }), "evidence"),
        (json!({ "note": "没带 status" }), "note"),
    ] {
        let r = patch(&w.assignee, &a1, body.clone()).await;
        assert_eq!((r.status, r.json()["error"]["details"]["fields"][field].is_string()), (400, true), "{body}: {}", r.text());
    }
    // 父节点：子任务没全部完成不能提交评审
    let r = patch(&w.assignee, &a, json!({ "status": "in_review" })).await;
    assert_eq!((r.status, r.code()), (409, "children_not_done".into()));
    // 提交评审（完成说明 + 证据）
    let r = patch(&w.assignee, &a1, json!({ "status": "in_review", "note": "联调通过", "evidence": ["https://ci.example.com/run/1"] })).await.ok(200);
    assert_eq!((r["status"].clone(), r["submit_note"].clone(), r["evidence"].clone()), (json!("in_review"), json!("联调通过"), json!(["https://ci.example.com/run/1"])));
    assert_eq!(r["submitted_by"]["display_name"], "assignee");
    // 待评审时负责人不能再改状态
    let r = patch(&w.assignee, &a1, json!({ "status": "in_progress" })).await;
    assert_eq!((r.status, r.code()), (409, "task_in_review".into()));
    // 非评审人（含项目 admin，因为指定了评审人）不能评审
    for c in [&w.viewer, &w.owner, &w.editor] {
        let r = review(c, &a1, json!({ "decision": "approve" })).await;
        assert_eq!((r.status, r.code()), (403, "not_reviewer".into()), "{}", r.text());
    }
    // 驳回必须写理由
    let r = review(&w.reviewer, &a1, json!({ "decision": "reject" })).await;
    assert_eq!((r.status, r.json()["error"]["details"]["fields"]["note"].is_string()), (400, true));
    let r = review(&w.reviewer, &a1, json!({ "decision": "reject", "note": "缺少回调验签" })).await.ok(200);
    assert_eq!((r["status"].clone(), r["reject_reason"].clone(), r["reviewed_by"]["display_name"].clone()), (json!("in_progress"), json!("缺少回调验签"), json!("reviewer")));
    // 被驳回筛选
    let rej = h.req(&w.assignee, "GET", &format!("/api/pages/{page}/tasks?filter=rejected"), None).await.ok(200);
    assert_eq!(rej["tasks"].as_array().unwrap().len(), 1);
    // 再提交 → 驳回理由清空；评审人在待评审队列里看到它
    let r = patch(&w.assignee, &a1, json!({ "status": "in_review", "note": "已补验签" })).await.ok(200);
    assert_eq!(r["reject_reason"], Value::Null);
    let q = h.req(&w.reviewer, "GET", &format!("/api/pages/{page}/tasks?filter=review"), None).await.ok(200);
    assert_eq!((q["tasks"].as_array().unwrap().len(), q["tasks"][0]["can_review"].clone()), (1, json!(true)));
    assert_eq!(h.req(&w.reviewer, "GET", "/api/pages", None).await.ok(200)["items"][0]["task_stats"]["my_review"], 1);
    let r = review(&w.reviewer, &a1, json!({ "decision": "approve", "note": "通过" })).await.ok(200);
    assert_eq!(r["status"], "done");
    // 完成后不能再改状态、不能再评审
    assert_eq!(patch(&w.assignee, &a1, json!({ "status": "in_progress" })).await.code(), "task_done");
    assert_eq!(review(&w.reviewer, &a1, json!({ "decision": "approve" })).await.code(), "task_not_in_review");
    // 完成人不能评审自己：评审人自己是 a2 的负责人时
    h.req(&w.editor, "PATCH", &format!("/api/tasks/{a2}"), Some(json!({ "assignee": "reviewer@example.com" }))).await.ok(200);
    patch(&w.reviewer, &a2, json!({ "status": "in_review" })).await.ok(200);
    let r = review(&w.reviewer, &a2, json!({ "decision": "approve" })).await;
    assert_eq!((r.status, r.code()), (403, "self_review".into()));
    // 列表里也不计入他的待评审
    assert_eq!(h.req(&w.reviewer, "GET", "/api/pages", None).await.ok(200)["items"][0]["task_stats"]["my_review"], 0);
    // 换评审人（群组）后由群组成员评审；评审人可后改
    let g = create_group(&h, &w.owner, &w.org, "qa").await;
    h.req(&w.owner, "POST", &format!("/api/groups/{g}/members"), Some(json!({ "user_id": w.viewer.user_id }))).await.ok(201);
    h.req(&w.editor, "PATCH", &format!("/api/pages/{page}"), Some(json!({ "reviewers": { "groups": [g] } }))).await.ok(200);
    assert_eq!(review(&w.reviewer, &a2, json!({ "decision": "approve" })).await.code(), "not_reviewer");
    review(&w.viewer, &a2, json!({ "decision": "approve" })).await.ok(200);
    // 子任务全部完成后父节点才能提交
    patch(&w.assignee, &a, json!({ "status": "in_review", "note": "全部完成" })).await.ok(200);
    // 清空评审人 → 回落到项目管理员（组织 owner）
    let v = h.req(&w.editor, "PATCH", &format!("/api/pages/{page}"), Some(json!({ "reviewers": { "users": [], "groups": [] } }))).await.ok(200);
    assert_eq!(v["version"], 1, "评审人变化不产生新版本");
    assert_eq!(tasks(&h, &w.owner, &page).await["reviewers"]["fallback"], "project_admins");
    assert_eq!(review(&w.viewer, &a, json!({ "decision": "approve" })).await.code(), "not_reviewer");
    review(&w.owner, &a, json!({ "decision": "approve" })).await.ok(200);
    let t = tasks(&h, &w.viewer, &page).await;
    assert_eq!(t["progress"], json!({ "total": 4, "done": 3, "in_review": 0 }));
    // 历史完整：谁、何时、从什么到什么、说明
    let ev = h.req(&w.viewer, "GET", &format!("/api/tasks/{a1}/events"), None).await.ok(200);
    let acts: Vec<(String, Value, Value, Value)> = ev["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (s(&e["action"]), e["to_status"].clone(), e["note"].clone(), e["actor"]["display_name"].clone()))
        .collect();
    assert_eq!(
        acts,
        vec![
            ("created".into(), Value::Null, Value::Null, json!("editor")),
            ("started".into(), json!("in_progress"), Value::Null, json!("assignee")),
            ("submitted".into(), json!("in_review"), json!("联调通过"), json!("assignee")),
            ("rejected".into(), json!("in_progress"), json!("缺少回调验签"), json!("reviewer")),
            ("submitted".into(), json!("in_review"), json!("已补验签"), json!("assignee")),
            ("approved".into(), json!("done"), json!("通过"), json!("reviewer")),
        ]
    );
    assert_eq!(ev["items"][2]["evidence"], json!(["https://ci.example.com/run/1"]));
    assert_eq!(ev["items"][2]["from_status"], "in_progress");
    // 动态流出现任务事件
    let act = h.req(&w.owner, "GET", "/api/activity", None).await.ok(200);
    let task_evs: Vec<&Value> = act["items"].as_array().unwrap().iter().filter(|a| a["type"] == "task").collect();
    assert!(task_evs.iter().any(|a| a["task"]["action"] == "rejected" && a["task"]["title"] == "接口联调" && a["actor"]["name"] == "reviewer"), "{act}");
}

#[tokio::test]
async fn permissions() {
    let h = H::new().await;
    let w = world(&h).await;
    let page = publish_tree(&h, &w, json!({})).await;
    let t = tasks(&h, &w.owner, &page).await;
    let (a, a1, b) = (id_of(&t, "a"), id_of(&t, "a1"), id_of(&t, "b"));
    // 普通查看者：能看，不能改、不能加
    tasks(&h, &w.viewer, &page).await;
    assert_eq!(h.req(&w.viewer, "PATCH", &format!("/api/tasks/{b}"), Some(json!({ "status": "in_progress" }))).await.status, 403);
    assert_eq!(h.req(&w.viewer, "POST", &format!("/api/pages/{page}/tasks"), Some(json!({ "title": "x" }))).await.status, 403);
    // 负责人：只能改自己的节点；能在自己的节点下加子任务，不能加根节点
    assert_eq!(h.req(&w.assignee, "PATCH", &format!("/api/tasks/{b}"), Some(json!({ "title": "x" }))).await.status, 403);
    let sub = h.req(&w.assignee, "POST", &format!("/api/pages/{page}/tasks"), Some(json!({ "parent_id": a1, "title": "补单测", "assignee": "me" }))).await.ok(201);
    assert_eq!((sub["parent_id"].clone(), sub["status"].clone(), sub["assignee"]["user"]["display_name"].clone()), (json!(a1), json!("todo"), json!("assignee")));
    assert_eq!(h.req(&w.assignee, "POST", &format!("/api/pages/{page}/tasks"), Some(json!({ "title": "根" }))).await.status, 403);
    // 项目 admin 与发布者：任意节点
    h.req(&w.owner, "PATCH", &format!("/api/tasks/{b}"), Some(json!({ "status": "in_progress", "assignee": "viewer@example.com" }))).await.ok(200);
    h.req(&w.editor, "PATCH", &format!("/api/tasks/{b}"), Some(json!({ "due_at": null, "title": "写接口文档" }))).await.ok(200);
    h.req(&w.editor, "POST", &format!("/api/pages/{page}/tasks"), Some(json!({ "title": "新根节点", "key": "c" }))).await.ok(201);
    assert_eq!(h.req(&w.editor, "POST", &format!("/api/pages/{page}/tasks"), Some(json!({ "title": "重复", "key": "c" }))).await.code(), "task_key_taken");
    // 改成负责人后，原查看者获得编辑权
    h.req(&w.viewer, "PATCH", &format!("/api/tasks/{b}"), Some(json!({ "status": "todo" }))).await.ok(200);
    // 跨组织、无关用户、匿名：404
    for c in [&w.outsider, &C::anon()] {
        assert_eq!(h.req(c, "GET", &format!("/api/pages/{page}/tasks"), None).await.status, 404);
        assert_eq!(h.req(c, "PATCH", &format!("/api/tasks/{a}"), Some(json!({ "title": "x" }))).await.status, 404);
        assert_eq!(h.req(c, "POST", &format!("/api/tasks/{a}/review"), Some(json!({ "decision": "approve" }))).await.status, 404);
        assert_eq!(h.req(c, "GET", &format!("/api/tasks/{a}/events"), None).await.status, 404);
    }
    // 不存在的任务 404
    assert_eq!(h.req(&w.owner, "PATCH", &format!("/api/tasks/{}", uuid::Uuid::now_v7()), Some(json!({ "title": "x" }))).await.status, 404);
    // PAT：publish 能改，read_responses 只能读；限定其它项目的 PAT 404
    let (pat, _) = create_pat(&h, &w.assignee, &["publish"], None, None).await;
    let r = h.req(&pat, "PATCH", &format!("/api/tasks/{a1}"), Some(json!({ "status": "in_progress" }))).await.ok(200);
    assert_eq!(r["status"], "in_progress");
    let ev = h.req(&w.owner, "GET", &format!("/api/tasks/{a1}/events"), None).await.ok(200);
    assert_eq!(ev["items"].as_array().unwrap().last().unwrap()["via_token"], true);
    let (ro, _) = create_pat(&h, &w.assignee, &["read_responses"], None, None).await;
    tasks(&h, &ro, &page).await;
    assert_eq!(h.req(&ro, "PATCH", &format!("/api/tasks/{a1}"), Some(json!({ "title": "x" }))).await.status, 403);
    let p2 = create_project(&h, &w.owner, &w.org, "p2").await;
    add_project_member(&h, &w.owner, &p2, &w.assignee, "viewer").await;
    let (bounded, _) = create_pat(&h, &w.assignee, &["publish"], Some(&w.org), Some(&p2)).await;
    assert_eq!(h.req(&bounded, "PATCH", &format!("/api/tasks/{a1}"), Some(json!({ "title": "x" }))).await.status, 404);
    // 已完成 / 待评审的父节点下不能加子任务
    h.req(&w.owner, "PATCH", &format!("/api/tasks/{b}"), Some(json!({ "status": "in_review" }))).await.ok(200);
    assert_eq!(h.req(&w.owner, "POST", &format!("/api/pages/{page}/tasks"), Some(json!({ "parent_id": b, "title": "x" }))).await.code(), "task_locked");
    // 临时链接访问：能看到任务树，但一律只读
    let link = h.req(&w.editor, "POST", &format!("/api/pages/{page}/share-links"), Some(json!({ "expires_in": 3600 }))).await.ok(201);
    let token = s(&link["url"]).rsplit('/').next().unwrap().to_string();
    let v = h.req(&w.owner, "GET", &format!("/api/s/{token}"), None).await.ok(200);
    assert_eq!((v["task_tree"]["me"]["can_manage"].clone(), v["task_tree"]["tasks"][0]["can_edit"].clone()), (json!(false), json!(false)));
}

#[tokio::test]
async fn move_up_down() {
    let h = H::new().await;
    let w = world(&h).await;
    let page = publish_tree(&h, &w, json!({})).await;
    let t = tasks(&h, &w.editor, &page).await;
    let a2 = id_of(&t, "a2");
    let order = |t: &Value| {
        let mut v: Vec<(i64, String)> = t["tasks"].as_array().unwrap().iter().filter(|x| x["parent_id"].is_string()).map(|x| (x["position"].as_i64().unwrap(), s(&x["key"]))).collect();
        v.sort();
        v.into_iter().map(|x| x.1).collect::<Vec<_>>()
    };
    assert_eq!(order(&t), vec!["a1", "a2"]);
    h.req(&w.editor, "PATCH", &format!("/api/tasks/{a2}"), Some(json!({ "move": "up" }))).await.ok(200);
    assert_eq!(order(&tasks(&h, &w.editor, &page).await), vec!["a2", "a1"]);
    // 已在最前：不变
    h.req(&w.editor, "PATCH", &format!("/api/tasks/{a2}"), Some(json!({ "move": "up" }))).await.ok(200);
    h.req(&w.editor, "PATCH", &format!("/api/tasks/{a2}"), Some(json!({ "move": "down" }))).await.ok(200);
    assert_eq!(order(&tasks(&h, &w.editor, &page).await), vec!["a1", "a2"]);
    assert_eq!(h.req(&w.editor, "PATCH", &format!("/api/tasks/{a2}"), Some(json!({ "move": "left" }))).await.status, 400);
}

#[tokio::test]
async fn republish_merges_by_key() {
    let h = H::new().await;
    let w = world(&h).await;
    let page = publish_tree(&h, &w, json!({})).await;
    let t = tasks(&h, &w.editor, &page).await;
    let (a1, b) = (id_of(&t, "a1"), id_of(&t, "b"));
    h.req(&w.assignee, "PATCH", &format!("/api/tasks/{a1}"), Some(json!({ "status": "in_progress" }))).await.ok(200);
    // 重发：a1 改标题并移到 b 下、删掉 a2、新增 c；状态保留，版本不变
    let v = h
        .req(&w.editor, "PATCH", &format!("/api/pages/{page}"), Some(json!({ "tasks": [
            { "key": "a", "title": "上线支付", "description": "<b>纯文本</b>", "assignee": "assignee@example.com", "due_at": "2026-12-01T10:00:00+08:00" },
            { "key": "b", "title": "写文档", "children": [{ "key": "a1", "title": "接口联调（含验签）", "assignee": "assignee@example.com" }] },
            { "key": "c", "title": "灰度" },
        ] })))
        .await
        .ok(200);
    assert_eq!(v["version"], 1);
    let t = tasks(&h, &w.editor, &page).await;
    assert_eq!(t["tasks"].as_array().unwrap().len(), 4);
    let x = by_key(&t, "a1");
    assert_eq!((x["id"].clone(), x["status"].clone(), x["title"].clone(), x["parent_id"].clone()), (json!(a1), json!("in_progress"), json!("接口联调（含验签）"), json!(b)));
    assert_eq!(by_key(&t, "c")["status"], "todo");
    // 我的待办计数：负责人（a 待办 + a1 进行中）
    let items = h.req(&w.assignee, "GET", "/api/pages", None).await.ok(200);
    let tp = items["items"].as_array().unwrap().iter().find(|p| p["id"] == json!(page)).unwrap();
    assert_eq!(tp["task_stats"]["my_todo"], 2);
    assert!(!t["tasks"].as_array().unwrap().iter().any(|x| x["key"] == "a2"));
    // 软删的节点不能再操作，历史保留
    let a2: String = sqlx::query_scalar("SELECT id::text FROM tasks WHERE key = 'a2' AND deleted_at IS NOT NULL").fetch_one(&h.db).await.unwrap();
    assert_eq!(h.req(&w.editor, "PATCH", &format!("/api/tasks/{a2}"), Some(json!({ "title": "x" }))).await.status, 404);
    let acts: Vec<String> = sqlx::query_scalar("SELECT action FROM task_events WHERE task_id = $1::uuid ORDER BY created_at, id").bind(&a2).fetch_all(&h.db).await.unwrap();
    assert_eq!(acts, vec!["created", "deleted"]);
    let edited: Value = sqlx::query_scalar("SELECT meta FROM task_events WHERE task_id = $1::uuid AND action = 'edited'").bind(&a1).fetch_one(&h.db).await.unwrap();
    assert_eq!(edited["fields"], json!(["title", "parent"]));
    // 再加回 a2：恢复原节点（同 id，原状态）
    h.req(&w.editor, "PATCH", &format!("/api/pages/{page}"), Some(json!({ "tasks": [{ "key": "a", "title": "上线支付", "children": [{ "key": "a2", "title": "压测" }] }] }))).await.ok(200);
    let t = tasks(&h, &w.editor, &page).await;
    assert_eq!(id_of(&t, "a2"), a2);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM task_events WHERE task_id = $1::uuid AND action = 'restored'").bind(&a2).fetch_one(&h.db).await.unwrap();
    assert_eq!(n, 1);
    // 版本快照只有 v1
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM page_versions WHERE page_id = $1::uuid").bind(&page).fetch_one(&h.db).await.unwrap();
    assert_eq!(n, 1);
    // 非任务页传 tasks → 400；页面查看者不能重发
    let vote = publish(&h, &w.editor, &w.proj, "project", &[]).await;
    assert_eq!(h.req(&w.editor, "PATCH", &format!("/api/pages/{vote}"), Some(json!({ "tasks": [] }))).await.status, 400);
    assert_eq!(h.req(&w.viewer, "PATCH", &format!("/api/pages/{page}"), Some(json!({ "tasks": [] }))).await.status, 403);
}
