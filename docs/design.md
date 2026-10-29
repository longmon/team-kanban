# Team Kanban 设计文档（v2：多租户完整版）

状态：已定稿待实现 · 2026-10-21 · 配套契约：[api.md](api.md)、[../server/migrations/0001_init.sql](../server/migrations/0001_init.sql)、[0002_page_types.sql](../server/migrations/0002_page_types.sql)（页面分类）

## 1. 目标与范围

本机 agent 通过 MCP 发布产物（报告、表格、图表、投票/问卷），外部用户在网页上查看、点选、提交，agent 通过 MCP 拉回提交结果。v2 在原型（server.js + mcp.js，单 token 单租户）基础上加入：账号、组织/项目/群组多租户、页面可见性、临时链接、OpenUI 渲染、实时结果、审计。

**不做**：OAuth/SSO（模型留口子，见 §3.1）、网页端编辑 OpenUI 内容（页面内容只由 agent 发布/更新，网页端只改元数据）、多实例水平扩展（见 §9 天花板）、页面历史版本、计费。

## 2. 架构

```
                        ┌──────────────────── 一台机器 / 一个 compose ───────────────────┐
 本机                   │                                                                │
┌──────────┐  stdio  ┌──┴───────┐  HTTPS + PAT   ┌───────┐   ┌──────────────────────────┐ │
│ agent    ├────────►│ mcp/     ├───────────────►│       │   │ relay (Rust 单二进制)     │ │
│ (Claude/ │         │ Rust MCP │  /api/*        │       │   │  axum 0.8 + tokio         │ │
│  Codex)  │         │ lang-core│                │ Caddy ├──►│  ├ /api/*   JSON API       │ │
└──────────┘         │ 本地校验 │                │ HTTPS │   │  ├ /openui/* 库 schema/提示│ │
                     └──────────┘                │ 反代  │   │  ├ /*       React SPA      │ │
 外部用户                                         │       │   │  │          (rust-embed)   │ │
┌──────────┐  HTTPS  cookie / share token         │       │   │  └ PAGES_ORIGIN 主机名:    │ │
│ 浏览器   ├─────────────────────────────────────►│       │   │     /h/*  html 页面原文     │ │
│ app 源   │◄── SSE 实时结果                      │       │   │  进程内: 限流表、长轮询/   │ │
│  └iframe ├── pages 源 (sandbox, 无 same-origin)►│       │   │          SSE 通知中心       │ │
└──────────┘    postMessage ↔ 外壳页代提交         └───────┘   └────────────┬─────────────┘ │
                                                                         │ sqlx           │
                                                               ┌─────────▼─────────┐      │
                                                               │ PostgreSQL 17      │      │
                                                               └────────────────────┘      │
                        └────────────────────────────────────────────────────────────────┘
```

仓库结构：

```
server/            Rust: axum 0.8, tokio, sqlx(postgres, migrate), rust-embed, argon2, uuid(v7), lettre(SMTP)
  migrations/      sqlx 迁移；启动时 sqlx::migrate! 自动执行
  src/
    main.rs config.rs error.rs db.rs
    auth/          session.rs csrf.rs pat.rs password.rs   —— 解析「是谁」→ Principal
    authz.rs       ——「能不能」唯一入口，产出 OrgCtx/ProjectCtx/PageCtx（见 §5）
    routes/        auth orgs projects groups invites tokens pages share_links responses openui spa pages_origin
    notify.rs      进程内 page_id → tokio::sync::broadcast，供长轮询与 SSE
    ratelimit.rs   进程内固定窗口计数
    mail.rs audit.rs
web/               Vite + React + TS + Tailwind 4；@openuidev/react-lang@1.0.1（精确版本）+ shadcn/ui（src/components/ui）+ Recharts
  src/openui-lib/         自定义 OpenUI 组件库 kanbanLibrary（schema 与原 openuiLibrary 一致，渲染用 shadcn/ui），视觉规范见 docs/design-system.md
  scripts/gen-openui.ts   构建时导出 kanbanLibrary 的 JSON Schema 与提示词 → dist/openui/
mcp/               Rust stdio MCP 单二进制；rmcp + rquickjs 内嵌 QuickJS 运行打包好的 @openuidev/lang-core（校验，vendor/lang-core.js）
docs/              本文档、api.md
Dockerfile docker-compose.yml Caddyfile.example
```

旧的 `server.js`、`test.js`、`mcp.js` 在新版通过验收后删除。

**OpenUI 库的单一真相源**：页面渲染用 `web/src/openui-lib` 的 `kanbanLibrary`（组件名、参数顺序与枚举沿用 `@openuidev/react-ui` 的 openuiLibrary，渲染换成 shadcn/ui）。`web/scripts/gen-openui.ts` 在 `vite build` 后运行，输出：
- `dist/openui/library.schema.json` = `kanbanLibrary.toJSONSchema()`
- `dist/openui/prompt.md` = `kanbanLibrary.prompt(kanbanPromptOptions)` + 本项目的提交规则（§8.2）

二者随 SPA 一起被 rust-embed 打进二进制，经 `GET /openui/library.schema.json`、`GET /openui/prompt.md` 公开提供。MCP 从服务端拉取并缓存，用 `createParser(schema, "Stack")` 校验，保证 **MCP 校验的库 = 浏览器渲染的库**，不会版本漂移。所有 npm 安装与构建设 `OPENUI_TELEMETRY_DISABLED=1`；Renderer 传 `publishObservability={false}`、`toolProvider={null}`。

## 3. 数据模型

完整 DDL 见 `server/migrations/0001_init.sql`（已在 postgres:17-alpine 实测）。下表是语义说明。

### 3.0 通用约定

| 项 | 约定 |
|---|---|
| 主键 | `uuid`，应用生成 **UUIDv7**（`uuid` crate `v7` feature，随机部分来自 OS CSPRNG）。对外就是小写带连字符的 UUID 字符串。`audit_log` 用 bigint identity。 |
| 时间 | `timestamptz`，对外 RFC 3339 UTC 毫秒：`2026-10-21T08:00:00.000Z` |
| 租户隔离 | 业务表都有 `org_id NOT NULL`；父表 `UNIQUE (org_id, id)`，子表复合外键 `(org_id, parent_id) → parent(org_id, id)`。跨租户关联在 INSERT 时被外键拒绝（已测）。 |
| 秘密 | session/PAT/邀请/邮件/临时链接 token：32 字节随机，base64url 无填充（43 字符），库里只存 `sha256` 摘要（bytea 32）。密码（账号、临时链接）：argon2id，PHC 字符串。 |
| 软删除 | `orgs`、`projects`、`pages` 用 `deleted_at`；所有读取都带 `deleted_at IS NULL`，且访问页面时要求所属项目与组织均未删除。其余表硬删除/级联。 |
| updated_at | 应用在 UPDATE 时显式写，不用触发器。 |

### 3.1 账号

**users** — `id uuid PK`、`email text UNIQUE`（CHECK 已小写去空格）、`password_hash text`、`display_name text(1..50)`、`email_verified_at timestamptz?`、`must_change_password bool NOT NULL DEFAULT false`（0007：管理员建的账号为 true，改密前会话只能看自己/改密码/登出）、`is_superadmin bool NOT NULL DEFAULT false`、`disabled_at timestamptz?`（0011：超级管理员与账号禁用，见 §5.5）、`created_at`、`updated_at`。
扩展余地：接 OAuth 时新增 `user_identities(user_id, provider, subject, UNIQUE(provider, subject))`，`password_hash` 改可空。现在不建。

**sessions** — `id`、`user_id → users CASCADE`、`token_hash bytea UNIQUE`、`csrf_token text`、`ip inet`、`user_agent text`、`created_at`、`last_seen_at`、`expires_at`。索引 `user_id`、`expires_at`。

**email_tokens** — `id`、`user_id → users CASCADE`、`purpose ∈ {verify_email, reset_password}`、`token_hash UNIQUE`、`expires_at`、`used_at?`。验证邮箱 24h，重置密码 1h，一次性。

### 3.2 租户

**orgs** — `id`、`name(1..100)`、`slug`（`^[a-z0-9](-?[a-z0-9]){0,39}$`，未删除者唯一）、`created_by → users`、时间戳、`deleted_at?`。

**memberships** — PK `(org_id, user_id)`；`role ∈ {owner, admin, member}`。索引 `user_id`。

**projects** — `id`、`org_id → orgs`、`name`、`slug`（组织内未删除者唯一）、`description(≤2000)`、`created_by`、时间戳、`deleted_at?`；`UNIQUE (org_id, id)`。

**project_members** — PK `(project_id, user_id)`；`org_id`；`role ∈ {admin, editor, viewer}`；FK `(org_id, project_id) → projects CASCADE`；FK `(org_id, user_id) → memberships CASCADE`（**必须先是组织成员；移出组织自动移出项目**）。

**groups** — `id`、`org_id`、`name`（组织内忽略大小写唯一）、`description`、`created_by`、时间戳；`UNIQUE (org_id, id)`。

**group_members** — PK `(group_id, user_id)`；FK `(org_id, group_id) → groups CASCADE`；FK `(org_id, user_id) → memberships CASCADE`。

**project_groups** — 群组授权给项目。PK `(project_id, group_id)`；`role ∈ {admin, editor, viewer}`；两条复合 FK 保证同组织。

### 3.3 页面与提交

**pages** — `id`、`org_id`、`project_id`（FK `(org_id, project_id)`）、`title(1..200)`、`kind ∈ {openui, html}`（创建后不可改）、`content text`（openui ≤ 512 KiB，html ≤ 5 MiB，CHECK 兜底）、`version int`（content 变更 +1）、`visibility ∈ {public, org, project, groups}`、`accept_responses bool`、`results_visible_to ∈ {managers, viewers}`、`response_seq bigint`（最后分配的序号 = 提交总数）、`created_by`、`created_via_pat uuid?`、时间戳、`deleted_at?`。索引 `(project_id, id DESC) WHERE deleted_at IS NULL`。

**页面类型**（0002）— `pages.page_type text NOT NULL DEFAULT 'general'`，CHECK 取值 ∈ {general, report, knowledge, flowchart, architecture, vote, requirement, task, task_tree}；与 `kind` 正交，创建后不可改。大类不入库，由代码里的纯函数 `page_category(page_type)` 推导：read = report/knowledge/flowchart/architecture（只读，CHECK `pages_read_only_check` 强制 `accept_responses = false`）；collect = vote/general；collab = requirement/task/task_tree（CHECK `pages_collab_kind_check` 要求 `kind='openui'`；task_tree 已开放（0009，见下「任务树」），requirement/task 仍未开放，创建时应用层 400）。旧页面全部为 general，行为不变；旧客户端不传 page_type 时也是 general。
**接口文档**（0008）— 新增 `page_type='api_doc'`（read 类）与 `kind='api'`（content 存规范化 JSON，≤512 KiB），CHECK `pages_api_doc_kind_check` 要求两者同时出现；`page_versions.kind` 同步放宽。结构与校验见 api.md §7.5（`server/src/apidoc.rs`，MCP 以 `#[path]` 共用）。
迁移只做 `ADD COLUMN … DEFAULT 常量`（PG11+ 只改元数据，不重写表）+ 三个 CHECK（校验扫一遍 pages 主表，大字段在 TOAST 不读），文件内 `SET LOCAL lock_timeout = '5s'`，拿不到锁即失败退出、不长时间阻塞。0002 上线后回退到旧镜像会因 sqlx 报版本缺失而起不来，确需回退时先停 app 再执行：
```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_collab_kind_check, DROP CONSTRAINT IF EXISTS pages_read_only_check,
                  DROP CONSTRAINT IF EXISTS pages_page_type_check, DROP COLUMN IF EXISTS page_type;
DELETE FROM _sqlx_migrations WHERE version = 2;
COMMIT;
```

**卡片字段**（0005）— `pages.closes_at timestamptz?`（截止时间，到期视为截止）、`summary text?`（CHECK 1..300 字符）、`highlights jsonb?`（CHECK：1..4 项数组，每项 `label`/`value` 为 1..20 字符字符串；应用层另校验无多余字段、trim）。均为可空无默认值的 ADD COLUMN（只改元数据）。同一迁移为首页动态流加 `responses (org_id, created_at DESC)`、`page_versions (org_id, created_at DESC)` 两个普通索引。回退到旧镜像前先停 app 再执行：
```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP INDEX IF EXISTS responses_org_created_idx, page_versions_org_created_idx;
ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_highlights_check, DROP CONSTRAINT IF EXISTS pages_summary_check,
                  DROP COLUMN IF EXISTS highlights, DROP COLUMN IF EXISTS summary, DROP COLUMN IF EXISTS closes_at;
DELETE FROM _sqlx_migrations WHERE version = 5;
COMMIT;
```

**任务树**（0009，契约见 api.md §7.6）— 三张新表，不改任何已有表、不回填：
- `tasks`：`id`、`org_id`、`page_id`（FK `(org_id, page_id) → pages CASCADE`）、`parent_id`（FK `(org_id, parent_id) → tasks CASCADE`）、`key`（`UNIQUE (page_id, key)`，重发合并用，也服务按页拉树）、`position`、`title(1..200)`、`description(≤5000)`、`assignee_user_id`（FK `(org_id, assignee_user_id) → memberships ON DELETE SET NULL (assignee_user_id)`，移出组织自动置空）、`assignee_label`、`due_at`、`status ∈ {todo, in_progress, in_review, done}`、`submit_note`/`evidence`（最近一次提交）、`submitted_by`/`submitted_at`、`reject_reason`、`reviewed_by`/`reviewed_at`、`created_by`、时间戳、`deleted_at`（软删）。部分索引 `(assignee_user_id, page_id) WHERE deleted_at IS NULL AND status IN ('todo','in_progress')`（我的待办），`(parent_id)`。
- `task_events`：只增不改的历史（actor 用户与 PAT、action、from/to、note、evidence、meta）；索引 `(task_id, created_at)`、`(org_id, created_at DESC)`（首页动态）。
- `page_reviewers`：`(org_id, page_id, user_id | group_id)` 恰好一个非空，两条部分唯一索引；成员 FK 指 memberships（移出组织即失去评审人身份），群组删掉即级联。没有任何行 = 项目 admin 评审。
- 权限：查看同页面；改任务 = 负责人 / 项目 admin / 页面发布者；评审 = 评审人且不是该任务的 `submitted_by`；PAT 复用 `publish` scope（读用任一 scope），不新增 scope——scope 只区分「接口类别」，谁能评审由身份决定，令牌不放大权限，且新增 scope 要改 PAT 表 CHECK 与令牌界面。
- 状态机与父子规则见 api.md §7.6；任务状态变化不改 `pages.version`。首页列表 `task_stats` 在 `GET /api/pages` 同一条 SQL 内对当前页的 task_tree 行做子查询（走 `tasks_page_key_key`），不额外请求。
回退到旧镜像前先停 app 再执行（会丢掉全部任务数据，先导出）：
```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TABLE IF EXISTS page_reviewers, task_events, tasks;
DELETE FROM _sqlx_migrations WHERE version = 9;
COMMIT;
```

**page_groups** — `visibility = 'groups'` 的受众。PK `(page_id, group_id)`，两条复合 FK。visibility 改成别的值时应用清空本表。

**share_links** — `id`、`org_id`、`page_id`（FK `(org_id, page_id)`）、`token_hash UNIQUE`、`token_prefix`（前 6 字符，界面辨认）、`label`、`expires_at NOT NULL`、`max_uses int?`、`use_count int`（CHECK `use_count ≤ max_uses`）、`password_hash?`、`created_by`、`created_at`、`revoked_at?`；`UNIQUE (org_id, page_id, id)` 供 responses 复合外键。**token 只在创建时返回一次**（与 PAT 一致），丢了就新建一个。

**responses** — `id`、`org_id`、`page_id`、`seq`（页面内从 1 递增；`UNIQUE (page_id, seq)` 即游标索引）、`page_version`、`user_id?`、`nickname?`、`share_link_id?`、`data jsonb`（必须是 object，序列化 ≤ 64 KiB 由应用检查）、`ip inet`、`created_at`。CHECK `user_id IS NOT NULL OR nickname IS NOT NULL`。FK `(org_id, page_id, share_link_id) → share_links(org_id, page_id, id)` 保证临时链接属于同一页面。提交不可删除（审计需要）；删页面级联删除。

**seq 分配**（与插入同一事务，按页面行锁串行，无竞态）：
```sql
UPDATE pages SET response_seq = response_seq + 1
 WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL AND accept_responses
   AND (closes_at IS NULL OR closes_at > now())
 RETURNING response_seq, version;
-- 经临时链接时再原子占用名额（0 行 = 已用完/过期/吊销 → 回滚，409）
UPDATE share_links SET use_count = use_count + 1
 WHERE id = $3 AND page_id = $2 AND revoked_at IS NULL AND expires_at > now()
   AND (max_uses IS NULL OR use_count < max_uses)
 RETURNING id;
INSERT INTO responses (...) VALUES (...);
COMMIT;  -- 提交后 notify.send(page_id, seq)
```

### 3.4 邀请、PAT、审计

**invites** — `id`、`org_id`、`target_type ∈ {org, project, group}`、`project_id?`、`group_id?`、`role`（CHECK：org→admin/member，project→admin/editor/viewer，group→member；**不能邀请 owner**）、`email?`（非空则只有该邮箱且已验证的账号可接受，且 `max_uses = 1`）、`token_hash UNIQUE`、`max_uses(1..1000)`、`use_count`、`created_by`、`created_at`、`expires_at`、`revoked_at?`。接受 project/group 邀请时若还不是组织成员，同事务内先以 `member` 加入组织。

**personal_access_tokens** — `id`、`user_id → users CASCADE`、`name`、`token_hash UNIQUE`、`token_prefix`、`org_id?`（NULL=不限组织）、`project_id?`（需 org_id，复合 FK）、`scopes text[] ⊆ {publish, read_responses}` 非空、`expires_at?`、`last_used_at`（最多每分钟写一次）、`created_at`、`revoked_at?`。token 形如 `arp_` + 43 字符。

**audit_log** — `id bigint identity`、`org_id?`、`actor_user_id?`、`actor_pat_id?`、`action`、`target_type`、`target_id?`、`ip`、`meta jsonb`、`created_at`。**无外键**，删除组织/用户后记录保留。索引 `(org_id, id DESC)`、`(actor_user_id, id DESC)`。

## 4. 角色权限矩阵

### 4.1 有效项目角色

```
project_role(user, project) =
    'admin'  若 user 是 project.org 的 owner/admin
    否则 max( project_members.role,
              max(project_groups.role  where user ∈ group_members(group)) )
    无则 NULL
排序：admin > editor > viewer
```
一条 SQL 算出（authz.rs 内，带 org_id 条件）。

### 4.2 组织级（✓=允许，空=不允许）

| 操作 | owner | admin | member |
|---|:-:|:-:|:-:|
| 查看组织、成员列表、群组列表 | ✓ | ✓ | ✓ |
| 修改组织名称/slug | ✓ | ✓ | |
| 删除组织（软删） | ✓ | | |
| 邀请成员（role=member/admin） | ✓ | ✓（只能邀 member） | |
| 直接建账号（`POST .../members/accounts`，可同时加入项目/群组；不能建 owner） | ✓ | ✓（只能建 member） | |
| 重置管理员所建、尚未改密账号的一次性密码 | ✓ | ✓（仅 member） | |
| 修改成员角色 | ✓（任意，含设 owner） | ✓（仅 member↔admin，不能动 owner） | |
| 移除成员 | ✓ | ✓（不能移除 owner/admin） | |
| 退出组织 | ✓（不能是最后一个 owner） | ✓ | ✓ |
| 创建项目（创建者自动成为项目 admin；PAT 需 `manage` 且不限定项目） | ✓ | ✓ | ✓ |
| 创建/改/删组织级群组、管理其成员、发群组邀请 | ✓ | ✓ | |
| 创建项目群组（`POST /api/projects/{id}/groups`）、改/删项目群组及管理其成员 | ✓ | ✓ | 仅该项目的 admin |
| 查看审计日志 | ✓ | ✓ | |

不变量：组织至少一个 owner（降级/移除/退出最后一个 owner → 409 `last_owner`）。

### 4.3 项目级（按有效项目角色）

| 操作 | admin | editor | viewer |
|---|:-:|:-:|:-:|
| 查看项目、项目成员 | ✓ | ✓ | ✓ |
| 修改项目信息 / 删除项目（软删） | ✓ | | |
| 增删改项目成员（只能加本组织成员）、发项目邀请 | ✓ | | |
| 授权/取消组织级群组访问项目（项目群组不能授权给别的项目，本项目群组的授权不能单独取消） | ✓ | | |
| 新建本项目的项目群组（自动授权 viewer/editor，创建者入组）、管理其成员 | ✓ | | |
| 页面列表 | ✓ 全部 | ✓ 全部 | 按可见性过滤 |
| 发布 / 更新 / 删除页面（任意作者） | ✓ | ✓ | |
| 管理临时链接（创建/吊销） | ✓ | ✓ | |
| 查看提交结果（表格、SSE 实时） | ✓ | ✓ | 仅当 `results_visible_to=viewers` 且能查看页面 |
| 导出 CSV、长轮询拉取 | ✓ | ✓ | |
| 查看 / 提交页面 | 见 §5 | 见 §5 | 见 §5 |

「页面管理者」= 该页面所在项目的 admin/editor（含 org owner/admin）。

### 4.4 PAT

PAT 的有效权限 = **用户本人当前权限 ∩ PAT 限定范围 ∩ PAT scope**。用户权限实时计算（被降级则 PAT 立即降级）。

| scope | 允许的接口 |
|---|---|
| `publish` | `GET /api/orgs`、`GET /api/me/projects`、`GET /api/orgs/{id}/groups`、`GET /api/projects/{id}/groups`、`GET /api/pages`、`GET /api/pages/{id}`、`POST /api/pages`、`PATCH /api/pages/{id}`、`DELETE /api/pages/{id}`、`GET/POST /api/pages/{id}/share-links`、`DELETE /api/share-links/{id}`、任务树 `GET/POST /api/pages/{id}/tasks`、`PATCH /api/tasks/{id}`、`POST /api/tasks/{id}/review`、`GET /api/tasks/{id}/events` |
| `manage` | `GET /api/orgs`、`GET /api/me/projects`、`GET /api/orgs/{id}/groups`、`GET /api/projects/{id}/groups`、`POST /api/orgs/{id}/projects`（PAT 不能限定项目）、`POST /api/projects/{id}/groups`、`POST /api/orgs/{id}/groups`（角色要求不变）、`GET /api/pages`、`GET /api/pages/{id}` |
| `read_responses` | `GET /api/orgs`、`GET /api/me/projects`、`GET /api/pages`、`GET /api/pages/{id}`、`GET /api/pages/{id}/responses`、`GET /api/pages/{id}/responses.csv`、`GET /api/pages/{id}/tasks`、`GET /api/tasks/{id}/events` |
| 任何 scope 都不行 | 账号/会话、组织/项目/群组的修改删除、成员/邀请管理、PAT 管理、审计查询、提交（`POST .../responses`）、SSE |

限定范围：`org_id` 非空 → 只能触达该组织的资源；`project_id` 非空 → 只能触达该项目的页面（`/api/me/projects` 只返回该项目）。越界一律 404。PAT 请求不需要 CSRF；带 `Authorization` 头的请求**忽略 cookie**。

## 5. 鉴权分层与可见性判定

### 5.1 分层（防越权的核心）

1. **认证层**（`auth/` 中间件/extractor）：只回答「是谁」，产出
   `Principal = User{user_id, via: Session{session_id} | Pat{pat_id, org_id?, project_id?, scopes}} | Anonymous`。
   顺序：有 `Authorization: Bearer arp_…` → 只认 PAT（无效即 401，不回落到 cookie）；否则有会话 cookie → 会话（无效当匿名）；否则匿名。cookie 会话的非 GET/HEAD 请求在此层校验 CSRF（§6.2）。
2. **授权层**（`authz.rs`，唯一入口）：每个 handler 在做任何业务查询之前调用其一：
   - `require_org(&p, org_id, min_org_role) -> OrgCtx`
   - `require_project(&p, project_id, min_project_role) -> ProjectCtx`
   - `require_page_manage(&p, page_id) -> PageCtx`（admin/editor）
   - `page_access(&p, page_id, share: Option<ShareCreds>) -> PageAccess`（查看/提交，算法见 §5.3）
   - `require_scope(&p, Scope)`（PAT scope，session 恒通过）
   Ctx 结构体字段私有、只能在 authz.rs 内构造——**类型即证明**：拿不到 Ctx 就调不了数据访问函数。
3. **数据访问层**：所有查询函数第一个参数是 Ctx，SQL 一律 `WHERE org_id = $ctx.org_id AND …`；按 id 查子资源时同时带 org_id（以及 project_id/page_id）。即使上层漏了，查询也只会落在已授权的租户内。
4. **数据库层**：复合外键阻止跨租户关联写入（§3.0）。

不用 PostgreSQL RLS：连接池下要每事务 `SET LOCAL`，sqlx 易漏；以上 4 层足够，且 Ctx 类型约束能在编译期发现遗漏。

**统一 404**：资源不存在、已删除、跨租户、无权限查看，一律 `404 not_found`，不泄露存在性。只有「能看见但不能做」（例如 viewer 尝试删除页面）才返回 `403 forbidden`。

**集成测试硬性要求**：两个组织 A、B 各一套用户/项目/页面；对每个带 id 的端点，用 B 的 session 和 B 的 PAT 请求 A 的 id，断言 404。这份测试矩阵是后端验收条件。

### 5.2 角色辅助

```
org_role(user, org)        -> owner|admin|member|NULL
project_role(user, proj)   -> admin|editor|viewer|NULL   (§4.1)
is_manager(user, page)     = project_role(user, page.project) ∈ {admin, editor}
in_any_group(user, page)   = EXISTS page_groups pg JOIN group_members gm USING(group_id)
                             WHERE pg.page_id = page.id AND gm.user_id = user
```

### 5.3 访问页面 `page_access(principal, page_id, share)`

```
输入: principal, page_id 或 share_token, 可选 share_grant(密码解锁凭证), 可选 nickname
输出: PageAccess{ page, can_submit, block_reason, can_view_results, can_manage } 或错误

# --- 定位页面 ---
if 通过 share_token:
    link = SELECT share_links WHERE token_hash = sha256(token)          # 常数时间由 hash 等值查找保证
    if !link                          -> 404 not_found
    if link.revoked_at                -> 410 share_link_revoked
    if link.expires_at <= now()       -> 410 share_link_expired
    page = 加载 link.page_id（含 project、org 未删除）  否则 404
    if link.password_hash:
        if !verify_grant(share_grant, link.id)  -> 401 share_password_required
    via_share = true
else:
    page = SELECT pages p JOIN projects pr JOIN orgs o
           WHERE p.id = page_id AND 三者 deleted_at IS NULL     否则 404
    via_share = false

# --- PAT 约束（只适用于 principal 是 PAT；PAT 不能走 share 路径）---
if principal.via == Pat:
    if pat.org_id and pat.org_id != page.org_id          -> 404
    if pat.project_id and pat.project_id != page.project_id -> 404

user = principal.user_id 或 None
role = user ? project_role(user, page.project_id) : NULL
can_manage = role ∈ {admin, editor}

# --- 已关闭（closed_at 非空，api.md §7.7）---
if via_share and page.closed_at   -> 404 not_found                 # share_by_token 直接按不存在处理
if page.closed_at and !(role == admin or (page.created_by == user and can_manage))
                                  -> 404 not_found                 # 只有项目 admin 与仍是 editor 的发布者能看

# --- 查看判定 ---
if via_share:
    can_view = true                              # 临时链接绕过 visibility，仅限此页面
else if can_manage:
    can_view = true
else switch page.visibility:
    'public':  can_view = true                   # 持链接即可，含匿名
    'org':     can_view = user && org_role(user, page.org_id) != NULL
    'project': can_view = role != NULL           # 含经群组授权的 viewer
    'groups':  can_view = user && in_any_group(user, page)
if !can_view -> 404 not_found                    # 未登录访问非 public 页面：404 + 前端提示登录

# --- 提交判定（查看通过之后）---
block_reason = NULL
if page.closed_at                          -> block_reason = 'page_closed'   # 已关闭，提交返回 409 page_closed
elif category(page.page_type) == 'read'    -> block_reason = 'read_only'     # 只读类，提交返回 409 read_only_page
elif principal.via == Pat                  -> block_reason = 'not_allowed'   # PAT 不能提交
elif !page.accept_responses                -> 'responses_closed'
elif page.closes_at <= now()               -> 'closed'                      # 截止；提交返回 409 responses_closed（「已截止」）
elif via_share and link.max_uses and link.use_count >= link.max_uses
                                           -> 'share_link_exhausted'        # 仍可查看
elif !user and !nickname（仅在提交时检查）  -> 400 nickname_required
can_submit = block_reason == NULL

can_view_results = can_manage or page.results_visible_to == 'viewers'
```

**提交 `POST` 的完整检查顺序**（任一步失败即返回，不写库）：
1. 请求体 ≤ 64 KiB（超出 413），`Content-Type: application/json`（否则 415）。
2. 限流：IP 维度 30 次/分钟；页面维度 600 次/分钟（429 + `Retry-After`）。
3. 认证：cookie 会话则校验 CSRF；PAT → 403 `not_allowed`。
4. `page_access`（上面全部步骤）；`can_submit` 为假 → 409 并给出 `block_reason` 作为错误码（`read_only` 对应错误码 `read_only_page`，`closed` 对应 `responses_closed`）。
5. 校验 body：`data` 必须是 JSON object；未登录必须有 `nickname`（trim 后 1..50 字符，去控制字符）；已登录时 nickname 忽略。
6. 事务：§3.3 的 seq 分配 + 临时链接名额原子占用（0 行 → 回滚，409 `share_link_exhausted` 或 410）+ INSERT。
7. 提交后 `notify.send(page_id, seq)` 唤醒长轮询与 SSE。

### 5.4 结果读取

SSE（`/responses/stream`）：先按 §5.3 判定查看权限，再要求 `can_view_results`。长轮询 `GET /responses` 与 CSV：只允许页面管理者；PAT 还需 scope `read_responses`。经临时链接看实时结果：`results_visible_to=viewers` 时允许，走 share 路径的 SSE 端点。

任何提交记录响应都不含提交者 email 与 ip（ip 只存库供运维排查）。

### 5.5 超级管理员与账号禁用（api.md §15）

- **平台级角色**：`users.is_superadmin`，与组织角色独立，不经 `authz.rs` 的 Ctx（超管接口不属于任何租户），在 `routes/admin.rs` 的 `require_superadmin` 统一判定：只接受 cookie 会话（PAT 一律 403），再查 `users.is_superadmin`。超管**不**因此获得任何组织/项目/页面的访问权——要看某组织内容仍需是成员（可以在面板里把自己加进去，留审计）。
- **能做**：查看全站账号；建账号并分配到多个组织（各自组织角色，可选项目及角色、群组）；对已有账号增删组织/项目/群组分配、改角色（不改其密码）；禁用/启用；显式重置密码（一次性密码 + `must_change_password`）；建组织并指定所有者；授予/撤销其他人的超管。
- **不变量**：不能禁用自己；撤销或禁用后至少剩一个未禁用的超管（`FOR UPDATE` 锁全部超管行再计数）；组织分配沿用 owner 至少一个（`last_owner`）、项目/群组须先是组织成员、建账号时项目群组只能是所选项目的（与 `create_account` 共用 `orgs.rs Targets`）。
- **首个超管**：`SUPERADMIN_EMAILS` 环境变量，启动时幂等授予已注册账号（`lib.rs bootstrap_superadmins`）。先注册、再配变量重启。
- **禁用**：`users.disabled_at`。`auth.rs` 的 `load_session` / `load_pat` 都在原查询上 JOIN users 加 `disabled_at IS NULL`（按主键探测一行，无额外往返）；禁用时同事务删会话；登录在密码校验通过后才返回 `account_disabled`，不向猜密码的人暴露账号状态。PAT 不吊销，启用后未过期未吊销的自动恢复。

## 6. 会话、CSRF、限流、审计、PAGES_ORIGIN

### 6.1 会话

- 登录/注册成功：生成 32 字节 token，cookie 写明文，库存 `sha256`。同时生成 `csrf_token`。
- Cookie（名称为历史名称，为兼容保留）：`__Host-relay_session=<token>; Path=/; HttpOnly; Secure; SameSite=Lax`，Max-Age 30 天。`COOKIE_SECURE=false`（仅本地 http 开发）时改名 `relay_session` 且不带 Secure。
- 有效期 30 天滑动：请求时若 `last_seen_at` 距今 > 1 小时则 `UPDATE last_seen_at, expires_at = now()+30d`（降低写放大）。
- 登出删除本会话；改密码/重置密码删除该用户其它所有会话；管理员重置一次性密码删除该用户全部会话。
- `users.must_change_password = true` 的会话（管理员建的账号）在 `auth.rs` 统一入口只放行 `GET /auth/me`、`POST /auth/password/change`、`POST /auth/logout`，其它返回 `403 password_change_required`。
- 每小时后台任务删除过期 sessions、email_tokens。
- 登录失败统一返回 `401 invalid_credentials`（不区分邮箱不存在/密码错），邮箱不存在时也跑一次 argon2 校验假哈希以抹平时延。

### 6.2 CSRF

- 同步令牌：`csrf_token` 存会话行，经 `GET /api/auth/me`、登录、注册的响应体下发；前端放内存，所有 cookie 会话的非 GET/HEAD/OPTIONS 请求带 `X-CSRF-Token`，服务端常数时间比对，不符 → `403 csrf_failed`。
- 额外：若请求带 `Origin` 头，必须等于 `PUBLIC_URL` 的 origin，否则 403。
- 写接口只接受 `application/json`（表单提交跨站打不进来）。
- 无会话的匿名请求（临时链接匿名提交、登录、注册、忘记密码）不需要 CSRF token，但仍检查 Origin。
- GET 请求严格无副作用（邀请接受、邮箱验证都是 POST，SPA 页面加载后再 POST）。

### 6.3 限流（进程内固定窗口，`ratelimit.rs`）

| 键 | 限额 | 超限 |
|---|---|---|
| 登录：IP | 20 / 分钟 | 429 |
| 登录：邮箱 | 失败 10 次 / 15 分钟后锁 15 分钟（成功清零） | 429 |
| 注册：IP | 5 / 小时 | 429 |
| 忘记密码、重发验证邮件：IP | 5 / 小时；同邮箱 3 / 小时 | 静默成功（204，防枚举） |
| 临时链接解锁密码：(link, IP) | 10 / 15 分钟 | 429 |
| 提交：IP | 30 / 分钟 | 429 |
| 提交：页面 | 600 / 分钟 | 429 |
| 接受邀请：IP | 30 / 小时 | 429 |
| 管理员建账号 + 重置一次性密码：操作者 | 30 / 小时 | 429 |
| 其它已认证 API：用户/PAT | 600 / 分钟 | 429 |

客户端 IP：`TRUST_PROXY=1` 时取 `X-Forwarded-For` 最右一个由 Caddy 追加的地址（Caddy 已设置为只信任自身），否则 socket 地址。429 带 `Retry-After` 秒数。

请求体上限：默认 64 KiB；`POST /api/pages`、`PATCH /api/pages/{id}` 为 6 MiB（axum `DefaultBodyLimit` 按路由设置）。长轮询 `wait ≤ 25s`，SSE 心跳 20s。

### 6.4 审计

同事务写 `audit_log`，`action` 取值固定：

```
auth.register  auth.password_change  auth.password_reset
org.create  org.update  org.delete
member.role_change  member.remove  member.leave  member.account_create(meta: role/projects/group_ids/password=generated|manual)  member.password_reset
project.create  project.update  project.delete
project_member.add  project_member.role_change  project_member.remove
project_group.grant  project_group.revoke
group.create  group.update  group.delete  group_member.add  group_member.remove
invite.create  invite.revoke  invite.accept
page.publish  page.update(meta 含变更字段，visibility/groups 变更时记录旧→新)  page.delete  page.close  page.reopen
share_link.create  share_link.revoke
pat.create  pat.revoke
admin.user_create  admin.user_update  admin.user_disable(meta: sessions_revoked)  admin.user_enable  admin.superadmin_grant  admin.superadmin_revoke
admin.password_reset(meta: password=generated|manual)  admin.member_set(meta: old/new)  admin.member_remove  admin.project_member_set  admin.project_member_remove
admin.group_member_add  admin.group_member_remove  admin.org_create(meta: owner_user_id/owner_created)
```
`meta` 只记录 id、角色、字段名与旧新值；**不记录** token、密码、页面内容、提交数据。

### 6.5 html 页面与 PAGES_ORIGIN

威胁：agent 产出的 HTML 含任意脚本，不能和应用同源执行（否则可读 CSRF token、以查看者身份调 API）。

方案（两层，任一层都足以隔离）：
1. **独立源**：`PAGES_ORIGIN=https://pages.example.com`（同一二进制按 Host 头分流，该主机名下只开放 `GET /h/*`，其它一律 404）。
2. **sandbox**：外壳页 `<iframe sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" src=frame_url>`（无 `allow-same-origin` → 不透明源，无 cookie/storage）；同时 `/h/*` 响应头 `Content-Security-Policy: sandbox allow-scripts allow-forms; frame-ancestors <PUBLIC_URL>`，即使被直接顶层打开也处于沙箱中。

取内容：查看者调用 `GET /api/pages/{id}/view`（或 share 版）通过权限检查后，服务端签发
`frame_url = {PAGES_ORIGIN}/h/{page_id}/{version}?exp={unix}&sig={b64url(HMAC-SHA256(SECRET_KEY, "h|{page_id}|{version}|{exp}"))}`，有效期 10 分钟。`/h/*` 只验签，不看 cookie。版本号进 URL，`Cache-Control: private, max-age=600`。

服务端给 HTML 注入桥接脚本（在 `</body>` 前，兼容原型）：`window.kanban.submit(data)` 与 `<form data-kanban>` 自动接管（`window.relay` / `data-relay` 为历史名称，为兼容旧页面保留），经 postMessage 交给外壳页提交（协议见 api.md §9）。外壳页校验 `event.source === iframe.contentWindow`，用自身的 cookie/share 凭证代为调用提交接口。外壳页在 iframe 上方显示固定提示条「以下内容由 agent 生成」，降低钓鱼风险。

未配置 `PAGES_ORIGIN`（本地开发）时退化为同源 `/h/*`，仅靠 sandbox + CSP sandbox 隔离，启动日志打印 WARN。

**主应用安全头**：
```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' https: data:; font-src 'self' data:; connect-src 'self';
  frame-src <PAGES_ORIGIN 或 'self'>; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
Referrer-Policy: no-referrer          # /s/{token}、/invite/{token} 的 token 不能经 Referer 泄露
X-Content-Type-Options: nosniff
Strict-Transport-Security 由 Caddy 加
```
`/api/*` 响应一律 `Cache-Control: no-store`。

### 6.6 临时链接密码

`POST /api/s/{token}/unlock {password}` 校验 argon2id 后返回 `share_grant = b64url("{link_id}.{exp}") + "." + b64url(HMAC(SECRET_KEY, "g|{link_id}|{exp}"))`，有效 12 小时；前端存 sessionStorage，之后用 `X-Share-Grant` 头（SSE 用 `?grant=` 查询参数）。吊销链接即令所有 grant 失效（每次都会查 link 状态）。

## 7. 其它机制

### 7.1 长轮询与 SSE

`notify.rs`：`Mutex<HashMap<page_id, broadcast::Sender<i64>>>`，提交成功后 `send(seq)`；无订阅者时移除条目。
- 长轮询：先查 `seq > since`，有则立即返回；否则订阅后**再查一次**（防止订阅前后丢通知），再循环等到 deadline：收到 `Response`（或广播滞后 Lagged）时查库，有数据即返回；`Page` 等其它事件不查库、继续等，不会提前返回空结果；页面删除或超时返回当前结果。
- SSE：先补发 `seq > since`（或 `Last-Event-ID`），再持续推送；每条事件一次按 seq 范围查库，保证顺序与不丢。

### 7.2 邮件

`SMTP_URL`（如 `smtps://user:pass@smtp.example.com:465`）+ `SMTP_FROM`。未配置时，邮件正文（含链接）以 `INFO mail.dev to=… subject=… body=…` 打到日志。发信失败不影响主流程（记 WARN）。邮件类型：验证邮箱、重置密码、邀请（invite 带 email 时）。

### 7.3 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | 必填 | `postgres://…` |
| `PUBLIC_URL` | 必填 | `https://relay.example.com`，拼链接、校验 Origin |
| `PAGES_ORIGIN` | 空 | html 页面独立源；生产必配 |
| `SECRET_KEY` | 必填 | ≥ 32 字节随机（hex/base64），HMAC 签 frame_url 与 share_grant；轮换会使未过期的签名失效（可接受） |
| `BIND` | `0.0.0.0:8080` | 监听 |
| `TRUST_PROXY` | `0` | 在 Caddy 后面设 `1` |
| `COOKIE_SECURE` | `1` | 仅本地 http 开发设 `0` |
| `ALLOW_SIGNUP` | `1` | `0` 时只能凭邀请链接注册 |
| `SUPERADMIN_EMAILS` | 空 | 逗号分隔的邮箱；每次启动把其中已注册的账号设为超级管理员（幂等，只授予不撤销，见 §5.5） |
| `SMTP_URL` / `SMTP_FROM` | 空 | 见 §7.2 |
| `RUST_LOG` | `info` | tracing 日志级别 |

### 7.4 前端（web/）

路由：`/login` `/register` `/verify-email?token=` `/forgot-password` `/reset-password?token=` `/invite/:token` `/` (我的组织) `/o/:orgSlug`（项目、群组、成员、邀请、审计 tabs）`/o/:orgSlug/p/:projectSlug`（页面列表、成员、项目群组）`/pages/:id`（查看/提交）`/pages/:id/results`（表格 + CSV + 实时）`/pages/:id/links`（临时链接）`/s/:token`（临时链接查看/提交）`/settings/tokens`（PAT）`/settings/account`。

- 管理界面与 OpenUI 渲染共用 shadcn/ui 组件（`web/src/components/ui`）与同一套主题 token（`web/src/theme.css`），不再引入其它 UI 库；配色、字体、阴影、动效与组件状态以 [design-system.md](design-system.md) 为准。
- 查看 openui 页面：`<Renderer response={spec} library={kanbanLibrary} onAction={…} toolProvider={null} publishObservability={false} />`，onAction 规则见 api.md §10。
- 结果页：表格列 = 元信息 + `data` 扁平化（规则同 CSV）；对取值是字符串/字符串数组且不同取值 ≤ 20 的字段显示计数条（投票实时统计）。

### 7.5 部署

- `Dockerfile` 三阶段：`node:22-alpine` 构建 web（`OPENUI_TELEMETRY_DISABLED=1 npm ci && npm run build`）→ `rust:1-alpine` 构建 server（rust-embed 嵌入 `web/dist`，`SQLX_OFFLINE=true` 用提交到仓库的 `.sqlx/`）→ `alpine` 运行（非 root，仅一个二进制）。
- `docker-compose.yml`：`mcp-server`（容器名 team-kanban-mcp-server，端口只绑 127.0.0.1:8080）+ `pg`（postgres:17-alpine，命名卷，健康检查）；app 启动时自动跑迁移。
- 外网：Caddy 反代两个主机名到同一 app：
  ```
  relay.example.com { reverse_proxy 127.0.0.1:8080 }
  pages.example.com { reverse_proxy 127.0.0.1:8080 }
  ```
  SSE/长轮询无需特殊配置（Caddy 默认流式转发）。
- 本地开发（容器名为历史名称，为兼容保留）：`docker run -d --name agent-relay-pg -e POSTGRES_PASSWORD=dev -p 127.0.0.1:55432:5432 postgres:17-alpine`；`DATABASE_URL=postgres://postgres:dev@127.0.0.1:55432/postgres`；`COOKIE_SECURE=0`；web 用 `vite dev` 代理 `/api` `/openui` `/h` 到 8080。

## 8. MCP

### 8.1 配置（多服务器 profile）
本机二进制 `tkanban`（`mcp/`）：`tkanban add/list/remove/default/targets/test` 管理 profile，`tkanban mcp`（或不带子命令，兼容旧注册）启动 stdio MCP。服务端镜像里的二进制叫 `relay`（历史名称，为兼容保留），跑在容器里，两者无关。
- 配置文件 `$XDG_CONFIG_HOME/team-kanban/config.toml`（缺省 `~/.config/team-kanban/config.toml`），文件 0600、目录 0700，原子写（临时文件 + rename）；新路径不存在而旧路径 `agent-relay/config.toml`（历史名称）存在时，读取旧文件写到新路径。格式：顶层 `default = "<名称>"`（只由 `--default` / `tkanban default` 写入），`[profiles.<名称>]` 下 `url`、`token`、可选 `org`、`project`、`groups = [...]`。
- 兼容：进程有 `TEAM_KANBAN_URL`（+`TEAM_KANBAN_TOKEN`）时追加隐式 profile `env`；`env` 为保留名。
- MCP 每次工具调用都重新读配置，`tkanban add` 后无需重启 agent。
- `tkanban add` 联网校验 token（`GET /api/me/projects` + 各组织 `GET /api/orgs/{id}/groups`）并列出可发布目标，失败不保存；token 可交互输入（`stty -echo` 关回显）或从 stdin 读，避免进 shell 历史。
- 目标解析（详见 api.md §14.0）：服务器 → 组织 → 项目逐级；用户指定的、profile 默认的 org/project/groups 视为已指定；唯一候选自动用；多个候选返回 `need_selection` 让 agent 询问用户，不猜。默认服务器只在用户显式设置过时生效。page_id 不在本地映射服务器，由 `publish_page` 出参的 `server` 带到后续调用。
- 可发布目标复用现有 PAT 可调的 `/api/me/projects`（已按 PAT 范围裁剪、只含有项目角色的项目）与 `/api/orgs/{id}/groups`（需 publish scope、范围外 404），服务端不为此新增端点。
- 工具清单与入出参见 api.md §14。

### 8.2 get_ui_guide 内容
= 服务端 `/openui/prompt.md`（OpenUI 官方库提示词，含组件签名与示例）+ 本项目规则：
- 根组件必须是 `root = Stack([...])`；不要使用 `Query()`/`Mutation()`（页面没有数据源，会报错）；不要编造图片 URL。
- **每个 `@ToAssistant("…")` 按钮点击 = 一次提交**，提交内容是按钮文字 + 所在 Form 的字段值；一个 Form 只放一个提交按钮，不要放「取消」按钮。
- 表单字段用稳定的英文 `name`，agent 拿回的 `data.values` 以它为键。
- 外部用户不在项目里：发布后用 `create_share_link` 生成临时链接发出去，或 `visibility=public`。
- html 兜底：自包含 HTML，`<form data-kanban>` 或 `kanban.submit({...})` 提交；页面在沙箱 iframe 中，不能用 cookie/localStorage/弹窗。
- 页面类型：report / knowledge / flowchart / architecture 是只读页面，不放 Form 或 `@ToAssistant`；knowledge 用 `MarkDownRenderer` 的 `##`/`###` 分节（前端自动生成目录）；flowchart / architecture 用 `Diagram` 写 Mermaid。

### 8.3 本地校验
`publish_page`/`update_page` 在 kind=openui 时：按服务器 URL 分别拉取并缓存（进程生命周期，ETag 刷新）`/openui/library.schema.json`；`createParser(schema, "Stack").parse(spec)`；以下任一视为失败，**不调用服务端**，以 `isError: true` 返回错误列表给 agent：`result.root == null`、`meta.errors.length > 0`、`meta.incomplete`、`meta.unresolved.length > 0`。`meta.orphaned` 作为 warning 随成功结果返回。只读类 page_type 的 spec 含 `@ToAssistant` 或 `Form(` → `page_type_mismatch`，同样不调用服务端。

### 8.4 页面类型的前端呈现
- 只读类：不显示昵称栏、「已停止接受提交」提示与「查看结果」按钮；OpenUI 里会触发提交的按钮（`@ToAssistant` 或缺省动作）不渲染，Form 字段禁用；html 页 `relay:init` 带 `can_submit:false`。
- `Diagram(code, caption?)`：`diagram.tsx` 只放 schema，`diagram-impl.tsx` 用 `import("mermaid")` 懒加载（npm 精确版本，Vite 打包自托管，满足 `script-src 'self'`）；`securityLevel:'strict'`、`htmlLabels:false`、`startOnLoad:false`；陶土 token 映射到 themeVariables，切换暗色时重新渲染；语法错误就地显示错误与源码；带「放大查看」对话框。
- knowledge：从正文 Markdown 的 h2/h3 生成目录，xl 起左侧 240px sticky。
- api_doc（`pages/apidoc-view.tsx`，单独 chunk）：≥1100 左侧 232px sticky 接口目录（分组、method 色块、搜索过滤），窄屏收进折叠块；每个接口一张卡，≥1400 左右两栏（说明 / 参数表 / 请求体 / 响应 / 错误码 | 代码样例、请求体示例、响应示例，右栏 sticky）；环境切换、语言切换（localStorage `tk.apidoc.lang`）。代码由 `src/apidoc.ts` 的纯函数按结构生成（curl / PHP / JS / TS / Go / Rust / Python / Java），字符串经各语言转义；description 用 react-markdown（不渲染原始 HTML），其余按纯文本；不发请求。
- 项目页列表：筛选 chips「全部 / 只读 / 收集 / 各类型」，展开成 `?page_type=`；每行显示类型图标与中文名；只读类不显示提交数、结果按钮和提交开关。

## 9. 有意的简化与天花板

| 简化 | 天花板 | 升级路径 |
|---|---|---|
| 限流、长轮询通知都在进程内 | 只能单实例；重启限流清零 | 多实例时通知换 PG `LISTEN/NOTIFY`，限流换 PG/Redis |
| 长轮询/SSE 每次唤醒查库 | 单页面数千并发 SSE 时库压力大 | 广播里带上记录本身 |
| 提交按页面行锁分配 seq | 单页面提交约数百 TPS | 足够；真不够再用 sequence + 重排 |
| 软删除不清理 | 数据只增 | 需要时加定期清理任务 |
| frame_url 不绑定查看者 | 拿到 URL 的人 10 分钟内可看 html 原文 | 与「能看页面」等价，可接受 |

## 10. 分阶段实现顺序

后端、前端、MCP 三条线在 P0 之后并行，接口以 api.md 为准，改契约必须先改文档。

| 阶段 | 负责 | 内容 | 验收 |
|---|---|---|---|
| P0 | 架构 | design.md、api.md、0001_init.sql | 本文档；SQL 已实测 |
| P1 | 后端 | 骨架：config、sqlx 池 + 自动迁移、错误类型（api.md §2）、认证（注册/登录/登出/me/验证邮箱/改密/重置）、会话 cookie、CSRF、限流、SPA 托管、安全头 | 集成测试：注册登录、CSRF 拒绝、限流 429 |
| P2 | 后端 | authz.rs；组织/成员/项目/项目成员/群组/群组成员/项目群组授权/邀请；审计 | **跨租户 404 测试矩阵**、最后一个 owner 保护 |
| P3 | 后端 | 页面 CRUD、可见性、view 端点、PAGES_ORIGIN + 签名、桥接脚本注入、临时链接 + 密码、提交、长轮询、SSE、CSV | 可见性四种 × 角色 × 匿名的判定测试；share 名额并发测试 |
| P4 | 后端 | PAT 创建/吊销、Bearer 认证、scope/范围限制、`/api/me/projects` | PAT 越界 404、scope 不足 403 |
| P1–P4 并行 | 前端 | 按 api.md 用 mock 先做页面；gen-openui 脚本；Renderer 查看/提交；postMessage 外壳；结果页 SSE | 对接真实后端的冒烟 |
| P1–P4 并行 | MCP | 7 个工具、本地校验、PAT 鉴权、错误透传 | 对真实后端的 stdio 冒烟（发布→匿名提交→get_responses） |
| P5 | 全员 | Dockerfile、compose、Caddyfile 示例、README；删除 server.js/test.js；端到端冒烟 | compose 起来跑完整流程 |
