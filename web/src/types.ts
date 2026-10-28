// api.md §1.3 等共用对象
export type UserBrief = { id: string; display_name: string };
export type UserFull = { id: string; email: string; display_name: string; email_verified: boolean; created_at: string };
export type OrgRole = "owner" | "admin" | "member";
export type ProjectRole = "admin" | "editor" | "viewer";
export type Visibility = "public" | "org" | "project" | "groups";
export type PageKind = "openui" | "html";
export type PageType = "general" | "report" | "knowledge" | "flowchart" | "architecture" | "vote" | "requirement" | "task" | "task_tree";
export type PageCategory = "read" | "collect" | "collab";
export type Scope = "publish" | "read_responses" | "manage";

export type Org = { id: string; name: string; slug: string; my_role: OrgRole; created_at: string };
export type Project = {
  id: string; org_id: string; name: string; slug: string; description: string;
  my_role: ProjectRole | null; created_at: string; updated_at: string;
};
/** project_id 非空 = 专属该项目的项目群组；null = 组织级群组（旧后端无这两个字段，按组织级处理） */
export type Group = {
  id: string; org_id: string; name: string; description: string; member_count: number; created_at: string;
  project_id?: string | null; project?: { id: string; name: string } | null;
};

export type Page = {
  id: string; org_id: string; project_id: string;
  title: string; kind: PageKind; version: number;
  page_type: PageType; category: PageCategory; generated_by: string | null;
  visibility: Visibility; group_ids: string[];
  accept_responses: boolean; results_visible_to: "managers" | "viewers";
  response_count: number; url: string;
  created_by: UserBrief; created_at: string; updated_at: string;
  can_manage: boolean;
  /** 当前用户是否已提交过（后端未返回时按 false） */
  my_submitted?: boolean;
  /** 截止时间（到点后拒收）；以下字段旧后端没有，缺失时前端降级 */
  closes_at?: string | null;
  summary?: string | null;
  highlights?: Highlight[] | null;
  /** 当前版本去重参与人数 */
  respondent_count?: number;
  /** 可提交的组织内人数（public 页面为 null） */
  eligible_count?: number | null;
};
export type Highlight = { label: string; value: string };
export type Participation = { eligible_count: number | null; respondent_count: number; pending: UserBrief[] | null };
/** GET /api/activity */
export type Activity = {
  type: "published" | "updated" | "submitted"; at: string; version: number;
  page: { id: string; title: string; page_type: PageType; project: { id: string; name: string } };
  actor: { kind: "user" | "anonymous"; name: string } | null;
};
/** GET /api/me/projects（跨组织，不分页） */
export type MyProject = {
  id: string; name: string; slug: string;
  org: { id: string; name: string; slug: string };
  role: ProjectRole; can_publish: boolean; can_read_responses: boolean;
};

export type Respondent =
  | { type: "user"; user_id: string; display_name: string }
  | { type: "anonymous"; nickname: string };

export type Response = {
  id: string; seq: number; page_version: number; created_at: string;
  respondent: Respondent;
  share_link: { id: string; label: string } | null;
  data: Record<string, unknown>;
};

export type Paged<T> = { items: T[]; next_cursor: string | null };
export type Me = { user: UserFull; csrf_token: string; orgs: Org[] };

type Member = { user: UserBrief & { email: string } };
export type OrgMember = Member & { role: OrgRole; joined_at: string };
export type ProjectMember = Member & { role: ProjectRole; joined_at: string };
export type GroupMember = Member & { joined_at: string };
/** GET /projects/{id}/groups：本项目群组 + 已授权的组织级群组；active = 4 小时内有页面发给它 */
export type ProjectGroupGrant = {
  group: { id: string; name: string }; role: ProjectRole; created_at: string;
  id?: string; name?: string; description?: string; project_id?: string | null;
  member_count?: number; last_page_at?: string | null; active?: boolean;
};

export type Invite = {
  id: string; org_id: string; target_type: "org" | "project" | "group";
  target: { id: string; name: string };
  role: string; email: string | null; max_uses: number; use_count: number;
  created_by: UserBrief; created_at: string; expires_at: string; revoked_at: string | null;
};
export type InvitePreview = {
  org: { name: string; slug: string };
  target_type: "org" | "project" | "group"; target_name: string; role: string;
  invited_by: string; email_bound: boolean; expires_at: string;
};

export type Pat = {
  id: string; name: string; token_prefix: string;
  org: { id: string; name: string } | null; project: { id: string; name: string } | null;
  scopes: Scope[]; expires_at: string | null; last_used_at: string | null; created_at: string; revoked_at: string | null;
};

export type PageView = {
  page: {
    id: string; title: string; kind: PageKind; version: number;
    page_type: PageType; category: PageCategory; generated_by: string | null;
    accept_responses: boolean; results_visible_to: "managers" | "viewers"; updated_at: string;
    project: { id: string; name: string }; org: { id: string; name: string };
    closes_at?: string | null; summary?: string | null; highlights?: Highlight[] | null;
  };
  /** 所查看版本的内容（version/title 为该版本快照；旧后端无这两个字段时按当前版本处理） */
  content: ({ kind: "openui"; spec: string } | { kind: "html"; frame_url: string; frame_origin: string }) & { version?: number; title?: string };
  viewer: { type: "user"; user_id: string; display_name: string } | { type: "anonymous" };
  can_submit: boolean;
  submit_block_reason: null | "read_only" | "responses_closed" | "closed" | "share_link_exhausted" | "already_submitted";
  can_view_results: boolean;
  can_manage: boolean;
  my_submitted?: boolean;
  /** 登录用户对所查看版本的提交；匿名、临时链接为 null */
  my_response?: MyResponse | null;
  /** 全部版本（降序）；临时链接为 null */
  versions?: { version: number; created_at: string }[] | null;
  share_link: null | { id: string; label: string; expires_at: string; remaining_uses: number | null };
  /** 参与进度（旧后端无） */
  participation?: Participation | null;
};

export type MyResponse = { seq: number; page_version: number; data: Record<string, unknown>; created_at: string };

export type ShareLink = {
  id: string; page_id: string; label: string; token_prefix: string;
  expires_at: string; max_uses: number | null; use_count: number;
  has_password: boolean; created_by: UserBrief; created_at: string; revoked_at: string | null;
  status: "active" | "expired" | "revoked" | "exhausted";
};

export type AuditEntry = {
  id: number; action: string; target_type: string; target_id: string | null;
  actor: { user: UserBrief | null; pat: { id: string; name: string } | null };
  meta: Record<string, unknown>; created_at: string;
};
