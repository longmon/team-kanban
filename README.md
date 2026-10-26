# Team Kanban

本机的 agent（Claude Code / Codex 等任意 MCP 客户端）通过 MCP 把生成的页面（投票、报告、表格、问卷……）发布到一台远程服务器；组织内成员或拿到临时链接的外部用户在浏览器里查看、填写并提交，结果由 agent 通过 MCP 取回，网页上也能实时看结果、导出 CSV。

```
本机 agent ──stdio──> tkanban mcp（Rust，mcp/） ──HTTPS + PAT──> Team Kanban 服务（Rust + PostgreSQL） <──浏览器── 成员 / 外部用户
```

- 多租户：组织 → 项目 → 页面；组织成员、项目角色（admin/editor/viewer）、群组；邀请链接。
- 页面两种：**OpenUI**（agent 写 OpenUI Lang，前端用官方组件渲染，推荐）和 **html**（自包含 HTML，放在独立源的沙箱 iframe 里）。
- 页面类型（`page_type`）：**只读**的报告 `report` / 知识库 `knowledge`（自动目录）/ 流程图 `flowchart` / 架构图 `architecture`（Mermaid 渲染）——不收提交、agent 不等回复；**收集回复**的投票 `vote`（投票/表单/问卷）——agent 用 `get_responses` 等待。agent 按需求选类型，你指定了就照用；旧页面都是通用 `general`，行为不变。
- 可见性：`public` / `org` / `project` / `groups`；对外用带有效期、次数上限、可选密码的临时链接。
- agent 用个人访问令牌（PAT，scope：`publish`、`read_responses`）调用。

| 目录 | 内容 |
|---|---|
| `server/` | 后端：axum + sqlx + PostgreSQL，前端产物经 rust-embed 打进同一个二进制 |
| `web/` | 前端：React + Tailwind + shadcn/ui；OpenUI 组件库 kanbanLibrary（`web/src/openui-lib`），视觉规范见 [design-system.md](docs/design-system.md) |
| `mcp/` | 本机 stdio MCP，Rust 单二进制，内嵌 QuickJS 做 OpenUI 本地校验，见 [mcp/README.md](mcp/README.md) |
| `docs/` | [design.md](docs/design.md) 设计、[api.md](docs/api.md) 接口契约（三方以它为准） |
| `scripts/e2e.sh` | 端到端联调脚本 |

## 1. 项目架构

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

### 目录与关键文件

```
server/                 后端（crate/二进制名 relay，历史名称，为兼容保留；Rust：axum 0.8、tokio、sqlx 0.8、rust-embed 8）
  migrations/           sqlx 迁移（0001_init.sql、0002_page_types.sql），服务启动时自动执行
  src/main.rs           读环境变量 → 连库 → 跑迁移 → 起后台清理任务 → 监听
  src/lib.rs            路由装配、host_guard（按 Host 分流 + CSP 等安全头）、后台清理
  src/routes/           account orgs groups invites tokens pages responses statics（/h/*、/openui/*、SPA 回落）
  src/auth.rs authz.rs  鉴权（会话 cookie / PAT / 临时链接）与权限判断唯一入口
  src/notify.rs         进程内 page_id → broadcast，唤醒长轮询与 SSE
  src/ratelimit.rs mail.rs audit.rs config.rs
  Dockerfile            三阶段：node 构建 web → rust 构建 server（嵌入 web/dist）→ alpine 运行
  tests/                集成测试（需要 PG）
web/                    前端：React 19 + Vite + TypeScript + Tailwind 4 + shadcn/ui（src/components/ui）
  src/pages/            登录、组织/项目、令牌、页面查看、结果、临时链接等页面
  src/openui-lib/       自定义 OpenUI 组件库 kanbanLibrary（@openuidev/react-lang 1.0.1，渲染用 shadcn/ui）
  scripts/gen-openui.ts 构建后导出 kanbanLibrary 的 JSON Schema 与提示词到 dist/openui/
  e2e/e2e.mjs           浏览器端到端测试
mcp/                    本机 tkanban 二进制：多服务器 profile 命令行 + stdio MCP（rmcp）
  src/                  main.rs cli.rs config.rs openui.rs
  vendor/lang-core.js   打包好的 @openuidev/lang-core，由 rquickjs 内嵌执行做本地校验
scripts/                deploy.sh（一键部署）、cf-firewall.sh（防火墙 + Caddy 信任段）、e2e.sh（端到端联调）
docs/                   design.md 设计、api.md 接口契约、design-system.md 视觉规范
docker-compose.yml      pg / app / caddy 三个服务
Caddyfile               两个主机名反代到 127.0.0.1:8080，只信任 Cloudflare 段的真实 IP
```

### 一次发布到回传

1. agent 调 `get_ui_guide`（MCP 从服务端 `/openui/prompt.md`、`/openui/library.schema.json` 拉取并缓存），写出 OpenUI Lang。
2. `publish_page`：`tkanban mcp` 用内嵌 QuickJS 按同一份 schema 本地校验，通过后带 PAT 调 `POST /api/pages`，返回页面地址；需要给组织外的人填时再 `create_share_link`。
3. 用户在浏览器打开页面：OpenUI 页由 kanbanLibrary 渲染；html 页放在 `PAGES_ORIGIN` 的沙箱 iframe 里，经 postMessage 交给外壳页代提交。提交写入 PostgreSQL，并通过进程内通知中心唤醒等待者。
4. 只读类页面（报告/知识库/流程图/架构图）到此结束，agent 把链接交给你即可。收集类（投票/表单）由 agent 调 `get_responses`（带 `since`、`wait_seconds`，服务端最多挂 25 秒）长轮询 `GET /api/pages/{id}/responses`，有新提交立即返回；网页结果页走 SSE 实时刷新，可导出 CSV。

### 技术栈

| 部分 | 技术 |
|---|---|
| 后端 | Rust、axum 0.8、tokio、sqlx 0.8（postgres + migrate）、rust-embed 8 |
| 数据库 | PostgreSQL 17（`postgres:17-alpine`） |
| 前端 | React 19、Vite、TypeScript、Tailwind CSS 4、shadcn/ui；OpenUI 组件库 kanbanLibrary 在 `web/src/openui-lib` |
| 本机 MCP | Rust、rmcp、rquickjs（QuickJS）、reqwest（rustls） |
| 部署 | docker compose、Caddy 2（Let's Encrypt）、Cloudflare 代理、firewalld |

### 安全要点

- **CSP**：主站响应带 `default-src 'self'; script-src 'self'; font-src 'self' data:; frame-ancestors 'none'` 等，字体自托管，不能用外部 CDN（见 [design-system.md](docs/design-system.md)）。
- **html 页面隔离**：放在独立主机名 `PAGES_ORIGIN`，两个主机名按 Host 严格分流；iframe 沙箱无 same-origin，frame_url 带签名和有效期。
- **鉴权**：网页用会话 cookie + Origin/CSRF 校验；agent 用 PAT（scope `publish` / `read_responses`，可限定组织或项目）；外部用户用临时链接（有效期、次数上限、可选密码）。
- **多租户**：组织 → 项目 → 页面，项目角色 admin/editor/viewer，群组授权；权限判断统一走 `authz.rs`。
- **单实例**：限流和长轮询唤醒都在进程内，不要横向扩容。

细节见 [docs/design.md](docs/design.md)（架构、数据模型、权限矩阵）、[docs/api.md](docs/api.md)（接口契约、MCP 工具）、[docs/design-system.md](docs/design-system.md)（视觉规范）。

## 2. 本地启动

依赖：Rust（≥ 1.88）、Node 22、Docker（只用来跑 PostgreSQL）。

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

打开 http://127.0.0.1:8080 注册账号 → 建组织 → 建项目 → 「令牌」页创建 PAT。

本地没有两个域名时，用 `127.0.0.1` 和 `localhost` 两个主机名模拟主站和 html 页面源（如上）。

**改前端时**用 vite 热更新：后端照常跑在 8080，另开 `cd web && npm run dev`，访问 http://localhost:5173（`/api` `/openui` `/h` 自动代理到 8080，可用 `TEAM_KANBAN_DEV_TARGET` 改）。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | 必填 | PostgreSQL 连接串 |
| `PUBLIC_URL` | 必填 | 主站地址，不带结尾 `/`，用于拼链接和校验 Origin |
| `PAGES_ORIGIN` | 空 | html 页面的独立源（另一个主机名）。不配则与主站同源，仅靠 sandbox 隔离，**生产必须配** |
| `SECRET_KEY` | 必填 | ≥ 32 字节随机串，用于签名 frame_url、临时链接 grant 等 |
| `BIND` | `0.0.0.0:8080` | 监听地址 |
| `COOKIE_SECURE` | `1` | 本地 http 设为 `0`（cookie 名随之从 `__Host-relay_session` 变为 `relay_session`，cookie 名为历史名称，为兼容保留） |
| `TRUST_PROXY` | `0` | 在反代后面设为 `1`，按 `X-Forwarded-For` 取客户端 IP（限流用） |
| `ALLOW_SIGNUP` | `1` | `0` = 只能凭邀请注册 |
| `SMTP_URL` / `SMTP_FROM` | 空 | 发验证邮件、邀请、重置密码；不配时邮件内容只打到日志 |
| `RUST_LOG` | `info` | 日志级别 |

## 3. 部署（docker compose + Caddy）

compose 起三个服务：`pg`（postgres:17-alpine，命名卷 `pgdata`，不对外）、`app`（只绑 `127.0.0.1:8080`，默认 `TRUST_PROXY=1`、`COOKIE_SECURE=1`）、`caddy`（host 网络监听 80/443，配置见 `Caddyfile`）。

`Caddyfile` 假定前面是 Cloudflare 代理（橙云）：只信任 `cf-trusted.caddy` 里的 CF 段，客户端 IP 取 `CF-Connecting-IP`，并把它作为唯一的 `X-Forwarded-For` 传给 app。证书走 Let's Encrypt HTTP-01；Cloudflare SSL/TLS 设 Full (strict)。不走 Cloudflare 时删掉 `servers` 块里的三行即可。caddy 用 host 网络是因为 docker 发布的端口会绕过 firewalld。

### 3.1 首次部署：准备服务器

1. 安装 Docker（含 compose 插件），确认 `docker compose version` 可用；`scripts/cf-firewall.sh` 依赖 firewalld 和 curl。部署目录固定为 `/opt/agent-relay`（历史名称，为兼容保留），以 root 操作。
2. 准备两个域名都解析到服务器（Cloudflare 开橙云），例如 `relay.example.com`（主站）和 `pages.example.com`（html 页面源，**不要**用主站的子路径）。
3. 在服务器上写 `/opt/agent-relay/.env`（compose 自动读取，值全部换成你自己的）：

```bash
mkdir -p /opt/agent-relay && cd /opt/agent-relay
cat > .env <<EOF
PUBLIC_HOST=relay.example.com
PAGES_HOST=pages.example.com
PUBLIC_URL=https://relay.example.com
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

   换域名时可以把旧主站写在 `PUBLIC_HOST` 里（空格分隔，加引号），并用 `PRIMARY_HOST` 指定新主站：旧域名下的网页 308 跳到新主站，`/api/*`、`/openui/*` 照常可用，已配置旧地址的 tkanban 不受影响。例：`PUBLIC_HOST="dash.example.com relay.example.com"`、`PRIMARY_HOST=dash.example.com`。

   compose 强制要求 `PUBLIC_HOST`、`PAGES_HOST`（Caddy 站点名）和 `SECRET_KEY`；`PUBLIC_URL`、`PAGES_ORIGIN`、`PG_PASSWORD` 不配会分别回落到 `http://localhost:8080`、空、`relay`，生产必须配。`TRUST_PROXY`、`COOKIE_SECURE` 用 compose 默认值即可，各变量含义见上面的「环境变量」表。`PG_PASSWORD` 只在 `pgdata` 卷首次初始化时生效，之后不要改。
4. 本机执行一次 `scripts/deploy.sh user@host`（见 3.2）。首次运行时服务器上没有 `cf-trusted.caddy`，会自动执行 `cf-firewall.sh`：firewalld public 区只放 ssh，80/443 只对 Cloudflare 段放行，并生成 `cf-trusted.caddy`。
5. Cloudflare 的 IP 段会变，建议在服务器上加每周 cron，例如 `0 4 * * 1 /opt/agent-relay/cf-firewall.sh`（可重复执行，刷新后热加载 caddy）。
6. 打开 `https://relay.example.com` 注册第一个账号；之后如需只凭邀请注册，在 `.env` 加 `ALLOW_SIGNUP=0` 再部署一次。

不用 deploy.sh 也可以在服务器上 `git clone` 本仓库，放好 `.env` 后执行 `sudo scripts/cf-firewall.sh && docker compose up -d --build`。

### 3.2 日常部署：`scripts/deploy.sh user@host`

在本机仓库里执行，参数是 SSH 目标（需要能免密登录，且能操作 docker 和 firewalld，一般是 root）；不传参数时读环境变量 `DEPLOY_HOST`，两者都没有就报错退出：

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

### 3.3 数据库迁移

不手工执行 SQL。迁移文件在 `server/migrations/`，由 `sqlx::migrate!` 编进二进制，app 每次启动先执行未应用的迁移再开始监听；迁移失败时进程退出（日志有「迁移失败」），容器会反复重启。改表结构只需新增迁移文件，随代码一起部署。已发布过的迁移文件（如 `0001_init.sql`）不能再改，sqlx 会因校验和不符拒绝启动。

`0002_page_types.sql`（页面分类）只给 `pages` 加一列带常量默认值的 `page_type` 和三个 CHECK，不重写表，旧页面全部为 `general`；文件内 `lock_timeout = 5s`，遇到长事务拿不到锁会失败退出（容器重启后重试），先处理长事务即可。

### 3.4 部署后核对

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
curl -fsS -o /dev/null -w '%{http_code}\n' https://relay.example.com/              # 期望 200
curl -fsS https://relay.example.com/openui/library.schema.json | head -c 100; echo  # MCP 依赖的 schema
```

本机再执行 `tkanban test` 确认 PAT 和连通性正常。

### 3.5 回滚

没有单独的回滚脚本，用旧提交重新部署：

```bash
git checkout <旧提交>
scripts/deploy.sh user@host
git checkout -                 # 回到原分支
```

注意迁移只进不退：如果要回退的版本之后新增过迁移，旧二进制会因数据库里有它不认识的迁移而启动失败。这种情况需要先人工处理表结构，或改为发一个修复版本向前滚。回退到 0002 之前的版本需先停 app 执行回滚 SQL，见 [design.md](docs/design.md) §3.3「页面类型」。

### 3.6 备份

仓库里没有备份脚本或备份服务，需要时手工导出（放在 `/opt/agent-relay/backups/`，不会被 deploy.sh 清理）：

```bash
cd /opt/agent-relay && mkdir -p backups
docker compose exec -T pg pg_dump -U postgres relay | gzip > backups/relay-$(date +%F).sql.gz   # 库名 relay 为历史名称，为兼容保留
```

## 4. 本地 MCP 配置

本机只需要一个二进制 `tkanban`（`mcp/`，Rust 单文件，不需要 Node / OpenSSL）：既是管理多服务器配置的命令行，也是 stdio MCP 服务器（`tkanban mcp`）。
> 服务端 Docker 镜像里的二进制叫 `relay`（历史名称，为兼容保留），那个跑在服务器（容器）里；这里说的 `tkanban` 跑在你自己的电脑上，两者无关。

```bash
# 1) 安装：到 https://github.com/longmon/team-kanban/releases 下载对应平台的压缩包，解压后把 tkanban 放进 PATH
#    Linux（静态链接，任意发行版）：x86_64 / aarch64-unknown-linux-musl；macOS：aarch64（M 系列）/ x86_64-apple-darwin；Windows：x86_64-pc-windows-msvc
#    例：curl -L https://github.com/longmon/team-kanban/releases/latest/download/tkanban-v2.1.0-x86_64-unknown-linux-musl.tar.gz | tar xz
#    macOS 首次运行被拦时：xattr -d com.apple.quarantine tkanban
#    或从源码装（需要 Rust 1.85+ 和 C 编译器；装到 ~/.cargo/bin/tkanban）：
cargo install --git https://github.com/longmon/team-kanban team-kanban
#    或在本仓库里自己编译：cd mcp && cargo build --release && sudo install -m 0755 target/release/tkanban /usr/local/bin/tkanban
tkanban --help                                     # 中文帮助

# 2) 添加服务器（profile）：联网校验 token，并列出它能发布的组织 / 项目 / 群组；校验失败不保存
#    不写 --token 时交互输入（不回显），避免 token 留在 shell 历史
tkanban add depx --url https://dash.tkanban.com
#    也可以从 stdin 读，并给这个服务器配默认发布目标（视为「已指定」）
printf '%s\n' "$ANOTHER_PAT" | tkanban add another --url https://relay.example.com \
  --org acme --project demo --group 设计组 --group 运营组

# 3) 默认服务器（可选）：只有显式设置过，才会在没指明服务器时直接用它
tkanban default depx                               # tkanban default --clear 取消
tkanban list                                       # 列出服务器，token 打码，* 为默认
tkanban targets                                    # 实时列出每个服务器上可发布的组织 / 项目 / 群组
tkanban test                                       # 测试连通性与 token
tkanban remove another

# 4) 注册到 Claude Code（-s user 全局生效；无需再传 TEAM_KANBAN_URL / TEAM_KANBAN_TOKEN）
claude mcp add team-kanban -s user -- "$(command -v tkanban)" mcp

# 5) 注册到 Codex（二选一）
codex mcp add team-kanban -- tkanban mcp
```

Codex 也可以直接编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.team-kanban]
command = "tkanban"          # 或绝对路径 /usr/local/bin/tkanban
args = ["mcp"]
tool_timeout_sec = 60        # get_responses 长轮询最长 25 秒，留足余量
```

配置文件在 `$XDG_CONFIG_HOME/team-kanban/config.toml`（缺省 `~/.config/team-kanban/config.toml`），文件 0600、目录 0700，`tkanban add/remove/default` 维护，也可手改。旧路径 `agent-relay/config.toml`（历史名称）存在而新路径不存在时，首次运行会自动迁移到新路径：

```toml
default = "depx"

[profiles.depx]
url = "https://dash.tkanban.com"
token = "arp_xxxx…"

[profiles.another]
url = "https://relay.example.com"
token = "arp_yyyy…"
org = "acme"
project = "demo"
groups = ["设计组", "运营组"]
```

兼容旧方式：MCP 进程有环境变量 `TEAM_KANBAN_URL`（+ `TEAM_KANBAN_TOKEN`）时，视为一个名为 `env` 的服务器，和配置文件里的服务器一起参与选择。改用配置文件后，请把注册命令里的 `-e TEAM_KANBAN_URL… -e TEAM_KANBAN_TOKEN…` 去掉，否则会多出一个 `env` 候选。

PAT 在网页「令牌」页创建：发布需要 `publish`，读提交需要 `read_responses`；可以限定到某个组织或项目。

### 目标选择规则（agent 照此执行）

- 按 服务器 → 组织 → 项目 逐级定位。你在对话里指明了就用指明的；profile 里配的 `org` / `project` / `groups` 视为已指定。
- 没指明时：某一级只有一个候选就直接用；有多个候选，工具返回「需要选择」和候选列表（name / slug / id），agent 会先问你发到哪个服务器、哪个项目或群组。
- 默认服务器只在执行过 `tkanban add --default` 或 `tkanban default <名称>` 时生效；没设默认、又有多个服务器时，每次都会问。
- 指定了群组就发到这些群组（可见性 groups）；不指定群组不会追问，可见性默认 project。群组名在多个组织重名时会让你选。
- 发布结果里带 `server`，之后读提交、改页面、生成临时链接都带上它。

### 在对话里怎么说

- 「把这份周报发到 depx 的 acme/weekly 项目」
- 「做个投票，发到 another 服务器的『设计组』群」
- 「发到 depx 的设计组和运营组，再给外部同事生成一个 7 天的临时链接」
- 「看看我能发到哪些地方」（agent 调 `list_targets` 列出服务器、项目、群组）
- 「把部署结构画成架构图发给我」「这份说明做成知识库页」（只读页面，发完给链接，不等回复）
- 没说发到哪且有多个选择时，agent 会先列出候选问你，比如「要发到 depx 还是 another？」

工具：`get_ui_guide`（先调它拿 OpenUI 写法）、`list_targets`、`list_projects`、`publish_page`、`update_page`、`create_share_link`、`get_responses`（支持 `wait_seconds` 长轮询）、`list_pages`。详见 [mcp/README.md](mcp/README.md) 与 [docs/api.md](docs/api.md) §14。

典型流程：`get_ui_guide` → `list_targets`（需要时）→ `publish_page`（必填 `page_type`，kind=openui 本地校验通过才上传）→ 需要给组织外的人看/填就 `create_share_link` → 收集类（`vote`）用 `get_responses` 带 `server`、`since` 和 `wait_seconds` 循环拉取；只读类不等待。`publish_page` 还必填 `model`（agent 自己的模型名称，如 `Claude Opus 5.5`），`update_page` 可选 `model`；页面上显示「由 {model} 生成」。

## 5. 测试

```bash
cd server && cargo test && cargo clippy --all-targets -- -D warnings   # 需要上面的 PG 容器（TEST_DATABASE_URL 可改）
cd mcp && cargo test
cd web && npx tsc --noEmit && npm run check
scripts/e2e.sh                                                         # 端到端，见下
```

`scripts/e2e.sh` 会：建临时库 → 构建 web/server 并启动（自动找空闲端口）→ 用 curl 建用户/组织/项目/PAT → 跑 MCP 冒烟（`mcp/tests/live.rs`，通过 stdio 拉起真实 `tkanban` 二进制（env 方式）调用全部工具）→ 跑浏览器 e2e（`web/e2e/e2e.mjs`，playwright-core + 本机 chromium headless shell）→ 停服务、删库。
浏览器路径用 `CHROME=` 指定，缺省找 `~/.cache/ms-playwright/chromium_headless_shell-*`（可用 `npx playwright install chromium-headless-shell` 安装）。

## 6. 常见问题

**登录后马上又跳回登录页 / 所有写请求 403 `csrf_failed`**
本地用 http 时必须 `COOKIE_SECURE=0`，否则浏览器不保存 `__Host-` cookie。另外 `PUBLIC_URL` 必须和浏览器地址栏的源完全一致（`127.0.0.1` 和 `localhost` 算不同源），服务端会校验 `Origin`。

**html 页面空白或报 frame-ancestors**
`PAGES_ORIGIN` 的主机名下只开放 `/h/*`，主站下不开放 `/h/*`；检查反代是否把 `pages.example.com` 的 Host 原样转发。frame_url 10 分钟过期，前端会自动重新获取；页面内容更新后旧 frame_url 立即失效。

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

**只能单实例**
限流和长轮询唤醒都在进程内，不要横向扩多个 app 副本（见 design.md §9）。
