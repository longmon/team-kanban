-- 0004 页面版本快照。契约见 docs/api.md §7。
-- 每次 content 变化（pages.version +1）在同一事务写一行；查看页可切换历史版本，/h/{page_id}/{version} 可取历史 html。
-- 当前版本以 pages 为准（旧代码并存/回滚期间写的版本可能缺快照行，读取端兼容）。
-- 先建表、回填，最后再加到 pages 的外键：回填期间只对 pages 加 ACCESS SHARE（不阻塞读写，也不逐行加 KEY SHARE 行锁）；
-- ADD CONSTRAINT 时对 pages 加 SHARE ROW EXCLUSIVE（阻塞 pages 写入）并做一次连接校验，持有到本迁移提交（10 万页实测约 50ms）。
-- 回填复制每个页面的当前 content（含已软删页面），耗时与 pages 总内容大小成正比（实测 10 万页、pages 72MB：冷缓存约 3s、热缓存约 0.5s）；created_by 未知记 NULL，created_at 取 updated_at。
-- 回填期间旧代码并发改出的新版本可能漏快照行：当前版本读取以 pages 为准，不受影响。
-- lock_timeout：拿不到 pages 的锁 5 秒即失败退出，不会长时间排队阻塞全站读写。
SET LOCAL lock_timeout = '5s';

CREATE TABLE page_versions (
    org_id     uuid NOT NULL,
    page_id    uuid NOT NULL,
    version    integer NOT NULL,
    title      text NOT NULL,
    kind       text NOT NULL,
    content    text NOT NULL,
    created_by uuid REFERENCES users(id),      -- 产生该版本的用户；回填行为 NULL
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (page_id, version),
    CONSTRAINT page_versions_kind_check CHECK (kind IN ('openui', 'html')),
    CONSTRAINT page_versions_version_positive CHECK (version >= 1)
);

INSERT INTO page_versions (org_id, page_id, version, title, kind, content, created_by, created_at)
SELECT org_id, id, version, title, kind, content, NULL, updated_at FROM pages;

ALTER TABLE page_versions
    ADD CONSTRAINT page_versions_page_fk FOREIGN KEY (org_id, page_id)
        REFERENCES pages (org_id, id) ON DELETE CASCADE;
