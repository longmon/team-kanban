#!/usr/bin/env bash
# 重新生成 vendor/lang-core.js（仅开发期需要 Node；cargo build 与运行时不需要）。
# 用法：bash mcp/vendor/build.sh
set -euo pipefail
cd "$(dirname "$0")"
export OPENUI_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
PROXY=(--proxy=http://127.0.0.1:12000 --https-proxy=http://127.0.0.1:12000)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
npm init -y >/dev/null
npm install "${PROXY[@]}" --no-audit --no-fund --ignore-scripts @openuidev/lang-core@1.0.1 zod@4 esbuild@0.25
echo 'export { createParser } from "@openuidev/lang-core";' > entry.mjs
# IIFE：执行后 globalThis.LangCore.createParser 可用
npx "${PROXY[@]}" --no-install esbuild entry.mjs --bundle --format=iife --global-name=LangCore \
  --platform=neutral --target=es2020 --minify --legal-comments=none --outfile=lang-core.js
{ echo "// @openuidev/lang-core@1.0.1 (MIT) bundled by vendor/build.sh — do not edit"; cat lang-core.js; } > "$OLDPWD/lang-core.js"
ls -l "$OLDPWD/lang-core.js"
