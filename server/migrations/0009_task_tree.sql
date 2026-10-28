-- 0009 任务树页面（page_type = task_tree）。契约见 docs/api.md §7.6、docs/design.md §3.3「任务树」。
-- 编号跳过 0008（预留给并行分支）；sqlx 0.8 按版本号顺序补跑未执行的迁移，0008 晚于 0009 上线时仍会被执行（见迁移报告）。
-- 只新建三张表与索引，不改任何已有表、不回填数据：旧页面行为不变。
-- 新表的外键引用 pages / users / memberships / groups：CREATE TABLE 时对被引用表短暂持 SHARE ROW EXCLUSIVE 锁
-- （阻塞这些表的写入，不阻塞读；空表无需校验，毫秒级）。
-- lock_timeout：拿不到锁 5 秒即失败退出，不会长时间排队阻塞全站读写。
SET LOCAL lock_timeout = '5s';

-- 任务节点：一页一棵树，parent_id 为空的是根层节点；key 是发布者给的稳定 id（update_page 重发整棵树时按它合并）
CREATE TABLE tasks (
    id               uuid PRIMARY KEY,
    org_id           uuid NOT NULL,
    page_id          uuid NOT NULL,
    parent_id        uuid,
    key              text NOT NULL,
    position         integer NOT NULL DEFAULT 0,
    title            text NOT NULL,
    description      text NOT NULL DEFAULT '',
    assignee_user_id uuid,                       -- 负责人账号（agent 即其令牌所属账号）；移出组织时置空
    assignee_label   text,                       -- 负责人显示名补充（如 agent 名称），纯文本
    due_at           timestamptz,
    status           text NOT NULL DEFAULT 'todo',
    submit_note      text,                       -- 最近一次提交评审的完成说明
    evidence         jsonb,                      -- 最近一次提交评审的证据链接（http/https 字符串数组）
    submitted_by     uuid REFERENCES users(id),  -- 最近一次提交评审的人（不能评审自己提交的任务）
    submitted_at     timestamptz,
    reject_reason    text,                       -- 当前处于「被驳回」时的理由；再次提交时清空
    reviewed_by      uuid REFERENCES users(id),
    reviewed_at      timestamptz,
    created_by       uuid NOT NULL REFERENCES users(id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz,                -- 软删（重发时被去掉的节点），历史保留
    CONSTRAINT tasks_org_id_id_key UNIQUE (org_id, id),
    CONSTRAINT tasks_page_key_key UNIQUE (page_id, key),          -- 也服务「按页面拉整棵树」
    CONSTRAINT tasks_page_fk FOREIGN KEY (org_id, page_id) REFERENCES pages (org_id, id) ON DELETE CASCADE,
    CONSTRAINT tasks_parent_fk FOREIGN KEY (org_id, parent_id) REFERENCES tasks (org_id, id) ON DELETE CASCADE,
    CONSTRAINT tasks_assignee_fk FOREIGN KEY (org_id, assignee_user_id)
        REFERENCES memberships (org_id, user_id) ON DELETE SET NULL (assignee_user_id),
    CONSTRAINT tasks_status_check CHECK (status IN ('todo', 'in_progress', 'in_review', 'done')),
    CONSTRAINT tasks_key_format CHECK (key ~ '^[A-Za-z0-9_.-]{1,64}$'),
    CONSTRAINT tasks_title_len CHECK (char_length(title) BETWEEN 1 AND 200),
    CONSTRAINT tasks_description_len CHECK (char_length(description) <= 5000),
    CONSTRAINT tasks_assignee_label_len CHECK (assignee_label IS NULL OR char_length(assignee_label) BETWEEN 1 AND 50),
    CONSTRAINT tasks_submit_note_len CHECK (submit_note IS NULL OR char_length(submit_note) <= 2000),
    CONSTRAINT tasks_reject_reason_len CHECK (reject_reason IS NULL OR char_length(reject_reason) BETWEEN 1 AND 2000),
    CONSTRAINT tasks_evidence_array CHECK (evidence IS NULL OR (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) <= 10)),
    CONSTRAINT tasks_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id)
);
-- 「分配给我的待办」：按负责人查未完成任务
CREATE INDEX tasks_assignee_open_idx ON tasks (assignee_user_id, page_id)
    WHERE deleted_at IS NULL AND status IN ('todo', 'in_progress');
CREATE INDEX tasks_parent_idx ON tasks (parent_id) WHERE parent_id IS NOT NULL;

-- 任务历史：所有状态变化、评审意见、编辑、移动、软删/恢复，只增不改
CREATE TABLE task_events (
    id            uuid PRIMARY KEY,
    org_id        uuid NOT NULL,
    page_id       uuid NOT NULL,
    task_id       uuid NOT NULL,
    actor_user_id uuid REFERENCES users(id),
    actor_pat_id  uuid,                          -- 经哪个令牌操作（无外键：令牌吊销后仍保留痕迹）
    action        text NOT NULL,
    from_status   text,
    to_status     text,
    note          text,                          -- 完成说明 / 评审意见 / 驳回理由
    evidence      jsonb,
    meta          jsonb,                         -- 编辑时变化的字段名等
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT task_events_task_fk FOREIGN KEY (org_id, task_id) REFERENCES tasks (org_id, id) ON DELETE CASCADE,
    CONSTRAINT task_events_page_fk FOREIGN KEY (org_id, page_id) REFERENCES pages (org_id, id) ON DELETE CASCADE,
    CONSTRAINT task_events_action_check CHECK (action IN
        ('created', 'edited', 'moved', 'started', 'reverted', 'submitted', 'approved', 'rejected', 'deleted', 'restored')),
    CONSTRAINT task_events_note_len CHECK (note IS NULL OR char_length(note) <= 2000)
);
CREATE INDEX task_events_task_idx ON task_events (task_id, created_at);
-- 首页动态流按组织取最近事件（同 0005 的两个索引）
CREATE INDEX task_events_org_created_idx ON task_events (org_id, created_at DESC);

-- 任务页评审人：成员或群组（恰好一个非空）；一页没有任何行时由项目管理员评审
CREATE TABLE page_reviewers (
    org_id   uuid NOT NULL,
    page_id  uuid NOT NULL,
    user_id  uuid,
    group_id uuid,
    CONSTRAINT page_reviewers_page_fk FOREIGN KEY (org_id, page_id) REFERENCES pages (org_id, id) ON DELETE CASCADE,
    CONSTRAINT page_reviewers_user_fk FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id) ON DELETE CASCADE,
    CONSTRAINT page_reviewers_group_fk FOREIGN KEY (org_id, group_id) REFERENCES groups (org_id, id) ON DELETE CASCADE,
    CONSTRAINT page_reviewers_one_check CHECK ((user_id IS NULL) <> (group_id IS NULL))
);
CREATE UNIQUE INDEX page_reviewers_user_key ON page_reviewers (page_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX page_reviewers_group_key ON page_reviewers (page_id, group_id) WHERE group_id IS NOT NULL;
