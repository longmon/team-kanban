#!/bin/bash
# 可重复执行（服务器上 root 跑，cron 每周刷新）：firewalld public 区只放 ssh，80/443 只对 Cloudflare 段放行；
# 同时生成 ../cf-trusted.caddy（Caddy trusted_proxies）并在 caddy 运行时热加载。
set -euo pipefail
dir=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
v4=$(curl -fsS --max-time 20 https://www.cloudflare.com/ips-v4)
v6=$(curl -fsS --max-time 20 https://www.cloudflare.com/ips-v6)
[ -n "$v4" ] && [ -n "$v6" ] || { echo "拉取 CF IP 段失败" >&2; exit 1; }

systemctl is-active -q firewalld || systemctl enable --now firewalld
fw="firewall-cmd --permanent"
$fw --get-ipsets | grep -qw cf4 || $fw --new-ipset=cf4 --type=hash:net --option=family=inet >/dev/null
$fw --get-ipsets | grep -qw cf6 || $fw --new-ipset=cf6 --type=hash:net --option=family=inet6 >/dev/null
for s in cf4 cf6; do for e in $($fw --ipset=$s --get-entries); do $fw --ipset=$s --remove-entry="$e" >/dev/null; done; done
for e in $v4; do $fw --ipset=cf4 --add-entry="$e" >/dev/null; done
for e in $v6; do $fw --ipset=cf6 --add-entry="$e" >/dev/null; done
for svc in $($fw --zone=public --list-services); do [ "$svc" = ssh ] || $fw --zone=public --remove-service="$svc" >/dev/null; done
$fw --zone=public --query-service=ssh >/dev/null || $fw --zone=public --add-service=ssh >/dev/null
for p in $($fw --zone=public --list-ports); do $fw --zone=public --remove-port="$p" >/dev/null; done
for s in cf4 cf6; do for port in 80 443; do
	r="rule source ipset=$s port port=$port protocol=tcp accept"
	$fw --zone=public --query-rich-rule="$r" >/dev/null || $fw --zone=public --add-rich-rule="$r" >/dev/null
done; done
firewall-cmd --reload >/dev/null

# 原地覆盖（保持 inode，bind mount 能看到新内容）
echo "trusted_proxies static" $v4 $v6 > "$dir/cf-trusted.caddy"
if docker compose -f "$dir/docker-compose.yml" ps -q caddy 2>/dev/null | grep -q .; then
	docker compose -f "$dir/docker-compose.yml" --env-file "$dir/.env" exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null
fi
echo "cf4=$(echo $v4 | wc -w) cf6=$(echo $v6 | wc -w) 已应用"
