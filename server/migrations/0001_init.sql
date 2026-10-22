-- agent-relay 初始建表。契约见 docs/design.md §3。
-- 约定：
--   * 主键一律 uuid，由应用生成 UUIDv7（Rust uuid crate, feature "v7"），库里不设默认值。
--   * 时间一律 timestamptz；应用写入 UTC。
--   * 租户隔离：每张业务表带 org_id NOT NULL；父表提供 UNIQUE (org_id, id)，
--     子表用复合外键 (org_id, xxx_id) 引用，数据库层面保证子行的 org_id 与父行一致，
--     跨租户串数据在 INSERT 时就会被外键拒绝。
--   * token 一律只存 sha256 摘要（bytea, 32 字节）；密码一律 argon2id PHC 字符串。
--   * updated_at 由应用在 UPDATE 时显式写入，不用触发器。

-- ---------------------------------------------------------------- 账号

CREATE TABLE users (
    id                uuid PRIMARY KEY,
    email             text NOT NULL,
    password_hash     text NOT NULL,              -- argon2id；未来接 OAuth 时改为可空并新增 user_identities 表
    display_name      text NOT NULL,
    email_verified_at timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_email_normalized CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
    CONSTRAINT users_display_name_len CHECK (length(display_name) BETWEEN 1 AND 50),
    CONSTRAINT users_email_key UNIQUE (email)
);

CREATE TABLE sessions (
    id           uuid PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   bytea NOT NULL,
    csrf_token   text NOT NULL,                  -- 随机 32 字节 base64url，明文（只用于同步令牌比对）
    ip           inet,
    user_agent   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),
    CONSTRAINT sessions_token_hash_len CHECK (octet_length(token_hash) = 32)
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- 邮箱验证 / 重置密码的一次性 token
CREATE TABLE email_tokens (
    id         uuid PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose    text NOT NULL,
    token_hash bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    CONSTRAINT email_tokens_purpose_check CHECK (purpose IN ('verify_email', 'reset_password')),
    CONSTRAINT email_tokens_token_hash_key UNIQUE (token_hash),
    CONSTRAINT email_tokens_token_hash_len CHECK (octet_length(token_hash) = 32)
);
CREATE INDEX email_tokens_user_id_idx ON email_tokens (user_id);
CREATE INDEX email_tokens_expires_at_idx ON email_tokens (expires_at);

-- ---------------------------------------------------------------- 租户

CREATE TABLE orgs (
    id         uuid PRIMARY KEY,
    name       text NOT NULL,
    slug       text NOT NULL,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT orgs_name_len CHECK (length(name) BETWEEN 1 AND 100),
    CONSTRAINT orgs_slug_format CHECK (slug ~ '^[a-z0-9](-?[a-z0-9]){0,39}$')
);
CREATE UNIQUE INDEX orgs_slug_live_key ON orgs (slug) WHERE deleted_at IS NULL;

CREATE TABLE memberships (
    org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id),
    CONSTRAINT memberships_role_check CHECK (role IN ('owner', 'admin', 'member'))
);
CREATE INDEX memberships_user_id_idx ON memberships (user_id);

CREATE TABLE projects (
    id          uuid PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name        text NOT NULL,
    slug        text NOT NULL,
    description text NOT NULL DEFAULT '',
    created_by  uuid NOT NULL REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz,
    CONSTRAINT projects_org_id_id_key UNIQUE (org_id, id),
    CONSTRAINT projects_name_len CHECK (length(name) BETWEEN 1 AND 100),
    CONSTRAINT projects_slug_format CHECK (slug ~ '^[a-z0-9](-?[a-z0-9]){0,39}$'),
    CONSTRAINT projects_description_len CHECK (length(description) <= 2000)
);
CREATE UNIQUE INDEX projects_org_slug_live_key ON projects (org_id, slug) WHERE deleted_at IS NULL;

CREATE TABLE project_members (
    org_id     uuid NOT NULL,
    project_id uuid NOT NULL,
    user_id    uuid NOT NULL,
    role       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id),
    CONSTRAINT project_members_role_check CHECK (role IN ('admin', 'editor', 'viewer')),
    CONSTRAINT project_members_project_fk FOREIGN KEY (org_id, project_id)
        REFERENCES projects (org_id, id) ON DELETE CASCADE,
    -- 移出组织时自动移出该组织下所有项目
    CONSTRAINT project_members_membership_fk FOREIGN KEY (org_id, user_id)
        REFERENCES memberships (org_id, user_id) ON DELETE CASCADE
);
CREATE INDEX project_members_user_id_idx ON project_members (user_id);
CREATE INDEX project_members_org_user_idx ON project_members (org_id, user_id);

CREATE TABLE groups (
    id          uuid PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name        text NOT NULL,
    description text NOT NULL DEFAULT '',
    created_by  uuid NOT NULL REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT groups_org_id_id_key UNIQUE (org_id, id),
    CONSTRAINT groups_name_len CHECK (length(name) BETWEEN 1 AND 100),
    CONSTRAINT groups_description_len CHECK (length(description) <= 2000)
);
CREATE UNIQUE INDEX groups_org_name_key ON groups (org_id, lower(name));

CREATE TABLE group_members (
    org_id     uuid NOT NULL,
    group_id   uuid NOT NULL,
    user_id    uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id),
    CONSTRAINT group_members_group_fk FOREIGN KEY (org_id, group_id)
        REFERENCES groups (org_id, id) ON DELETE CASCADE,
    CONSTRAINT group_members_membership_fk FOREIGN KEY (org_id, user_id)
        REFERENCES memberships (org_id, user_id) ON DELETE CASCADE
);
CREATE INDEX group_members_user_id_idx ON group_members (user_id);

-- 把群组授权给项目：群组成员获得该项目的 role
CREATE TABLE project_groups (
    org_id     uuid NOT NULL,
    project_id uuid NOT NULL,
    group_id   uuid NOT NULL,
    role       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, group_id),
    CONSTRAINT project_groups_role_check CHECK (role IN ('admin', 'editor', 'viewer')),
    CONSTRAINT project_groups_project_fk FOREIGN KEY (org_id, project_id)
        REFERENCES projects (org_id, id) ON DELETE CASCADE,
    CONSTRAINT project_groups_group_fk FOREIGN KEY (org_id, group_id)
        REFERENCES groups (org_id, id) ON DELETE CASCADE
);
CREATE INDEX project_groups_group_id_idx ON project_groups (group_id);

-- ---------------------------------------------------------------- 页面

CREATE TABLE pages (
    id                 uuid PRIMARY KEY,
    org_id             uuid NOT NULL,
    project_id         uuid NOT NULL,
    title              text NOT NULL,
    kind               text NOT NULL,
    content            text NOT NULL,           -- openui: OpenUI Lang 原文；html: 完整 HTML 文档
    version            integer NOT NULL DEFAULT 1,   -- content 每次变更 +1
    visibility         text NOT NULL,
    accept_responses   boolean NOT NULL DEFAULT true,
    results_visible_to text NOT NULL DEFAULT 'managers',
    response_seq       bigint NOT NULL DEFAULT 0,    -- 最后分配的提交序号，也是提交总数（提交不删除）
    created_by         uuid NOT NULL REFERENCES users(id),
    created_via_pat    uuid,                    -- 通过哪个 PAT 发布（无外键：PAT 吊销后仍保留痕迹）
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    deleted_at         timestamptz,
    CONSTRAINT pages_org_id_id_key UNIQUE (org_id, id),
    CONSTRAINT pages_project_fk FOREIGN KEY (org_id, project_id)
        REFERENCES projects (org_id, id) ON DELETE CASCADE,
    CONSTRAINT pages_title_len CHECK (length(title) BETWEEN 1 AND 200),
    CONSTRAINT pages_kind_check CHECK (kind IN ('openui', 'html')),
    CONSTRAINT pages_visibility_check CHECK (visibility IN ('public', 'org', 'project', 'groups')),
    CONSTRAINT pages_results_visible_to_check CHECK (results_visible_to IN ('managers', 'viewers')),
    CONSTRAINT pages_content_size CHECK (
        (kind = 'openui' AND octet_length(content) <= 524288) OR
        (kind = 'html'   AND octet_length(content) <= 5242880)),
    CONSTRAINT pages_version_positive CHECK (version >= 1),
    CONSTRAINT pages_response_seq_nonneg CHECK (response_seq >= 0)
);
CREATE INDEX pages_project_live_idx ON pages (project_id, id DESC) WHERE deleted_at IS NULL;

-- visibility = 'groups' 时的受众
CREATE TABLE page_groups (
    org_id   uuid NOT NULL,
    page_id  uuid NOT NULL,
    group_id uuid NOT NULL,
    PRIMARY KEY (page_id, group_id),
    CONSTRAINT page_groups_page_fk FOREIGN KEY (org_id, page_id)
        REFERENCES pages (org_id, id) ON DELETE CASCADE,
    CONSTRAINT page_groups_group_fk FOREIGN KEY (org_id, group_id)
        REFERENCES groups (org_id, id) ON DELETE CASCADE
);
CREATE INDEX page_groups_group_id_idx ON page_groups (group_id);

-- 临时链接：绕过 visibility，只授予「查看 + 提交」这一个页面
CREATE TABLE share_links (
    id            uuid PRIMARY KEY,
    org_id        uuid NOT NULL,
    page_id       uuid NOT NULL,
    token_hash    bytea NOT NULL,
    token_prefix  text NOT NULL,                -- token 前 6 个字符，仅用于界面辨认
    label         text NOT NULL DEFAULT '',
    expires_at    timestamptz NOT NULL,
    max_uses      integer,                      -- 最多成功提交次数；NULL = 不限
    use_count     integer NOT NULL DEFAULT 0,   -- 已成功提交次数
    password_hash text,                         -- argon2id；NULL = 无密码
    created_by    uuid NOT NULL REFERENCES users(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    revoked_at    timestamptz,
    CONSTRAINT share_links_org_page_id_key UNIQUE (org_id, page_id, id),
    CONSTRAINT share_links_token_hash_key UNIQUE (token_hash),
    CONSTRAINT share_links_token_hash_len CHECK (octet_length(token_hash) = 32),
    CONSTRAINT share_links_page_fk FOREIGN KEY (org_id, page_id)
        REFERENCES pages (org_id, id) ON DELETE CASCADE,
    CONSTRAINT share_links_label_len CHECK (length(label) <= 100),
    CONSTRAINT share_links_max_uses_check CHECK (max_uses IS NULL OR max_uses BETWEEN 1 AND 1000000),
    CONSTRAINT share_links_use_count_check CHECK (use_count >= 0 AND (max_uses IS NULL OR use_count <= max_uses))
);
CREATE INDEX share_links_page_id_idx ON share_links (page_id, id DESC);

CREATE TABLE responses (
    id            uuid PRIMARY KEY,
    org_id        uuid NOT NULL,
    page_id       uuid NOT NULL,
    seq           bigint NOT NULL,              -- 页面内从 1 递增，= 提交时 pages.response_seq
    page_version  integer NOT NULL,
    user_id       uuid REFERENCES users(id),    -- 已登录提交者
    nickname      text,                         -- 匿名提交者昵称（已登录时可空）
    share_link_id uuid,                         -- 经临时链接提交时记录
    data          jsonb NOT NULL,
    ip            inet,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT responses_page_seq_key UNIQUE (page_id, seq),   -- 长轮询/SSE 游标查询走这个索引
    CONSTRAINT responses_page_fk FOREIGN KEY (org_id, page_id)
        REFERENCES pages (org_id, id) ON DELETE CASCADE,
    -- 保证 share_link 属于同一页面同一租户（share_link_id 为 NULL 时不检查）
    CONSTRAINT responses_share_link_fk FOREIGN KEY (org_id, page_id, share_link_id)
        REFERENCES share_links (org_id, page_id, id),   -- 临时链接只吊销不删除；删页面时两者一起级联
    CONSTRAINT responses_identity_check CHECK (user_id IS NOT NULL OR nickname IS NOT NULL),
    CONSTRAINT responses_nickname_len CHECK (nickname IS NULL OR length(nickname) BETWEEN 1 AND 50),
    CONSTRAINT responses_data_object CHECK (jsonb_typeof(data) = 'object'),
    CONSTRAINT responses_seq_positive CHECK (seq >= 1)
);
CREATE INDEX responses_share_link_id_idx ON responses (share_link_id) WHERE share_link_id IS NOT NULL;
CREATE INDEX responses_user_id_idx ON responses (user_id) WHERE user_id IS NOT NULL;

-- ---------------------------------------------------------------- 邀请

CREATE TABLE invites (
    id          uuid PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    target_type text NOT NULL,
    project_id  uuid,
    group_id    uuid,
    role        text NOT NULL,
    email       text,                           -- 非空时只有该邮箱（且已验证）的账号能接受
    token_hash  bytea NOT NULL,
    max_uses    integer NOT NULL DEFAULT 1,
    use_count   integer NOT NULL DEFAULT 0,
    created_by  uuid NOT NULL REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    revoked_at  timestamptz,
    CONSTRAINT invites_token_hash_key UNIQUE (token_hash),
    CONSTRAINT invites_token_hash_len CHECK (octet_length(token_hash) = 32),
    CONSTRAINT invites_project_fk FOREIGN KEY (org_id, project_id)
        REFERENCES projects (org_id, id) ON DELETE CASCADE,
    CONSTRAINT invites_group_fk FOREIGN KEY (org_id, group_id)
        REFERENCES groups (org_id, id) ON DELETE CASCADE,
    CONSTRAINT invites_target_check CHECK (
        (target_type = 'org'     AND project_id IS NULL     AND group_id IS NULL     AND role IN ('admin', 'member')) OR
        (target_type = 'project' AND project_id IS NOT NULL AND group_id IS NULL     AND role IN ('admin', 'editor', 'viewer')) OR
        (target_type = 'group'   AND project_id IS NULL     AND group_id IS NOT NULL AND role = 'member')),
    CONSTRAINT invites_email_normalized CHECK (email IS NULL OR email = lower(btrim(email))),
    CONSTRAINT invites_uses_check CHECK (max_uses BETWEEN 1 AND 1000 AND use_count BETWEEN 0 AND max_uses),
    CONSTRAINT invites_email_single_use CHECK (email IS NULL OR max_uses = 1)
);
CREATE INDEX invites_org_id_idx ON invites (org_id, id DESC);

-- ---------------------------------------------------------------- PAT

CREATE TABLE personal_access_tokens (
    id           uuid PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         text NOT NULL,
    token_hash   bytea NOT NULL,
    token_prefix text NOT NULL,                 -- "arp_" 后前 6 个字符，界面辨认用
    org_id       uuid REFERENCES orgs(id) ON DELETE CASCADE,  -- NULL = 不限组织
    project_id   uuid,                          -- 非空时必须同时有 org_id
    scopes       text[] NOT NULL,
    expires_at   timestamptz,                   -- NULL = 不过期
    last_used_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    revoked_at   timestamptz,
    CONSTRAINT pat_token_hash_key UNIQUE (token_hash),
    CONSTRAINT pat_token_hash_len CHECK (octet_length(token_hash) = 32),
    CONSTRAINT pat_name_len CHECK (length(name) BETWEEN 1 AND 100),
    CONSTRAINT pat_project_fk FOREIGN KEY (org_id, project_id)
        REFERENCES projects (org_id, id) ON DELETE CASCADE,
    CONSTRAINT pat_project_needs_org CHECK (project_id IS NULL OR org_id IS NOT NULL),
    CONSTRAINT pat_scopes_check CHECK (
        cardinality(scopes) >= 1 AND scopes <@ ARRAY['publish', 'read_responses']::text[])
);
CREATE INDEX pat_user_id_idx ON personal_access_tokens (user_id, id DESC);

-- ---------------------------------------------------------------- 审计

-- 不加外键：组织/用户/页面删除后审计记录仍需保留
CREATE TABLE audit_log (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id        uuid,                         -- 与组织无关的事件（如不限组织的 PAT 创建）为 NULL
    actor_user_id uuid,
    actor_pat_id  uuid,
    action        text NOT NULL,                -- 见 docs/design.md §7.4
    target_type   text NOT NULL,
    target_id     uuid,
    ip            inet,
    meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_idx ON audit_log (org_id, id DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, id DESC);
