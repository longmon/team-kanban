-- 0005 截止时间、卡片摘要、关键数字，以及首页动态流索引。契约见 docs/api.md §7。
-- closes_at：截止时间，到期后不再接受提交（view 的 submit_block_reason = "closed"）；summary：卡片摘要；highlights：卡片上的关键数字。
-- 可空无默认值的 ADD COLUMN 只改元数据（不重写表）；CHECK 校验扫一遍 pages 主表（新列全为 NULL，大字段在 TOAST 不读）。
-- 两个索引供 GET /api/activity 按组织取最近事件：普通 CREATE INDEX（sqlx 迁移在事务里，不能 CONCURRENTLY），
-- 建索引期间对 responses / page_versions 持 SHARE 锁（阻塞提交与发布/改版写入，不阻塞读），耗时与表行数成正比（10 万行约 0.1–0.3s）。
-- lock_timeout：拿不到锁 5 秒即失败退出，不会长时间排队阻塞全站读写。
SET LOCAL lock_timeout = '5s';

ALTER TABLE pages
    ADD COLUMN closes_at timestamptz,
    ADD COLUMN summary text,
    ADD COLUMN highlights jsonb;

-- highlights：1..4 项的数组，每项 {label, value} 均为 1..20 字符的字符串（应用层另做 trim 与多余字段校验）
ALTER TABLE pages
    ADD CONSTRAINT pages_summary_check CHECK (summary IS NULL OR char_length(summary) BETWEEN 1 AND 300),
    ADD CONSTRAINT pages_highlights_check CHECK (highlights IS NULL OR (
        jsonb_typeof(highlights) = 'array' AND jsonb_array_length(highlights) BETWEEN 1 AND 4
        AND jsonb_array_length(jsonb_path_query_array(highlights,
              '$[*] ? (@.label like_regex "^.{1,20}$" flag "s" && @.value like_regex "^.{1,20}$" flag "s")'))
            = jsonb_array_length(highlights)));

CREATE INDEX responses_org_created_idx ON responses (org_id, created_at DESC);
CREATE INDEX page_versions_org_created_idx ON page_versions (org_id, created_at DESC);
