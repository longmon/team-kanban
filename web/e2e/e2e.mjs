// 浏览器端到端：对真实后端（空库）跑。用法：
//   BASE=http://127.0.0.1:8080 node web/e2e/e2e.mjs [截图目录]
// 前提：后端以 PUBLIC_URL=$BASE、PAGES_ORIGIN=同端口另一主机名（127.0.0.1 ↔ localhost）启动，库是空的。
// 浏览器：CHROME 环境变量，缺省找 ~/.cache/ms-playwright 下的 headless shell。任一场景失败则退出码 1。
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";

const BASE = (process.env.BASE ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const OUT = process.argv[2] ?? "/tmp/tkanban-e2e";
mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROME ?? execSync("ls -d ~/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell | tail -1").toString().trim();

// ---------- 种子数据（Node fetch，手动带 cookie + CSRF） ----------
async function call(sess, method, path, body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (sess?.cookie) headers.Cookie = sess.cookie;
  if (sess?.csrf && method !== "GET") headers["X-CSRF-Token"] = sess.csrf;
  const r = await fetch(BASE + "/api" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
async function register(email, display_name, invite_token) {
  const r = await fetch(BASE + "/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password1234", display_name, invite_token }),
  });
  if (r.status !== 201) throw new Error(`register ${email} → ${r.status} ${await r.text()}`);
  const j = await r.json();
  return { cookie: r.headers.get("set-cookie").split(";")[0], csrf: j.csrf_token, user: j.user };
}

const demo = await register("demo@example.com", "Demo");
const org = await call(demo, "POST", "/orgs", { name: "演示组织", slug: "demo" });
const project = await call(demo, "POST", `/orgs/${org.id}/projects`, { name: "演示项目", slug: "demo", description: "e2e 数据" });
const IDS = {};
const addPage = async (title, kind, content, extra = {}) =>
  (IDS[title] = (await call(demo, "POST", "/pages", { project_id: project.id, title, kind, content, visibility: "public", results_visible_to: "viewers", ...extra })).id);
const exDir = new URL("../examples/", import.meta.url);
for (const f of readdirSync(exDir).filter((f) => f.endsWith(".openui")).sort()) await addPage(`示例：${f}`, "openui", readFileSync(new URL(f, exDir), "utf8"));
await addPage("示例：html 表单", "html", `<!doctype html><html><body style="font-family:sans-serif">
<h2>HTML 页面</h2><form data-kanban><label>喜欢的颜色 <select name="color"><option>红</option><option>蓝</option></select></label>
<label><input type="checkbox" name="tags" value="a" checked>a</label><label><input type="checkbox" name="tags" value="b" checked>b</label>
<button>提交</button></form><button id="js">kanban.submit</button>
<script>document.getElementById('js').onclick=()=>kanban.submit({via:'js'}).then(r=>alert('ok '+r.seq),e=>alert('err '+e.message))</script>
<div style="height:900px;background:linear-gradient(#eee,#ccc)">高内容测试 resize</div></body></html>`);
const share = async (title, body) => (await call(demo, "POST", `/pages/${IDS[title]}/share-links`, { expires_in: 86400, ...body })).url.replace(/^.*\/s\//, "/s/");
const OPEN = await share("示例：report.openui", { label: "公开", max_uses: 3 });
const PW = await share("示例：table.openui", { label: "有密码", password: "1234" });

// 权限：组织成员 member（只在群组里，不在项目里）、组织外 outsider
const inv = await call(demo, "POST", `/orgs/${org.id}/invites`, { target_type: "org", role: "member", max_uses: 1 });
const member = await register("member@example.com", "Member");
await call(member, "POST", `/invites/by-token/${inv.url.split("/").pop()}/accept`, {});
await register("outsider@example.com", "Outsider");
const group = await call(demo, "POST", `/orgs/${org.id}/groups`, { name: "评审组" });
await call(demo, "POST", `/groups/${group.id}/members`, { user_id: member.user.id });
const vote = readFileSync(new URL("vote.openui", exDir), "utf8");
await addPage("仅项目可见", "openui", vote, { visibility: "project" });
await addPage("评审组可见", "openui", vote, { visibility: "groups", group_ids: [group.id] });

// ---------- 浏览器 ----------
const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const page = await ctx.newPage();
const errors = [];
const watch = (p) => {
  p.on("console", (m) => m.type() === "error" && !/status of 40[134]/.test(m.text()) && errors.push(m.text()));
  p.on("pageerror", (e) => errors.push("pageerror " + e.message));
};
watch(page);
let failed = 0;
const step = async (name, fn) => {
  try { await fn(); console.log("ok  ", name); }
  catch (e) { failed++; console.log("FAIL", name, e.message.split("\n")[0]); await page.screenshot({ path: `${OUT}/fail-${name}.png` }).catch(() => {}); }
};
const toast = (t) => page.locator(".toast", { hasText: t }).first().waitFor({ timeout: 5000 });
const login = async (p, email) => {
  await p.goto(BASE + "/login");
  await p.fill("input[type=email]", email);
  await p.fill("input[type=password]", "password1234");
  await p.getByRole("button", { name: "登录" }).click();
  await p.waitForURL((u) => !u.pathname.startsWith("/login"));
};
// 网页结果表的数据列（去掉 # 时间 提交者 来源 版本）与 CSV 数据列（去掉 7 个固定列）
const tableCols = async () => (await page.locator("table thead th").allTextContents()).slice(5);
const csvCols = (id) => page.evaluate(async (id) => {
  const t = await (await fetch(`/api/pages/${id}/responses.csv`)).text();
  return t.replace(/^﻿/, "").split("\r\n")[0].split(",").slice(7);
}, id);

await step("share-anon-render", async () => {
  await page.goto(BASE + OPEN);
  await page.getByText("2026 Q3 运营报告").waitFor();
  await page.screenshot({ path: `${OUT}/share-report.png`, fullPage: true });
});
await step("share-anon-nickname-required", async () => {
  await page.getByRole("button", { name: "提交反馈" }).click();
  await toast("昵称");
});
await step("share-anon-submit", async () => {
  await page.fill("#relay-nick", "小明");
  await page.getByText("有帮助", { exact: true }).click();
  await page.locator("textarea").first().fill("不错");
  await page.getByRole("button", { name: "提交反馈" }).click();
  await toast("已提交（#1）");
});
await step("share-results-sse", async () => {
  await page.getByRole("button", { name: "查看结果" }).click();
  await page.locator("td", { hasText: "小明" }).waitFor();
  await page.locator(".tally-title", { hasText: "score" }).waitFor();
  await page.screenshot({ path: `${OUT}/share-results.png`, fullPage: true });
});
await step("share-password-unlock", async () => {
  await page.goto(BASE + PW);
  await page.getByText("需要密码").waitFor();
  await page.fill("input[type=password]", "bad");
  await page.getByRole("button", { name: "解锁" }).click();
  await page.getByText("密码错误").waitFor();
  await page.fill("input[type=password]", "1234");
  await page.getByRole("button", { name: "解锁" }).click();
  await page.getByText("待确认的发布清单").waitFor();
});
await step("html-anon-nickname", async () => {
  await page.goto(BASE + "/");
  await page.evaluate(() => localStorage.removeItem("relay_nickname"));
  await page.goto(BASE + "/pages/" + IDS["示例：html 表单"]);
  const el = page.locator("iframe.html-frame");
  if ((await el.getAttribute("sandbox")) !== "allow-scripts allow-forms") throw new Error("iframe sandbox attr");
  const src = new URL(await el.getAttribute("src"));
  if (src.origin === new URL(BASE).origin) throw new Error("frame served from main origin: " + src.origin);
  await page.frameLocator("iframe.html-frame").getByRole("button", { name: "提交" }).waitFor();
  const fr = page.frames().find((f) => f.url().startsWith(src.origin));
  if ((await fr.evaluate(() => self.origin)) !== "null") throw new Error("iframe origin not opaque");
  const frame = page.frameLocator("iframe.html-frame");
  await frame.getByRole("button", { name: "提交" }).click();
  await page.waitForFunction(() => document.activeElement?.id === "relay-nick", null, { timeout: 5000 });
  await page.fill("#relay-nick", "阿花");
  await frame.getByRole("button", { name: "提交" }).click();
  await toast("已提交（#1）");
});
await step("table-example-submit", async () => {
  await page.goto(BASE + "/pages/" + IDS["示例：table.openui"]);
  await page.getByText("待确认的发布清单").waitFor();
  await page.getByText("支付回调重试").last().click();
  await page.getByRole("button", { name: "确认" }).click();
  await toast("已提交");
  await page.screenshot({ path: `${OUT}/table.png`, fullPage: true });
});
await step("login", async () => {
  await page.goto(BASE + "/pages/does-not-exist/results");
  await page.waitForURL(/\/login\?next=/);
  await page.fill("input[type=email]", "demo@example.com");
  await page.fill("input[type=password]", "password1234");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL(/does-not-exist\/results/);
});
await step("org-project-pages", async () => {
  await page.goto(BASE + "/o/demo");
  await page.getByText("演示项目").click();
  await page.getByText("示例：vote.openui").waitFor();
  await page.screenshot({ path: `${OUT}/project.png`, fullPage: true });
});
let voteUrl;
await step("vote-submit-logged-in", async () => {
  await page.getByText("示例：vote.openui").click();
  await page.getByText("技术选型投票").waitFor();
  voteUrl = page.url();
  if (await page.locator("#relay-nick").count()) throw new Error("logged-in user should not see nickname");
  await page.getByText("B. NATS").click();
  await page.locator("textarea").first().fill("部署简单");
  await page.getByRole("button", { name: "提交" }).click();
  await toast("已提交（#1）");
  await page.getByText("B. NATS").click();
  await page.getByRole("button", { name: "提交" }).click();
  await toast("已提交（#2）");
});
await step("results-page", async () => {
  await page.goto(voteUrl + "/results");
  await page.locator(".tally-title", { hasText: "choice" }).waitFor();
  const n = await page.locator(".tally-row", { hasText: "B" }).locator(".tally-n").first().textContent();
  if (n !== "2") throw new Error("tally B = " + n);
  await page.screenshot({ path: `${OUT}/results.png`, fullPage: true });
});
await step("results-live-update", async () => {
  const id = voteUrl.split("/").pop();
  // 另开一个匿名上下文按契约提交（public 页面），结果页应经 SSE 实时追加
  const r = await fetch(`${BASE}/api/pages/${id}/responses`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nickname: "路人", data: { action: "提交", form: "vote", values: { choice: "C", seq: "撞名" }, params: {} } }) });
  if (r.status !== 201) throw new Error("submit " + r.status);
  await page.locator("td", { hasText: /^C$/ }).waitFor({ timeout: 5000 });
});
await step("csv-matches-table", async () => {
  const id = voteUrl.split("/").pop();
  const [t, c] = [await tableCols(), await csvCols(id)];
  if (JSON.stringify(t) !== JSON.stringify(c) || !c.includes("values.seq")) throw new Error(`table ${t} ≠ csv ${c}`);
});
await step("html-frame-submit", async () => {
  await page.goto(BASE + "/o/demo/p/demo");
  await page.getByText("示例：html 表单").click();
  const frame = page.frameLocator("iframe.html-frame");
  await frame.getByRole("button", { name: "提交" }).waitFor();
  page.once("dialog", (d) => d.accept());
  await frame.getByRole("button", { name: "提交" }).click();
  await toast("已提交（#2）");
  const h = await page.locator("iframe.html-frame").evaluate((e) => e.style.height);
  if (parseInt(h) < 900) throw new Error("resize not applied: " + h);
  await page.goto(BASE + `/pages/${IDS["示例：html 表单"]}/results`);
  await page.locator("td", { hasText: "a; b" }).first().waitFor();
  const [t, c] = [await tableCols(), await csvCols(IDS["示例：html 表单"])];
  if (JSON.stringify(t) !== JSON.stringify(c)) throw new Error(`table ${t} ≠ csv ${c}`);
});
await step("links-create", async () => {
  await page.goto(voteUrl + "/links");
  await page.getByRole("button", { name: "创建链接" }).click();
  await page.getByText("链接只显示这一次").waitFor();
});
await step("tokens-create", async () => {
  await page.goto(BASE + "/settings/tokens");
  await page.fill("input[placeholder*=笔记本]", "test");
  await page.getByRole("button", { name: "创建令牌" }).click();
  await page.getByText("令牌只显示这一次").waitFor();
  await page.getByRole("button", { name: "吊销" }).first().waitFor();
});
await step("page-meta-edit", async () => {
  await page.goto(BASE + "/o/demo/p/demo");
  await page.getByRole("button", { name: "编辑" }).first().click();
  await page.getByRole("button", { name: "保存" }).click();
  await toast("已保存");
});
await step("perm-outsider-404", async () => {
  const c2 = await browser.newContext();
  const p = await c2.newPage();
  watch(p);
  try {
    await login(p, "outsider@example.com");
    for (const t of ["仅项目可见", "评审组可见"]) {
      await p.goto(BASE + "/pages/" + IDS[t]);
      await p.getByText("页面不存在，或你没有查看权限。").waitFor();
    }
    await p.goto(BASE + "/pages/" + IDS["示例：vote.openui"]); // public 仍可见
    await p.getByText("技术选型投票").waitFor();
  } finally { await c2.close(); }
});
await step("perm-group-member", async () => {
  const c2 = await browser.newContext();
  const p = await c2.newPage();
  watch(p);
  try {
    await login(p, "member@example.com");
    await p.goto(BASE + "/pages/" + IDS["评审组可见"]);
    await p.getByText("技术选型投票").waitFor();
    await p.goto(BASE + "/pages/" + IDS["仅项目可见"]);
    await p.getByText("页面不存在，或你没有查看权限。").waitFor();
  } finally { await c2.close(); }
});
await step("perm-anon-login-hint", async () => {
  const c2 = await browser.newContext();
  const p = await c2.newPage();
  try {
    await p.goto(BASE + "/pages/" + IDS["仅项目可见"]);
    await p.getByText("页面不存在，或需要登录后才能查看。").waitFor();
  } finally { await c2.close(); }
});
await step("mobile-dark", async () => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.evaluate(() => localStorage.setItem("openui-theme-mode", '"dark"'));
  await page.goto(voteUrl);
  await page.getByText("技术选型投票").waitFor();
  await page.screenshot({ path: `${OUT}/mobile-dark-vote.png`, fullPage: true });
  await page.goto(voteUrl + "/results");
  await page.locator(".tally").first().waitFor();
  await page.screenshot({ path: `${OUT}/mobile-dark-results.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) throw new Error("horizontal page overflow at 375px");
});
console.log("console errors:", errors.length ? errors : "none");
await browser.close();
if (failed || errors.length) { console.log(`${failed} 个场景失败`); process.exit(1); }
