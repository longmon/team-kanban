//! 对真实后端的冒烟：需设置 LIVE_TEAM_KANBAN_URL 与 LIVE_TEAM_KANBAN_TOKEN（含 publish + read_responses 的 PAT），
//! 否则直接跳过。scripts/e2e.sh 会起临时库和服务后执行 `cargo test --test live`。

use std::time::{Duration, Instant};

use rmcp::{
    RoleClient, ServiceExt,
    model::{CallToolRequestParams, CallToolResult},
    service::RunningService,
    transport::TokioChildProcess,
};
use serde_json::{Value, json};

async fn client(url: &str, token: &str) -> RunningService<RoleClient, ()> {
    let mut cmd = tokio::process::Command::new(env!("CARGO_BIN_EXE_tkanban"));
    cmd.env("TEAM_KANBAN_URL", url).env("TEAM_KANBAN_TOKEN", token);
    // 指向不存在的配置目录：只用 env 隐式 profile，不受本机 ~/.config/team-kanban 影响
    cmd.env("XDG_CONFIG_HOME", std::env::temp_dir().join(format!("tkanban-live-noconf-{}", std::process::id())));
    for k in ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"] {
        cmd.env_remove(k);
    }
    ().serve(TokioChildProcess::new(cmd).unwrap()).await.unwrap()
}

async fn call(c: &RunningService<RoleClient, ()>, name: &'static str, args: Value) -> (bool, String) {
    let params = CallToolRequestParams::new(name).with_arguments(args.as_object().unwrap().clone());
    let r: CallToolResult = c.call_tool(params).await.unwrap();
    let text = r.content.iter().filter_map(|c| c.as_text()).map(|t| t.text.as_str()).collect();
    (r.is_error == Some(true), text)
}

fn ok_json(r: (bool, String)) -> Value {
    assert!(!r.0, "unexpected error: {}", r.1);
    serde_json::from_str(&r.1).unwrap()
}

fn responses_json(t: &str) -> Value {
    let (head, body) = t.split_once("\n\n").unwrap();
    assert!(head.starts_with('⚠'), "{t}");
    serde_json::from_str(body).unwrap()
}

/// 匿名 POST（模拟分享页/外壳页调用 §8.1）
async fn anon_post(http: &reqwest::Client, url: String, body: Value) -> Value {
    let r = http.post(url).json(&body).send().await.unwrap();
    assert_eq!(r.status(), 201, "{:?}", r.text().await);
    r.json().await.unwrap()
}

#[tokio::test]
async fn live_smoke() {
    let (Ok(base), Ok(token)) = (std::env::var("LIVE_TEAM_KANBAN_URL"), std::env::var("LIVE_TEAM_KANBAN_TOKEN")) else {
        eprintln!("跳过：未设置 LIVE_TEAM_KANBAN_URL / LIVE_TEAM_KANBAN_TOKEN");
        return;
    };
    let base = base.trim_end_matches('/').to_string();
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    let c = client(&base, &token).await;

    // 1. 真实提示词
    let (e, guide) = call(&c, "get_ui_guide", json!({})).await;
    let prompt = http.get(format!("{base}/openui/prompt.md")).send().await.unwrap().text().await.unwrap();
    assert!(!e && guide.contains(prompt.lines().find(|l| !l.trim().is_empty()).unwrap()), "{guide}");
    assert!(guide.contains("data-kanban"));

    // 2. 项目
    let p = ok_json(call(&c, "list_projects", json!({})).await);
    let proj = &p["projects"][0];
    let slug = format!("{}/{}", proj["org"]["slug"].as_str().unwrap(), proj["slug"].as_str().unwrap());
    assert_eq!(proj["can_publish"], true);

    // 3. 投票页
    let vote = include_str!("../guide/vote.oui");
    let pub1 = ok_json(call(&c, "publish_page", json!({ "page_type": "vote", "model": "Claude Opus 5.5",
        "project": slug, "title": "技术方案投票", "spec": vote, "visibility": "project",
    })).await);
    assert_eq!((pub1["version"].as_i64(), pub1["visibility"].as_str()), (Some(1), Some("project")));
    let id = pub1["id"].as_str().unwrap().to_string();
    assert_eq!(pub1["url"], format!("{base}/pages/{id}"));

    // 4. 临时链接
    let link = ok_json(call(&c, "create_share_link", json!({ "page_id": id, "expires_in": 3600, "max_uses": 10, "label": "群发" })).await);
    let share_token = link["url"].as_str().unwrap().rsplit('/').next().unwrap().to_string();
    assert_eq!(link["has_password"], false);

    // 5. 匿名经分享链接提交 2 次（数据结构见 api.md §10）
    let view: Value = http.get(format!("{base}/api/s/{share_token}")).send().await.unwrap().json().await.unwrap();
    assert_eq!((view["content"]["kind"].as_str(), view["can_submit"].as_bool()), (Some("openui"), Some(true)), "{view}");
    for (nick, choice) in [("小明", "A"), ("小红", "B")] {
        anon_post(&http, format!("{base}/api/s/{share_token}/responses"), json!({
            "nickname": nick,
            "data": { "action": "提交", "form": "vote", "values": { "choice": choice, "comment": "理由" }, "params": {} },
        })).await;
    }

    // 6. get_responses：since + wait
    let r = responses_json(&call(&c, "get_responses", json!({ "page_id": id })).await.1);
    assert_eq!(r["responses"].as_array().unwrap().len(), 2);
    assert_eq!(r["responses"][0]["respondent"], json!({ "type": "anonymous", "nickname": "小明" }));
    assert_eq!(r["responses"][1]["data"]["values"]["choice"], "B");
    assert_eq!(r["responses"][0]["share_link"]["label"], "群发");
    let since = r["next_since"].as_i64().unwrap();
    // 无新数据：挂满 wait
    let t0 = Instant::now();
    let r = responses_json(&call(&c, "get_responses", json!({ "page_id": id, "since": since, "wait_seconds": 1 })).await.1);
    assert!(r["responses"].as_array().unwrap().is_empty() && t0.elapsed() >= Duration::from_millis(900));
    // 等待中来新提交：立即返回
    let (h2, b2, t2) = (http.clone(), base.clone(), share_token.clone());
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        anon_post(&h2, format!("{b2}/api/s/{t2}/responses"), json!({ "nickname": "小刚", "data": { "action": "提交", "form": "vote", "values": { "choice": "A" }, "params": {} } })).await;
    });
    let t0 = Instant::now();
    let r = responses_json(&call(&c, "get_responses", json!({ "page_id": id, "since": since, "wait_seconds": 20 })).await.1);
    assert_eq!(r["responses"][0]["respondent"]["nickname"], "小刚", "{r}");
    assert!(t0.elapsed() < Duration::from_secs(5));

    // 7. html 页：取 frame_url 验证 CSP 与桥接脚本，再按外壳页的方式提交
    let pub2 = ok_json(call(&c, "publish_page", json!({ "page_type": "vote", "model": "Claude Opus 5.5",
        "project": proj["id"], "title": "报名表", "kind": "html", "visibility": "public",
        "html": "<!doctype html><form data-kanban><input name=\"name\"><button>提交</button></form>",
    })).await);
    let hid = pub2["id"].as_str().unwrap().to_string();
    let view: Value = http.get(format!("{base}/api/pages/{hid}/view")).send().await.unwrap().json().await.unwrap();
    let frame_url = view["content"]["frame_url"].as_str().unwrap();
    let fr = http.get(frame_url).send().await.unwrap();
    assert_eq!(fr.status(), 200, "{frame_url}");
    let csp = fr.headers()["content-security-policy"].to_str().unwrap().to_string();
    assert!(csp.contains("sandbox allow-scripts allow-forms") && csp.contains(&format!("frame-ancestors {base}")), "{csp}");
    let body = fr.text().await.unwrap();
    assert!(body.contains("relay:submit") && body.contains("data-kanban"), "{body}");
    anon_post(&http, format!("{base}/api/pages/{hid}/responses"), json!({ "nickname": "访客", "data": { "name": "张三" } })).await;
    let r = responses_json(&call(&c, "get_responses", json!({ "page_id": hid })).await.1);
    assert_eq!(r["responses"][0]["data"], json!({ "name": "张三" }));

    // 8. update_page：内容变化 version+1，旧 frame_url 仍返回 v1 历史内容
    let up = ok_json(call(&c, "update_page", json!({ "page_id": hid, "title": "报名表 v2", "html": "<!doctype html><p>closed</p>", "accept_responses": false })).await);
    assert_eq!(up["version"], 2);
    let old = http.get(frame_url).send().await.unwrap();
    assert_eq!(old.status(), 200);
    assert!(!old.text().await.unwrap().contains("closed"));

    // 9. list_pages
    let l = ok_json(call(&c, "list_pages", json!({ "project": slug })).await);
    let titles: Vec<&str> = l["pages"].as_array().unwrap().iter().map(|p| p["title"].as_str().unwrap()).collect();
    assert!(titles.contains(&"技术方案投票") && titles.contains(&"报名表 v2"), "{titles:?}");

    // 10. 写错的 openui 被本地拦下，服务端无新页面
    let (e, t) = call(&c, "publish_page", json!({ "page_type": "vote", "model": "Claude Opus 5.5", "project": slug, "title": "坏", "spec": "root = Stack([x])\nx = Bogus(1)" })).await;
    assert!(e && t.starts_with("openui_invalid:"), "{t}");
    let l2 = ok_json(call(&c, "list_pages", json!({ "project": slug })).await);
    assert_eq!(l2["pages"].as_array().unwrap().len(), l["pages"].as_array().unwrap().len());

    // 11. 任务树：发布 → list_tasks → update_task 提交评审 → 自评被拒 → 另一位评审人（第二个令牌）通过。
    // 需要 LIVE_TEAM_KANBAN_TOKEN2（同项目另一成员的 publish 令牌）与 LIVE_REVIEWER_EMAIL（该成员邮箱）
    if let (Ok(token2), Ok(bob)) = (std::env::var("LIVE_TEAM_KANBAN_TOKEN2"), std::env::var("LIVE_REVIEWER_EMAIL")) {
        let p = ok_json(call(&c, "publish_page", json!({ "page_type": "task_tree", "model": "Claude Opus 5.5", "project": slug, "title": "上线清单",
            "visibility": "project", "summary": "支付上线的任务清单", "reviewers": ["me", bob],
            "tasks": [{ "key": "deploy", "title": "上线", "assignee": "me", "assignee_label": "Claude Opus 5.5",
                        "children": [{ "key": "migrate", "title": "执行迁移", "assignee": "me" }] }],
        })).await);
        assert_eq!(p["category"], "collab");
        let pid = p["id"].as_str().unwrap().to_string();
        let tasks_of = |t: &str| -> Value { serde_json::from_str(t.split_once("\n\n").unwrap().1).unwrap() };
        let (e, t) = call(&c, "list_tasks", json!({ "page_id": pid, "filter": "mine" })).await;
        assert!(!e, "{t}");
        let list = tasks_of(&t);
        let find = |k: &str| list["tasks"].as_array().unwrap().iter().find(|x| x["key"] == k).unwrap()["id"].as_str().unwrap().to_string();
        let (deploy, migrate) = (find("deploy"), find("migrate"));
        // 父节点在子任务完成前不能提交
        let (e, t) = call(&c, "update_task", json!({ "page_id": pid, "task_id": deploy, "status": "in_review" })).await;
        assert!(e && t.starts_with("children_not_done:"), "{t}");
        let r = ok_json(call(&c, "update_task", json!({ "page_id": pid, "task_id": migrate, "status": "in_review", "note": "迁移已执行并核对",
            "evidence": ["https://ci.example.com/run/42"] })).await);
        assert_eq!(r["task"]["status"], "in_review");
        let (e, t) = call(&c, "review_task", json!({ "task_id": migrate, "decision": "approve" })).await;
        assert!(e && t.starts_with("self_review:"), "{t}");
        let c2 = client(&base, &token2).await;
        let (_, t) = call(&c2, "list_tasks", json!({ "page_id": pid, "filter": "review" })).await;
        assert_eq!(tasks_of(&t)["tasks"].as_array().unwrap().len(), 1, "{t}");
        let r = ok_json(call(&c2, "review_task", json!({ "task_id": migrate, "decision": "approve", "note": "核对无误" })).await);
        assert_eq!(r["task"]["status"], "done");
        let (_, t) = call(&c, "list_tasks", json!({ "page_id": pid })).await;
        assert_eq!(tasks_of(&t)["progress"], json!({ "total": 2, "done": 1, "in_review": 0 }));
        c2.cancel().await.unwrap();
    } else {
        eprintln!("跳过任务树冒烟：未设置 LIVE_TEAM_KANBAN_TOKEN2 / LIVE_REVIEWER_EMAIL");
    }

    // 12. 接口文档与任务树并存：发布 api_doc 仍正常（只读、带「接口 N 个」）
    let api = json!({ "title": "支付接口", "servers": [{ "name": "生产", "url": "https://pay.example.com" }],
        "groups": [{ "name": "订单", "endpoints": [{ "method": "post", "path": "/orders", "title": "下单" }, { "method": "get", "path": "/orders/query", "title": "查单" }] }] });
    let d = ok_json(call(&c, "publish_page", json!({ "page_type": "api_doc", "model": "Claude Opus 5.5", "project": slug, "title": "支付接口", "visibility": "public", "api": api })).await);
    assert_eq!((d["page_type"].clone(), d["category"].clone()), (json!("api_doc"), json!("read")));
    let view: Value = http.get(format!("{base}/api/pages/{}/view", d["id"].as_str().unwrap())).send().await.unwrap().json().await.unwrap();
    assert_eq!(view["page"]["highlights"][0], json!({ "label": "接口", "value": "2 个" }), "{view}");

    c.cancel().await.unwrap();
}
