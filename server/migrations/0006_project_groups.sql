-- 0006 项目群组 + PAT manage scope。契约见 docs/api.md §4.5、§6。
-- groups.project_id：非空 = 专属某个项目的「项目群组」（创建时自动授权给该项目）；NULL = 组织级群组（旧数据全部是 NULL，行为不变）。
-- 可空无默认值的 ADD COLUMN 只改元数据（不重写表）；复合外键与唯一索引校验/构建时扫一遍 groups（群组表很小，毫秒级）。
-- 名称唯一性拆成两个部分唯一索引：组织级群组仍按 (org_id, lower(name)) 唯一；项目群组按 (project_id, lower(name)) 唯一，
-- 不同项目可以有同名群组；项目群组与本组织的组织级群组不能同名（跨两类无法用索引表达，由应用层在组织级 advisory 锁内检查）。
-- 活跃群组（4 小时内有页面发给它）实时计算，不加冗余列；为它新增 pages (project_id, updated_at DESC) 部分索引（见文件末尾）。
-- personal_access_tokens.scopes 允许新增 manage（建项目、建群组）；换 CHECK 约束扫一遍 PAT 表（行数很少）。
-- lock_timeout：拿不到 groups / projects / pages / personal_access_tokens 的锁 5 秒即失败退出，不会长时间排队阻塞全站读写。
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

-- GET /projects/{id}/groups 取本项目最近更新的页面算各群组 last_page_at / active（有上界，见 routes/orgs.rs GROUP_RECENT_SCAN）。
-- 普通 CREATE INDEX（sqlx 迁移在事务里，不能 CONCURRENTLY），建索引期间对 pages 持 SHARE 锁（阻塞发布/更新页面，不阻塞读），
-- 耗时与 pages 行数成正比（20 万行本地实测见迁移报告）；只索引未删除页面。
CREATE INDEX pages_project_updated_idx ON pages (project_id, updated_at DESC) WHERE deleted_at IS NULL;
