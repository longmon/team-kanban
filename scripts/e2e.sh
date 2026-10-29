#!/usr/bin/env bash
# 端到端联调：临时库 → 构建并启动服务 → MCP 冒烟（mcp/tests/live.rs）→ 浏览器 e2e（web/e2e/e2e.mjs）→ 清理。
# 依赖：cargo、node、curl、jq；PostgreSQL（本机 psql，或 docker 容器 $PG_CONTAINER）；playwright 的 chromium headless shell。
# 可调环境变量：
#   PG_URL        不带库名的连接串，默认 postgres://postgres:dev@127.0.0.1:55432
#   PG_CONTAINER  没有 psql 时用来执行建库/删库的容器名，默认 agent-relay-pg
#   PORT          服务端口，默认从 8080 起找空闲端口
#   SKIP_BUILD=1  跳过 web / server 构建
#   CHROME        浏览器可执行文件路径
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PG_URL=${PG_URL:-postgres://postgres:dev@127.0.0.1:55432}
PG_CONTAINER=${PG_CONTAINER:-agent-relay-pg}
DB=relay_e2e_$(date +%s)_$$
OUT=$(mktemp -d -t tkanban-e2e.XXXXXX)
export OPENUI_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY

pgq() {
  if command -v psql >/dev/null; then psql "$PG_URL/postgres" -qc "$1"; else docker exec "$PG_CONTAINER" psql -U postgres -qc "$1"; fi
}
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

if [[ -z "${PORT:-}" ]]; then
  PORT=8080
  until port_free "$PORT"; do PORT=$((PORT + 1)); done
fi
BASE=http://127.0.0.1:$PORT

SERVER_PID=
cleanup() {
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null || true
  pgq "DROP DATABASE IF EXISTS $DB WITH (FORCE)" || true
  echo "日志与截图：$OUT"
}
trap cleanup EXIT

if [[ "${SKIP_BUILD:-}" != 1 ]]; then
  echo "== 构建 web / server"
  (cd "$ROOT/web" && npm run build >"$OUT/web-build.log" 2>&1)
  (cd "$ROOT/server" && cargo build --release -q)
fi

echo "== 临时库 $DB，服务 $BASE（PAGES_ORIGIN=http://localhost:$PORT）"
pgq "CREATE DATABASE $DB"
SA_EMAIL=root@example.com SA_PASSWORD=rootpass12345
start_server() {
  DATABASE_URL=$PG_URL/$DB PUBLIC_URL=$BASE PAGES_ORIGIN=http://localhost:$PORT BIND=127.0.0.1:$PORT \
    SECRET_KEY=e2e-secret-key-0123456789abcdef0123456789 COOKIE_SECURE=0 RUST_LOG=info SUPERADMIN_EMAILS=$SA_EMAIL \
    "$ROOT/server/target/release/relay" >>"$OUT/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 50); do curl -sf "$BASE/openui/prompt.md" >/dev/null && break; sleep 0.2; done
}
start_server
# 首个超管：先注册，再重启让 SUPERADMIN_EMAILS 生效（与部署文档一致）
curl -sf -H 'Content-Type: application/json' -d "{\"email\":\"$SA_EMAIL\",\"password\":\"$SA_PASSWORD\",\"display_name\":\"Root\"}" "$BASE/api/auth/register" >/dev/null
kill "$SERVER_PID" && wait "$SERVER_PID" 2>/dev/null || true
start_server
curl -sf "$BASE/" | grep -q '<div id="root">' || { echo "首页不是 SPA，web/dist 没嵌进去？"; exit 1; }
curl -sf "$BASE/openui/library.schema.json" | jq -e . >/dev/null

echo "== 建 MCP 用户 / 组织 / 项目 / PAT"
J='Content-Type: application/json'
JAR=$OUT/alice.jar
CSRF=$(curl -sf -c "$JAR" -H "$J" -d '{"email":"alice@example.com","password":"alicepass123","display_name":"Alice"}' "$BASE/api/auth/register" | jq -r .csrf_token)
H=(-sf -b "$JAR" -H "$J" -H "X-CSRF-Token: $CSRF")
ORG=$(curl "${H[@]}" -d '{"name":"Acme","slug":"acme"}' "$BASE/api/orgs" | jq -r .id)
PROJ=$(curl "${H[@]}" -d '{"name":"Demo","slug":"demo"}' "$BASE/api/orgs/$ORG/projects" | jq -r .id)
TOKEN=$(curl "${H[@]}" -d '{"name":"mcp","scopes":["publish","read_responses"]}' "$BASE/api/tokens" | jq -r .token)
# 第二个成员 Bob（项目 viewer）：任务树冒烟里当另一位评审人
JAR2=$OUT/bob.jar
BOB=$(curl -sf -c "$JAR2" -H "$J" -d '{"email":"bob@example.com","password":"bobpass12345","display_name":"Bob"}' "$BASE/api/auth/register")
H2=(-sf -b "$JAR2" -H "$J" -H "X-CSRF-Token: $(jq -r .csrf_token <<<"$BOB")")
INV=$(curl "${H[@]}" -d '{"target_type":"org","role":"member"}' "$BASE/api/orgs/$ORG/invites" | jq -r .url)
curl "${H2[@]}" -d '{}' "$BASE/api/invites/by-token/${INV##*/}/accept" >/dev/null
curl "${H[@]}" -d "{\"user_id\":\"$(jq -r .user.id <<<"$BOB")\",\"role\":\"viewer\"}" "$BASE/api/projects/$PROJ/members" >/dev/null
TOKEN2=$(curl "${H2[@]}" -d '{"name":"mcp","scopes":["publish"]}' "$BASE/api/tokens" | jq -r .token)

echo "== MCP 冒烟"
(cd "$ROOT/mcp" && LIVE_TEAM_KANBAN_URL=$BASE LIVE_TEAM_KANBAN_TOKEN=$TOKEN LIVE_TEAM_KANBAN_TOKEN2=$TOKEN2 LIVE_REVIEWER_EMAIL=bob@example.com \
  cargo test -q --test live -- --nocapture)

echo "== 浏览器 e2e"
(cd "$ROOT/web" && BASE=$BASE SA_EMAIL=$SA_EMAIL SA_PASSWORD=$SA_PASSWORD node e2e/e2e.mjs "$OUT")

echo "== 全部通过"
