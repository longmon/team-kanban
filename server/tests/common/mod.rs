//! 集成测试脚手架：每个测试独立建库、跑迁移，结束（含 panic）时 DROP DATABASE
#![allow(dead_code)]

use std::sync::atomic::{AtomicU32, Ordering};

use axum::{
    Router,
    body::Body,
    http::{HeaderMap, Request},
};
use relay::{AppState, Config, MIGRATOR};
use serde_json::{Value, json};
use sqlx::{Executor, PgPool, postgres::PgPoolOptions};
use tower::ServiceExt;
use uuid::Uuid;

pub const PUBLIC: &str = "http://relay.test";

fn admin_url() -> String {
    std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| "postgres://postgres:dev@127.0.0.1:55432/postgres".into())
}

pub struct H {
    pub app: Router,
    pub db: PgPool,
    name: String,
}

impl H {
    pub async fn new() -> Self {
        Self::with(|_| {}).await
    }

    pub async fn with(f: impl FnOnce(&mut Config)) -> Self {
        let name = format!("relay_test_{}", Uuid::now_v7().simple());
        let admin = PgPoolOptions::new().max_connections(1).connect(&admin_url()).await.expect("连接测试 PG 失败（先启动 agent-relay-pg）");
        admin.execute(format!("CREATE DATABASE {name}").as_str()).await.unwrap();
        admin.close().await;
        let base = admin_url();
        let url = format!("{}/{name}", base.rsplit_once('/').unwrap().0);
        let db = PgPoolOptions::new().max_connections(10).connect(&url).await.unwrap();
        MIGRATOR.run(&db).await.unwrap();
        let mut cfg = Config {
            database_url: url,
            public_url: PUBLIC.into(),
            pages_origin: None,
            secret_key: b"test-secret-key-0123456789abcdef-xyz".to_vec(),
            bind: String::new(),
            trust_proxy: true,
            cookie_secure: false,
            allow_signup: true,
            smtp_url: None,
            smtp_from: None,
        };
        f(&mut cfg);
        let st = AppState::new(db.clone(), cfg).unwrap();
        H { app: relay::app(st), db, name }
    }

    pub async fn req(&self, c: &C, method: &str, path: &str, body: Option<Value>) -> R {
        self.raw(c, method, path, body.map(|b| b.to_string()), &[]).await
    }

    pub fn build(&self, c: &C, method: &str, path: &str, body: Option<String>, extra: &[(&str, &str)]) -> Request<Body> {
        let mut b = Request::builder().method(method).uri(path).header("x-forwarded-for", &c.ip);
        if let Some(ck) = &c.cookie {
            b = b.header("cookie", format!("relay_session={ck}"));
        }
        if let Some(t) = &c.csrf {
            b = b.header("x-csrf-token", t);
        }
        if let Some(t) = &c.bearer {
            b = b.header("authorization", format!("Bearer {t}"));
        }
        if body.is_some() && !extra.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")) {
            b = b.header("content-type", "application/json");
        }
        for (k, v) in extra {
            b = b.header(*k, *v);
        }
        b.body(body.map(Body::from).unwrap_or_else(Body::empty)).unwrap()
    }

    pub async fn raw(&self, c: &C, method: &str, path: &str, body: Option<String>, extra: &[(&str, &str)]) -> R {
        let res = self.app.clone().oneshot(self.build(c, method, path, body, extra)).await.unwrap();
        let status = res.status().as_u16();
        let headers = res.headers().clone();
        let body = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap().to_vec();
        R { status, headers, body }
    }
}

impl Drop for H {
    fn drop(&mut self) {
        let name = self.name.clone();
        let _ = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            rt.block_on(async {
                if let Ok(admin) = PgPoolOptions::new().max_connections(1).connect(&admin_url()).await {
                    let _ = admin.execute(format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)").as_str()).await;
                }
            });
        })
        .join();
    }
}

static IP: AtomicU32 = AtomicU32::new(1);

pub fn fresh_ip() -> String {
    let n = IP.fetch_add(1, Ordering::SeqCst);
    format!("10.{}.{}.{}", (n >> 16) & 255, (n >> 8) & 255, n & 255)
}

/// 测试客户端身份
#[derive(Clone, Default, Debug)]
pub struct C {
    pub cookie: Option<String>,
    pub csrf: Option<String>,
    pub bearer: Option<String>,
    pub ip: String,
    pub user_id: String,
}

impl C {
    pub fn anon() -> C {
        C { ip: fresh_ip(), ..Default::default() }
    }
    pub fn with_pat(&self, token: &str) -> C {
        C { bearer: Some(token.into()), ip: self.ip.clone(), user_id: self.user_id.clone(), ..Default::default() }
    }
}

#[derive(Debug)]
pub struct R {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl R {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    pub fn code(&self) -> String {
        self.json()["error"]["code"].as_str().unwrap_or("").to_string()
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    pub fn header(&self, k: &str) -> String {
        self.headers.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
    }
    #[track_caller]
    pub fn ok(&self, status: u16) -> Value {
        assert_eq!(self.status, status, "body: {}", self.text());
        self.json()
    }
}

pub fn s(v: &Value) -> String {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}")).to_string()
}

pub fn session_from(r: &R, ip: &str) -> C {
    let set = r.header("set-cookie");
    let token = set.split(';').next().unwrap().split_once('=').unwrap().1.to_string();
    let body = r.json();
    C { cookie: Some(token), csrf: Some(s(&body["csrf_token"])), bearer: None, ip: ip.into(), user_id: s(&body["user"]["id"]) }
}

pub async fn register(h: &H, email: &str) -> C {
    let ip = fresh_ip();
    let name = email.split('@').next().unwrap();
    let r = h
        .req(&C { ip: ip.clone(), ..Default::default() }, "POST", "/api/auth/register", Some(json!({ "email": email, "password": "password-123", "display_name": name })))
        .await;
    assert_eq!(r.status, 201, "{}", r.text());
    session_from(&r, &ip)
}

pub async fn create_org(h: &H, c: &C, slug: &str) -> String {
    s(&h.req(c, "POST", "/api/orgs", Some(json!({ "name": slug, "slug": slug }))).await.ok(201)["id"])
}

pub async fn create_project(h: &H, c: &C, org: &str, slug: &str) -> String {
    s(&h.req(c, "POST", &format!("/api/orgs/{org}/projects"), Some(json!({ "name": slug, "slug": slug }))).await.ok(201)["id"])
}

pub async fn create_group(h: &H, c: &C, org: &str, name: &str) -> String {
    s(&h.req(c, "POST", &format!("/api/orgs/{org}/groups"), Some(json!({ "name": name }))).await.ok(201)["id"])
}

/// 发邀请并由 user 接受
pub async fn invite(h: &H, inviter: &C, org: &str, body: Value, user: &C) -> Value {
    let r = h.req(inviter, "POST", &format!("/api/orgs/{org}/invites"), Some(body)).await.ok(201);
    let token = s(&r["url"]).rsplit('/').next().unwrap().to_string();
    h.req(user, "POST", &format!("/api/invites/by-token/{token}/accept"), Some(json!({}))).await.ok(200)
}

pub async fn join_org(h: &H, owner: &C, org: &str, user: &C, role: &str) {
    invite(h, owner, org, json!({ "target_type": "org", "role": role }), user).await;
}

pub async fn add_project_member(h: &H, admin: &C, project: &str, user: &C, role: &str) {
    h.req(admin, "POST", &format!("/api/projects/{project}/members"), Some(json!({ "user_id": user.user_id, "role": role }))).await.ok(201);
}

pub async fn create_pat(h: &H, c: &C, scopes: &[&str], org: Option<&str>, project: Option<&str>) -> (C, String) {
    let r = h
        .req(c, "POST", "/api/tokens", Some(json!({ "name": "t", "scopes": scopes, "org_id": org, "project_id": project })))
        .await
        .ok(201);
    (c.with_pat(&s(&r["token"])), s(&r["pat"]["id"]))
}

pub async fn publish(h: &H, c: &C, project: &str, visibility: &str, groups: &[&str]) -> String {
    publish_with(h, c, json!({ "project_id": project, "title": "页面", "kind": "openui", "content": "root = Stack([])", "visibility": visibility, "group_ids": groups })).await
}

pub async fn publish_with(h: &H, c: &C, body: Value) -> String {
    s(&h.req(c, "POST", "/api/pages", Some(body)).await.ok(201)["id"])
}

pub async fn submit_anon(h: &H, page: &str) -> R {
    h.req(&C::anon(), "POST", &format!("/api/pages/{page}/responses"), Some(json!({ "data": { "x": 1 }, "nickname": "路人" }))).await
}
