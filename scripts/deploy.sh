#!/bin/bash
# 本机一键部署：scripts/deploy.sh user@host（或设置 DEPLOY_HOST），打包 HEAD（只含已提交内容）上传到 /opt/agent-relay 并构建重启。
# 服务器上 /opt/agent-relay/deploy.sh 是本文件的软链，带 --remote 时就地构建重启。
set -euo pipefail
DIR=/opt/agent-relay

if [ "${1:-}" = "--remote" ]; then
	cd "$DIR"
	ln -sf scripts/deploy.sh deploy.sh
	ln -sf scripts/cf-firewall.sh cf-firewall.sh
	[ -f cf-trusted.caddy ] || ./cf-firewall.sh
	docker compose up -d --build --remove-orphans
	docker image prune -f >/dev/null
	docker compose ps
	exit 0
fi

HOST=${1:-${DEPLOY_HOST:?用法：scripts/deploy.sh user@host，或设置 DEPLOY_HOST}}
cd "$(git rev-parse --show-toplevel)"
[ -z "$(git status --porcelain)" ] || echo "警告：有未提交改动，不会被部署（只打包 HEAD）" >&2
# 先清掉源码目录，避免改名/删除的文件残留（.env、备份等服务器本地文件不在这些目录里）
git archive --format=tar.gz HEAD | ssh "$HOST" "mkdir -p $DIR && cd $DIR && rm -rf docs mcp scripts server web && tar xzf - && $DIR/scripts/deploy.sh --remote"
