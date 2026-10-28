-- 0010 页面「关闭」：关闭后只有发布者与项目管理员能看、任何人不能提交。契约见 docs/api.md §7.7、docs/design.md §5.3。
-- 两列都可空、无默认值：ADD COLUMN 只改元数据（不重写表）；旧页面 closed_at 为 NULL，行为不变。
-- 部分索引只收已关闭页面（上线时为空），供动态流取「X 关闭了 Y」；建索引扫一遍 pages 主表（大字段在 TOAST 不读），期间阻塞 pages 写入、不阻塞读。
-- lock_timeout：拿不到 pages 的锁 5 秒即失败退出，不会长时间排队阻塞全站读写。
SET LOCAL lock_timeout = '5s';

ALTER TABLE pages ADD COLUMN closed_at timestamptz, ADD COLUMN closed_by uuid;

CREATE INDEX pages_closed_idx ON pages (org_id, closed_at DESC) WHERE closed_at IS NOT NULL;
