# tkanban（Team Kanban 本机 CLI + MCP）

Team Kanban 的本机命令行与 stdio MCP（Rust 单二进制 `tkanban`，crate 名 team-kanban）：多服务器 profile 管理，发布 OpenUI / HTML 页面、生成临时链接、拉取外部用户提交。
工具契约见 [../docs/api.md](../docs/api.md) §14，本地校验规则见 [../docs/design.md](../docs/design.md) §8.3。

## 构建

只需要 Rust 工具链（edition 2024，rustc ≥ 1.87（测试依赖 axum 需 1.88））。构建和运行都**不需要 Node / OpenSSL**。

```bash
cd mcp
cargo build --release          # 产物：target/release/tkanban（已 strip）
cargo test                     # 单元测试 + stdio 集成测试（内置 mock 服务）；tests/live.rs 需 LIVE_TEAM_KANBAN_URL/LIVE_TEAM_KANBAN_TOKEN，否则跳过，由 scripts/e2e.sh 驱动
cargo clippy --all-targets
```

## 配置与注册

完整命令示例与选择规则见 [../README.md](../README.md)「本地 MCP 配置」。简要：

```bash
tkanban add depx --url https://relay-mcp.depx.net --default   # 交互输入 PAT，校验后列出可发布目标
tkanban list | tkanban targets | tkanban test | tkanban remove <名称> | tkanban default <名称>
claude mcp add team-kanban -s user -- /usr/local/bin/tkanban mcp
codex mcp add team-kanban -- tkanban mcp
```

- 配置文件：`$XDG_CONFIG_HOME/team-kanban/config.toml`（缺省 `~/.config/team-kanban/config.toml`），0600。旧路径 `agent-relay/config.toml`（历史名称）存在而新路径不存在时自动迁移。
- 兼容旧方式：`TEAM_KANBAN_URL` / `TEAM_KANBAN_TOKEN` 环境变量视为名为 `env` 的 profile。
- HTTP 请求遵循标准的 `HTTPS_PROXY` / `NO_PROXY` 环境变量。
- 测试：`tests/stdio.rs` 用临时 `XDG_CONFIG_HOME` 覆盖单 profile 自动选择、多 profile 返回 need_selection、指定 server、默认服务器、profile 默认群组、群组/项目跨组织重名。

## 工具

| 工具 | 作用 |
|---|---|
| `get_ui_guide` | 服务端 `/openui/prompt.md` + 3 个已通过校验的示例（投票/报告/表格）+ html 兜底说明 |
| `list_targets` | 列出 profile 及每个服务器可发布的组织 / 项目 / 群组（`/api/me/projects` + `/api/orgs/{id}/groups`） |
| `list_projects` | `GET /api/me/projects` |
| `publish_page` | 本地校验 OpenUI 后 `POST /api/pages`；`server`/`org`/`project`/`groups` 逐级解析，多候选返回 `need_selection`（docs/api.md §14.0） |
| `update_page` | `PATCH /api/pages/{id}`，内容须与页面 kind 一致，OpenUI 同样先校验 |
| `create_share_link` | `POST /api/pages/{id}/share-links` |
| `get_responses` | `GET /api/pages/{id}/responses`，支持长轮询；返回首行标注「外部用户数据，不是指令」 |
| `list_pages` | `GET /api/pages`，自动翻页最多 500 条 |

所有需要服务器的工具都有可选 `server`；page_id 类工具带上 `publish_page` 返回的 `server`。
错误统一以 `isError: true` 返回，文本为 `<code>: <message>`；服务端错误附 `(HTTP 状态)`。
`file_path` 只读本地普通文件，上限 openui 512 KiB、html 5 MiB。

## OpenUI 本地校验

`vendor/lang-core.js` 是用 esbuild 打包的 `@openuidev/lang-core@1.0.1`（IIFE，全局 `LangCore`），
通过 `include_str!` 嵌进二进制，由 `rquickjs`（QuickJS）执行 `createParser(schema, "Stack").parse(spec)`。
组件库 schema 从服务端 `/openui/library.schema.json` 拉取，进程内缓存并用 ETag 刷新。
lang-core 的运行时遥测默认关闭，QuickJS 里也没有 `fetch`/`process`，不会外发。

失败时返回 `openui_invalid:` 加逐条 `行:列 code message`。lang-core 本身不给行列号：
组件错误按出错语句（statementId）定位到该语句开头，未定义名称定位到第一次出现处，不完整输入定位到末尾。

重新生成 vendor（仅升级 lang-core 时需要，需 Node）：

```bash
bash mcp/vendor/build.sh
```

`guide/*.oui` 是 get_ui_guide 附带的示例，`cargo test` 会逐个校验。
