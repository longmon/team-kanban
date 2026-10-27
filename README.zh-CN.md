# Team Kanban

[English](README.md) | 简体中文

让本机的 AI agent 把可交互页面发布到共享服务器，团队成员（或拿到临时链接的外部访客）在浏览器里查看、提交，agent 再通过 MCP 取回结果。

线上示例：<https://dash.tkanban.com>

## 目录

- [1. 概览](#1-概览)
- [2. 架构](#2-架构)
  - [2.1 架构图](#21-架构图)
  - [2.2 目录与关键文件](#22-目录与关键文件)
  - [2.3 一次发布到回传](#23-一次发布到回传)
  - [2.4 技术栈](#24-技术栈)
  - [2.5 安全要点](#25-安全要点)
- [3. 使用](#3-使用)
  - [3.1 安装 tkanban](#31-安装-tkanban)
  - [3.2 连接服务器](#32-连接服务器)
  - [3.3 注册到 MCP 客户端](#33-注册到-mcp-客户端)
  - [3.4 配置文件](#34-配置文件)
  - [3.5 MCP 工具](#35-mcp-工具)
  - [3.6 目标选择规则](#36-目标选择规则)
  - [3.7 在对话里怎么说](#37-在对话里怎么说)
  - [3.8 命令行速查](#38-命令行速查)
- [4. 部署 / 自托管](#4-部署--自托管)
  - [4.1 本地快速体验（Docker）](#41-本地快速体验docker)
  - [4.2 使用外部 PostgreSQL](#42-使用外部-postgresql)
  - [4.3 从源码本地开发](#43-从源码本地开发)
  - [4.4 生产部署](#44-生产部署)
  - [4.5 环境变量](#45-环境变量)
- [5. 测试](#5-测试)
- [6. 发布 tkanban](#6-发布-tkanban)
- [7. 常见问题](#7-常见问题)
- [8. 许可证](#8-许可证)

## 1. 概览

本机的 agent（Claude Code / Codex 等任意 MCP 客户端）把生成的页面——投票、表单、问卷、报告、知识库、流程图、架构图——发布到远程的 Team Kanban 服务器；组织成员或拿到临时链接的外部用户在浏览器里查看、填写并提交。agent 通过 MCP 取回提交，网页上也能实时看结果、导出 CSV。

```
本机 agent ──stdio──> tkanban mcp（Rust，mcp/） ──HTTPS + PAT──> Team Kanban 服务（Rust + PostgreSQL） <──浏览器── 成员 / 外部用户
```

- **多租户**：组织 → 项目 → 页面；组织成员、项目角色（admin / editor / viewer）、群组、邀请链接。
- **两种页面**：**OpenUI**（agent 写 OpenUI Lang，前端用官方组件渲染，推荐）和 **html**（自包含 HTML，放在独立源的沙箱 iframe 里）。
- **页面类型（`page_type`）**：
  - 只读：报告 `report`、知识库 `knowledge`（自动目录）、流程图 `flowchart`、架构图 `architecture`（Mermaid 渲染）。不收提交，agent 不等回复。
  - 收集回复：投票 `vote`（投票 / 表单 / 问卷），agent 用 `get_responses` 等待。
  - agent 按需求选类型，你指定了就照用；旧页面都是通用 `general`，行为不变。
- **可见性**：`public` / `org` / `project` / `groups`；对外用带有效期、次数上限、可选密码的临时链接。
- **生成模型**：发布页面的 agent 上报自己的模型名（MCP 的 `publish_page` 必填），页面显示「由 {model} 生成」；未上报的页面不显示。
- **agent 访问**用个人访问令牌（PAT），scope：`publish`、`read_responses`。

## 2. 架构

### 2.1 架构图

```
 本机                                             服务器（一个 docker compose）
┌──────────────┐ stdio ┌──────────────┐ HTTPS + PAT ┌────────┐     ┌──────────────────────────────┐
│ agent        ├──────►│ tkanban mcp  ├────────────►│        │     │ app：relay（Rust 单二进制）    │
│ Claude Code /│       │（mcp/，本机）│  /api/*     │ caddy  │     │  axum 0.8 + tokio             │
│ Codex        │◄──────┤ QuickJS 本地 │◄── 长轮询 ──┤ 80/443 ├────►│  /api/*    JSON API           │
└──────────────┘       │ 校验 OpenUI  │             │ 反代   │     │  /openui/* 组件 schema/提示词 │
                       └──────────────┘             │        │     │  /*        React SPA          │
 浏览器（成员 / 外部用户）                          │        │     │   （rust-embed 嵌入 web/dist）│
┌──────────────┐ HTTPS  cookie / 临时链接 token     │        │     │  PAGES_HOST 下只开放 /h/*     │
│ 主站页面     ├───────────────────────────────────►│        │     │  进程内：限流、长轮询/SSE 通知│
│  └ iframe    ├── PAGES_HOST（html 页面，沙箱）───►│        │     └──────────────┬───────────────┘
└──────────────┘◄── SSE 实时结果                    └────────┘                    │ sqlx
                                                                      ┌──────────▼──────────┐
                                                                      │ pg：PostgreSQL 17   │
                                                                      └─────────────────────┘
```

### 2.2 目录与关键文件

| 目录 | 内容 |
|---|---|
| `server/` | 后端：axum + sqlx + PostgreSQL，前端产物经 rust-embed 打进同一个二进制 |
| `web/` | 前端：React + Tailwind + shadcn/ui；OpenUI 组件库 kanbanLibrary（`web/src/openui-lib`），视觉规范见 [design-system.md](docs/design-system.md) |
| `mcp/` | 本机 stdio MCP，Rust 单二进制 `tkanban`，内嵌 QuickJS 做 OpenUI 本地校验，见 [mcp/README.md](mcp/README.md) |
| `docs/` | [design.md](docs/design.md) 设计、[api.md](docs/api.md) 接口契约（服务端、前端、MCP 三方以它为准） |
| `scripts/` | `deploy.sh`（一键部署）、`cf-firewall.sh`（防火墙 + Caddy 信任段）、`e2e.sh`（端到端联调） |

关键文件：

```
server/                 后端（crate/二进制名 relay，历史名称，为兼容保留）
  migrations/           sqlx 迁移（0001_init、0002_page_types、0003_page_model），服务启动时自动执行
  src/main.rs           读环境变量 → 连库 → 跑迁移 → 起后台清理任务 → 监听
  src/lib.rs            路由装配、host_guard（按 Host 分流 + CSP 等安全头）、后台清理
  src/routes/           account orgs groups invites tokens pages responses statics（/h/*、/openui/*、SPA 回落）
  src/auth.rs authz.rs  鉴权（会话 cookie / PAT / 临时链接）与权限判断唯一入口
  src/notify.rs         进程内 page_id → broadcast，唤醒长轮询与 SSE
  src/ratelimit.rs mail.rs audit.rs config.rs
  Dockerfile            三阶段：node 构建 web → rust 构建 server（嵌入 web/dist）→ alpine 运行
  tests/                集成测试（需要 PG）
web/                    React 19 + Vite + TypeScript + Tailwind 4 + shadcn/ui（src/components/ui）
  src/pages/            登录、组织/项目、令牌、页面查看、结果、临时链接等页面
  src/openui-lib/       自定义 OpenUI 组件库 kanbanLibrary（@openuidev/react-lang 1.0.1，渲染用 shadcn/ui）
  scripts/gen-openui.ts 构建后导出 kanbanLibrary 的 JSON Schema 与提示词到 dist/openui/
  e2e/e2e.mjs           浏览器端到端测试
mcp/                    本机 tkanban 二进制：多服务器 profile 命令行 + stdio MCP（rmcp）
  src/                  main.rs cli.rs config.rs openui.rs
  vendor/lang-core.js   打包好的 @openuidev/lang-core，由 rquickjs 内嵌执行做本地校验
docs/                   design.md、api.md、design-system.md
docker-compose.yml      pg / app / caddy 三个服务
Caddyfile               两个主机名反代到 127.0.0.1:8080，只信任 Cloudflare 段的真实 IP
```

### 2.3 一次发布到回传

1. agent 调 `get_ui_guide`（MCP 从服务端 `/openui/prompt.md`、`/openui/library.schema.json` 拉取并缓存），写出 OpenUI Lang。
2. `publish_page`：`tkanban mcp` 用内嵌 QuickJS 按同一份 schema 本地校验，通过后带 PAT 调 `POST /api/pages`，返回页面地址；需要给组织外的人填时再 `create_share_link`。
3. 用户在浏览器打开页面：OpenUI 页由 kanbanLibrary 渲染；html 页放在 `PAGES_ORIGIN` 的沙箱 iframe 里，经 postMessage 交给外壳页代提交。提交写入 PostgreSQL，并通过进程内通知中心唤醒等待者。
4. 只读类页面（报告 / 知识库 / 流程图 / 架构图）到此结束，agent 把链接交给你即可。收集类（投票 / 表单）由 agent 调 `get_responses`（带 `since`、`wait_seconds`，服务端最多挂 25 秒）长轮询 `GET /api/pages/{id}/responses`，有新提交立即返回；网页结果页走 SSE 实时刷新，可导出 CSV。

### 2.4 技术栈

| 部分 | 技术 |
|---|---|
| 后端 | Rust、axum 0.8、tokio、sqlx 0.8（postgres + migrate）、rust-embed 8 |
| 数据库 | PostgreSQL 17（`postgres:17-alpine`） |
| 前端 | React 19、Vite、TypeScript、Tailwind CSS 4、shadcn/ui；OpenUI 组件库 kanbanLibrary 在 `web/src/openui-lib` |
| 本机 MCP | Rust、rmcp、rquickjs（QuickJS）、reqwest（rustls） |
| 部署 | docker compose、Caddy 2（Let's Encrypt）、Cloudflare 代理、firewalld |

### 2.5 安全要点

- **双源隔离**：html 页面放在独立主机名 `PAGES_ORIGIN`，两个主机名按 Host 严格分流——页面源下只开放 `/h/*`，主站下不开放 `/h/*`；iframe 沙箱无 `allow-same-origin`，`frame_url` 带签名和有效期。
- **CSP**：主站响应带 `default-src 'self'; script-src 'self'; font-src 'self' data:; frame-ancestors 'none'` 等，字体自托管，不能用外部 CDN（见 [design-system.md](docs/design-system.md)）。
- **鉴权**：网页用会话 cookie + Origin/CSRF 校验；agent 用 PAT（scope `publish` / `read_responses`，可限定组织或项目）；外部用户用临时链接（有效期、次数上限、可选密码）。
- **多租户**：组织 → 项目 → 页面，项目角色 admin / editor / viewer，群组授权；权限判断统一走 `authz.rs`。
- **单实例**：限流和长轮询唤醒都在进程内，不要横向扩容。

细节见 [docs/design.md](docs/design.md)（架构、数据模型、权限矩阵）、[docs/api.md](docs/api.md)（接口契约、MCP 工具）、[docs/design-system.md](docs/design-system.md)（视觉规范）。

## 3. 使用

本机只需要一个二进制 `tkanban`（`mcp/`，Rust 单文件，不需要 Node / OpenSSL）：既是管理多服务器配置的命令行，也是 stdio MCP 服务器（`tkanban mcp`）。

> 服务端 Docker 镜像里的二进制叫 `relay`（历史名称，为兼容保留），跑在服务器上；`tkanban` 跑在你自己的电脑上，两者无关。

### 3.1 安装 tkanban

**预编译二进制**：到 [GitHub Releases](https://github.com/longmon/team-kanban/releases) 下载对应平台的压缩包，解压后把 `tkanban` 放进 `PATH`：

| 平台 | Target |
|---|---|
| Linux x86_64（静态链接，任意发行版） | `x86_64-unknown-linux-musl` |
| Linux arm64（静态链接，任意发行版） | `aarch64-unknown-linux-musl` |
| macOS Apple 芯片（M 系列） | `aarch64-apple-darwin` |
| macOS Intel | `x86_64-apple-darwin` |
| Windows x86_64 | `x86_64-pc-windows-msvc`（`.zip`） |

文件名为 `tkanban-<标签>-<target>.tar.gz`（Windows 为 `.zip`），同时附 `SHA256SUMS.txt`。例：

```bash
curl -L https://github.com/longmon/team-kanban/releases/latest/download/tkanban-v2.1.0-x86_64-unknown-linux-musl.tar.gz | tar xz
# macOS 首次运行被拦时：
xattr -d com.apple.quarantine tkanban
```

**从源码装**（需要 Rust 1.89+ 和 C 编译器；装到 `~/.cargo/bin/tkanban`）：

```bash
cargo install --git https://github.com/longmon/team-kanban team-kanban
# 或在本仓库里自己编译：
cd mcp && cargo build --release && sudo install -m 0755 target/release/tkanban /usr/local/bin/tkanban
```

`tkanban --help` 查看内置帮助（中文）。

### 3.2 连接服务器

先在网页「令牌」页（`/settings/tokens`）创建令牌：发布需要 scope `publish`，读提交需要 `read_responses`；可以限定到某个组织或项目。令牌只显示一次。

```bash
# 添加服务器（profile）：联网校验 token，并列出它能发布的组织 / 项目 / 群组；校验失败不保存。
# 不写 --token 时交互输入（不回显），避免 token 留在 shell 历史。
tkanban add depx --url https://dash.tkanban.com --default

# 从 stdin 读 token，并给这个服务器配默认发布目标（视为「已指定」）
printf '%s\n' "$ANOTHER_PAT" | tkanban add another --url https://relay.example.com \
  --org acme --project demo --group 设计组 --group 运营组

tkanban test                       # 测试连通性与 token
```

默认服务器只有显式设置过才生效（上面的 `--default`，或 `tkanban default <名称>`）。

### 3.3 注册到 MCP 客户端

不需要再传 `TEAM_KANBAN_URL` / `TEAM_KANBAN_TOKEN`，服务器来自配置文件。

**Claude Code**（`-s user` 全局生效）：

```bash
claude mcp add team-kanban -s user -- "$(command -v tkanban)" mcp
```

**Codex**，执行：

```bash
codex mcp add team-kanban -- tkanban mcp
```

或直接编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.team-kanban]
command = "tkanban"          # 或绝对路径 /usr/local/bin/tkanban
args = ["mcp"]
tool_timeout_sec = 60        # get_responses 长轮询最长 25 秒，留足余量
```

**其他 MCP 客户端**：注册一个 stdio 服务器，命令 `tkanban`（建议写绝对路径），参数 `mcp`。不带子命令运行 `tkanban` 同样启动 MCP。工具超时请设在 25 秒以上。

### 3.4 配置文件

`$XDG_CONFIG_HOME/team-kanban/config.toml`（缺省 `~/.config/team-kanban/config.toml`），文件 0600、目录 0700，由 `tkanban add/remove/default` 维护，也可手改。旧路径 `agent-relay/config.toml`（历史名称）存在而新路径不存在时，首次运行会自动迁移到新路径。

```toml
default = "depx"

[profiles.depx]
url = "https://dash.tkanban.com"
token = "arp_xxxx…"          # 令牌前缀 arp_ 为历史名称

[profiles.another]
url = "https://relay.example.com"
token = "arp_yyyy…"
org = "acme"
project = "demo"
groups = ["设计组", "运营组"]
```

兼容旧方式：MCP 进程有环境变量 `TEAM_KANBAN_URL`（+ `TEAM_KANBAN_TOKEN`）时，视为一个名为 `env` 的服务器，和配置文件里的服务器一起参与选择。改用配置文件后，请把注册命令里的 `-e TEAM_KANBAN_URL… -e TEAM_KANBAN_TOKEN…` 去掉，否则会多出一个 `env` 候选。HTTP 请求遵循标准的 `HTTPS_PROXY` / `NO_PROXY` 环境变量。

### 3.5 MCP 工具

| 工具 | 作用 |
|---|---|
| `get_ui_guide` | OpenUI 写法（先调它）：服务端提示词 + 已通过校验的示例 + html 兜底说明 |
| `list_targets` | 列出服务器及每个服务器上可发布的组织 / 项目 / 群组 |
| `list_projects` | 列出你所在的项目 |
| `publish_page` | 发布页面。必填 `page_type` 和 `model`（agent 自己的模型名称，如 `Claude Opus 5.5`）；`kind=openui` 本地校验通过才上传 |
| `update_page` | 更新页面内容；可选 `model`，给了就覆盖记录的生成模型 |
| `create_share_link` | 给组织外的人生成临时链接 |
| `get_responses` | 拉取提交，支持 `wait_seconds` 长轮询；用于 `vote`（及旧的 `general`）页面 |
| `list_pages` | 列出页面 |

典型流程：`get_ui_guide` → `list_targets`（需要时）→ `publish_page` → 需要给组织外的人看/填就 `create_share_link` → 收集类（`vote`）用 `get_responses` 带 `server`、`since` 和 `wait_seconds` 循环拉取；只读类不等待。页面上显示「由 {model} 生成」。

完整契约见 [mcp/README.md](mcp/README.md) 与 [docs/api.md](docs/api.md) §14。

### 3.6 目标选择规则

agent 照此执行：

- 按 服务器 → 组织 → 项目 逐级定位。你在对话里指明了就用指明的；profile 里配的 `org` / `project` / `groups` 视为已指定。
- 没指明时：某一级只有一个候选就直接用；有多个候选，工具返回「需要选择」和候选列表（name / slug / id），agent 会先问你发到哪个服务器、哪个项目或群组。
- 默认服务器只在执行过 `tkanban add --default` 或 `tkanban default <名称>` 时生效；没设默认、又有多个服务器时，每次都会问。
- 指定了群组就发到这些群组（可见性 `groups`）；不指定群组不会追问，可见性默认 `project`。群组名在多个组织重名时会让你选。
- 发布结果里带 `server`，之后读提交、改页面、生成临时链接都带上它。

### 3.7 在对话里怎么说

- 「把这份周报发到 depx 的 acme/weekly 项目」
- 「做个投票，发到 another 服务器的『设计组』群」
- 「发到 depx 的设计组和运营组，再给外部同事生成一个 7 天的临时链接」
- 「看看我能发到哪些地方」（agent 调 `list_targets` 列出服务器、项目、群组）
- 「把部署结构画成架构图发给我」「这份说明做成知识库页」（只读页面，发完给链接，不等回复）
- 没说发到哪且有多个选择时，agent 会先列出候选问你，比如「要发到 depx 还是 another？」

### 3.8 命令行速查

| 命令 | 说明 |
|---|---|
| `tkanban add <名称> --url <URL> [--token <PAT>] [--org <slug>] [--project <slug>] [--group <群组名>]... [--default]` | 添加服务器；联网校验 token 并列出可发布目标。不写 `--token`（或写 `--token -`）时终端里交互输入，管道里从 stdin 读第一行 |
| `tkanban list` | 列出全部服务器和默认项（token 打码，`*` 为默认） |
| `tkanban remove <名称>` | 删除服务器 |
| `tkanban default <名称>` / `tkanban default --clear` | 设为 / 取消默认服务器 |
| `tkanban targets [名称]` | 实时列出可发布的组织、项目、群组（缺省列全部服务器） |
| `tkanban test [名称]` | 测试连通性和 token（缺省测全部服务器） |
| `tkanban mcp` | 启动 stdio MCP 服务器（不带子命令时同样启动） |
| `tkanban --help` / `--version` | 帮助 / 版本 |

## 4. 部署 / 自托管

### 4.1 本地快速体验（Docker）

只起 `pg` 和 `app`（不起 Caddy），只需要 Docker 及 compose 插件：

```bash
git clone https://github.com/longmon/team-kanban.git && cd team-kanban
cat > .env <<EOF
SECRET_KEY=$(openssl rand -hex 32)
PG_PASSWORD=$(openssl rand -hex 16)
PUBLIC_URL=http://127.0.0.1:8080
PAGES_ORIGIN=http://localhost:8080
COOKIE_SECURE=0
TRUST_PROXY=0
PUBLIC_HOST=localhost   # 仅为通过 compose 校验，本地不起 caddy
PAGES_HOST=localhost
EOF
chmod 600 .env
docker compose up -d --build pg app
```

打开 <http://127.0.0.1:8080> 注册账号 → 建组织 → 建项目 → 在「令牌」页创建 PAT，然后按 [3.2](#32-连接服务器) 用 `--url http://127.0.0.1:8080` 连接。

- `127.0.0.1` 和 `localhost` 是两个不同的源，分别模拟主站和 html 页面源；浏览器地址必须与 `PUBLIC_URL` 完全一致。
- `COOKIE_SECURE=0`：http 下浏览器不接受 `Secure` / `__Host-` cookie，不设会登录不上。
- `PUBLIC_HOST` / `PAGES_HOST` 是 `docker-compose.yml` 里 caddy 服务的必填项，即使不起 caddy 也要有值。

常用命令：

```bash
docker compose logs -f app          # 看日志
docker compose down                 # 停止（数据留在 pgdata 卷里；加 -v 会一并删除）
git pull && docker compose up -d --build pg app   # 更新
```

### 4.2 使用外部 PostgreSQL

构建镜像，连接你自己的数据库运行：

```bash
docker build -f server/Dockerfile -t team-kanban .     # 构建上下文为仓库根目录（需要 BuildKit）

cat > team-kanban.env <<EOF
DATABASE_URL=postgres://USER:PASSWORD@host.docker.internal:5432/teamkanban
SECRET_KEY=$(openssl rand -hex 32)
PUBLIC_URL=http://127.0.0.1:8080
PAGES_ORIGIN=http://localhost:8080
COOKIE_SECURE=0
EOF
chmod 600 team-kanban.env

docker run -d --name team-kanban --restart unless-stopped \
  --env-file team-kanban.env -p 127.0.0.1:8080:8080 \
  --add-host=host.docker.internal:host-gateway \
  team-kanban
```

`host.docker.internal` 指向 Docker 宿主机上的 PostgreSQL；Linux 需要加 `--add-host=host.docker.internal:host-gateway`（Docker Desktop 自带）。生产环境放在反代后面时，URL 用 https，`COOKIE_SECURE=1`（默认）、`TRUST_PROXY=1`，见 [4.5](#45-环境变量)。

要求与注意事项：

- **版本**：建议 PostgreSQL 13+（线上用 17），无需任何扩展。
- **权限**：启动时自动跑迁移，账号需要在该库里建表、改表的权限。
- **不支持连库 TLS**：服务端编译时没有开启 sqlx 的 TLS 支持（`server/Cargo.toml` 未启用任何 `tls-*` feature），强制 `sslmode=require` 的托管数据库连不上；不建议跨公网连库。
- **不要接 PgBouncer 事务模式**：迁移使用会话级 advisory lock。
- **`SECRET_KEY` 要固定**：生成一次存好（如上面的 env 文件），不要每次启动重新生成。换了它，临时链接访客已拿到的签名授权（grant）会失效、需重新打开链接，未过期的 html `frame_url` 也会失效。
- **只支持单实例**：通知在进程内（`server/src/notify.rs`），一个库只跑一个容器。

### 4.3 从源码本地开发

依赖：Rust 1.89+、Node 22、Docker（只用来跑 PostgreSQL）。

```bash
# 1) 数据库（容器名 agent-relay-pg、库名 relay_dev 为历史名称，为兼容保留）
docker run -d --name agent-relay-pg -e POSTGRES_PASSWORD=dev -p 127.0.0.1:55432:5432 postgres:17-alpine
docker exec agent-relay-pg psql -U postgres -c "CREATE DATABASE relay_dev"

# 2) 前端构建（产物 web/dist 会被嵌进后端二进制）
cd web && OPENUI_TELEMETRY_DISABLED=1 npm ci && npm run build && cd ..

# 3) 后端（启动时自动跑迁移）
cd server && cargo build --release
DATABASE_URL=postgres://postgres:dev@127.0.0.1:55432/relay_dev \
PUBLIC_URL=http://127.0.0.1:8080 \
PAGES_ORIGIN=http://localhost:8080 \
SECRET_KEY=$(openssl rand -hex 32) \
COOKIE_SECURE=0 \
./target/release/relay
```

打开 <http://127.0.0.1:8080> 注册账号 → 建组织 → 建项目 → 「令牌」页创建 PAT。与 4.1 一样，用 `127.0.0.1` 和 `localhost` 模拟两个源。

**改前端时**用 vite 热更新：后端照常跑在 8080，另开 `cd web && npm run dev`，访问 <http://localhost:5173>（`/api` `/openui` `/h` 自动代理到 8080，可用 `TEAM_KANBAN_DEV_TARGET` 改）。

### 4.4 生产部署

`docker compose` 起三个服务：

- `pg`：`postgres:17-alpine`，命名卷 `pgdata`，不对外。
- `app`：只绑 `127.0.0.1:8080`，默认 `TRUST_PROXY=1`、`COOKIE_SECURE=1`。
- `caddy`：host 网络监听 80/443，配置见 `Caddyfile`。用 host 网络是因为 docker 发布的端口会绕过 firewalld。

`Caddyfile` 假定前面是 Cloudflare 代理（橙云）：只信任 `cf-trusted.caddy` 里的 CF 段，客户端 IP 取 `CF-Connecting-IP`，并把它作为唯一的 `X-Forwarded-For` 传给 app。证书走 Let's Encrypt HTTP-01；Cloudflare SSL/TLS 设 Full (strict)。不走 Cloudflare 时删掉 `servers` 块里的三行即可。

#### 4.4.1 首次部署：准备服务器

1. 安装 Docker（含 compose 插件），确认 `docker compose version` 可用；`scripts/cf-firewall.sh` 依赖 firewalld 和 curl。部署目录固定为 `/opt/agent-relay`（历史名称，为兼容保留），以 root 操作。
2. 准备两个域名都解析到服务器（Cloudflare 开橙云），例如 `kanban.example.com`（主站）和 `pages.example.com`（html 页面源，**不要**用主站的子路径）。
3. 在服务器上写 `/opt/agent-relay/.env`（compose 自动读取，值全部换成你自己的）：

   ```bash
   mkdir -p /opt/agent-relay && cd /opt/agent-relay
   cat > .env <<EOF
   PUBLIC_HOST=kanban.example.com
   PAGES_HOST=pages.example.com
   PUBLIC_URL=https://kanban.example.com
   PAGES_ORIGIN=https://pages.example.com
   SECRET_KEY=$(openssl rand -hex 32)
   PG_PASSWORD=$(openssl rand -hex 16)
   # 可选：
   # ALLOW_SIGNUP=0
   # SMTP_URL=smtps://user:pass@smtp.example.com:465
   # SMTP_FROM=Team Kanban <noreply@example.com>
   # RUST_LOG=info
   EOF
   chmod 600 .env
   ```

   - compose 强制要求 `PUBLIC_HOST`、`PAGES_HOST`（Caddy 站点名）和 `SECRET_KEY`；`PUBLIC_URL`、`PAGES_ORIGIN`、`PG_PASSWORD` 不配会分别回落到 `http://localhost:8080`、空、`relay`，生产必须配。`TRUST_PROXY`、`COOKIE_SECURE` 用 compose 默认值即可。`PG_PASSWORD` 只在 `pgdata` 卷首次初始化时生效，之后不要改。
   - **换域名**：把旧主站也写进 `PUBLIC_HOST`（空格分隔，加引号），并用 `PRIMARY_HOST` 指定新主站：旧域名下的网页 308 跳到新主站，`/api/*`、`/openui/*` 照常可用，已配置旧地址的 tkanban 不受影响。例：`PUBLIC_HOST="kanban.example.com old.example.com"`、`PRIMARY_HOST=kanban.example.com`。
4. 本机执行一次 `scripts/deploy.sh user@host`（见 4.4.2）。首次运行时服务器上没有 `cf-trusted.caddy`，会自动执行 `cf-firewall.sh`：firewalld public 区只放 ssh，80/443 只对 Cloudflare 段放行，并生成 `cf-trusted.caddy`。
5. Cloudflare 的 IP 段会变，建议在服务器上加每周 cron，例如 `0 4 * * 1 /opt/agent-relay/cf-firewall.sh`（可重复执行，刷新后热加载 caddy）。
6. 打开 `https://kanban.example.com` 注册第一个账号；之后如需只凭邀请注册，在 `.env` 加 `ALLOW_SIGNUP=0` 再部署一次。

不用 deploy.sh 也可以在服务器上 `git clone` 本仓库，放好 `.env` 后执行 `sudo scripts/cf-firewall.sh && docker compose up -d --build`。

#### 4.4.2 日常部署：`scripts/deploy.sh user@host`

在本机仓库里执行，参数是 SSH 目标（需要能免密登录，且能操作 docker 和 firewalld，一般是 root）；不传参数时读环境变量 `DEPLOY_HOST`，两者都没有就报错退出。

```bash
git commit ...                 # 只部署已提交内容
scripts/deploy.sh user@host
```

它做的事：

1. `git archive HEAD` 打包**已提交**的内容；有未提交改动只打印警告，不会带上。
2. 经 ssh 流式上传，在服务器上 `mkdir -p /opt/agent-relay`，**先删除 `docs mcp scripts server web` 五个目录**再解包，避免改名/删除的文件残留。`.env`、`cf-trusted.caddy`、`backups/` 等不在这五个目录里的服务器本地文件不受影响；根目录的 `docker-compose.yml`、`Caddyfile`、`README.md` 会被新版本覆盖。
3. 在服务器上执行 `/opt/agent-relay/scripts/deploy.sh --remote`：
   - 建软链 `/opt/agent-relay/deploy.sh`、`/opt/agent-relay/cf-firewall.sh`，指向 `scripts/` 下同名脚本；
   - 没有 `cf-trusted.caddy` 时执行 `cf-firewall.sh`；
   - `docker compose up -d --build --remove-orphans`：在镜像里构建 web 和 server，重建有变化的容器；
   - `docker image prune -f` 清理悬空镜像，最后打印 `docker compose ps`。

在服务器上也可以直接执行 `/opt/agent-relay/deploy.sh --remote`，用现有代码就地重建。

#### 4.4.3 数据库迁移

不手工执行 SQL。迁移文件在 `server/migrations/`，由 `sqlx::migrate!` 编进二进制，app 每次启动先执行未应用的迁移再开始监听；迁移失败时进程退出（日志有「迁移失败」），容器会反复重启。改表结构只需新增迁移文件，随代码一起部署。已发布过的迁移文件（如 `0001_init.sql`）不能再改，sqlx 会因校验和不符拒绝启动。

`0002_page_types.sql`（页面分类）和 `0003_page_model.sql`（生成模型）各只给 `pages` 加一列（带常量默认值的 `page_type`，旧页面全部为 `general`；可空的 `generated_by`）及 CHECK 约束，不重写表。两个文件内都设了 `lock_timeout = 5s`，遇到长事务拿不到锁会失败退出（容器重启后重试），先处理长事务即可。

#### 4.4.4 部署后核对

在服务器上：

```bash
cd /opt/agent-relay
docker compose ps                    # pg / app / caddy 都应为 healthy
docker compose logs --tail=100 app   # 应有 listening on 0.0.0.0:8080，无「迁移失败」
docker compose logs --tail=50 caddy  # 证书是否签发成功
curl --noproxy '*' -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/   # 期望 200
```

服务没有专门的 health 端点，compose 的健康检查就是请求首页 `/`。`--noproxy '*'` 只用于直连本机地址，访问线上域名不需要：

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' https://kanban.example.com/              # 期望 200
curl -fsS https://kanban.example.com/openui/library.schema.json | head -c 100; echo  # MCP 依赖的 schema
```

本机再执行 `tkanban test` 确认 PAT 和连通性正常。

#### 4.4.5 回滚

没有单独的回滚脚本，用旧提交重新部署：

```bash
git checkout <旧提交>
scripts/deploy.sh user@host
git checkout -                 # 回到原分支
```

注意迁移只进不退：如果要回退的版本之后新增过迁移，旧二进制会因数据库里有它不认识的迁移而启动失败。这种情况需要先人工处理表结构，或改为发一个修复版本向前滚。回退到 0002 之前的版本需先停 app 执行回滚 SQL，见 [design.md](docs/design.md) §3.3「页面类型」。

#### 4.4.6 备份

仓库里没有备份脚本或备份服务，需要时手工导出（放在 `/opt/agent-relay/backups/`，不会被 deploy.sh 清理）：

```bash
cd /opt/agent-relay && mkdir -p backups
docker compose exec -T pg pg_dump -U postgres relay | gzip > backups/relay-$(date +%F).sql.gz   # 库名 relay 为历史名称，为兼容保留
```

### 4.5 环境变量

服务端读取（`server/src/config.rs`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | 必填 | PostgreSQL 连接串 |
| `PUBLIC_URL` | 必填 | 主站地址，不带结尾 `/`，用于拼链接和校验 Origin |
| `PAGES_ORIGIN` | 空 | html 页面的独立源（另一个主机名）。不配则与主站同源，仅靠 sandbox 隔离，**生产必须配** |
| `SECRET_KEY` | 必填 | ≥ 32 字节随机串，用于签名 `frame_url`、临时链接 grant 等；保持固定 |
| `BIND` | `0.0.0.0:8080` | 监听地址 |
| `COOKIE_SECURE` | `1` | 本地 http 设为 `0`（cookie 名随之从 `__Host-relay_session` 变为 `relay_session`，cookie 名为历史名称，为兼容保留） |
| `TRUST_PROXY` | `0` | 在反代后面设为 `1`，按 `X-Forwarded-For` 取客户端 IP（限流用） |
| `ALLOW_SIGNUP` | `1` | `0` = 只能凭邀请注册 |
| `SMTP_URL` / `SMTP_FROM` | 空 | 发验证邮件、邀请、重置密码；不配时邮件内容只打到日志 |
| `RUST_LOG` | `info` | 日志级别 |

仅 `docker-compose.yml` / Caddy 使用：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PUBLIC_HOST` | 必填 | 主站的 Caddy 站点名；可同时写旧域名，空格分隔 |
| `PAGES_HOST` | 必填 | html 页面源的 Caddy 站点名 |
| `PRIMARY_HOST` | `PUBLIC_HOST` | `PUBLIC_HOST` 写了多个时，指定哪个是主站 |
| `PG_PASSWORD` | `relay` | Postgres 密码，只在 `pgdata` 卷首次创建时生效 |

注意：compose 下 `app` 的 `TRUST_PROXY` 默认是 `1`，与二进制自身默认的 `0` 不同。

## 5. 测试

```bash
cd server && cargo test && cargo clippy --all-targets -- -D warnings   # 需要 4.3 的 PG 容器（TEST_DATABASE_URL 可改）
cd mcp && cargo test
cd web && npx tsc --noEmit && npm run check
scripts/e2e.sh                                                         # 端到端，见下
```

`scripts/e2e.sh` 会：建临时库 → 构建 web/server 并启动（自动找空闲端口）→ 用 curl 建用户/组织/项目/PAT → 跑 MCP 冒烟（`mcp/tests/live.rs`，通过 stdio 拉起真实 `tkanban` 二进制（env 方式）调用全部工具）→ 跑浏览器 e2e（`web/e2e/e2e.mjs`，playwright-core + 本机 chromium headless shell）→ 停服务、删库。
浏览器路径用 `CHROME=` 指定，缺省找 `~/.cache/ms-playwright/chromium_headless_shell-*`（可用 `npx playwright install chromium-headless-shell` 安装）。

## 6. 发布 tkanban

`.github/workflows/release.yml` 为 [3.1](#31-安装-tkanban) 中的五个平台构建 `tkanban`：

- 推送 `v*` 标签：构建全部平台，每个包附带 `LICENSE`，发布名为 `tkanban <标签>` 的 GitHub Release，含各平台压缩包和 `SHA256SUMS.txt`（自动生成更新说明）。
- 推送 `main` 以外的分支只构建不发布，用于验证；也可手动触发（`workflow_dispatch`）。

```bash
git tag v2.1.0 && git push origin v2.1.0
```

建议让 `mcp/Cargo.toml` 的 `version` 与标签保持一致，这样 `tkanban --version` 才对得上。

## 7. 常见问题

**登录后马上又跳回登录页 / 所有写请求 403 `csrf_failed`**
本地用 http 时必须 `COOKIE_SECURE=0`，否则浏览器不保存 `__Host-` cookie。另外 `PUBLIC_URL` 必须和浏览器地址栏的源完全一致（`127.0.0.1` 和 `localhost` 算不同源），服务端会校验 `Origin`。

**html 页面空白或报 frame-ancestors**
`PAGES_ORIGIN` 的主机名下只开放 `/h/*`，主站下不开放 `/h/*`；检查反代是否把 `pages.example.com` 的 Host 原样转发。`frame_url` 10 分钟过期，前端会自动重新获取；页面内容更新后旧 `frame_url` 立即失效。

**MCP 报 `openui_invalid:`**
OpenUI 写错了，被本地拦下没有上传。按返回的 `行:列 code message` 修改；先调 `get_ui_guide` 看组件签名和示例。

**MCP 报 `forbidden (HTTP 403)` / `not_found (HTTP 404)`**
PAT scope 不足（发布要 `publish`，读提交要 `read_responses`），或 PAT 限定的组织/项目不包含目标页面。PAT 不能调用只允许网页会话的接口，也不能提交（`not_allowed`）。

**外部用户打开链接显示「页面不存在，或需要登录后才能查看」**
页面可见性不是 `public`。给组织外的人用 `create_share_link` 生成临时链接，不要直接发 `/pages/{id}`。

**注册提示 429**
同一 IP 每小时最多注册 5 次（进程内限流，重启清零）；登录每分钟 20 次，提交每 IP 每分钟 30 次。

**CSV 列名和网页表格不一样？**
二者规则相同（api.md §8.4）：OpenUI 提交列为 `action`、`form` 和表单字段名；字段名与固定列（`seq`、`created_at` 等）或 `action`/`form` 撞名时加 `values.` 前缀，非 OpenUI 提交撞名时加 `data.` 前缀。

**能不能跑多个 app 副本？**
不能。限流和长轮询唤醒都在进程内，只跑一个 app 实例（见 design.md §9）。

## 8. 许可证

[GNU Affero 通用公共许可证 v3.0](LICENSE)（`AGPL-3.0-only`）。

简单说：可以使用、修改、自建部署，包括商用。如果对外分发，或者把修改后的版本通过网络提供给用户使用（例如做成托管服务），必须按同一协议向这些用户提供你那个版本的完整源码。v2.1.0 及之前的版本按 Apache-2.0 发布，仍按原协议有效。
