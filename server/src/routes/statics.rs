//! SPA、/openui/* 静态资源（rust-embed）与 PAGES_ORIGIN 下的 /h/* html 原文
use axum::{
    Router,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;
use rust_embed::RustEmbed;
use serde::Deserialize;
use uuid::Uuid;

use crate::{AppState, util::hmac_verify};

#[derive(RustEmbed)]
#[folder = "../web/dist"]
struct Dist;

pub fn static_router() -> Router<AppState> {
    Router::new().route("/h/{page_id}/{version}", get(html_page)).route("/openui/{*path}", get(openui)).fallback(spa)
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

fn embedded(path: &str, req: &HeaderMap, cache: &'static str) -> Option<Response> {
    let f = Dist::get(path)?;
    let etag = format!("\"{}\"", f.metadata.sha256_hash().iter().map(|b| format!("{b:02x}")).collect::<String>());
    let mime = match path.rsplit('.').next() {
        Some("md") => "text/markdown; charset=utf-8".to_string(),
        Some("json") => "application/json".to_string(),
        _ => f.metadata.mimetype().to_string(),
    };
    let headers = [
        (header::ETAG, HeaderValue::from_str(&etag).ok()?),
        (header::CACHE_CONTROL, HeaderValue::from_static(cache)),
        (header::CONTENT_TYPE, HeaderValue::from_str(&mime).ok()?),
    ];
    if req.get(header::IF_NONE_MATCH).is_some_and(|v| v.as_bytes() == etag.as_bytes()) {
        return Some((StatusCode::NOT_MODIFIED, headers).into_response());
    }
    Some((headers, f.data.into_owned()).into_response())
}

async fn openui(Path(path): Path<String>, h: HeaderMap) -> Response {
    if path.contains("..") {
        return not_found();
    }
    embedded(&format!("openui/{path}"), &h, "no-cache").unwrap_or_else(not_found)
}

/// 非 /api 路径：静态文件存在则返回，否则回落 index.html
async fn spa(uri: Uri, h: HeaderMap) -> Response {
    let path = uri.path().trim_start_matches('/');
    if !path.is_empty() && !path.contains("..") {
        let cache = if path.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
        if let Some(r) = embedded(path, &h, cache) {
            return r;
        }
    }
    embedded("index.html", &h, "no-cache").unwrap_or_else(|| (StatusCode::NOT_FOUND, "前端未构建（web/dist 为空）").into_response())
}

#[derive(Deserialize)]
struct HQuery {
    exp: Option<i64>,
    sig: Option<String>,
    /// c=1：签发给已关闭页面管理者的地址（签名里带 |c）
    c: Option<String>,
}

/// 只验 HMAC 签名与 exp，不看 cookie（design §6.5）。已关闭页面只认 c=1 的签名（只签发给能看已关闭页面的人）
async fn html_page(State(st): State<AppState>, Path((page_id, version)): Path<(String, String)>, Query(q): Query<HQuery>) -> Response {
    let (Ok(page_id), Ok(version), Some(exp), Some(sig)) = (Uuid::parse_str(&page_id), version.parse::<i32>(), q.exp, q.sig) else {
        return not_found();
    };
    let closed_ok = q.c.as_deref() == Some("1");
    let c = if closed_ok { "|c" } else { "" };
    if exp <= Utc::now().timestamp() || !hmac_verify(&st.cfg.secret_key, &format!("h|{page_id}|{version}|{exp}{c}"), &sig) {
        return not_found();
    }
    let content: Option<Option<String>> = match sqlx::query_scalar(
        "SELECT CASE WHEN p.closed_at IS NOT NULL AND NOT $3 THEN NULL WHEN p.version = $2 THEN p.content
                     ELSE (SELECT v.content FROM page_versions v WHERE v.page_id = p.id AND v.version = $2) END
           FROM pages p
           JOIN projects pr ON pr.org_id = p.org_id AND pr.id = p.project_id AND pr.deleted_at IS NULL
           JOIN orgs o ON o.id = p.org_id AND o.deleted_at IS NULL
          WHERE p.id = $1 AND p.kind = 'html' AND p.deleted_at IS NULL",
    )
    .bind(page_id)
    .bind(version)
    .bind(closed_ok)
    .fetch_optional(&st.db)
    .await
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("html page: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response();
        }
    };
    let Some(Some(html)) = content else { return not_found() };
    let public = &st.cfg.public_url;
    let csp = format!("sandbox allow-scripts allow-forms; frame-ancestors {public}");
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8")),
            (header::CONTENT_SECURITY_POLICY, HeaderValue::from_str(&csp).unwrap_or(HeaderValue::from_static("sandbox"))),
            (header::REFERRER_POLICY, HeaderValue::from_static("no-referrer")),
            (header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")),
            (header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=600")),
        ],
        inject_bridge(&html, public),
    )
        .into_response()
}

/// 桥接脚本（api.md §9）：window.kanban.submit、<form data-kanban> 接管（含按 my_response 回填锁定）、relay:resize。
/// window.relay / data-relay / data-relay-status 是历史名称，为兼容已发布的旧页面保留；relay:* 消息类型同理。
const BRIDGE: &str = r#"<script>(function(){
var P=__ORIGIN__,n=0,w={};
function post(m){m.v=1;parent.postMessage(m,P);}
window.kanban=window.relay={submit:function(data){return new Promise(function(res,rej){var id="r"+(++n);w[id]=[res,rej];post({type:"relay:submit",req_id:id,data:data||{}});});}};
window.addEventListener("message",function(e){
if(e.source!==parent)return;var d=e.data;if(!d||d.v!==1)return;
if(d.type==="relay:submit_result"&&w[d.req_id]){var c=w[d.req_id];delete w[d.req_id];if(d.ok)c[0]({seq:d.seq});else c[1](new Error(d.error&&d.error.code||"error"));}
else if(d.type==="relay:init"){window.kanban.init=d;var m=d.my_response;if(m&&m.data)forms().forEach(function(f){lock(f,m.data,m.page_version);});}
});
function forms(){return [].slice.call(document.querySelectorAll("form[data-kanban],form[data-relay]"));}
var css=0;
function lock(f,data,ver){
if(!css){css=1;var st=document.createElement("style");st.textContent=":where([data-kanban-selected]){outline:2px solid #2563eb;outline-offset:2px;border-radius:4px;font-weight:600}:where([data-kanban-dimmed]){opacity:.45;cursor:not-allowed}";(document.head||document.documentElement).appendChild(st);}
var idx={},msg="已提交（第 "+ver+" 版）";
[].forEach.call(f.elements,function(el){
var k=el.name,t=(el.type||"").toLowerCase(),c=t==="radio"||t==="checkbox";
if(k&&Object.prototype.hasOwnProperty.call(data,k)&&t!=="file"&&t!=="submit"&&t!=="button"){
var a=[].concat(data[k]).map(String);
if(c)el.checked=a.indexOf(el.value)>=0;
else if(el.tagName==="SELECT")[].forEach.call(el.options,function(o){o.selected=a.indexOf(o.value)>=0;});
else{idx[k]=idx[k]||0;el.value=a[idx[k]++]||"";}
}
if(c&&el.labels&&el.labels[0]){var l=el.labels[0];l.removeAttribute(el.checked?"data-kanban-dimmed":"data-kanban-selected");l.setAttribute(el.checked?"data-kanban-selected":"data-kanban-dimmed","");}
if(t==="submit"||(el.tagName==="BUTTON"&&!el.getAttribute("type"))){if(el.tagName==="BUTTON")el.textContent=msg;else el.value=msg;}
el.disabled=true;
});
f.setAttribute("data-kanban-status","submitted");
}
function ser(f){var o={};new FormData(f).forEach(function(v,k){if(typeof v!=="string")return;if(Object.prototype.hasOwnProperty.call(o,k)){if(!Array.isArray(o[k]))o[k]=[o[k]];o[k].push(v);}else o[k]=v;});return o;}
document.addEventListener("submit",function(e){
var f=e.target;if(!f||!f.hasAttribute||!(f.hasAttribute("data-kanban")||f.hasAttribute("data-relay")))return;e.preventDefault();
var b=f.querySelectorAll("button,input[type=submit]"),s=f.querySelector("[data-kanban-status],[data-relay-status]");
if(!s){s=document.createElement("div");s.setAttribute("data-kanban-status","");f.appendChild(s);}
b.forEach(function(x){x.disabled=true;});s.textContent="提交中…";
var d=ser(f);window.kanban.submit(d).then(function(){s.textContent="已提交";lock(f,d,(window.kanban.init||{}).version);},function(err){s.textContent="提交失败："+err.message;b.forEach(function(x){x.disabled=false;});});
},true);
function size(){post({type:"relay:resize",height:Math.ceil(document.documentElement.scrollHeight)});}
if(window.ResizeObserver)new ResizeObserver(size).observe(document.documentElement);
window.addEventListener("load",size);
post({type:"relay:ready"});
})();</script>"#;

fn inject_bridge(html: &str, public_url: &str) -> String {
    let origin = serde_json::to_string(public_url).unwrap_or_default().replace('<', "\\u003c");
    let script = BRIDGE.replace("__ORIGIN__", &origin);
    match html.to_ascii_lowercase().rfind("</body>") {
        Some(i) => format!("{}{script}{}", &html[..i], &html[i..]),
        None => format!("{html}{script}"),
    }
}
