// 开发自测用的极简内存 mock（不进生产构建）。只覆盖前端用到的主干行为，不做真实权限判定。
// 用法：node mock/server.mjs  →  TEAM_KANBAN_DEV_TARGET=http://127.0.0.1:18787 npm run dev
// 种子账号 demo@example.com / password1234；临时链接 /s/open-token、/s/pw-token（密码 1234）
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 18787);
const now = () => new Date().toISOString();
const id = () => randomUUID();

const users = [{ id: id(), email: "demo@example.com", password: "password1234", display_name: "Demo", email_verified: true, created_at: now() }];
const sessions = new Map(); // token → user_id
const org = { id: id(), name: "演示组织", slug: "demo", created_at: now() };
const project = { id: id(), org_id: org.id, name: "演示项目", slug: "demo", description: "mock 数据", created_at: now(), updated_at: now() };
const groups = [{ id: id(), org_id: org.id, name: "评审组", description: "", member_count: 1, created_at: now() }];
const pages = [];
const responses = new Map(); // page_id → Response[]
const shareLinks = [];
const tokens = [];
const invites = [];
const subscribers = new Map(); // page_id → Set<res>

const brief = (u) => ({ id: u.id, display_name: u.display_name });
const full = (u) => ({ id: u.id, email: u.email, display_name: u.display_name, email_verified: u.email_verified, created_at: u.created_at });
const orgOut = () => ({ ...org, my_role: "owner" });
const projOut = () => ({ ...project, my_role: "admin" });
const pageOut = (p) => ({ ...p, content: undefined, response_count: (responses.get(p.id) ?? []).length, url: `http://localhost:5173/pages/${p.id}`, created_by: brief(users[0]), can_manage: true });

function addPage(title, kind, content, visibility = "public") {
  const p = { id: id(), org_id: org.id, project_id: project.id, title, kind, version: 1, visibility, group_ids: [], accept_responses: true, results_visible_to: "viewers", created_at: now(), updated_at: now(), content };
  pages.push(p);
  responses.set(p.id, []);
  return p;
}
const exDir = new URL("../examples/", import.meta.url);
for (const f of readdirSync(exDir).filter((f) => f.endsWith(".openui"))) addPage(`示例：${f}`, "openui", readFileSync(new URL(f, exDir), "utf8"));
addPage("示例：html 表单", "html", `<!doctype html><html><body style="font-family:sans-serif">
<h2>HTML 页面</h2><form data-kanban><label>喜欢的颜色 <select name="color"><option>红</option><option>蓝</option></select></label>
<label><input type="checkbox" name="tags" value="a">a</label><label><input type="checkbox" name="tags" value="b">b</label>
<button>提交</button></form><button id="js">kanban.submit</button>
<script>document.getElementById('js').onclick=()=>kanban.submit({via:'js'}).then(r=>alert('ok '+r.seq),e=>alert('err '+e.message))</script>
<div style="height:900px;background:linear-gradient(#eee,#ccc)">高内容测试 resize</div></body></html>`);
const openPage = pages[0];
shareLinks.push(
  { id: id(), page_id: openPage.id, token: "open-token", label: "公开", token_prefix: "open-t", expires_at: new Date(Date.now() + 864e5).toISOString(), max_uses: 3, use_count: 0, password: null, created_at: now(), revoked_at: null },
  { id: id(), page_id: pages[1].id, token: "pw-token", label: "有密码", token_prefix: "pw-tok", expires_at: new Date(Date.now() + 864e5).toISOString(), max_uses: null, use_count: 0, password: "1234", created_at: now(), revoked_at: null },
);
const linkStatus = (l) => (l.revoked_at ? "revoked" : Date.parse(l.expires_at) <= Date.now() ? "expired" : l.max_uses !== null && l.use_count >= l.max_uses ? "exhausted" : "active");
const linkOut = (l) => ({ id: l.id, page_id: l.page_id, label: l.label, token_prefix: l.token_prefix, expires_at: l.expires_at, max_uses: l.max_uses, use_count: l.use_count, has_password: !!l.password, created_by: brief(users[0]), created_at: l.created_at, revoked_at: l.revoked_at, status: linkStatus(l) });

// ---------- http helpers ----------
const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};
const err = (res, status, code, message = code) => send(res, status, { error: { code, message, details: null } });
const readBody = (req) => new Promise((ok) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch { ok(null); } }); });
const cookieUser = (req) => {
  const m = /relay_session=([^;]+)/.exec(req.headers.cookie ?? "");
  const uid = m && sessions.get(m[1]);
  return users.find((u) => u.id === uid) ?? null;
};
const login = (res, u) => {
  const t = id();
  sessions.set(t, u.id);
  res.setHeader("Set-Cookie", `relay_session=${t}; Path=/; HttpOnly; SameSite=Lax`);
  return { user: full(u), csrf_token: "csrf-" + t };
};
const paged = (items) => ({ items, next_cursor: null });

function frameUrl(p) { return `/h/${p.id}/${p.version}?exp=${Math.floor(Date.now() / 1000) + 600}&sig=mock`; }
function view(p, user, link) {
  const blocked = !p.accept_responses ? "responses_closed" : link && link.max_uses !== null && link.use_count >= link.max_uses ? "share_link_exhausted" : null;
  return {
    page: { id: p.id, title: p.title, kind: p.kind, version: p.version, accept_responses: p.accept_responses, results_visible_to: p.results_visible_to, updated_at: p.updated_at, project: { id: project.id, name: project.name }, org: { id: org.id, name: org.name } },
    content: p.kind === "openui" ? { kind: "openui", spec: p.content } : { kind: "html", frame_url: frameUrl(p), frame_origin: "null" },
    viewer: user ? { type: "user", user_id: user.id, display_name: user.display_name } : { type: "anonymous" },
    can_submit: !blocked, submit_block_reason: blocked,
    can_view_results: !!user || p.results_visible_to === "viewers", can_manage: !!user,
    share_link: link ? { id: link.id, label: link.label, expires_at: link.expires_at, remaining_uses: link.max_uses === null ? null : link.max_uses - link.use_count } : null,
  };
}
function shareLookup(req, res, token) {
  const l = shareLinks.find((x) => x.token === token);
  if (!l) return err(res, 404, "not_found"), null;
  if (l.revoked_at) return err(res, 410, "share_link_revoked", "临时链接已吊销"), null;
  if (Date.parse(l.expires_at) <= Date.now()) return err(res, 410, "share_link_expired", "临时链接已过期"), null;
  const grant = req.headers["x-share-grant"] ?? new URL(req.url, "http://x").searchParams.get("grant");
  if (l.password && grant !== "grant-" + l.id) return err(res, 401, "share_password_required", "需要密码"), null;
  return l;
}
function addResponse(res, p, user, body, link) {
  if (!body || typeof body.data !== "object" || Array.isArray(body.data)) return err(res, 400, "validation_failed", "data 必须是对象");
  if (!p.accept_responses) return err(res, 409, "responses_closed", "页面不接受提交");
  if (link && link.max_uses !== null && link.use_count >= link.max_uses) return err(res, 409, "share_link_exhausted", "次数用完");
  if (!user && !String(body.nickname ?? "").trim()) return err(res, 400, "nickname_required", "请填写昵称");
  const list = responses.get(p.id);
  const r = {
    id: id(), seq: list.length + 1, page_version: p.version, created_at: now(),
    respondent: user ? { type: "user", user_id: user.id, display_name: user.display_name } : { type: "anonymous", nickname: String(body.nickname).trim() },
    share_link: link ? { id: link.id, label: link.label } : null, data: body.data,
  };
  list.push(r);
  if (link) link.use_count++;
  for (const s of subscribers.get(p.id) ?? []) s.write(`id: ${r.seq}\nevent: response\ndata: ${JSON.stringify(r)}\n\n`);
  send(res, 201, { id: r.id, seq: r.seq, created_at: r.created_at });
}
function stream(req, res, p) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  const since = Number(req.headers["last-event-id"] ?? new URL(req.url, "http://x").searchParams.get("since") ?? 0);
  res.write("retry: 3000\n\n");
  for (const r of responses.get(p.id).filter((r) => r.seq > since)) res.write(`id: ${r.seq}\nevent: response\ndata: ${JSON.stringify(r)}\n\n`);
  if (!subscribers.has(p.id)) subscribers.set(p.id, new Set());
  subscribers.get(p.id).add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => (clearInterval(ping), subscribers.get(p.id).delete(res)));
}
const BRIDGE = `<script>(()=>{const P=parent,n=()=>Math.random().toString(36).slice(2);const w=new Map();let init=null;
addEventListener("message",e=>{if(e.source!==P)return;const d=e.data;if(!d||d.v!==1)return;if(d.type==="relay:init")init=d;
if(d.type==="relay:submit_result"){const f=w.get(d.req_id);if(f){w.delete(d.req_id);d.ok?f[0]({seq:d.seq}):f[1](new Error(d.error.code))}}});
window.kanban=window.relay={submit:data=>new Promise((ok,no)=>{const id=n();w.set(id,[ok,no]);P.postMessage({v:1,type:"relay:submit",req_id:id,data},"*")})};
document.addEventListener("submit",e=>{const f=e.target;if(!(f.hasAttribute("data-kanban")||f.hasAttribute("data-relay")))return;e.preventDefault();const d={};
for(const [k,v] of new FormData(f)){if(v instanceof File)continue;k in d?(d[k]=[].concat(d[k],v)):(d[k]=v)}
kanban.submit(d).then(r=>alert("已提交 #"+r.seq),er=>alert("提交失败："+er.message))});
new ResizeObserver(()=>P.postMessage({v:1,type:"relay:resize",height:document.documentElement.scrollHeight},"*")).observe(document.documentElement);
P.postMessage({v:1,type:"relay:ready"},"*")})()</script>`;

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  const m = (re) => re.exec(path);
  const me = cookieUser(req);
  const method = req.method;
  let g;

  if ((g = m(/^\/h\/([^/]+)\/(\d+)$/))) {
    const p = pages.find((x) => x.id === g[1]);
    if (!p) return res.writeHead(404).end("not found");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "sandbox allow-scripts allow-forms" });
    return res.end(p.content.replace("</body>", BRIDGE + "</body>"));
  }
  if (!path.startsWith("/api/")) return res.writeHead(404).end();
  const body = ["POST", "PATCH", "PUT", "DELETE"].includes(method) ? await readBody(req) : null;
  const api = path.slice(4);
  const R = (meth, re) => method === meth && (g = re.exec(api));

  // auth
  if (R("POST", /^\/auth\/login$/)) {
    const u = users.find((x) => x.email === String(body.email).trim().toLowerCase() && x.password === body.password);
    return u ? send(res, 200, login(res, u)) : err(res, 401, "invalid_credentials", "邮箱或密码错误");
  }
  if (R("POST", /^\/auth\/register$/)) {
    if (users.some((x) => x.email === body.email)) return err(res, 409, "email_taken", "邮箱已注册");
    const u = { id: id(), email: String(body.email).toLowerCase(), password: body.password, display_name: body.display_name, email_verified: false, created_at: now() };
    users.push(u);
    return send(res, 201, login(res, u));
  }
  if (R("GET", /^\/auth\/me$/)) return me ? send(res, 200, { user: full(me), csrf_token: "csrf", orgs: [orgOut()] }) : err(res, 401, "unauthenticated", "需要登录");
  if (R("POST", /^\/auth\/logout$/)) return send(res, 204);
  if (R("POST", /^\/auth\/(verify-email|resend-verification|password\/forgot|password\/reset|password\/change)$/)) return send(res, 204);
  if (R("PATCH", /^\/auth\/me$/)) return (me.display_name = body.display_name), send(res, 200, { user: full(me) });

  // share（匿名可用）
  if (R("POST", /^\/s\/([^/]+)\/unlock$/)) {
    const l = shareLinks.find((x) => x.token === g[1]);
    if (!l) return err(res, 404, "not_found");
    return body.password === l.password ? send(res, 200, { grant: "grant-" + l.id, expires_at: now() }) : err(res, 401, "share_password_invalid", "密码错误");
  }
  if (R("GET", /^\/s\/([^/]+)$/)) { const l = shareLookup(req, res, g[1]); if (l) send(res, 200, view(pages.find((p) => p.id === l.page_id), me, l)); return; }
  if (R("POST", /^\/s\/([^/]+)\/responses$/)) { const l = shareLookup(req, res, g[1]); if (l) addResponse(res, pages.find((p) => p.id === l.page_id), me, body, l); return; }
  if (R("GET", /^\/s\/([^/]+)\/responses\/stream$/)) { const l = shareLookup(req, res, g[1]); if (l) stream(req, res, pages.find((p) => p.id === l.page_id)); return; }

  const page = (pid) => pages.find((p) => p.id === pid);
  if (R("GET", /^\/pages\/([^/]+)\/view$/)) { const p = page(g[1]); return p && (me || p.visibility === "public") ? send(res, 200, view(p, me, null)) : err(res, 404, "not_found", "不存在"); }
  if (R("POST", /^\/pages\/([^/]+)\/responses$/)) { const p = page(g[1]); return p ? addResponse(res, p, me, body, null) : err(res, 404, "not_found"); }
  if (!me) return err(res, 401, "unauthenticated", "需要登录");
  if (R("GET", /^\/pages\/([^/]+)\/responses\/stream$/)) { const p = page(g[1]); return p ? stream(req, res, p) : err(res, 404, "not_found"); }
  if (R("GET", /^\/pages\/([^/]+)\/responses\.csv$/)) {
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="responses-${g[1]}.csv"` });
    return res.end("﻿seq,created_at\n" + responses.get(g[1]).map((r) => `${r.seq},${r.created_at}`).join("\n"));
  }

  // 组织/项目/群组/成员
  const member = { user: { ...brief(me), email: me.email }, joined_at: org.created_at };
  if (R("GET", /^\/orgs$/)) return send(res, 200, paged([orgOut()]));
  if (R("POST", /^\/orgs$/)) return err(res, 409, "slug_taken", "mock 只支持一个组织");
  if (R("GET", /^\/orgs\/[^/]+\/projects$/)) return send(res, 200, paged([projOut()]));
  if (R("POST", /^\/orgs\/[^/]+\/projects$/)) return err(res, 409, "slug_taken", "mock 只支持一个项目");
  if (R("GET", /^\/orgs\/[^/]+\/members$/)) return send(res, 200, paged([{ ...member, role: "owner" }]));
  if (R("GET", /^\/orgs\/[^/]+\/groups$/)) return send(res, 200, paged(groups));
  if (R("POST", /^\/orgs\/[^/]+\/groups$/)) { const gr = { id: id(), org_id: org.id, name: body.name, description: body.description ?? "", member_count: 0, created_at: now() }; groups.push(gr); return send(res, 201, gr); }
  if (R("GET", /^\/groups\/[^/]+\/members$/)) return send(res, 200, paged([member]));
  if (R("GET", /^\/projects\/[^/]+\/members$/)) return send(res, 200, paged([{ ...member, role: "admin" }]));
  if (R("GET", /^\/projects\/[^/]+\/groups$/)) return send(res, 200, { items: [] });
  if (R("GET", /^\/(orgs|projects)\/[^/]+\/invites$/)) return send(res, 200, paged(invites));
  if (R("POST", /^\/orgs\/[^/]+\/invites$/)) {
    const inv = { id: id(), org_id: org.id, target_type: body.target_type, target: { id: org.id, name: org.name }, role: body.role, email: body.email ?? null, max_uses: body.max_uses ?? 1, use_count: 0, created_by: brief(me), created_at: now(), expires_at: new Date(Date.now() + body.expires_in * 1000).toISOString(), revoked_at: null };
    invites.push(inv);
    return send(res, 201, { invite: inv, url: `http://localhost:5173/invite/mock-${inv.id}` });
  }
  if (R("GET", /^\/orgs\/[^/]+\/audit$/)) return send(res, 200, paged([{ id: 1, action: "page.publish", target_type: "page", target_id: openPage.id, actor: { user: brief(me), pat: null }, meta: {}, created_at: now() }]));

  // 页面
  if (R("GET", /^\/pages$/)) return send(res, 200, paged(pages.map(pageOut).reverse()));
  if (R("GET", /^\/pages\/([^/]+)$/)) { const p = page(g[1]); return p ? send(res, 200, { ...pageOut(p), content: p.content }) : err(res, 404, "not_found"); }
  if (R("PATCH", /^\/pages\/([^/]+)$/)) {
    const p = page(g[1]);
    for (const k of ["title", "visibility", "group_ids", "accept_responses", "results_visible_to"]) if (k in body) p[k] = body[k];
    p.updated_at = now();
    for (const s of subscribers.get(p.id) ?? []) s.write(`event: page\ndata: ${JSON.stringify({ version: p.version, accept_responses: p.accept_responses })}\n\n`);
    return send(res, 200, pageOut(p));
  }
  if (R("DELETE", /^\/pages\/([^/]+)$/)) { pages.splice(pages.findIndex((p) => p.id === g[1]), 1); return send(res, 204); }
  if (R("GET", /^\/pages\/([^/]+)\/share-links$/)) return send(res, 200, { items: shareLinks.filter((l) => l.page_id === g[1] && (url.searchParams.get("include_inactive") === "true" || linkStatus(l) === "active")).map(linkOut) });
  if (R("POST", /^\/pages\/([^/]+)\/share-links$/)) {
    const t = id().replace(/-/g, "");
    const l = { id: id(), page_id: g[1], token: t, label: body.label ?? "", token_prefix: t.slice(0, 6), expires_at: new Date(Date.now() + body.expires_in * 1000).toISOString(), max_uses: body.max_uses ?? null, use_count: 0, password: body.password ?? null, created_at: now(), revoked_at: null };
    shareLinks.push(l);
    return send(res, 201, { share_link: linkOut(l), url: `http://localhost:5173/s/${t}` });
  }
  if (R("DELETE", /^\/share-links\/([^/]+)$/)) { const l = shareLinks.find((x) => x.id === g[1]); if (l) l.revoked_at = now(); return send(res, 204); }

  // PAT
  if (R("GET", /^\/tokens$/)) return send(res, 200, { items: tokens.filter((t) => url.searchParams.get("include_revoked") === "true" || !t.revoked_at) });
  if (R("POST", /^\/tokens$/)) {
    const t = { id: id(), name: body.name, token_prefix: "abc123", org: body.org_id ? { id: org.id, name: org.name } : null, project: body.project_id ? { id: project.id, name: project.name } : null, scopes: body.scopes, expires_at: body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null, last_used_at: null, created_at: now(), revoked_at: null };
    tokens.push(t);
    return send(res, 201, { pat: t, token: "arp_abc123" + id().replace(/-/g, "") });
  }
  if (R("DELETE", /^\/tokens\/([^/]+)$/)) { const t = tokens.find((x) => x.id === g[1]); if (t) t.revoked_at = now(); return send(res, 204); }

  if (["PATCH", "PUT", "DELETE", "POST"].includes(method)) return send(res, method === "DELETE" ? 204 : 200, {});
  err(res, 404, "not_found", "mock 未实现：" + method + " " + api);
}).listen(PORT, "127.0.0.1", () => console.log(`mock on http://127.0.0.1:${PORT}`));
