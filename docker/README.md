# Team Kanban server

English | [简体中文](#简体中文)

Server for [Team Kanban](https://github.com/longmon/team-kanban): your AI agent (Claude Code, Codex or any MCP client) publishes pages — polls, forms, reports, knowledge pages, flowcharts, architecture diagrams — to this server through the `tkanban` MCP command; teammates or guests with a temporary link view and respond in the browser, and the agent pulls the responses back.

- **Image**: one Rust binary on Alpine, web UI embedded, runs as non-root (uid 10001), listens on `8080`.
- **Architectures**: `linux/amd64`, `linux/arm64`.
- **Tags**: `latest`, `<version>` (e.g. `2.2.0`), `sha-<commit>`.
- **Needs**: PostgreSQL 13+ (17 recommended). Database migrations run automatically at startup.
- **License**: AGPL-3.0-only. Source: <https://github.com/longmon/team-kanban>

## Quick start (local trial)

Save as `docker-compose.yml`:

```yaml
services:
  pg:
    image: postgres:17-alpine
    environment:
      POSTGRES_PASSWORD: ${PG_PASSWORD:?set PG_PASSWORD}
      POSTGRES_DB: kanban
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d kanban"]
      interval: 5s
      retries: 20
    restart: unless-stopped

  team-kanban-mcp-server:
    container_name: team-kanban
    image: DOCKERHUB_NAMESPACE/team-kanban-mcp-server:latest
    depends_on:
      pg:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://postgres:${PG_PASSWORD}@pg:5432/kanban
      SECRET_KEY: ${SECRET_KEY:?set SECRET_KEY}
      PUBLIC_URL: ${PUBLIC_URL:-http://127.0.0.1:8080}
      PAGES_ORIGIN: ${PAGES_ORIGIN:-http://localhost:8080}
      COOKIE_SECURE: ${COOKIE_SECURE:-0}
      TRUST_PROXY: ${TRUST_PROXY:-0}
      ALLOW_SIGNUP: ${ALLOW_SIGNUP:-1}
      SMTP_URL: ${SMTP_URL:-}
      SMTP_FROM: ${SMTP_FROM:-}
    ports:
      - "127.0.0.1:8080:8080"
    restart: unless-stopped

volumes:
  pgdata:
```

Then:

```bash
cat > .env <<EOF
SECRET_KEY=$(openssl rand -hex 32)
PG_PASSWORD=$(openssl rand -hex 16)
EOF
chmod 600 .env
docker compose up -d
```

Open <http://127.0.0.1:8080>, register, create an organization and a project, then create a personal access token on the **Tokens** page (令牌).

`127.0.0.1` and `localhost` act as two different origins: the main site and the isolated origin for html pages. `COOKIE_SECURE=0` is needed because this is plain http.

## Connect your agent

Install `tkanban` from [GitHub Releases](https://github.com/longmon/team-kanban/releases) (macOS / Linux / Windows), then:

```bash
tkanban add my --url http://127.0.0.1:8080 --default     # paste the token when prompted
tkanban test
claude mcp add team-kanban -s user -- "$(command -v tkanban)" mcp   # Claude Code
codex mcp add team-kanban -- tkanban mcp                             # Codex
```

Then ask your agent, e.g. "publish a poll to Team Kanban asking which message queue we should use".

## Production

You need **two host names** pointing to the server, e.g. `kanban.example.com` (main site) and `pages.example.com` (html pages; must be a different host, not a sub-path), plus HTTPS in front of the app.

1. In `.env`, add:

   ```bash
   PUBLIC_URL=https://kanban.example.com
   PAGES_ORIGIN=https://pages.example.com
   COOKIE_SECURE=1
   TRUST_PROXY=1
   ```

2. Add a reverse proxy to the compose file. A minimal Caddy setup (automatic Let's Encrypt certificates):

   ```yaml
     caddy:
       image: caddy:2-alpine
       ports: ["80:80", "443:443"]
       volumes:
         - ./Caddyfile:/etc/caddy/Caddyfile:ro
         - caddy_data:/data
       restart: unless-stopped
   # and add `caddy_data:` under `volumes:`
   ```

   `Caddyfile`:

   ```
   kanban.example.com, pages.example.com {
   	reverse_proxy team-kanban-mcp-server:8080
   }
   ```

   The app tells the two hosts apart by the `Host` header. With `TRUST_PROXY=1`, keep port 8080 bound to `127.0.0.1` (or remove the `ports:` entry) so clients cannot reach the app directly and fake `X-Forwarded-For`.

3. `docker compose up -d`. To make registration invite-only after creating the first account, set `ALLOW_SIGNUP=0` and run `docker compose up -d` again.

Behind Cloudflare (orange cloud), use SSL mode **Full (strict)**. The repository's [Caddyfile](https://github.com/longmon/team-kanban/blob/main/Caddyfile) shows a hardened setup that trusts only Cloudflare IPs and takes the client IP from `CF-Connecting-IP`.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string |
| `SECRET_KEY` | required | Random string ≥ 32 bytes (`openssl rand -hex 32`). Keep it stable: changing it invalidates share-link visitor sessions and pending html frame URLs |
| `PUBLIC_URL` | required | Main site URL, no trailing `/` |
| `PAGES_ORIGIN` | empty | Separate origin for html pages. **Required in production**; if empty, html pages rely on the iframe sandbox alone |
| `COOKIE_SECURE` | `1` | `0` for plain-http local use |
| `TRUST_PROXY` | `0` | `1` behind a reverse proxy (client IP from `X-Forwarded-For`, used for rate limiting) |
| `ALLOW_SIGNUP` | `1` | `0` = invite-only |
| `SMTP_URL` / `SMTP_FROM` | empty | e.g. `smtps://user:pass@smtp.example.com:465` / `Team Kanban <noreply@example.com>`. Without SMTP, emails are only written to the log |
| `BIND` | `0.0.0.0:8080` | Listen address |
| `RUST_LOG` | `info` | Log level |

## Using an external PostgreSQL

Point `DATABASE_URL` at your database and drop the `pg` service. Requirements:

- An empty database and an account that can create and alter tables in it.
- **No TLS**: the server is currently built without TLS for database connections, so managed databases that enforce `sslmode=require` cannot be used. Keep the database on a private network.
- No PgBouncer in transaction mode (migrations use a session-level advisory lock).
- PostgreSQL on the Docker host: use `host.docker.internal` and, on Linux, add `extra_hosts: ["host.docker.internal:host-gateway"]` to the `team-kanban-mcp-server` service.

## Operations

- **Upgrade**: `docker compose pull team-kanban-mcp-server && docker compose up -d team-kanban-mcp-server`. Migrations run at startup; back up first. Rolling back to an older image after a new migration has run requires reverting that migration manually.
- **Backup**: `docker compose exec -T pg pg_dump -U postgres -Fc kanban > kanban-$(date +%F).dump`
- **Restore**: `docker compose exec -T pg pg_restore -U postgres -d kanban --clean < kanban-YYYY-MM-DD.dump`
- **Logs**: `docker compose logs -f team-kanban-mcp-server`
- **Health check**: `GET /healthz` returns 200.
- **Single instance only**: rate limiting and long-poll notifications are in-process. Run one `team-kanban-mcp-server` container per database.

---

## 简体中文

[Team Kanban](https://github.com/longmon/team-kanban) 的服务端。你的 AI agent（Claude Code、Codex 或任意 MCP 客户端）通过 `tkanban` 命令把投票、问卷、报告、知识页、流程图、架构图等页面发布到这台服务器；同事或拿到临时链接的访客在浏览器里查看和提交，agent 再把结果取回。

- **镜像**：Alpine + 单个 Rust 程序，网页界面已内置，以非 root 用户（uid 10001）运行，监听 `8080`。
- **架构**：`linux/amd64`、`linux/arm64`。
- **标签**：`latest`、`<版本号>`（如 `2.2.0`）、`sha-<提交号>`。
- **依赖**：PostgreSQL 13 及以上（推荐 17）。启动时自动执行数据库迁移。
- **协议**：AGPL-3.0-only。源码：<https://github.com/longmon/team-kanban>

### 本地快速体验

把上面英文部分 [Quick start](#quick-start-local-trial) 里的 `docker-compose.yml` 存到一个空目录，然后：

```bash
cat > .env <<EOF
SECRET_KEY=$(openssl rand -hex 32)
PG_PASSWORD=$(openssl rand -hex 16)
EOF
chmod 600 .env
docker compose up -d
```

打开 <http://127.0.0.1:8080>，注册账号 → 建组织 → 建项目 → 到「令牌」页面创建访问令牌。

`127.0.0.1` 和 `localhost` 被当作两个不同的源，分别模拟主站和 html 页面的隔离域名；本地是 http，所以要 `COOKIE_SECURE=0`。

### 连接 agent

从 [GitHub Releases](https://github.com/longmon/team-kanban/releases) 下载 `tkanban`（macOS / Linux / Windows），然后：

```bash
tkanban add my --url http://127.0.0.1:8080 --default     # 按提示粘贴令牌
tkanban test
claude mcp add team-kanban -s user -- "$(command -v tkanban)" mcp   # Claude Code
codex mcp add team-kanban -- tkanban mcp                             # Codex
```

之后直接对 agent 说，比如“发一个投票到 Team Kanban，问大家用哪个消息队列”。

### 生产部署

需要**两个域名**都解析到服务器，例如 `kanban.example.com`（主站）和 `pages.example.com`（html 页面，必须是另一个主机名，不能用子路径），并在应用前面加 HTTPS。

1. `.env` 里加上：

   ```bash
   PUBLIC_URL=https://kanban.example.com
   PAGES_ORIGIN=https://pages.example.com
   COOKIE_SECURE=1
   TRUST_PROXY=1
   ```

2. 在 compose 里加反向代理。用英文部分 [Production](#production) 第 2 步的 Caddy 服务和 `Caddyfile` 即可，证书由 Let's Encrypt 自动签发。应用按 `Host` 头区分两个域名。开了 `TRUST_PROXY=1` 后，8080 端口只能绑 `127.0.0.1`（或者去掉 `ports:`），否则别人可以绕过代理直连并伪造 `X-Forwarded-For`。

3. `docker compose up -d`。注册完第一个账号后，如果只想凭邀请注册，设 `ALLOW_SIGNUP=0` 再执行一次 `docker compose up -d`。

前面用 Cloudflare 代理（橙云）时，SSL 模式选 **Full (strict)**。仓库里的 [Caddyfile](https://github.com/longmon/team-kanban/blob/main/Caddyfile) 是加固版：只信任 Cloudflare 的 IP 段，客户端 IP 取 `CF-Connecting-IP`。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | 必填 | PostgreSQL 连接串 |
| `SECRET_KEY` | 必填 | ≥ 32 字节随机串（`openssl rand -hex 32`）。要固定不变：更换后，临时链接访客需要重新打开链接，未使用的 html 页面地址失效 |
| `PUBLIC_URL` | 必填 | 主站地址，结尾不带 `/` |
| `PAGES_ORIGIN` | 空 | html 页面的独立源。**生产必须配**；不配时 html 页面只靠 iframe sandbox 隔离 |
| `COOKIE_SECURE` | `1` | 本地 http 设为 `0` |
| `TRUST_PROXY` | `0` | 在反向代理后面设为 `1`（从 `X-Forwarded-For` 取客户端 IP，用于限流） |
| `ALLOW_SIGNUP` | `1` | `0` = 只能凭邀请注册 |
| `SMTP_URL` / `SMTP_FROM` | 空 | 例如 `smtps://user:pass@smtp.example.com:465` / `Team Kanban <noreply@example.com>`；不配时邮件内容只写进日志 |
| `BIND` | `0.0.0.0:8080` | 监听地址 |
| `RUST_LOG` | `info` | 日志级别 |

### 使用外部 PostgreSQL

把 `DATABASE_URL` 指向你的数据库，去掉 `pg` 服务即可。要求：

- 一个空库，连接账号要能在库里建表、改表。
- **不支持加密连接**：服务端目前没有编译数据库 TLS 支持，强制 `sslmode=require` 的托管数据库连不上，数据库请放在内网。
- 不要接 PgBouncer 的事务模式（迁移用了会话级的 advisory lock）。
- PostgreSQL 装在宿主机上时，主机名写 `host.docker.internal`；Linux 上还要给 `team-kanban-mcp-server` 服务加 `extra_hosts: ["host.docker.internal:host-gateway"]`。

### 运维

- **升级**：`docker compose pull team-kanban-mcp-server && docker compose up -d team-kanban-mcp-server`。启动时会自动迁移，升级前先备份；新迁移执行后再回退旧镜像，需要先手动撤销那次迁移。
- **备份**：`docker compose exec -T pg pg_dump -U postgres -Fc kanban > kanban-$(date +%F).dump`
- **恢复**：`docker compose exec -T pg pg_restore -U postgres -d kanban --clean < kanban-YYYY-MM-DD.dump`
- **日志**：`docker compose logs -f team-kanban-mcp-server`
- **健康检查**：`GET /healthz` 返回 200。
- **只能单实例**：限流和长轮询通知都在进程内，一个数据库只跑一个 `team-kanban-mcp-server` 容器。
