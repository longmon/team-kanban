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
// 带默认值的投票：RadioGroup defaultValue="B"、Slider defaultValue=[4]，都必填；不改直接提交应成功
await addPage("默认值投票", "openui", vote.replace('RadioGroup("choice", [optA, optB, optC], null,', 'RadioGroup("choice", [optA, optB, optC], "B",')
  .replace("[choiceField, commentField]", "[choiceField, scoreField, commentField]")
  .replace("commentField =", `scoreField = FormControl("信心", Slider("score", "discrete", 1, 5, 1, [4], null, { required: true }))\ncommentField =`));
// 任务树：Member 负责，Demo 评审（组织可见，Member 不在项目里也能看）
const TASKS = (await call(demo, "POST", "/pages", { project_id: project.id, title: "支付上线清单", kind: "openui", page_type: "task_tree", visibility: "org",
  summary: "支付通道上线的任务清单", reviewers: { users: ["demo@example.com"] },
  tasks: [{ key: "launch", title: "支付上线", assignee: "member@example.com", children: [{ key: "api", title: "接口联调", assignee: "member@example.com" }] }] })).id;
// 页面类型：只读报告（故意带表单，验证前端不渲染提交入口）、流程图（Mermaid）、知识库（目录）
await addPage("只读报告", "openui", vote, { page_type: "report", model: "Claude Opus 5.5" });
await addPage("流程图", "openui", String.raw`root = Stack([d])
d = Diagram("flowchart LR\n  A[提交需求] --> B{评审}\n  B -->|通过| C[开发]\n  B -->|驳回| A\n  subgraph 上线\n    C --> D[发布]\n  end", "需求流程")`, { page_type: "flowchart" });
await addPage("知识库", "openui", String.raw`root = Stack([md])
md = MarkDownRenderer("## 安装\n\n下载二进制。\n\n### Linux\n\n解压即可。\n\n## 配置\n\n运行 tkanban add。\n\n## 常见问题\n\n见下文。")`, { page_type: "knowledge" });
// 接口文档（kind=api，结构化 JSON；示例值含单引号与中文，验证代码转义）
await addPage("支付接口文档", "api", JSON.stringify({
  title: "支付网关 API", description: "**下单**与查单接口", version: "1.0",
  servers: [{ name: "测试", url: "https://sandbox.pay.example.com/v1" }, { name: "生产", url: "https://api.pay.example.com/v1" }],
  auth: { type: "header", name: "X-Api-Key", value: "{{API_KEY}}" },
  groups: [
    { name: "订单", endpoints: [
      { method: "POST", path: "/orders", title: "创建订单",
        body: { content_type: "application/json", fields: [{ name: "amount", type: "integer", required: true, example: 100 }, { name: "subject", type: "string", example: "会员 'VIP'" }] },
        responses: [{ status: "200", example: { order_id: "o_1" } }], errors: [{ code: "INVALID_AMOUNT", description: "金额不合法" }] },
      { method: "GET", path: "/orders/{order_id}", title: "查询订单", params: [{ name: "order_id", in: "path", example: "o 1" }] },
    ] },
    { name: "退款", endpoints: [{ method: "POST", path: "/refunds", title: "申请退款", body: { fields: [{ name: "order_id", type: "string", required: true }] } }] },
  ],
}), { page_type: "api_doc", model: "Claude Opus 5.5", summary: "支付下单、查单、退款接口" });
// 截止：API 不允许设过去的时间，建一个 3 秒后截止的投票页，用到时轮询 view 直到 submit_block_reason=closed（后端无该字段时跳过）
let CLOSING = null;
try {
  const p = await call(demo, "POST", "/pages", { project_id: project.id, title: "即将截止的投票", kind: "openui", content: vote, page_type: "vote",
    visibility: "project", results_visible_to: "viewers", closes_at: new Date(Date.now() + 3000).toISOString() });
  if (p.closes_at) CLOSING = IDS["即将截止的投票"] = p.id;
} catch (e) { console.log("skip closes_at seed:", e.message.split("\n")[0]); }

// 关闭页面：组织可见的投票 + 临时链接（关闭后成员与链接都看不到，重新打开恢复）
await addPage("关闭测试投票", "openui", vote, { page_type: "vote", visibility: "org" });
const CLOSE_SHARE = await share("关闭测试投票", { label: "关闭测试" });

// ---------- 浏览器 ----------
const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
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
// 网页结果表的数据列（表头显示 OpenUI 标签，原始列名在 data-col）与 CSV 数据列（去掉 7 个固定列）
const tableCols = () => page.locator("table thead th[data-col]").evaluateAll((ths) => ths.map((t) => t.dataset.col));
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
  const btn = page.getByRole("button", { name: "提交反馈" });
  // 记录按钮是否出现过 shake（抖动 300ms 后类名即移除）
  await btn.evaluate((e) => new MutationObserver(() => e.classList.contains("shake") && (window.__shook = true)).observe(e, { attributeFilter: ["class"] }));
  await btn.click();
  await toast("昵称");
  // 提交失败：按钮抖动 + 标红，按钮旁红字写明原因
  if ((await btn.getAttribute("aria-invalid")) !== "true") throw new Error("failed submit button not aria-invalid");
  if (!(await page.evaluate(() => window.__shook))) throw new Error("failed submit button did not shake");
  await page.getByRole("alert").filter({ hasText: "昵称" }).waitFor();
});
await step("share-anon-submit", async () => {
  await page.fill("#relay-nick", "小明");
  await page.getByText("有帮助", { exact: true }).click();
  await page.locator("textarea").first().fill("不错");
  // 提交成功：按钮变「已提交」并有一圈柔光（随后自动切到结果，按钮被隐藏，所以用 MutationObserver 记录），失败提示消失
  await page.evaluate(() => new MutationObserver(() => document.querySelector("button.submit-glow") && (window.__glow = document.querySelector("button.submit-glow").textContent))
    .observe(document.body, { subtree: true, attributeFilter: ["class"] }));
  await page.getByRole("button", { name: "提交反馈" }).click();
  await toast("已提交（#1）");
  await page.waitForFunction(() => window.__glow?.includes("已提交"), null, { timeout: 3000 });
  if (await page.getByRole("alert").filter({ hasText: "昵称" }).count()) throw new Error("error reason still shown after success");
});
await step("share-results-auto-after-submit", async () => {
  // 结果对访客可见：提交后自动切到结果（同页展开），选项显示 OpenUI 标签，我的选择有确认标记
  await page.getByRole("region", { name: "结果" }).waitFor();
  await page.locator("td", { hasText: "小明" }).waitFor();
  await page.locator(".tally-title[data-col=score]", { hasText: "这份报告对你有帮助吗？" }).waitFor();
  await page.locator(".tally-row[data-mine]", { hasText: "有帮助" }).waitFor();
  // 右栏「查看全部结果」变成展开态
  await page.getByRole("button", { name: "收起结果", expanded: true }).waitFor();
  await page.screenshot({ path: `${OUT}/share-results.png`, fullPage: true });
});
await step("share-anon-locked-after-reload", async () => {
  // 匿名访客：localStorage 记住这一版已提交，刷新后原题锁定
  await page.reload();
  await page.getByText("2026 Q3 运营报告").first().waitFor();
  await page.locator("button[data-locked]", { hasText: "已提交（第 1 版）" }).waitFor();
  if ((await page.getByRole("radio", { name: "有帮助" }).getAttribute("aria-checked")) !== "true") throw new Error("chip not prefilled");
  if (!(await page.getByRole("radio", { name: "一般" }).evaluate((e) => e.className.includes("opacity-45")))) throw new Error("other chip not dimmed");
  if (await page.locator("#relay-nick").count()) throw new Error("nickname bar shown when locked");
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
await step("html-anon-locked-after-reload", async () => {
  // HTML 页面：外壳把 localStorage 里的提交经 relay:init 交给桥接脚本，表单回填并锁定
  await page.reload();
  const frame = page.frameLocator("iframe.html-frame");
  await frame.locator("form[data-kanban-status=submitted]").waitFor();
  await frame.getByRole("button", { name: "已提交（第 1 版）" }).waitFor();
  if (!(await frame.locator("select[name=color]").isDisabled())) throw new Error("html select not disabled");
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
  await page.locator("main").getByText("演示项目").click();
  await page.locator(".tile-title", { hasText: "示例：vote.openui" }).waitFor();
  await page.screenshot({ path: `${OUT}/project.png`, fullPage: true });
});
let voteUrl;
const rail = () => page.getByRole("complementary", { name: "页面信息" });
/** 票卡：按选项完整标签（radio/checkbox 的 aria-label，如「B. NATS」）找到整张卡 */
const ticket = (p, label) => p.locator("[data-ticket]").filter({ has: p.getByRole("radio", { name: label, exact: true }) });
/** 原题锁定：label 票卡选中（data-on，带「你投的/你选的」标签），其余置灰（data-dim），提交按钮「已提交（第 N 版）」，表单 inert */
async function assertLocked(p, label, version) {
  await p.locator("button[data-locked]", { hasText: `已提交（第 ${version} 版）` }).waitFor();
  const opts = await p.locator("[role=form] [data-ticket]").evaluateAll((ls) => ls.map((l) => [l.querySelector("[aria-label]")?.getAttribute("aria-label"), l.hasAttribute("data-on"), l.hasAttribute("data-dim"), /你(投|选)的/.test(l.textContent)]));
  const on = opts.filter(([t]) => t === label);
  if (!on.length || !on.every(([, sel, dim, tag]) => sel && !dim && tag)) throw new Error("selected ticket not highlighted: " + JSON.stringify(opts));
  if (!opts.filter(([t]) => t !== label).every(([, sel, dim]) => !sel && dim)) throw new Error("other tickets not dimmed: " + JSON.stringify(opts));
  if ((await p.locator("fieldset[data-locked]").getAttribute("inert")) === null) throw new Error("locked form not inert");
}
await step("vote-submit-logged-in", async () => {
  await page.locator(".tile-title", { hasText: "示例：vote.openui" }).click();
  await page.getByText("技术选型投票").waitFor();
  voteUrl = page.url();
  if (await page.locator("#relay-nick").count()) throw new Error("logged-in user should not see nickname");
  await ticket(page, "B. NATS").click();
  await page.locator("textarea").first().fill("部署简单");
  await page.getByRole("button", { name: "提交" }).click();
  await toast("已提交（#1）");
  // 提交后自动显示结果（结果对查看者可见）
  await page.getByRole("region", { name: "结果" }).waitFor();
  await page.locator(".tally-row[data-mine]", { hasText: "B. NATS" }).waitFor();
  // 原题锁定（内容一直在上方）：选中票卡高亮、其余置灰，按钮「已提交（第 1 版）」；题头锁定提示卡写明选择
  await assertLocked(page, "B. NATS", 1);
  await page.locator(".locknote", { hasText: "B. NATS" }).waitFor();
  // 票卡锁定态显示比例：每张卡都有「N 票，P%」，我投的卡 1 票 100%、领先
  await ticket(page, "B. NATS").locator(".ticket-num", { hasText: "1票，100%，领先" }).waitFor();
  if ((await page.locator("[data-ticket] .ticket-num").count()) !== 3) throw new Error("ticket ratios missing");
  // 「你的回答」卡
  await page.getByRole("heading", { name: "你的回答" }).waitFor();
});
await step("vote-locked-after-reload-and-duplicate-rejected", async () => {
  await page.reload();
  await page.getByText("技术选型投票").waitFor();
  await assertLocked(page, "B. NATS", 1);
  if ((await page.locator("textarea").first().inputValue()) !== "部署简单") throw new Error("textarea not prefilled");
  // 同一版本重复提交：服务端 409 already_submitted
  const r = await fetch(`${BASE}/api/pages/${voteUrl.split("/").pop()}/responses`, { method: "POST",
    headers: { "Content-Type": "application/json", Cookie: demo.cookie, "X-CSRF-Token": demo.csrf },
    body: JSON.stringify({ data: { action: "提交", form: "vote", values: { choice: "A" }, params: {} } }) });
  const j = await r.json();
  if (r.status !== 409 || j.error?.code !== "already_submitted") throw new Error(`duplicate → ${r.status} ${JSON.stringify(j)}`);
});
await step("vote-default-value-submit", async () => {
  // 默认选中项不改直接提交：不报「必填」，提交值即默认项，原题回填锁定显示该默认项
  const id = IDS["默认值投票"];
  await page.goto(BASE + "/pages/" + id);
  await page.getByText("技术选型投票").waitFor();
  await ticket(page, "B. NATS").and(page.locator("[data-on]")).waitFor();
  await page.getByRole("button", { name: "提交" }).click();
  await toast("已提交（#1）");
  await assertLocked(page, "B. NATS", 1);
  const mine = await call(demo, "GET", `/pages/${id}/responses`);
  const v = mine.responses?.[0]?.data?.values;
  if (v?.choice !== "B" || JSON.stringify(v?.score) !== "[4]") throw new Error("submitted values " + JSON.stringify(v));
  await page.reload();
  await assertLocked(page, "B. NATS", 1);
});
await step("copy-link", async () => {
  await rail().getByRole("button", { name: "复制链接" }).click();
  await toast("已复制链接");
  const got = await page.evaluate(() => navigator.clipboard.readText());
  if (got !== page.url()) throw new Error("clipboard " + got);
});
await step("results-page", async () => {
  await page.goto(voteUrl + "/results");
  await page.locator(".tally-title[data-col=choice]", { hasText: "方案" }).waitFor();
  // 计数有 450ms 滚动动画，等到终值
  const n = page.locator(".tally-row", { hasText: "B. NATS" }).locator(".tally-n").first();
  await n.filter({ hasText: /^1$/ }).waitFor({ timeout: 3000 }).catch(async () => { throw new Error("tally B = " + (await n.textContent())); });
  await page.screenshot({ path: `${OUT}/results.png`, fullPage: true });
});
await step("results-live-update", async () => {
  const id = voteUrl.split("/").pop();
  // 另开一个匿名上下文按契约提交（public 页面），结果页应经 SSE 实时追加
  const r = await fetch(`${BASE}/api/pages/${id}/responses`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nickname: "路人", data: { action: "提交", form: "vote", values: { choice: "C", seq: "撞名" }, params: {} } }) });
  if (r.status !== 201) throw new Error("submit " + r.status);
  await page.locator("td", { hasText: /^C\. PostgreSQL/ }).waitFor({ timeout: 5000 });
});
await step("csv-matches-table", async () => {
  const id = voteUrl.split("/").pop();
  const [t, c] = [await tableCols(), await csvCols(id)];
  // 网页明细隐藏 OpenUI 内部表单名 form 列、action 显示为「操作」；其余列与 CSV 一致，CSV 本身不变
  if (!c.includes("form") || t.includes("form")) throw new Error(`form column: table ${t} csv ${c}`);
  if (JSON.stringify(t) !== JSON.stringify(c.filter((x) => x !== "form")) || !c.includes("values.seq")) throw new Error(`table ${t} ≠ csv ${c}`);
  if ((await page.locator("table thead th[data-col=action]").textContent()) !== "操作") throw new Error("action header not localized");
});
await step("versions-resubmit-and-history", async () => {
  const id = voteUrl.split("/").pop();
  // 更新内容 → 第 2 版：之前交过的人重新出现在「等我参与」，详情提示可以重新提交
  await call(demo, "PATCH", `/pages/${id}`, { content: vote.replace("每次点击「提交」记一票。", "第二版：补充了评估维度。") });
  await page.goto(BASE + "/");
  await page.locator("article[data-todo]", { hasText: "示例：vote.openui" }).waitFor();
  await page.goto(voteUrl);
  await page.getByText("第二版：补充了评估维度。").waitFor();
  await page.getByText("页面已更新到第 2 版，可以重新提交。").waitFor();
  if (await page.locator("button[data-locked]").count()) throw new Error("v2 should not be locked");
  await ticket(page, "A. Kafka").click();
  await page.getByRole("button", { name: "提交" }).click();
  await toast("已提交");
  await assertLocked(page, "A. Kafka", 2);
  await page.screenshot({ path: `${OUT}/locked-v2.png`, fullPage: true });
  // ?version=1：旧内容、只读，显示我当时的选择
  await page.goto(voteUrl + "?version=1");
  await page.getByText("你在看第 1 版，当前是第 2 版。历史版本只读。").waitFor();
  await page.getByText("每次点击「提交」记一票。").waitFor();
  if (await page.getByText("第二版：补充了评估维度。").count()) throw new Error("v1 shows v2 content");
  await assertLocked(page, "B. NATS", 1);
  await page.screenshot({ path: `${OUT}/history-v1.png`, fullPage: true });
  await page.getByRole("combobox", { name: "版本" }).waitFor();
  await page.getByRole("button", { name: "回到最新版" }).click();
  await page.waitForURL(voteUrl);
  await page.getByText("第二版：补充了评估维度。").waitFor();
});
await step("detail-rail-version-switch", async () => {
  // 右栏版本列表：点第 1 版 → ?version=1 只读历史；点当前版本回来
  const versions = rail().getByRole("heading", { name: "版本" }).locator("xpath=..");
  await versions.getByRole("button", { name: /第 1 版/ }).click();
  await page.waitForURL(/\?version=1$/);
  await page.getByText("你在看第 1 版，当前是第 2 版。历史版本只读。").waitFor();
  await versions.locator("button[aria-current]", { hasText: "第 1 版" }).waitFor();
  await versions.getByRole("button", { name: /当前版本/ }).click();
  await page.waitForURL(voteUrl);
  await page.getByText("第二版：补充了评估维度。").waitFor();
});
await step("html-frame-submit", async () => {
  await page.goto(BASE + "/o/demo/p/demo");
  await page.locator(".tile-title", { hasText: "示例：html 表单" }).click();
  const frame = page.frameLocator("iframe.html-frame");
  await frame.getByRole("button", { name: "提交" }).waitFor();
  // 列表标题 → 页面走 View Transition，过渡期间（≤ 600ms）iframe 收不到点击，等过渡结束
  await page.waitForFunction(() => !document.getAnimations().some((a) => a.effect?.pseudoElement?.startsWith("::view-transition")));
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
  await page.getByRole("button", { name: "撤销" }).first().waitFor();
  await page.getByText("tkanban add team-kanban --url " + BASE).waitFor(); // MCP 配置片段
});
await step("page-meta-edit", async () => {
  // 页面设置在详情页操作条「管理」里；改为公开要在对话框里确认
  await page.goto(BASE + "/pages/" + IDS["仅项目可见"]);
  await rail().getByRole("button", { name: "管理" }).click();
  await page.getByRole("dialog", { name: "管理页面" }).waitFor();
  await page.getByRole("combobox", { name: "可见性" }).click(); // 页面设置异步加载，按名字等到它出现
  await page.getByRole("option", { name: "公开（持链接即可）" }).click();
  await page.getByRole("button", { name: "保存" }).click();
  await page.getByRole("alertdialog").getByText("改为公开？").waitFor();
  await page.getByRole("button", { name: "取消" }).click();
  await page.getByRole("alertdialog").waitFor({ state: "detached" });
  await page.getByRole("combobox", { name: "可见性" }).click(); // 页面设置异步加载，按名字等到它出现
  await page.getByRole("option", { name: "项目成员" }).click();
  await page.getByRole("button", { name: "保存" }).click();
  await toast("已保存");
  await page.getByRole("button", { name: "删除页面" }).click();
  await page.getByRole("alertdialog").getByText("删除页面「仅项目可见」？").waitFor();
  await page.getByRole("button", { name: "取消" }).click();
  await page.getByRole("alertdialog").waitFor({ state: "detached" });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "管理页面" }).waitFor({ state: "detached" });
});
await step("project-group-create", async () => {
  // 项目页「成员与权限」→ 新建项目群组：出现在列表里，标「项目群组」，成员数 1（创建者自动加入）
  await page.goto(BASE + "/o/demo/p/demo?tab=members");
  await page.fill("input[placeholder*=前端组]", "前端组");
  await page.getByRole("button", { name: "创建群组" }).click();
  await toast("已创建项目群组");
  const row = page.locator(".list-row", { hasText: "前端组" });
  await row.getByText("项目群组").waitFor();
  await row.locator(".list-stat", { hasText: "1" }).waitFor();
  await row.getByRole("button", { name: "成员" }).click();
  await row.getByText("demo@example.com").waitFor();
  await page.screenshot({ path: `${OUT}/project-groups.png`, fullPage: true });
});
await step("page-meta-project-group", async () => {
  // 页面设置的群组候选：本项目群组在前（带「本项目」），再组织级群组；选本项目群组保存
  await page.goto(BASE + "/pages/" + IDS["仅项目可见"]);
  await rail().getByRole("button", { name: "管理" }).click();
  const dlg = page.getByRole("dialog", { name: "管理页面" });
  await dlg.getByRole("combobox", { name: "可见性" }).click();
  await page.getByRole("option", { name: "指定群组" }).click();
  await dlg.getByText("前端组（本项目）").waitFor();
  const labels = await dlg.locator("[data-slot=checkbox]").evaluateAll((cs) => cs.map((c) => c.parentElement.textContent));
  if (labels[0] !== "前端组（本项目）" || !labels.includes("评审组")) throw new Error("group candidates: " + JSON.stringify(labels));
  await dlg.getByText("前端组（本项目）").click();
  await dlg.getByRole("button", { name: "保存" }).click();
  await toast("已保存");
  const pg = await call(demo, "GET", `/pages/${IDS["仅项目可见"]}`);
  const groups = (await call(demo, "GET", `/projects/${project.id}/groups`)).items;
  const fe = groups.find((g) => g.name === "前端组");
  if (pg.visibility !== "groups" || pg.group_ids.join() !== fe.id || !fe.active) throw new Error("saved: " + JSON.stringify([pg.visibility, pg.group_ids, fe]));
  await page.keyboard.press("Escape");
  // 恢复原状，不影响后面的权限场景
  await call(demo, "PATCH", `/pages/${IDS["仅项目可见"]}`, { visibility: "project" });
});
await step("read-only-no-submit", async () => {
  await page.goto(BASE + "/pages/" + IDS["只读报告"]);
  await page.getByText("技术选型投票").waitFor();
  await page.getByText("报告", { exact: true }).first().waitFor(); // 题头面包屑里的类型
  if (await page.getByRole("button", { name: "提交" }).count()) throw new Error("read-only page shows submit button");
  if (await page.getByRole("button", { name: /查看全部结果/ }).count()) throw new Error("read-only page shows results button");
  if (await page.getByText("不接受提交").count()) throw new Error("read-only page shows block notice");
  await page.screenshot({ path: `${OUT}/read-only.png`, fullPage: true });
});
await step("read-only-anon-no-nickname", async () => {
  const c2 = await browser.newContext();
  const p = await c2.newPage();
  watch(p);
  try {
    await p.goto(BASE + "/pages/" + IDS["只读报告"]);
    await p.getByText("技术选型投票").waitFor();
    if (await p.locator("#relay-nick").count()) throw new Error("read-only page shows nickname input");
    if (await p.getByRole("button", { name: "提交" }).count()) throw new Error("read-only page shows submit button");
  } finally { await c2.close(); }
});
await step("generated-by-meta", async () => {
  await page.goto(BASE + "/pages/" + IDS["只读报告"]);
  await page.locator(".band").getByText("Claude Opus 5.5 生成", { exact: true }).waitFor();
  await page.goto(BASE + "/pages/" + IDS["流程图"]); // 未带 model
  await page.getByText("需求流程").waitFor();
  if (await page.locator(".band").getByText(/ 生成$/).count()) throw new Error("page without model shows generated_by");
  await page.goto(BASE + "/o/demo/p/demo");
  await page.locator(".tile").getByText("Claude Opus 5.5", { exact: true }).first().waitFor(); // 卡片底部只写模型名（带星标图标）
});
await step("mermaid-diagram", async () => {
  await page.goto(BASE + "/pages/" + IDS["流程图"]);
  await page.locator(".diagram-svg svg").first().waitFor({ timeout: 15000 });
  await page.getByText("需求流程").waitFor();
  const labels = await page.locator(".diagram-svg svg").first().textContent();
  if (!labels.includes("评审") || !labels.includes("发布")) throw new Error("diagram labels missing: " + labels);
  await page.screenshot({ path: `${OUT}/flowchart.png`, fullPage: true });
  await page.getByRole("button", { name: "放大查看" }).click();
  await page.locator("[role=dialog] .diagram-svg svg").first().waitFor();
  await page.keyboard.press("Escape");
});
await step("knowledge-toc", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(BASE + "/pages/" + IDS["知识库"]);
  const toc = page.getByRole("navigation", { name: "目录" });
  await toc.waitFor();
  const items = await toc.locator("a").allTextContents();
  if (JSON.stringify(items) !== JSON.stringify(["安装", "Linux", "配置", "常见问题"])) throw new Error("toc " + items);
  await page.screenshot({ path: `${OUT}/knowledge.png`, fullPage: true });
  await page.setViewportSize({ width: 1200, height: 900 });
});
await step("api-doc", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.removeItem("tk.apidoc.lang"));
  await page.goto(BASE + "/pages/" + IDS["支付接口文档"]);
  const card = page.locator("[data-endpoint='POST /orders']");
  await card.waitFor();
  // 目录：分组 + method 色块，搜索过滤
  const nav = page.getByRole("navigation", { name: "接口目录" });
  await nav.getByPlaceholder(/搜索/).fill("退款");
  if ((await nav.locator("a").count()) !== 1) throw new Error("search filter");
  await nav.getByPlaceholder(/搜索/).fill("");
  // 切语言：代码随之变化，并记住选择
  await card.getByRole("tab", { name: "Python" }).click();
  const code = card.getByTestId("code");
  if (!(await code.textContent()).includes("requests.post(")) throw new Error("python code");
  if ((await page.evaluate(() => localStorage.getItem("tk.apidoc.lang"))) !== "python") throw new Error("lang not stored");
  // 复制代码：剪贴板 = 代码原文
  await card.getByRole("button", { name: "复制代码" }).click();
  await toast("已复制 Python 代码");
  if ((await page.evaluate(() => navigator.clipboard.readText())) !== (await code.textContent())) throw new Error("clipboard code");
  // 切环境：Base URL 与代码里的地址随之变化；复制完整 URL
  await page.getByRole("radio", { name: "生产" }).click();
  if ((await page.getByTestId("base-url").textContent()) !== "https://api.pay.example.com/v1") throw new Error("base url");
  if (!(await code.textContent()).includes(`"https://api.pay.example.com/v1/orders"`)) throw new Error("code url after env switch");
  const q = page.locator("[data-endpoint='GET /orders/{order_id}']");
  await q.getByRole("button", { name: "复制完整 URL" }).click();
  if ((await page.evaluate(() => navigator.clipboard.readText())) !== "https://api.pay.example.com/v1/orders/o%201") throw new Error("copy url");
  // 复制参数名
  await card.getByRole("button", { name: "复制参数名 amount" }).click();
  if ((await page.evaluate(() => navigator.clipboard.readText())) !== "amount") throw new Error("copy param");
  await page.reload();
  await page.locator("[data-endpoint='POST /orders']").getByRole("tab", { name: "Python", selected: true }).waitFor();
  if (await page.getByRole("button", { name: "提交" }).count()) throw new Error("api doc shows submit");
  await page.screenshot({ path: `${OUT}/api-doc.png`, fullPage: true });
  // 窄屏：目录收进折叠块，无横向滚动
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText("接口目录").first().waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error("api doc horizontal overflow at 390px");
  await page.screenshot({ path: `${OUT}/api-doc-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1200, height: 900 });
  // 卡片：类型名与接口数
  await page.goto(BASE + "/o/demo/p/demo");
  const tile = page.locator(".tile", { hasText: "支付接口文档" });
  await tile.getByText("接口文档", { exact: true }).waitFor();
  await tile.getByText("3 个", { exact: true }).waitFor();
});
await step("list-filter-chips", async () => {
  await page.goto(BASE + "/o/demo/p/demo");
  await page.locator(".tile-title", { hasText: "示例：vote.openui" }).waitFor();
  const filters = page.getByRole("group", { name: "筛选" });
  const titles = async () => (await page.locator(".tile-title").allTextContents()).sort();
  // 类型分段（按钮文字带计数，如「报告 1」）
  await filters.getByRole("button", { name: /^报告/ }).click();
  // 切换时旧格子淡出（layout 重排），等格子真正变成 1 个再断言
  await page.waitForFunction(() => document.querySelectorAll(".tile-title").length === 1);
  let t = await titles();
  if (JSON.stringify(t) !== JSON.stringify(["只读报告"])) throw new Error("报告: " + t);
  if (!(await filters.getByRole("button", { pressed: true }).textContent()).startsWith("报告")) throw new Error("pressed chip");
  // 左侧导航「等我处理」= 首页 ?view=todo：只剩收集类、我还没交的
  await page.getByRole("navigation", { name: "导航" }).getByRole("link", { name: /^等我处理/ }).click();
  await page.waitForURL(/\?view=todo$/);
  await page.locator(".tile-title", { hasText: "评审组可见" }).waitFor();
  // 文档类的格子淡出后才从 DOM 移除
  await page.waitForFunction(() => ![...document.querySelectorAll(".tile-title")].some((e) => ["只读报告", "流程图", "知识库", "支付接口文档"].includes(e.textContent)));
  t = await titles();
  if (t.some((x) => ["只读报告", "流程图", "知识库"].includes(x))) throw new Error("等我处理: " + t);
  // 右栏「等我处理」面板里的待办卡带主按钮「去投票 / 去填写」
  await page.locator("article[data-todo]").getByRole("link", { name: /^去(投票|填写)$/ }).first().waitFor();
  await page.screenshot({ path: `${OUT}/project-filter.png`, fullPage: true });
  await filters.getByRole("button", { name: /^全部/ }).click();
});
await step("tab-in-url", async () => {
  await page.goto(BASE + "/o/demo/p/demo");
  await page.getByRole("tab", { name: "成员与权限" }).click();
  await page.waitForURL(/\?tab=members$/);
  await page.reload();
  await page.getByRole("tab", { name: "成员与权限", selected: true }).waitFor();
  await page.getByText("项目群组").first().waitFor();
  await page.goto(BASE + "/o/demo?tab=members");
  await page.getByRole("tab", { name: "成员", exact: true, selected: true }).waitFor();
});
await step("cmdk-search-jump", async () => {
  await page.goto(BASE + "/");
  await page.locator(".tile").first().waitFor();
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder("搜索项目、页面，或输入操作").fill("vote.openui");
  await page.getByRole("option", { name: /示例：vote\.openui/ }).click();
  await page.waitForURL(voteUrl);
  await page.getByText("技术选型投票").waitFor();
  // 顶栏搜索框也能打开命令栏
  await page.getByRole("button", { name: "搜索页面" }).click();
  await page.getByPlaceholder("搜索项目、页面，或输入操作").waitFor();
  await page.screenshot({ path: `${OUT}/command.png` });
  await page.keyboard.press("Escape");
});
await step("todo-count-after-submit", async () => {
  // 等我参与 = 收集类、仍接受提交、我还没提交过；提交后回到首页数量减 1
  await page.goto(BASE + "/");
  const chip = page.getByTestId("todo-count");
  await chip.waitFor();
  const before = Number(await chip.textContent());
  // 待办格子出现；提交后回到首页它变回普通格子（不再 2×2）
  await page.locator("article[data-todo]", { hasText: "评审组可见" }).waitFor();
  await page.goto(BASE + "/pages/" + IDS["评审组可见"]);
  await ticket(page, "A. Kafka").click();
  await page.getByRole("button", { name: "提交" }).click();
  await toast("已提交");
  await page.goto(BASE + "/");
  await page.locator(".tile").first().waitFor();
  await page.locator("article:not([data-todo])", { hasText: "评审组可见" }).waitFor({ timeout: 5000 });
  await page.waitForFunction((b) => Number(document.querySelector("[data-testid=todo-count]")?.textContent ?? 0) === b - 1, before, { timeout: 5000 })
    .catch(async () => { throw new Error(`todo ${before} → ${await chip.textContent().catch(() => "无")}`); });
});
await step("activity-rail", async () => {
  // 首页右侧「实时动态」：显示发布与提交事件（旧后端没有 /api/activity 时整栏不显示，跳过）
  await page.goto(BASE + "/");
  await page.locator(".tile").first().waitFor();
  const r = await page.evaluate(async () => (await fetch("/api/activity?limit=30")).status);
  if (r === 404) return console.log("     skip: /api/activity 未实现");
  const aside = page.getByRole("complementary", { name: "实时动态" });
  await aside.locator("li", { hasText: "发布了" }).first().waitFor();
  await aside.locator("li", { hasText: "评审组可见" }).first().waitFor(); // 刚才的提交
  await page.screenshot({ path: `${OUT}/home-activity.png` });
});
await step("closed-page-not-submittable", async () => {
  if (!CLOSING) return console.log("     skip: 后端未返回 closes_at");
  // 轮询 view 直到截止生效（建页时设的是 3 秒后）
  const deadline = Date.now() + 10000;
  let v;
  do {
    v = await call(demo, "GET", `/pages/${CLOSING}/view`);
    if (v.submit_block_reason === "closed") break;
    await new Promise((ok) => setTimeout(ok, 250));
  } while (Date.now() < deadline);
  if (v.submit_block_reason !== "closed" || v.can_submit) throw new Error("view not closed: " + JSON.stringify([v.can_submit, v.submit_block_reason]));
  const res = await fetch(`${BASE}/api/pages/${CLOSING}/responses`, { method: "POST",
    headers: { "Content-Type": "application/json", Cookie: demo.cookie, "X-CSRF-Token": demo.csrf },
    body: JSON.stringify({ data: { action: "提交", form: "vote", values: { choice: "A" }, params: {} } }) });
  const j = await res.json();
  if (res.status !== 409 || !["closed", "responses_closed"].includes(j.error?.code)) throw new Error(`closed submit → ${res.status} ${JSON.stringify(j)}`);
  await page.goto(BASE + "/pages/" + CLOSING);
  await page.getByText("已截止，不再接受提交").waitFor();
  await page.locator(".band", { hasText: "已截止" }).waitFor();
  if (await page.getByRole("button", { name: "提交" }).count()) throw new Error("closed page shows submit button");
  // 截止页不进「等我处理」
  await page.goto(BASE + "/");
  await page.locator("article:not([data-todo])", { hasText: "即将截止的投票" }).waitFor();
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
await step("page-close-reopen", async () => {
  // 管理员在「管理」里关闭（二次确认）→ 成员看不到、临时链接失效 → 首页「已关闭」分段可找到 → 横幅「重新打开」→ 成员可见可投
  const id = IDS["关闭测试投票"];
  await page.goto(BASE + "/pages/" + id);
  await rail().getByRole("button", { name: "管理" }).click();
  await page.getByRole("dialog", { name: "管理页面" }).getByRole("button", { name: "关闭页面" }).click();
  await page.getByRole("alertdialog").getByText("关闭页面「关闭测试投票」？").waitFor();
  await page.getByRole("button", { name: "确认关闭" }).click();
  await toast("已关闭");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "管理页面" }).waitFor({ state: "detached" });
  await page.getByRole("status", { name: "页面已关闭" }).waitFor();
  const c2 = await browser.newContext();
  const p = await c2.newPage();
  watch(p);
  try {
    await p.goto(BASE + CLOSE_SHARE);
    await p.getByText("页面不存在，或需要登录后才能查看。").waitFor();
    await login(p, "member@example.com");
    await p.goto(BASE + "/pages/" + id);
    await p.getByText("页面不存在，或你没有查看权限。").waitFor();
    // 管理员：首页「已关闭」分段里有它，「全部」里没有
    await page.goto(BASE + "/");
    const seg = page.getByRole("group", { name: "筛选" });
    await seg.getByRole("button", { name: /^全部/ }).waitFor();
    if (await page.locator(".tile-title", { hasText: "关闭测试投票" }).count()) throw new Error("closed page shown under 全部");
    await seg.getByRole("button", { name: /^已关闭/ }).click();
    await page.locator("article", { hasText: "关闭测试投票" }).getByText("已关闭").waitFor();
    await page.locator(".tile-title", { hasText: "关闭测试投票" }).click();
    await page.getByRole("status", { name: "页面已关闭" }).getByRole("button", { name: "重新打开" }).click();
    await toast("已重新打开");
    await page.getByRole("status", { name: "页面已关闭" }).waitFor({ state: "detached" });
    // 成员可见可投；临时链接恢复
    await p.goto(BASE + "/pages/" + id);
    await p.getByText("技术选型投票").waitFor();
    await ticket(p, "A. Kafka").click();
    await p.getByRole("button", { name: "提交" }).click();
    await p.locator(".toast", { hasText: "已提交（#1）" }).first().waitFor({ timeout: 5000 });
    const c3 = await browser.newContext();
    const a = await c3.newPage();
    try {
      await a.goto(BASE + CLOSE_SHARE);
      await a.getByText("技术选型投票").waitFor();
    } finally { await c3.close(); }
  } finally { await c2.close(); }
});
await step("admin-create-account-force-change", async () => {
  // 管理员在成员 tab 建账号（加入项目 + 群组，系统生成一次性密码）→ 新账号登录被要求改密码 → 改完进入首页
  const c2 = await browser.newContext();
  const p = await c2.newPage();
  watch(p);
  const c3 = await browser.newContext();
  const q = await c3.newPage();
  watch(q);
  try {
    await login(p, "demo@example.com");
    await p.goto(BASE + "/o/demo?tab=members");
    await p.getByRole("button", { name: "新建账号" }).click();
    const dlg = p.getByRole("dialog", { name: "新建账号" });
    await dlg.getByLabel("邮箱").fill("newbie@example.com");
    await dlg.getByLabel("姓名").fill("Newbie");
    await dlg.getByText("演示项目", { exact: true }).click();
    await dlg.getByRole("combobox", { name: "演示项目 角色" }).waitFor();
    await dlg.getByText("评审组", { exact: true }).click();
    await dlg.getByRole("button", { name: "创建账号" }).click();
    const done = p.getByRole("dialog", { name: "账号已就绪" });
    await done.getByText("初始密码只显示这一次").waitFor();
    const pw = (await done.locator("code").innerText()).trim();
    if (pw.length < 16) throw new Error("generated password too short: " + pw);
    await p.screenshot({ path: `${OUT}/account-created.png` });
    await done.getByRole("button", { name: "关闭" }).click();
    await p.locator("tr", { hasText: "newbie@example.com" }).getByText("待改初始密码").waitFor();

    await q.goto(BASE + "/login");
    await q.fill("input[type=email]", "newbie@example.com");
    await q.fill("input[type=password]", pw);
    await q.getByRole("button", { name: "登录" }).click();
    await q.getByRole("heading", { name: "请先修改密码" }).waitFor();
    await q.screenshot({ path: `${OUT}/force-change-password.png` });
    await q.fill("input[autocomplete=current-password]", pw);
    await q.fill("input[autocomplete=new-password]", "newbie-pass-123");
    await q.getByRole("button", { name: "修改密码并进入" }).click();
    await q.getByRole("heading", { name: "请先修改密码" }).waitFor({ state: "detached" });
    await q.waitForURL((u) => u.pathname === "/");
    await q.getByText("评审组可见").first().waitFor(); // 群组授权生效：首页动态里能看到评审组页面
  } finally { await c2.close(); await c3.close(); }
});
await step("task-tree-review", async () => {
  // 发布任务树 → 负责人勾选完成进入待评审 → 评审人驳回（必须填理由）→ 再提交 → 评审通过 → 进度更新
  const cm = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pm = await cm.newPage();
  watch(pm);
  const cd = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pd = await cd.newPage();
  watch(pd);
  const toastOn = (p, t) => p.locator(".toast", { hasText: t }).first().waitFor({ timeout: 5000 });
  const submit = async (note) => {
    await pm.goto(BASE + "/pages/" + TASKS);
    await pm.getByRole("button", { name: "勾选完成：接口联调" }).click();
    const dlg = pm.getByRole("dialog", { name: "完成并提交评审" });
    await dlg.getByLabel("完成说明").fill(note);
    await dlg.getByLabel("证据链接").fill("https://ci.example.com/run/1");
    await dlg.getByRole("button", { name: "提交评审" }).click();
    await toastOn(pm, "已提交评审");
    await pm.locator("li[data-task=api][data-status=in_review]").waitFor();
  };
  try {
    await login(pm, "member@example.com");
    // 父节点有未完成子任务：勾选圈提示不能提交
    await pm.goto(BASE + "/pages/" + TASKS);
    await pm.getByRole("tree", { name: "任务树" }).getByText("接口联调").waitFor();
    await submit("联调通过");
    await login(pd, "demo@example.com");
    // 首页卡片：待你评审 1 项
    await pd.goto(BASE + "/");
    await pd.locator("article.tile", { hasText: "支付上线清单" }).getByText("待你评审 1 项").waitFor();
    await pd.goto(BASE + "/pages/" + TASKS);
    await pd.getByRole("region", { name: "待你评审" }).or(pd.locator("[aria-label=待你评审]")).getByText("接口联调").waitFor();
    await pd.locator("li[data-task=api]").getByRole("button", { name: "评审" }).click();
    const rd = pd.getByRole("dialog", { name: "评审任务" });
    await rd.getByText("联调通过").waitFor();
    await rd.getByRole("button", { name: "驳回" }).click();
    await rd.getByRole("alert").filter({ hasText: "驳回必须写理由" }).waitFor();
    await rd.getByLabel("评审意见").fill("缺少回调验签");
    await rd.getByRole("button", { name: "驳回" }).click();
    await toastOn(pd, "已驳回");
    // 负责人看到被驳回与理由，再提交
    await pm.goto(BASE + "/pages/" + TASKS);
    await pm.locator("li[data-task=api]").getByText("缺少回调验签").waitFor();
    await pm.locator("li[data-task=api]").getByText("被驳回", { exact: true }).waitFor();
    await submit("已补回调验签");
    await pd.goto(BASE + "/pages/" + TASKS);
    await pd.locator("li[data-task=api]").getByRole("button", { name: "评审" }).click();
    await pd.getByRole("dialog", { name: "评审任务" }).getByRole("button", { name: "通过" }).click();
    await toastOn(pd, "已通过");
    await pd.locator("li[data-task=api][data-status=done]").waitFor();
    await pd.getByText("1 / 2 已完成").first().waitFor();
    // 历史时间线：两次提交、一次驳回、一次通过
    await pd.locator("li[data-task=api]").getByRole("button", { name: "接口联调", exact: true }).click();
    const hist = pd.locator("li[data-task=api] ol");
    await hist.getByText("评审通过").waitFor();
    if ((await hist.getByText("提交评审").count()) !== 2) throw new Error("history should have 2 submits");
    await hist.getByText("缺少回调验签").waitFor();
    await pd.screenshot({ path: `${OUT}/task-tree.png`, fullPage: true });
  } finally { await cm.close(); await cd.close(); }
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
  await page.goto(BASE + "/");
  await page.locator(".tile").first().waitFor();
  await page.screenshot({ path: `${OUT}/mobile-dark-home.png`, fullPage: true });
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error("home horizontal overflow at 375px");
});
await step("reduced-motion", async () => {
  // 开启「减少动态效果」：页面正常，所有动画/过渡时长归零，无运行中的动画残留
  const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const p = await c2.newPage();
  watch(p);
  const settled = async (where) => {
    await p.waitForTimeout(100);
    const r = await p.evaluate(() => ({
      running: document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().duration > 0).map((a) => a.animationName ?? a.transitionProperty ?? "waapi"),
      hidden: [...document.querySelectorAll(".list > *, .bento > *")].filter((e) => getComputedStyle(e).opacity !== "1").length,
    }));
    if (r.running.length || r.hidden) throw new Error(`${where}: running ${r.running} hidden rows ${r.hidden}`);
  };
  try {
    await login(p, "demo@example.com");
    await p.goto(BASE + "/o/demo/p/demo");
    await p.locator(".tile-title", { hasText: "示例：vote.openui" }).waitFor();
    await settled("project");
    const ind = p.locator("[data-slot=tabs-indicator]").first();
    if ((await ind.evaluate((e) => getComputedStyle(e).transitionDuration)).split(",").some((d) => d.trim() !== "0s")) throw new Error("indicator transition not zeroed");
    await p.getByRole("group", { name: "筛选" }).getByRole("button", { name: /^报告/ }).click();
    await p.locator(".tile-title", { hasText: "只读报告" }).click(); // 格子 → 页面（减少动态时不走 View Transition）
    await p.getByText("技术选型投票").waitFor();
    await settled("vote");
    await p.goto(BASE + "/pages/" + IDS["示例：report.openui"]);
    await p.getByText("2026 Q3 运营报告").waitFor();
    await settled("report");
    await p.screenshot({ path: `${OUT}/reduced-motion-report.png`, fullPage: true });
  } finally { await c2.close(); }
});
await step("classic-theme", async () => {
  // 设置 › 外观切到经典（Win98）→ 刷新仍是经典且强制亮色 → 首页详细信息列表 + 停靠小窗 → 投票详情（属性对话框）提交并锁定 → 任务树正常 → 切回默认
  const id = (await call(demo, "POST", "/pages", { project_id: project.id, title: "经典主题投票", kind: "openui", content: vote, page_type: "vote", visibility: "public", results_visible_to: "viewers" })).id;
  const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await c2.newPage();
  watch(p);
  try {
    await p.addInitScript(() => localStorage.setItem("openui-theme-mode", '"dark"'));
    await login(p, "demo@example.com");
    await p.goto(BASE + "/settings/account");
    await p.getByRole("radio", { name: "经典（Windows 98）" }).click();
    await p.waitForFunction(() => document.documentElement.dataset.skin === "classic" && !document.documentElement.classList.contains("dark"));
    await p.reload();
    await p.getByRole("region", { name: "Team Kanban - 资源管理器" }).waitFor();
    if ((await p.evaluate(() => [document.documentElement.dataset.skin, document.documentElement.classList.contains("dark")])).join() !== "classic,false") throw new Error("classic not persisted or not light");
    if (!(await p.getByRole("radio", { name: "暗色" }).isDisabled())) throw new Error("dark radio should be disabled in classic");
    await p.goto(BASE + "/");
    await p.locator(".cl-list tr", { hasText: "经典主题投票" }).getByText("等你投票").waitFor();
    await p.getByRole("region", { name: "等我处理" }).getByText("经典主题投票").waitFor();
    await p.screenshot({ path: `${OUT}/classic-home.png` });
    await p.locator(".cl-list .tile-title", { hasText: "经典主题投票" }).click();
    await p.waitForURL(new RegExp(`/pages/${id}$`));
    await p.getByRole("region", { name: "经典主题投票 - 属性" }).getByText("技术选型投票").waitFor();
    await ticket(p, "B. NATS").click();
    await p.getByRole("button", { name: "提交" }).click();
    await p.locator(".toast", { hasText: "已提交（#1）" }).first().waitFor({ timeout: 5000 });
    await assertLocked(p, "B. NATS", 1);
    await p.reload();
    await assertLocked(p, "B. NATS", 1);
    await p.screenshot({ path: `${OUT}/classic-vote.png` });
    await p.goto(BASE + "/pages/" + TASKS);
    await p.getByRole("tree", { name: "任务树" }).getByText("接口联调").waitFor();
    await p.screenshot({ path: `${OUT}/classic-tasks.png` });
    await p.goto(BASE + "/settings/account");
    await p.getByRole("radio", { name: "默认（长春花工作台）" }).click();
    await p.waitForFunction(() => !document.documentElement.dataset.skin);
    await p.reload();
    await p.getByRole("heading", { name: "账号设置" }).waitFor();
    if (await p.locator("html[data-skin], .cl-desk").count()) throw new Error("skin not reset to default");
  } finally { await c2.close(); }
});
console.log("console errors:", errors.length ? errors : "none");
await browser.close();
if (failed || errors.length) { console.log(`${failed} 个场景失败`); process.exit(1); }
