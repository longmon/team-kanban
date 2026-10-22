-- 0002 页面分类。契约见 docs/design.md §3.3、docs/api.md §7。
-- 旧页面全部得到 page_type='general'（收集类，行为与改动前完全一致）。
-- category 不入库：read = report/knowledge/flowchart/architecture；collect = vote/general；collab = requirement/task/task_tree。
-- 常量默认值的 ADD COLUMN 只改元数据（PG11+ 不重写表）；CHECK 校验扫一遍 pages 主表（大字段在 TOAST 不读）。
-- lock_timeout：拿不到 pages 的锁 5 秒即失败退出，不会长时间排队阻塞全站读写。
SET LOCAL lock_timeout = '5s';

ALTER TABLE pages ADD COLUMN page_type text NOT NULL DEFAULT 'general';

ALTER TABLE pages
    ADD CONSTRAINT pages_page_type_check CHECK (page_type IN
        ('general', 'report', 'knowledge', 'flowchart', 'architecture', 'vote', 'requirement', 'task', 'task_tree')),
    -- 只读类不接受提交
    ADD CONSTRAINT pages_read_only_check CHECK (
        page_type NOT IN ('report', 'knowledge', 'flowchart', 'architecture') OR NOT accept_responses),
    -- 协作类的任务/评论由前端原生渲染，说明区只支持 OpenUI
    ADD CONSTRAINT pages_collab_kind_check CHECK (
        page_type NOT IN ('requirement', 'task', 'task_tree') OR kind = 'openui');
