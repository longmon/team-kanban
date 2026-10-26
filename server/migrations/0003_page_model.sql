-- 0003 页面生成模型。契约见 docs/api.md §7。
-- generated_by：生成页面内容的 AI 模型名称（如 "Claude Opus 5.5"），由发布/更新时的 model 字段写入；旧页面为 NULL（不显示）。
-- 可空无默认值的 ADD COLUMN 只改元数据（不重写表）；CHECK 校验扫一遍 pages 主表（新列全为 NULL，大字段在 TOAST 不读）。
-- lock_timeout：拿不到 pages 的锁 5 秒即失败退出，不会长时间排队阻塞全站读写。
SET LOCAL lock_timeout = '5s';

ALTER TABLE pages ADD COLUMN generated_by text;

ALTER TABLE pages
    ADD CONSTRAINT pages_generated_by_check CHECK (generated_by IS NULL OR char_length(generated_by) BETWEEN 1 AND 100);
