-- 0011 全站超级管理员与账号禁用。契约见 docs/api.md §15、docs/design.md §5.5。
-- users.is_superadmin：平台级角色，与组织角色独立；只能由 SUPERADMIN_EMAILS 环境变量（启动时幂等授予）或其他超管授予。
-- users.disabled_at：非空 = 已禁用；会话与 PAT 鉴权（auth.rs load_session / load_pat）都 JOIN users 过滤，登录返回 account_disabled。
-- 带常量默认值的 NOT NULL ADD COLUMN 与可空无默认值的 ADD COLUMN 在 PG11+ 都只改元数据（不重写表）；
-- 旧用户全部为 is_superadmin = false、disabled_at = NULL，行为不变。不建索引：超管/禁用筛选只在超管面板里按 users 主键分页扫描。
-- lock_timeout：拿不到 users 的 ACCESS EXCLUSIVE 锁 5 秒即失败退出，不会长时间排队阻塞全站登录/鉴权。
SET LOCAL lock_timeout = '5s';

ALTER TABLE users ADD COLUMN is_superadmin boolean NOT NULL DEFAULT false, ADD COLUMN disabled_at timestamptz;
