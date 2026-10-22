// api.md §1.3 等共用对象
export type UserBrief = { id: string; display_name: string };
export type UserFull = { id: string; email: string; display_name: string; email_verified: boolean; created_at: string };
export type OrgRole = "owner" | "admin" | "member";
export type ProjectRole = "admin" | "editor" | "viewer";
export type Visibility = "public" | "org" | "project" | "groups";
export type PageKind = "openui" | "html";
export type Scope = "publish" | "read_responses";

export type Org = { id: string; name: string; slug: string; my_role: OrgRole; created_at: string };
export type Project = {
  id: string; org_id: string; name: string; slug: string; description: string;
  my_role: ProjectRole | null; created_at: string; updated_at: string;
};
export type Group = { id: string; org_id: string; name: string; description: string; member_count: number; created_at: string };

export type Page = {
  id: string; org_id: string; project_id: string;
  title: string; kind: PageKind; version: number;
  visibility: Visibility; group_ids: string[];
  accept_responses: boolean; results_visible_to: "managers" | "viewers";
  response_count: number; url: string;
  created_by: UserBrief; created_at: string; updated_at: string;
  can_manage: boolean;
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
export type ProjectGroupGrant = { group: { id: string; name: string }; role: ProjectRole; created_at: string };

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
    accept_responses: boolean; results_visible_to: "managers" | "viewers"; updated_at: string;
    project: { id: string; name: string }; org: { id: string; name: string };
  };
  content: { kind: "openui"; spec: string } | { kind: "html"; frame_url: string; frame_origin: string };
  viewer: { type: "user"; user_id: string; display_name: string } | { type: "anonymous" };
  can_submit: boolean;
  submit_block_reason: null | "responses_closed" | "share_link_exhausted";
  can_view_results: boolean;
  can_manage: boolean;
  share_link: null | { id: string; label: string; expires_at: string; remaining_uses: number | null };
};

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
