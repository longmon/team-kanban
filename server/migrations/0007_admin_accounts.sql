-- 0007 管理员直接建账号。契约见 docs/api.md §3、§4.2。
-- users.must_change_password：管理员建的账号（或管理员重置过一次性密码的账号）为 true，首次登录后必须先改密码，
-- 改完前会话只能调用 GET /auth/me、POST /auth/password/change、POST /auth/logout（auth.rs 统一拦截）。
-- 带常量默认值的 NOT NULL ADD COLUMN 在 PG11+ 只改元数据（不重写表）；旧用户全部为 false，行为不变。
-- lock_timeout：拿不到 users 的 ACCESS EXCLUSIVE 锁 5 秒即失败退出，不会长时间排队阻塞全站登录/鉴权。
SET LOCAL lock_timeout = '5s';

ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
