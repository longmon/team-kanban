-- 0006 项目群组 + PAT manage scope。契约见 docs/api.md §4.5、§6。
-- groups.project_id：非空 = 专属某个项目的「项目群组」（创建时自动授权给该项目）；NULL = 组织级群组（旧数据全部是 NULL，行为不变）。
-- 可空无默认值的 ADD COLUMN 只改元数据（不重写表）；复合外键与唯一索引校验/构建时扫一遍 groups（群组表很小，毫秒级）。
-- 名称唯一性拆成两个部分唯一索引：组织级群组仍按 (org_id, lower(name)) 唯一；项目群组按 (project_id, lower(name)) 唯一，
-- 不同项目可以有同名群组。项目群组索引同时服务「按项目列群组」查询。
-- 活跃群组（4 小时内有页面发给它）实时由 page_groups(group_id) 索引 + pages 主键算出，不加冗余列、不加新索引。
-- personal_access_tokens.scopes 允许新增 manage（建项目、建群组）；换 CHECK 约束扫一遍 PAT 表（行数很少）。
-- lock_timeout：拿不到 groups / projects / personal_access_tokens 的锁 5 秒即失败退出，不会长时间排队阻塞全站读写。
SET LOCAL lock_timeout = '5s';

ALTER TABLE groups ADD COLUMN project_id uuid;

-- 项目硬删除时级联删除其项目群组（项目平时是软删除，查询处过滤 deleted_at）
ALTER TABLE groups
    ADD CONSTRAINT groups_project_fk FOREIGN KEY (org_id, project_id)
        REFERENCES projects (org_id, id) ON DELETE CASCADE;

DROP INDEX groups_org_name_key;
CREATE UNIQUE INDEX groups_org_name_key ON groups (org_id, lower(name)) WHERE project_id IS NULL;
CREATE UNIQUE INDEX groups_project_name_key ON groups (project_id, lower(name)) WHERE project_id IS NOT NULL;

ALTER TABLE personal_access_tokens
    DROP CONSTRAINT pat_scopes_check,
    ADD CONSTRAINT pat_scopes_check CHECK (
        cardinality(scopes) >= 1 AND scopes <@ ARRAY['publish', 'read_responses', 'manage']::text[]);
