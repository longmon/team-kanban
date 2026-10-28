// 组织页：项目、群组、成员、邀请、审计、设置（api.md §4、§5、§12）
import { useState, type FormEvent } from "react";
import { FolderKanban, Mail, ScrollText, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { del, get, patch, post, qs } from "../api";
import { Link, navigate } from "../router";
import {
  AuthCard, CheckField, CopyText, Empty, ErrorBox, Field, fmtTime, ListSkeleton, Loading, MoreButton, NativeSelect, Notice, Page, PAGE_TABS_LIST, PAGE_TABS_TRIGGER,
  PageHeader, Panel, ROLE_LABEL, TableCard, toast, useAction, useLoad, usePaged, useSession, useTab, loadMyProjects,
} from "../ui";
import { autoSlug, SLUG_RE, Tile, TILES, useSlugFallback } from "./home";
import type { AuditEntry, Group, GroupMember, Invite, Org, OrgMember, OrgRole, Project, ProjectRole } from "../types";

const isAdmin = (o: Org) => o.my_role === "owner" || o.my_role === "admin";

export function OrgPage({ slug }: { slug: string }) {
  const { me } = useSession();
  const org = me!.orgs.find((o) => o.slug === slug);
  const admin = !!org && isAdmin(org);
  const [tab, setTab] = useTab(admin ? ["projects", "groups", "members", "invites", "audit", "settings"] : ["projects", "groups", "members", "settings"]);
  if (!org) return <AuthCard title="组织不存在或你不是成员"><p className="text-sm"><Link className="link" to="/">返回首页</Link></p></AuthCard>;
  return (
    <Page>
      <PageHeader title={org.name} badge={<Badge variant="secondary">{ROLE_LABEL[org.my_role]}</Badge>} desc={<span className="font-mono text-[13px]">{org.slug}</span>} />
      <Tabs value={tab} onValueChange={setTab} className="gap-6">
        <TabsList className={PAGE_TABS_LIST}>
          <TabsTrigger value="projects" className={PAGE_TABS_TRIGGER}>项目</TabsTrigger>
          <TabsTrigger value="groups" className={PAGE_TABS_TRIGGER}>群组</TabsTrigger>
          <TabsTrigger value="members" className={PAGE_TABS_TRIGGER}>成员</TabsTrigger>
          {admin && <TabsTrigger value="invites" className={PAGE_TABS_TRIGGER}>邀请</TabsTrigger>}
          {admin && <TabsTrigger value="audit" className={PAGE_TABS_TRIGGER}>审计</TabsTrigger>}
          <TabsTrigger value="settings" className={PAGE_TABS_TRIGGER}>设置</TabsTrigger>
        </TabsList>
        <TabsContent value="projects"><Projects org={org} /></TabsContent>
        <TabsContent value="groups"><Groups org={org} /></TabsContent>
        <TabsContent value="members"><Members org={org} /></TabsContent>
        {admin && <TabsContent value="invites"><Invites org={org} listPath={`/orgs/${org.id}/invites`} targets={["org", "group"]} /></TabsContent>}
        {admin && <TabsContent value="audit"><Audit org={org} /></TabsContent>}
        <TabsContent value="settings"><OrgSettings org={org} /></TabsContent>
      </Tabs>
    </Page>
  );
}

function Projects({ org }: { org: Org }) {
  const list = usePaged<Project>(`/orgs/${org.id}/projects`);
  const fallback = useSlugFallback("p");
  const [f, setF] = useState({ name: "", slug: "", description: "" });
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      const p = await post<Project>(`/orgs/${org.id}/projects`, f);
      await loadMyProjects(true);
      navigate(`/o/${org.slug}/p/${p.slug}`);
    });
  };
  return (
    <div className="split">
    <div className="stack">
      <ErrorBox error={list.error} />
      {list.loading && list.items.length === 0 && <ListSkeleton />}
      {!list.loading && list.items.length === 0 && <Empty icon={<FolderKanban />} title="还没有项目">在下方新建一个项目，再让 agent 往里发布页面。</Empty>}
      {list.items.length > 0 && (
        <div className={TILES}>
          {list.items.map((p) => (
            <Tile key={p.id} to={`/o/${org.slug}/p/${p.slug}`} title={p.name} desc={p.description} slug={p.slug} role={p.my_role ? ROLE_LABEL[p.my_role] : undefined} />
          ))}
        </div>
      )}
      <MoreButton p={list} />
    </div>
      <Panel title="新建项目">
        <form onSubmit={submit} className="form">
          <Field label="名称"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, slug: autoSlug(e.target.value, fallback) })} /></Field>
          <Field label="标识（slug）"><Input required pattern={SLUG_RE.source} value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} /></Field>
          <Field label="描述"><Textarea rows={2} maxLength={2000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <ErrorBox error={a.error} />
          <div className="form-actions"><Button type="submit" loading={a.busy} disabled={a.busy}>创建项目</Button></div>
        </form>
      </Panel>
    </div>
  );
}

/** 从组织成员中选人（项目成员、群组成员添加用） */
export function MemberPicker({ orgId, onPick, label = "添加" }: { orgId: string; onPick: (userId: string) => Promise<unknown>; label?: string }) {
  const [q, setQ] = useState("");
  const res = useLoad(
    () => (q.trim() ? get<{ items: OrgMember[] }>(`/orgs/${orgId}/members${qs({ q: q.trim(), limit: 10 })}`) : Promise.resolve({ items: [] })),
    [orgId, q],
  );
  const a = useAction();
  return (
    <div className="stack">
      <Input placeholder="按邮箱或名字搜索组织成员" value={q} onChange={(e) => setQ(e.target.value)} />
      {res.data?.items.map((m) => (
        <div key={m.user.id} className="pick-row">
          <span>{m.user.display_name} <span className="muted small">{m.user.email}</span></span>
          <Button size="sm" variant="outline" disabled={a.busy}
            onClick={() => a.run(async () => (await onPick(m.user.id), setQ("")))}>{label}</Button>
        </div>
      ))}
      <ErrorBox error={a.error} />
    </div>
  );
}

function Groups({ org }: { org: Org }) {
  const admin = isAdmin(org);
  const list = usePaged<Group>(`/orgs/${org.id}/groups?include=project`);
  const [open, setOpen] = useState<string | null>(null);
  const [f, setF] = useState({ name: "", description: "" });
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      await post(`/orgs/${org.id}/groups`, f);
      setF({ name: "", description: "" });
      list.reload();
    });
  };
  return (
    <div className={admin ? "split" : "stack"}>
    <div className="stack">
      <ErrorBox error={list.error} />
      {list.loading && list.items.length === 0 && <ListSkeleton />}
      {!list.loading && list.items.length === 0 && <Empty icon={<Users />} title="还没有群组">群组用来批量授权项目和页面，例如「评审组」。项目专属的群组在项目页「成员与权限」里新建。</Empty>}
      {list.items.length > 0 && (
        <div className="list">
          {list.items.map((g) => (
            <div key={g.id} className="list-row">
              <div className="list-main">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="list-title">{g.name}</span>
                  {g.project && <Badge variant="info">项目：{g.project.name}</Badge>}
                </div>
                {g.description && <div className="list-meta">{g.description}</div>}
              </div>
              <div className="list-stat"><b>{g.member_count}</b> 人</div>
              <div className="list-actions">
                <Button size="sm" variant="ghost" onClick={() => setOpen(open === g.id ? null : g.id)}>{open === g.id ? "收起" : "成员"}</Button>
              </div>
              {open === g.id && <div className="list-expand"><GroupDetail org={org} group={g} onChange={list.reload} /></div>}
            </div>
          ))}
        </div>
      )}
      <MoreButton p={list} />
    </div>
      {admin && (
        <Panel title="新建组织级群组" desc="可授权给多个项目；只给某个项目用的群组请到该项目页新建。">
          <form onSubmit={submit} className="form">
            <Field label="名称"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="描述"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
            <ErrorBox error={a.error} />
            <div className="form-actions"><Button type="submit" loading={a.busy} disabled={a.busy}>创建群组</Button></div>
          </form>
        </Panel>
      )}
    </div>
  );
}

/** 群组成员与设置；canManage 缺省为组织管理员（项目页对项目群组传入项目管理员身份） */
export function GroupDetail({ org, group, onChange, canManage }: { org: Org; group: Group; onChange: () => void; canManage?: boolean }) {
  const { me } = useSession();
  const admin = canManage ?? isAdmin(org);
  const members = usePaged<GroupMember>(`/groups/${group.id}/members`);
  const [edit, setEdit] = useState({ name: group.name, description: group.description });
  const a = useAction();
  const remove = (uid: string) =>
    a.run(async () => {
      await del(`/groups/${group.id}/members/${uid}`);
      members.reload();
      onChange();
    });
  return (
    <div className="stack">
      <ErrorBox error={members.error || a.error} />
      <TableCard><Table>
        <TableHeader><TableRow><TableHead>成员</TableHead><TableHead>加入时间</TableHead><TableHead /></TableRow></TableHeader>
        <TableBody>
          {members.items.map((m) => (
            <TableRow key={m.user.id}>
              <TableCell><div className="font-medium">{m.user.display_name}</div><div className="muted small">{m.user.email}</div></TableCell>
              <TableCell>{fmtTime(m.joined_at)}</TableCell>
              <TableCell className="text-right">
                {(admin || m.user.id === me!.user.id) && (
                  <Button size="sm" variant="ghost-destructive" disabled={a.busy}
                    onClick={() => confirm("确定移出该群组？") && remove(m.user.id)}>{m.user.id === me!.user.id ? "退出" : "移除"}</Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table></TableCard>
      <MoreButton p={members} />
      {admin && (
        <>
          <h4 className="sub-title">添加成员</h4>
          <MemberPicker orgId={org.id} onPick={async (uid) => (await post(`/groups/${group.id}/members`, { user_id: uid }), members.reload(), onChange())} />
          <h4 className="sub-title">修改群组</h4>
          <div className="row wrap toolbar">
            <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} aria-label="群组名" />
            <Input value={edit.description} placeholder="描述" onChange={(e) => setEdit({ ...edit, description: e.target.value })} aria-label="描述" />
            <Button size="sm" variant="outline" disabled={a.busy}
              onClick={() => a.run(async () => (await patch(`/groups/${group.id}`, edit), toast.ok("已保存"), onChange()))}>保存</Button>
            <Button size="sm" variant="ghost-destructive" disabled={a.busy}
              onClick={() => confirm(`删除群组「${group.name}」？同时移除其页面受众与项目授权。`) && a.run(async () => (await del(`/groups/${group.id}`), onChange()))}>删除群组</Button>
          </div>
        </>
      )}
    </div>
  );
}

function Members({ org }: { org: Org }) {
  const { me } = useSession();
  const [q, setQ] = useState("");
  const list = usePaged<OrgMember>(`/orgs/${org.id}/members${qs({ q: q.trim() })}`);
  const a = useAction();
  const roles: [OrgRole, string][] = (org.my_role === "owner" ? ["owner", "admin", "member"] as OrgRole[] : ["admin", "member"] as OrgRole[]).map((r) => [r, ROLE_LABEL[r]]);
  const canEdit = (m: OrgMember) => org.my_role === "owner" || (org.my_role === "admin" && m.role !== "owner");
  const canRemove = (m: OrgMember) => org.my_role === "owner" || (org.my_role === "admin" && m.role === "member");
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ email: string; password: string | null } | null>(null);
  const resetPw = (m: OrgMember) =>
    confirm(`为 ${m.user.display_name} 重新生成一次性密码？旧的初始密码立即失效。`) &&
    a.run(async () => {
      const r = await post<{ generated_password: string }>(`/orgs/${org.id}/members/${m.user.id}/reset-password`, {});
      setSecret({ email: m.user.email, password: r.generated_password });
    });
  return (
    <div className="stack">
      <div className="row wrap toolbar">
        <Input className="search" placeholder="搜索邮箱或名字" value={q} onChange={(e) => setQ(e.target.value)} />
        {isAdmin(org) && <Button size="sm" onClick={() => setCreating(true)}>新建账号</Button>}
      </div>
      <ErrorBox error={list.error || a.error} />
      <TableCard><Table>
        <TableHeader><TableRow><TableHead>成员</TableHead><TableHead>角色</TableHead><TableHead>加入时间</TableHead><TableHead /></TableRow></TableHeader>
        <TableBody>
          {list.items.map((m) => {
            const self = m.user.id === me!.user.id;
            return (
              <TableRow key={m.user.id}>
                <TableCell>
                  <div className="font-medium">{m.user.display_name}{self && <span className="muted font-normal">（我）</span>}
                    {m.must_change_password && <Badge variant="warning" className="ml-1.5">待改初始密码</Badge>}</div>
                  <div className="muted small">{m.user.email}</div>
                </TableCell>
                <TableCell>
                  {!self && canEdit(m) ? (
                    <NativeSelect aria-label="角色" value={m.role} options={m.role === "owner" && org.my_role !== "owner" ? [["owner", ROLE_LABEL.owner]] : roles}
                      onChange={(role) => a.run(async () => (await patch(`/orgs/${org.id}/members/${m.user.id}`, { role }), list.reload()))} />
                  ) : ROLE_LABEL[m.role]}
                </TableCell>
                <TableCell>{fmtTime(m.joined_at)}</TableCell>
                <TableCell className="text-right">
                  {!self && canRemove(m) && m.must_change_password && (
                    <Button size="sm" variant="ghost" disabled={a.busy} onClick={() => resetPw(m)}>重置密码</Button>
                  )}
                  {!self && canRemove(m) && (
                    <Button size="sm" variant="ghost-destructive" disabled={a.busy}
                      onClick={() => confirm(`将 ${m.user.display_name} 移出组织？`) && a.run(async () => (await del(`/orgs/${org.id}/members/${m.user.id}`), list.reload()))}>移除</Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table></TableCard>
      <MoreButton p={list} />
      {creating && <NewAccountDialog org={org} onClose={() => setCreating(false)} onCreated={(email, password) => (setCreating(false), setSecret({ email, password }), list.reload())} />}
      <Dialog open={!!secret} onOpenChange={(o) => !o && setSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>账号已就绪</DialogTitle>
            <DialogDescription>把邮箱和初始密码交给对方；对方首次登录后必须先修改密码。</DialogDescription>
          </DialogHeader>
          <p className="text-sm"><span className="text-muted-foreground">登录邮箱 </span>{secret?.email}</p>
          {secret?.password ? (
            <div className="stack">
              <Notice tone="warning">初始密码只显示这一次，关闭后无法再查看，请立即复制。</Notice>
              <CopyText text={secret.password} />
            </div>
          ) : <p className="text-sm text-muted-foreground">初始密码为你刚才填写的密码。</p>}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 管理员直接建账号（api.md §4.2）：组织角色、可选项目及角色、群组（组织级或所选项目的项目群组）、初始密码手填或系统生成 */
function NewAccountDialog({ org, onClose, onCreated }: { org: Org; onClose: () => void; onCreated: (email: string, password: string | null) => void }) {
  const projects = useLoad(() => get<{ items: Project[] }>(`/orgs/${org.id}/projects?limit=200`), [org.id]);
  const groups = useLoad(() => get<{ items: Group[] }>(`/orgs/${org.id}/groups?include=project&limit=200`), [org.id]);
  const [f, setF] = useState({ email: "", display_name: "", role: "member", pw: "generate", password: "" });
  const [proj, setProj] = useState<Record<string, ProjectRole>>({});
  const [grp, setGrp] = useState<string[]>([]);
  const a = useAction();
  const roleOpts: [string, string][] = (org.my_role === "owner" ? ["member", "admin"] : ["member"]).map((r) => [r, ROLE_LABEL[r]]);
  const visibleGroups = (groups.data?.items ?? []).filter((g) => !g.project_id || g.project_id in proj);
  const toggleProj = (id: string, on: boolean) => {
    const next = { ...proj };
    if (on) next[id] = "viewer";
    else delete next[id];
    setProj(next);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      const keep = new Set(visibleGroups.map((g) => g.id));
      const r = await post<{ member: OrgMember; generated_password: string | null }>(`/orgs/${org.id}/members/accounts`, {
        email: f.email, display_name: f.display_name, role: f.role,
        password: f.pw === "manual" ? f.password : undefined,
        projects: Object.entries(proj).map(([project_id, role]) => ({ project_id, role })),
        group_ids: grp.filter((id) => keep.has(id)),
      });
      onCreated(r.member.user.email, r.generated_password);
    });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>新建账号</DialogTitle>
          <DialogDescription>直接为同事建好账号并加入本组织，无需邮件验证；对方首次登录后必须修改密码。已注册的人请改用邀请。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="form">
          <Field label="邮箱"><Input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="姓名"><Input required maxLength={50} value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></Field>
          <Field label="组织角色" hint={org.my_role === "owner" ? undefined : "只有所有者能直接授予管理员"}>
            <NativeSelect aria-label="组织角色" value={f.role} onChange={(v) => setF({ ...f, role: v })} options={roleOpts} />
          </Field>
          <Field label="初始密码">
            <NativeSelect aria-label="初始密码" value={f.pw} onChange={(v) => setF({ ...f, pw: v })}
              options={[["generate", "系统生成一次性密码（推荐）"], ["manual", "我来填写"]]} />
          </Field>
          {f.pw === "manual" && (
            <Field label="密码" hint="10–128 个字符">
              <Input type="text" autoComplete="new-password" required minLength={10} maxLength={128} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
            </Field>
          )}
          <div className="grid gap-2">
            <span className="text-[13px] font-medium">加入项目（可选）</span>
            <div className="grid gap-1.5">
              {projects.data?.items.length === 0 && <span className="muted small">本组织还没有项目</span>}
              {projects.data?.items.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-2">
                  <CheckField checked={p.id in proj} onChange={(on) => toggleProj(p.id, on)}>{p.name}</CheckField>
                  {p.id in proj && (
                    <NativeSelect size="sm" className="w-28" aria-label={`${p.name} 角色`} value={proj[p.id]}
                      onChange={(v) => setProj({ ...proj, [p.id]: v })} options={(["viewer", "editor", "admin"] as ProjectRole[]).map((r) => [r, ROLE_LABEL[r]])} />
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="grid gap-2">
            <span className="text-[13px] font-medium">加入群组（可选）</span>
            <div className="grid gap-1.5">
              {visibleGroups.length === 0 && <span className="muted small">暂无可选群组</span>}
              {visibleGroups.map((g) => (
                <CheckField key={g.id} checked={grp.includes(g.id)} onChange={(on) => setGrp(on ? [...grp, g.id] : grp.filter((x) => x !== g.id))}>
                  {g.name}{g.project && <span className="muted small">（项目：{g.project.name}）</span>}
                </CheckField>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">组织级群组，或上面所选项目的项目群组</span>
          </div>
          <ErrorBox error={projects.error || groups.error || a.error} />
          <div className="form-actions">
            <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
            <Button type="submit" loading={a.busy} disabled={a.busy}>创建账号</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 邀请（组织页与项目页共用） ----------
const EXPIRES: [string, string][] = [["3600", "1 小时"], ["86400", "1 天"], ["604800", "7 天"], ["2592000", "30 天"]];
const TARGET_LABEL = { org: "组织", project: "项目", group: "群组" } as const;

export function Invites({ org, listPath, targets, projectId }: {
  org: Org; listPath: string; targets: ("org" | "project" | "group")[]; projectId?: string;
}) {
  const [inactive, setInactive] = useState(false);
  const list = usePaged<Invite>(listPath + qs({ include_inactive: inactive }));
  const groups = useLoad(() => (targets.includes("group") ? get<{ items: Group[] }>(`/orgs/${org.id}/groups?limit=200`) : Promise.resolve({ items: [] })), [org.id]);
  const [f, setF] = useState({ target_type: targets[0] as string, group_id: "", role: "", email: "", max_uses: "1", expires_in: "604800" });
  const [created, setCreated] = useState<string | null>(null);
  const a = useAction();
  const roleOpts: [string, string][] =
    f.target_type === "org" ? (org.my_role === "owner" ? ["member", "admin"] : ["member"]).map((r) => [r, ROLE_LABEL[r]])
      : f.target_type === "project" ? ["viewer", "editor", "admin"].map((r) => [r, ROLE_LABEL[r]])
        : [["member", ROLE_LABEL.member]];
  const role = roleOpts.some(([r]) => r === f.role) ? f.role : roleOpts[0][0];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      const r = await post<{ invite: Invite; url: string }>(`/orgs/${org.id}/invites`, {
        target_type: f.target_type,
        project_id: f.target_type === "project" ? projectId : undefined,
        group_id: f.target_type === "group" ? f.group_id : undefined,
        role,
        email: f.email.trim() || undefined,
        max_uses: f.email.trim() ? 1 : Number(f.max_uses),
        expires_in: Number(f.expires_in),
      });
      setCreated(r.url);
      list.reload();
    });
  };
  return (
    <div className="split">
      <div className="stack">
        <CheckField checked={inactive} onChange={setInactive}>显示已失效</CheckField>
        <ErrorBox error={list.error} />
        <InviteTable items={list.items} onRevoke={list.reload} />
        <MoreButton p={list} />
      </div>
      <Panel title="发出邀请" desc="生成链接后发给对方；对方登录或注册后即可加入。">
        <form onSubmit={submit} className="form">
          {targets.length > 1 && (
            <Field label="邀请加入">
              <NativeSelect value={f.target_type} onChange={(v) => setF({ ...f, target_type: v })} options={targets.map((t) => [t, TARGET_LABEL[t]])} />
            </Field>
          )}
          {f.target_type === "group" && (
            <Field label="群组">
              <NativeSelect value={f.group_id} onChange={(v) => setF({ ...f, group_id: v })}
                options={[["", "请选择"], ...(groups.data?.items.map((g) => [g.id, g.name] as [string, string]) ?? [])]} />
            </Field>
          )}
          <Field label="角色"><NativeSelect value={role} onChange={(v) => setF({ ...f, role: v })} options={roleOpts} /></Field>
          <Field label="限定邮箱（可选）" hint="填写后会发邮件，只有该邮箱的已验证账号能接受，且只能用一次">
            <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </Field>
          {!f.email.trim() && (
            <Field label="可用次数"><Input type="number" min={1} max={1000} value={f.max_uses} onChange={(e) => setF({ ...f, max_uses: e.target.value })} /></Field>
          )}
          <Field label="有效期"><NativeSelect value={f.expires_in} onChange={(v) => setF({ ...f, expires_in: v })} options={EXPIRES} /></Field>
          <ErrorBox error={a.error} />
          <div className="form-actions"><Button type="submit" loading={a.busy} disabled={a.busy || (f.target_type === "group" && !f.group_id)}>生成邀请链接</Button></div>
          {created && <div className="stack"><span className="small">邀请链接只显示这一次：</span><CopyText text={created} /></div>}
        </form>
      </Panel>
    </div>
  );
}

function InviteTable({ items, onRevoke }: { items: Invite[]; onRevoke: () => void }) {
  const a = useAction();
  return (
    <>
      <ErrorBox error={a.error} />
      {items.length > 0 && <TableCard><Table>
        <TableHeader><TableRow><TableHead>目标</TableHead><TableHead>角色</TableHead><TableHead>邮箱</TableHead><TableHead>使用</TableHead><TableHead>到期</TableHead><TableHead /></TableRow></TableHeader>
        <TableBody>
          {items.map((i) => (
            <TableRow key={i.id}>
              <TableCell>{TARGET_LABEL[i.target_type]}：{i.target.name}<div className="muted small">由 {i.created_by.display_name}</div></TableCell>
              <TableCell>{ROLE_LABEL[i.role] ?? i.role}</TableCell>
              <TableCell>{i.email ?? "—"}</TableCell>
              <TableCell>{i.use_count}/{i.max_uses}</TableCell>
              <TableCell>{i.revoked_at ? "已撤销" : fmtTime(i.expires_at)}</TableCell>
              <TableCell className="text-right">
                {!i.revoked_at && (
                  <Button size="sm" variant="ghost-destructive" disabled={a.busy}
                    onClick={() => a.run(async () => (await del(`/invites/${i.id}`), onRevoke()))}>撤销</Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table></TableCard>}
      {items.length === 0 && <Empty icon={<Mail />} title="暂无邀请">生成的邀请会列在这里，可随时撤销。</Empty>}
    </>
  );
}

function Audit({ org }: { org: Org }) {
  const [action, setAction] = useState("");
  const list = usePaged<AuditEntry>(`/orgs/${org.id}/audit${qs({ action: action.trim() })}`);
  return (
    <div className="stack">
      <Input className="search" placeholder="按动作过滤，如 page.publish" value={action} onChange={(e) => setAction(e.target.value)} />
      <ErrorBox error={list.error} />
      <TableCard><Table>
        <TableHeader><TableRow><TableHead>时间</TableHead><TableHead>操作者</TableHead><TableHead>动作</TableHead><TableHead>对象</TableHead><TableHead>详情</TableHead></TableRow></TableHeader>
        <TableBody>
          {list.items.map((e) => (
            <TableRow key={e.id}>
              <TableCell className="nowrap text-muted-foreground">{fmtTime(e.created_at)}</TableCell>
              <TableCell>{e.actor.user?.display_name ?? "—"}{e.actor.pat && <div className="muted small">令牌 {e.actor.pat.name}</div>}</TableCell>
              <TableCell><code className="rounded bg-muted px-1.5 py-0.5 text-xs">{e.action}</code></TableCell>
              <TableCell>{e.target_type}<div className="muted small mono">{e.target_id ?? ""}</div></TableCell>
              <TableCell><code className="small wrap-any">{Object.keys(e.meta ?? {}).length ? JSON.stringify(e.meta) : ""}</code></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table></TableCard>
      {list.loading && <Loading />}
      {!list.loading && list.items.length === 0 && <Empty icon={<ScrollText />} title="暂无审计记录" />}
      <MoreButton p={list} />
    </div>
  );
}

function OrgSettings({ org }: { org: Org }) {
  const { me, refresh } = useSession();
  const [f, setF] = useState({ name: org.name, slug: org.slug });
  const [confirmSlug, setConfirmSlug] = useState("");
  const a = useAction();
  const save = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      const o = await patch<Org>(`/orgs/${org.id}`, f);
      await refresh();
      toast.ok("已保存");
      if (o.slug !== org.slug) navigate(`/o/${o.slug}`, true);
    });
  };
  const remove = () =>
    a.run(async () => {
      await del(`/orgs/${org.id}`, { confirm_slug: confirmSlug });
      await refresh();
      navigate("/");
    });
  const leave = () =>
    confirm(`确定退出组织「${org.name}」？`) &&
    a.run(async () => {
      await del(`/orgs/${org.id}/members/${me!.user.id}`);
      await refresh();
      await loadMyProjects(true);
      navigate("/");
    });
  return (
    <div className="stack">
      <ErrorBox error={a.error} />
      <div className="cols-2">
      {isAdmin(org) && (
        <Panel title="基本信息">
        <form onSubmit={save} className="form">
          <Field label="名称"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="标识（slug）"><Input required pattern={SLUG_RE.source} value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} /></Field>
          <div className="form-actions"><Button type="submit" loading={a.busy} disabled={a.busy}>保存</Button></div>
        </form>
        </Panel>
      )}
      <div className="stack">
      <Panel title="退出组织" desc="退出后将无法访问该组织的项目和页面。"
        actions={<Button variant="outline" className="text-destructive hover:text-destructive" onClick={leave} disabled={a.busy}>退出组织</Button>} />
      {org.my_role === "owner" && (
        <Panel title="删除组织" danger
          desc={<>删除后组织内所有项目和页面都将不可访问。输入组织标识 <code>{org.slug}</code> 确认。</>}>
          <div className="row wrap toolbar">
            <Input value={confirmSlug} onChange={(e) => setConfirmSlug(e.target.value)} aria-label="确认标识" placeholder={org.slug} />
            <Button variant="destructive" disabled={a.busy || confirmSlug !== org.slug} onClick={remove}>删除组织</Button>
          </div>
        </Panel>
      )}
      </div>
      </div>
    </div>
  );
}
