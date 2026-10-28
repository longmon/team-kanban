-- 0008 接口文档页面类型。契约见 docs/api.md §7.0、§7.5。
-- 新增 page_type='api_doc'（只读类）与 kind='api'（content 存规范化 JSON，≤512KiB），两者必须同时出现。
-- 只放宽/新增 CHECK，旧数据（kind 只有 openui/html，page_type 不含 api_doc）全部满足，不改任何行。
-- 先 DROP 再以 NOT VALID 加回：ADD 只改元数据（不扫表），对新写入立即生效；随后 VALIDATE 扫一遍 pages / page_versions 主表
-- （只读 kind/page_type/accept_responses 等行内列，content 大字段在 TOAST；octet_length(content) 对 TOAST 值只读长度头）。
-- 整个迁移在一个事务里，pages / page_versions 的 ACCESS EXCLUSIVE 锁持有到提交。
-- lock_timeout：拿不到锁 5 秒即失败退出，不会长时间排队阻塞全站读写。
SET LOCAL lock_timeout = '5s';

ALTER TABLE pages
    DROP CONSTRAINT pages_kind_check,
    DROP CONSTRAINT pages_content_size,
    DROP CONSTRAINT pages_page_type_check,
    DROP CONSTRAINT pages_read_only_check,
    ADD CONSTRAINT pages_kind_check CHECK (kind IN ('openui', 'html', 'api')) NOT VALID,
    ADD CONSTRAINT pages_content_size CHECK (
        (kind IN ('openui', 'api') AND octet_length(content) <= 524288) OR
        (kind = 'html'             AND octet_length(content) <= 5242880)) NOT VALID,
    ADD CONSTRAINT pages_page_type_check CHECK (page_type IN
        ('general', 'report', 'knowledge', 'flowchart', 'architecture', 'api_doc', 'vote', 'requirement', 'task', 'task_tree')) NOT VALID,
    -- 只读类不接受提交
    ADD CONSTRAINT pages_read_only_check CHECK (
        page_type NOT IN ('report', 'knowledge', 'flowchart', 'architecture', 'api_doc') OR NOT accept_responses) NOT VALID,
    -- 接口文档 ⇔ kind=api
    ADD CONSTRAINT pages_api_doc_kind_check CHECK ((page_type = 'api_doc') = (kind = 'api')) NOT VALID;

ALTER TABLE page_versions
    DROP CONSTRAINT page_versions_kind_check,
    ADD CONSTRAINT page_versions_kind_check CHECK (kind IN ('openui', 'html', 'api')) NOT VALID;

ALTER TABLE pages VALIDATE CONSTRAINT pages_kind_check;
ALTER TABLE pages VALIDATE CONSTRAINT pages_content_size;
ALTER TABLE pages VALIDATE CONSTRAINT pages_page_type_check;
ALTER TABLE pages VALIDATE CONSTRAINT pages_read_only_check;
ALTER TABLE pages VALIDATE CONSTRAINT pages_api_doc_kind_check;
ALTER TABLE page_versions VALIDATE CONSTRAINT page_versions_kind_check;
