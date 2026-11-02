-- 0012 需求页面（对外英文名 Story，接口 /api/stories、编号 STORY-12；内部 page_type 与表名沿用 requirement）。契约见 docs/api.md §7.8、docs/design.md §3.3「需求」。
-- 需求本身仍是一行 pages（kind = openui、content = 空 Stack，满足 0002 的 pages_collab_kind_check），扩展字段放在新表里。
-- 只新建表与索引，不改任何已有表、不回填数据：旧页面、旧群组行为不变。
-- 新表的外键引用 pages / projects / users / memberships / groups：CREATE TABLE 时对被引用表短暂持 SHARE ROW EXCLUSIVE 锁
-- （阻塞这些表的写入，不阻塞读；新表为空无需校验，毫秒级）。
-- lock_timeout：拿不到锁 5 秒即失败退出，不会长时间排队阻塞全站读写。
SET LOCAL lock_timeout = '5s';

-- 需求编号计数器：每个项目一行。分配编号用
--   INSERT ... ON CONFLICT (project_id) DO UPDATE SET last_no = last_no + 1 RETURNING last_no
-- 行锁串行化同一项目的并发创建，编号项目内唯一递增（事务回滚时编号会空一个，可接受）
CREATE TABLE requirement_counters (
    org_id     uuid NOT NULL,
    project_id uuid PRIMARY KEY,
    last_no    integer NOT NULL,
    CONSTRAINT requirement_counters_project_fk FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id) ON DELETE CASCADE,
    CONSTRAINT requirement_counters_positive CHECK (last_no >= 1)
);

-- 需求扩展字段：一页一行
CREATE TABLE requirements (
    page_id     uuid PRIMARY KEY,
    org_id      uuid NOT NULL,
    project_id  uuid NOT NULL,
    number      integer NOT NULL,                 -- 项目内编号，显示为 STORY-<number>
    body        text NOT NULL DEFAULT '',         -- 正文 Markdown（图片引用本需求的附件地址）
    priority    text,                             -- P0..P3，可空
    due_at      timestamptz,                      -- 期望完成时间，可空
    status      text NOT NULL DEFAULT 'open',
    group_id    uuid,                             -- 需求群组（认领时自动创建或手动创建的项目群组）；群组被删时置空
    claimed_by  uuid REFERENCES users(id),
    claimed_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT requirements_org_page_key UNIQUE (org_id, page_id),
    CONSTRAINT requirements_project_number_key UNIQUE (project_id, number),
    CONSTRAINT requirements_page_fk FOREIGN KEY (org_id, page_id) REFERENCES pages (org_id, id) ON DELETE CASCADE,
    CONSTRAINT requirements_project_fk FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id) ON DELETE CASCADE,
    CONSTRAINT requirements_group_fk FOREIGN KEY (org_id, group_id) REFERENCES groups (org_id, id) ON DELETE SET NULL (group_id),
    CONSTRAINT requirements_number_positive CHECK (number >= 1),
    CONSTRAINT requirements_body_size CHECK (octet_length(body) <= 262144),
    CONSTRAINT requirements_priority_check CHECK (priority IS NULL OR priority IN ('P0', 'P1', 'P2', 'P3')),
    CONSTRAINT requirements_status_check CHECK (status IN ('open', 'analyzing', 'developing', 'in_review', 'done', 'rejected', 'on_hold'))
);
CREATE INDEX requirements_group_idx ON requirements (group_id) WHERE group_id IS NOT NULL;

-- 指派对象：成员或群组（恰好一个非空）
CREATE TABLE requirement_assignees (
    org_id   uuid NOT NULL,
    page_id  uuid NOT NULL,
    user_id  uuid,
    group_id uuid,
    CONSTRAINT requirement_assignees_req_fk FOREIGN KEY (org_id, page_id) REFERENCES requirements (org_id, page_id) ON DELETE CASCADE,
    CONSTRAINT requirement_assignees_user_fk FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id) ON DELETE CASCADE,
    CONSTRAINT requirement_assignees_group_fk FOREIGN KEY (org_id, group_id) REFERENCES groups (org_id, id) ON DELETE CASCADE,
    CONSTRAINT requirement_assignees_one_check CHECK ((user_id IS NULL) <> (group_id IS NULL))
);
-- 首页「等我处理」/ 列表的指派列与 mine：按页面探测（page_id 索引 → 群组成员走 group_members 主键），不扫表
CREATE INDEX requirement_assignees_page_idx ON requirement_assignees (page_id);
-- 同一页不重复指派
CREATE UNIQUE INDEX requirement_assignees_user_key ON requirement_assignees (page_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX requirement_assignees_group_key ON requirement_assignees (page_id, group_id) WHERE group_id IS NOT NULL;
-- 移出组织 / 删群组时外键级联按人、按群组找行
CREATE INDEX requirement_assignees_user_idx ON requirement_assignees (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX requirement_assignees_group_idx ON requirement_assignees (group_id) WHERE group_id IS NOT NULL;

-- 附件：文件存在服务器磁盘（UPLOAD_DIR/<storage_key>），storage_key 为服务端随机生成，与原文件名无关
CREATE TABLE requirement_files (
    id           uuid PRIMARY KEY,
    org_id       uuid NOT NULL,
    page_id      uuid NOT NULL,
    name         text NOT NULL,                   -- 清洗后的原文件名（只用于显示与下载文件名）
    content_type text NOT NULL,                   -- 按内容嗅探 + 扩展名白名单确定
    size         bigint NOT NULL,
    sha256       bytea NOT NULL,
    storage_key  text NOT NULL,
    uploaded_by  uuid NOT NULL REFERENCES users(id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT requirement_files_storage_key_key UNIQUE (storage_key),
    CONSTRAINT requirement_files_req_fk FOREIGN KEY (org_id, page_id) REFERENCES requirements (org_id, page_id) ON DELETE CASCADE,
    CONSTRAINT requirement_files_name_len CHECK (char_length(name) BETWEEN 1 AND 200),
    CONSTRAINT requirement_files_size_check CHECK (size >= 0),
    CONSTRAINT requirement_files_sha_len CHECK (octet_length(sha256) = 32),
    CONSTRAINT requirement_files_key_format CHECK (storage_key ~ '^[A-Za-z0-9_-]{20,64}$')
);
CREATE INDEX requirement_files_page_idx ON requirement_files (page_id, created_at);

-- 补充说明（Markdown）
CREATE TABLE requirement_docs (
    id         uuid PRIMARY KEY,
    org_id     uuid NOT NULL,
    page_id    uuid NOT NULL,
    title      text NOT NULL,
    body       text NOT NULL,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT requirement_docs_req_fk FOREIGN KEY (org_id, page_id) REFERENCES requirements (org_id, page_id) ON DELETE CASCADE,
    CONSTRAINT requirement_docs_title_len CHECK (char_length(title) BETWEEN 1 AND 200),
    CONSTRAINT requirement_docs_body_size CHECK (octet_length(body) BETWEEN 1 AND 262144)
);
CREATE INDEX requirement_docs_page_idx ON requirement_docs (page_id, created_at);

-- 关联已有页面：复合外键保证被关联页面与需求同组织；被关联页面硬删时级联删除关联
CREATE TABLE requirement_links (
    org_id         uuid NOT NULL,
    page_id        uuid NOT NULL,
    linked_page_id uuid NOT NULL,
    created_by     uuid NOT NULL REFERENCES users(id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (page_id, linked_page_id),
    CONSTRAINT requirement_links_req_fk FOREIGN KEY (org_id, page_id) REFERENCES requirements (org_id, page_id) ON DELETE CASCADE,
    CONSTRAINT requirement_links_page_fk FOREIGN KEY (org_id, linked_page_id) REFERENCES pages (org_id, id) ON DELETE CASCADE,
    CONSTRAINT requirement_links_not_self CHECK (page_id <> linked_page_id)
);
CREATE INDEX requirement_links_linked_idx ON requirement_links (linked_page_id);

-- 历史：创建、认领、状态变化、建群组、改指派，只增不改
CREATE TABLE requirement_events (
    id            uuid PRIMARY KEY,
    org_id        uuid NOT NULL,
    page_id       uuid NOT NULL,
    actor_user_id uuid REFERENCES users(id),
    actor_pat_id  uuid,                           -- 经哪个令牌操作（无外键：令牌吊销后仍保留痕迹）
    action        text NOT NULL,
    from_status   text,
    to_status     text,
    note          text,
    meta          jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT requirement_events_req_fk FOREIGN KEY (org_id, page_id) REFERENCES requirements (org_id, page_id) ON DELETE CASCADE,
    CONSTRAINT requirement_events_action_check CHECK (action IN ('created', 'claimed', 'status', 'group_created', 'assigned', 'edited')),
    CONSTRAINT requirement_events_note_len CHECK (note IS NULL OR char_length(note) <= 2000)
);
CREATE INDEX requirement_events_page_idx ON requirement_events (page_id, created_at);
