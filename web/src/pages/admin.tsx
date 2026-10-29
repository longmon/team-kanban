// 系统管理（超级管理员，api.md §15）：/admin 账号、组织两个 tab；/admin/users/:id 账号详情（基本信息、状态、超管开关、组织/项目/群组分配、重置密码、禁用/启用）
import { useState, type FormEvent } from "react";
import { Building2, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, del, get, patch, post, put, qs } from "../api";
import { Link } from "../router";
import {
  AuthCard, CheckField, Empty, ErrorBox, Field, fmtTime, FormDialog, ListSkeleton, Loading, MoreButton, NativeSelect, Page, PAGE_TABS_LIST, PAGE_TABS_TRIGGER,
  PageHeader, Panel, ROLE_LABEL, TableCard, toast, useAction, useLoad, usePaged, useSession, useTab,
} from "../ui";
import { autoSlug, SLUG_RE, useSlugFallback } from "./home";
import { InfoList, RoleDialog, SecretDialog } from "./org";
import type { AdminOrg, AdminUser, AdminUserOrg, OrgRole, OrgStructure, Paged, ProjectRole } from "../types";

const ORG_ROLES: [OrgRole, string][] = (["member", "admin", "owner"] as OrgRole[]).map((r) => [r, ROLE_LABEL[r]]);
const PROJECT_ROLES: [ProjectRole, string][] = (["viewer", "editor", "admin"] as ProjectRole[]).map((r) => [r, ROLE_LABEL[r]]);
const PW_MODES: [string, string][] = [["generate", "系统生成一次性密码（推荐）"], ["manual", "我来填写"]];
type Secret = { email: string; password: string | null };

function NoAccess() {
  return (
    <AuthCard title="无权访问" desc="系统管理仅对超级管理员开放。">
      <p className="text-sm"><Link className="link" to="/">返回首页</Link></p>
    </AuthCard>
  );
}

function UserBadges({ u }: { u: AdminUser }) {
  return (
    <>
      {u.is_superadmin && <Badge variant="info">超级管理员</Badge>}
      {u.disabled && <Badge variant="destructive">已禁用</Badge>}
      {u.must_change_password && <Badge variant="warning">待改密</Badge>}
    </>
  );
}

export function AdminPage() {
  const { me } = useSession();
  const [tab, setTab] = useTab(["users", "orgs"]);
  if (!me!.user.is_superadmin) return <NoAccess />;
  return (
    <Page>
      <PageHeader title="系统管理" desc="全站账号与组织，仅超级管理员可见。所有操作记入审计。" />
      <Tabs value={tab} onValueChange={setTab} className="gap-6">
        <TabsList className={PAGE_TABS_LIST}>
          <TabsTrigger value="users" className={PAGE_TABS_TRIGGER}>账号</TabsTrigger>
          <TabsTrigger value="orgs" className={PAGE_TABS_TRIGGER}>组织</TabsTrigger>
        </TabsList>
        <TabsContent value="users"><Users /></TabsContent>
        <TabsContent value="orgs"><Orgs /></TabsContent>
      </Tabs>
    </Page>
  );
}

// ---------- 账号列表 ----------
function Users() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const list = usePaged<AdminUser>(`/admin/users${qs({ q: q.trim(), status: status === "all" ? "" : status })}`);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<Secret | null>(null);
  return (
    <div className="stack">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" placeholder="搜索邮箱或姓名" value={q} onChange={(e) => setQ(e.target.value)} />
        <NativeSelect aria-label="状态" className="w-36" value={status} onChange={setStatus}
          options={[["all", "全部账号"], ["disabled", "已禁用"], ["must_change", "待改密"], ["superadmin", "超级管理员"]]} />
        <Button size="sm" className="ml-auto" onClick={() => setCreating(true)}>新增账号</Button>
      </div>
      <ErrorBox error={list.error} />
      {list.loading && list.items.length === 0 && <ListSkeleton />}
      {list.items.length > 0 && (
        <TableCard><Table>
          <TableHeader><TableRow><TableHead>账号</TableHead><TableHead>组织</TableHead><TableHead>创建时间</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {list.items.map((u) => (
              <TableRow key={u.id}>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5 font-medium">{u.display_name}<UserBadges u={u} /></div>
                  <div className="muted small">{u.email}</div>
                </TableCell>
                <TableCell>{u.org_count ?? 0}</TableCell>
                <TableCell className="nowrap">{fmtTime(u.created_at)}</TableCell>
                <TableCell className="text-right"><Button size="sm" variant="ghost" asChild><Link to={`/admin/users/${u.id}`}>编辑</Link></Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table></TableCard>
      )}
      {!list.loading && list.items.length === 0 && <Empty icon={<UserRound />} title="没有匹配的账号" />}
      <MoreButton p={list} />
      {creating && <NewUserDialog onClose={() => setCreating(false)} onCreated={(s) => (setCreating(false), setSecret(s), list.reload())} />}
      <SecretDialog secret={secret} onClose={() => setSecret(null)} />
    </div>
  );
}

// ---------- 组织分配编辑器（新增账号、加入组织共用） ----------
type Assign = { org_id: string; role: OrgRole; projects: Record<string, ProjectRole>; group_ids: string[] };
const emptyAssign = (): Assign => ({ org_id: "", role: "member", projects: {}, group_ids: [] });
const assignBody = (a: Assign) => ({
  org_id: a.org_id, role: a.role,
  projects: Object.entries(a.projects).map(([project_id, role]) => ({ project_id, role })),
  group_ids: a.group_ids,
});

/** 全部组织（选组织用）。ponytail: 只取前 200 个，组织更多时改成搜索 */
const useAllOrgs = () => useLoad(() => get<Paged<AdminOrg>>("/admin/orgs?limit=200"), []);
const useStructure = (orgId: string) => useLoad(() => (orgId ? get<OrgStructure>(`/admin/orgs/${orgId}/structure`) : Promise.resolve(undefined)), [orgId]);

/** 群组只能选组织级或已勾选项目的项目群组（与后端校验一致）：取消勾选项目时一并去掉它的项目群组 */
function AssignEditor({ value, onChange, orgs, exclude, onRemove }: {
  value: Assign; onChange: (a: Assign) => void; orgs: AdminOrg[]; exclude: string[]; onRemove?: () => void;
}) {
  const st = useStructure(value.org_id);
  const visibleGroups = (st.data?.groups ?? []).filter((g) => !g.project_id || g.project_id in value.projects);
  const toggleProj = (id: string, on: boolean) => {
    const next = { ...value.projects };
    if (on) next[id] = "viewer";
    else delete next[id];
    const own = new Set((st.data?.groups ?? []).filter((g) => g.project_id === id).map((g) => g.id));
    onChange({ ...value, projects: next, group_ids: on ? value.group_ids : value.group_ids.filter((g) => !own.has(g)) });
  };
  return (
    <div data-box="" className="grid gap-3 rounded-lg border p-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_9rem_auto]">
        <NativeSelect aria-label="组织" value={value.org_id} onChange={(v) => onChange({ ...emptyAssign(), org_id: v, role: value.role })}
          options={[["", "选择组织"], ...orgs.filter((o) => o.id === value.org_id || !exclude.includes(o.id)).map((o) => [o.id, o.name] as [string, string])]} />
        <NativeSelect aria-label="组织角色" value={value.role} onChange={(v) => onChange({ ...value, role: v })} options={ORG_ROLES} />
        {onRemove && <Button type="button" size="sm" variant="ghost" onClick={onRemove}>移除</Button>}
      </div>
      {value.org_id && st.data && (
        <>
          <div className="grid gap-1.5">
            <span className="text-[13px] font-medium">项目（可选）</span>
            {st.data.projects.length === 0 && <span className="muted small">该组织还没有项目</span>}
            {st.data.projects.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-2">
                <CheckField checked={p.id in value.projects} onChange={(on) => toggleProj(p.id, on)}>{p.name}</CheckField>
                {p.id in value.projects && (
                  <NativeSelect size="sm" className="w-28" aria-label={`${p.name} 角色`} value={value.projects[p.id]}
                    onChange={(v) => onChange({ ...value, projects: { ...value.projects, [p.id]: v } })} options={PROJECT_ROLES} />
                )}
              </div>
            ))}
          </div>
          <div className="grid gap-1.5">
            <span className="text-[13px] font-medium">群组（可选）</span>
            {visibleGroups.length === 0 && <span className="muted small">暂无可选群组</span>}
            {visibleGroups.map((g) => (
              <CheckField key={g.id} checked={value.group_ids.includes(g.id)}
                onChange={(on) => onChange({ ...value, group_ids: on ? [...value.group_ids, g.id] : value.group_ids.filter((x) => x !== g.id) })}>
                {g.name}{g.project_id && <span className="muted small">（项目群组）</span>}
              </CheckField>
            ))}
          </div>
        </>
      )}
      <ErrorBox error={st.error} />
    </div>
  );
}

/** 409 email_registered：给出跳到该账号详情的入口（已注册账号在详情里直接分配组织） */
function RegisteredHint({ error }: { error: unknown }) {
  const uid = error instanceof ApiError && error.code === "email_registered" ? (error.details as { user_id?: string } | null)?.user_id : undefined;
  return uid ? <Button type="button" size="sm" variant="outline" asChild><Link to={`/admin/users/${uid}`}>打开该账号</Link></Button> : null;
}

function NewUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (s: Secret) => void }) {
  const orgs = useAllOrgs();
  const [f, setF] = useState({ email: "", display_name: "", pw: "generate", password: "", is_superadmin: false });
  const [assigns, setAssigns] = useState<Assign[]>([]);
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      const r = await post<{ user: AdminUser; generated_password: string | null }>("/admin/users", {
        email: f.email, display_name: f.display_name, is_superadmin: f.is_superadmin,
        password: f.pw === "manual" ? f.password : undefined,
        orgs: assigns.filter((x) => x.org_id).map(assignBody),
      });
      onCreated({ email: r.user.email, password: r.generated_password });
    });
  };
  const set = (i: number, v: Assign) => setAssigns(assigns.map((x, j) => (j === i ? v : x)));
  return (
    <FormDialog onClose={onClose} title="新增账号" wide desc="直接建好账号并分配组织，无需邮件验证；对方首次登录后必须修改密码。已注册的账号请在其详情页分配组织。">
      <form onSubmit={submit} className="form">
        <Field label="邮箱"><Input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="姓名"><Input required maxLength={50} value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></Field>
        <Field label="初始密码"><NativeSelect aria-label="初始密码" value={f.pw} onChange={(v) => setF({ ...f, pw: v })} options={PW_MODES} /></Field>
        {f.pw === "manual" && (
          <Field label="密码" hint="10–128 个字符">
            <Input type="text" autoComplete="new-password" required minLength={10} maxLength={128} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          </Field>
        )}
        <CheckField checked={f.is_superadmin} onChange={(v) => setF({ ...f, is_superadmin: v })}>设为超级管理员</CheckField>
        <div className="grid gap-2">
          <span className="text-[13px] font-medium">分配组织（可选，可多个）</span>
          {assigns.map((x, i) => (
            <AssignEditor key={i} value={x} onChange={(v) => set(i, v)} orgs={orgs.data?.items ?? []} exclude={assigns.map((y) => y.org_id)}
              onRemove={() => setAssigns(assigns.filter((_, j) => j !== i))} />
          ))}
          <div><Button type="button" size="sm" variant="outline" onClick={() => setAssigns([...assigns, emptyAssign()])}>添加组织</Button></div>
        </div>
        <ErrorBox error={orgs.error || a.error} />
        <div className="form-actions">
          <RegisteredHint error={a.error} />
          <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
          <Button type="submit" loading={a.busy} disabled={a.busy}>创建账号</Button>
        </div>
      </form>
    </FormDialog>
  );
}

// ---------- 账号详情 ----------
type Detail = { user: AdminUser; orgs: AdminUserOrg[] };

export function AdminUserPage({ id }: { id: string }) {
  const { me } = useSession();
  const d = useLoad(() => (me!.user.is_superadmin ? get<Detail>(`/admin/users/${id}`) : Promise.resolve(null)), [id]);
  const [dlg, setDlg] = useState<null | "name" | "join">(null);
  const [secret, setSecret] = useState<Secret | null>(null);
  const a = useAction();
  if (!me!.user.is_superadmin) return <NoAccess />;
  if (d.loading && !d.data) return <Page><Loading /></Page>;
  if (!d.data) return <AuthCard title="账号不存在"><ErrorBox error={d.error} /><p className="text-sm"><Link className="link" to="/admin">返回系统管理</Link></p></AuthCard>;
  const u = d.data.user;
  const self = u.id === me!.user.id;
  const update = (body: Record<string, unknown>, msg: string) => a.run(async () => (await patch(`/admin/users/${u.id}`, body), toast.ok(msg), d.reload()));
  const resetPw = () =>
    confirm(`为 ${u.display_name} 重置密码？旧密码立即失效、已登录的设备全部下线，下次登录必须先修改密码。`) &&
    a.run(async () => {
      const r = await post<{ generated_password: string }>(`/admin/users/${u.id}/reset-password`, {});
      setSecret({ email: u.email, password: r.generated_password });
      d.reload();
    });
  return (
    <Page>
      <PageHeader crumbs={<><Link to="/admin">系统管理</Link><Link to="/admin">账号</Link></>} title={u.display_name} badge={<UserBadges u={u} />} desc={u.email}
        actions={<>
          <Button variant="outline" asChild><Link to="/admin">返回</Link></Button>
          {!self && <Button variant="outline" disabled={a.busy} onClick={resetPw}>重置密码</Button>}
          {!self && (u.disabled
            ? <Button variant="outline" disabled={a.busy} onClick={() => update({ disabled: false }, "已启用")}>启用账号</Button>
            : <Button variant="destructive" disabled={a.busy}
              onClick={() => confirm(`禁用 ${u.display_name}？对方会立即被踢下线，其访问令牌全部失效，无法再登录。`) && update({ disabled: true }, "已禁用")}>禁用账号</Button>)}
        </>} />
      <ErrorBox error={a.error} />
      <div className="cols-2">
        <Panel title="基本信息" actions={<Button size="sm" variant="outline" onClick={() => setDlg("name")}>编辑</Button>}>
          <InfoList items={[
            ["邮箱", u.email], ["姓名", u.display_name], ["邮箱验证", u.email_verified ? "已验证" : "未验证"],
            ["状态", u.disabled ? `已禁用（${fmtTime(u.disabled_at)}）` : u.must_change_password ? "正常（待修改初始密码）" : "正常"],
            ["创建时间", fmtTime(u.created_at)],
          ]} />
        </Panel>
        <Panel title="超级管理员" desc="超管可以管理全站账号与组织；至少保留一个可用的超管。">
          <label className="flex items-center gap-3 text-sm">
            <Switch aria-label="超级管理员" checked={u.is_superadmin} disabled={a.busy}
              onCheckedChange={(v) => (v || confirm(self ? "撤销自己的超级管理员？撤销后将无法再进入系统管理。" : `撤销 ${u.display_name} 的超级管理员？`)) && update({ is_superadmin: v }, v ? "已设为超级管理员" : "已撤销超级管理员")} />
            {u.is_superadmin ? "是超级管理员" : "不是超级管理员"}
          </label>
        </Panel>
      </div>
      <Panel title="组织 / 项目 / 群组" desc="直接分配，不需要对方接受邀请；不会改动对方的密码。"
        actions={<Button size="sm" onClick={() => setDlg("join")}>加入组织</Button>}>
        {d.data.orgs.length === 0 && <Empty icon={<Building2 />} title="还没有加入任何组织" />}
        {d.data.orgs.map((o) => <OrgAssignment key={o.org.id} userId={u.id} a={o} onChange={d.reload} />)}
      </Panel>
      {dlg === "name" && <NameDialog user={u} onClose={() => setDlg(null)} onSaved={d.reload} />}
      {dlg === "join" && <JoinOrgDialog userId={u.id} exclude={d.data.orgs.map((o) => o.org.id)} onClose={() => setDlg(null)} onDone={d.reload} />}
      <SecretDialog title="密码已重置" secret={secret} onClose={() => setSecret(null)} />
    </Page>
  );
}

function NameDialog({ user, onClose, onSaved }: { user: AdminUser; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(user.display_name);
  const a = useAction();
  return (
    <FormDialog onClose={onClose} title="编辑基本信息">
      <form className="form" onSubmit={(e) => (e.preventDefault(), a.run(async () => (await patch(`/admin/users/${user.id}`, { display_name: name }), toast.ok("已保存"), onSaved(), onClose())))}>
        <Field label="姓名"><Input required maxLength={50} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <ErrorBox error={a.error} />
        <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>取消</Button><Button type="submit" loading={a.busy} disabled={a.busy}>保存</Button></div>
      </form>
    </FormDialog>
  );
}

/** 加入组织：组织角色 + 可选项目与群组，逐个调用分配接口 */
function JoinOrgDialog({ userId, exclude, onClose, onDone }: { userId: string; exclude: string[]; onClose: () => void; onDone: () => void }) {
  const orgs = useAllOrgs();
  const [v, setV] = useState<Assign>(emptyAssign());
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      const b = assignBody(v);
      await put(`/admin/users/${userId}/orgs/${b.org_id}`, { role: b.role });
      for (const p of b.projects) await put(`/admin/users/${userId}/projects/${p.project_id}`, { role: p.role });
      for (const g of b.group_ids) await put(`/admin/users/${userId}/groups/${g}`, {});
      toast.ok("已加入组织");
      onDone();
      onClose();
    });
  };
  return (
    <FormDialog onClose={onClose} title="加入组织" wide>
      <form className="form" onSubmit={submit}>
        <AssignEditor value={v} onChange={setV} orgs={orgs.data?.items ?? []} exclude={exclude} />
        <ErrorBox error={orgs.error || a.error} />
        <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>取消</Button><Button type="submit" loading={a.busy} disabled={a.busy || !v.org_id}>加入</Button></div>
      </form>
    </FormDialog>
  );
}

/** 一个组织的分配：组织角色、项目（角色）、群组；可增删改 */
function OrgAssignment({ userId, a: o, onChange }: { userId: string; a: AdminUserOrg; onChange: () => void }) {
  const [dlg, setDlg] = useState<null | "role" | "project" | "group" | { project: AdminUserOrg["projects"][number] }>(null);
  const act = useAction();
  const run = (fn: () => Promise<unknown>) => act.run(async () => (await fn(), onChange()));
  const base = `/admin/users/${userId}`;
  return (
    <section data-box="" className="grid gap-3 rounded-lg border p-4" aria-label={`组织 ${o.org.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <b className="text-[15px]">{o.org.name}</b><span className="font-mono text-[12px] text-muted-foreground">{o.org.slug}</span>
        <Badge variant="secondary">{ROLE_LABEL[o.role]}</Badge>
        <span className="ml-auto flex flex-wrap gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setDlg("role")}>编辑角色</Button>
          <Button size="sm" variant="ghost-destructive" disabled={act.busy}
            onClick={() => confirm(`把该账号移出「${o.org.name}」？同时移出该组织下的项目与群组。`) && run(() => del(`${base}/orgs/${o.org.id}`))}>移出组织</Button>
        </span>
      </div>
      <ErrorBox error={act.error} />
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between"><span className="text-[13px] font-medium">项目</span><Button size="xs" variant="outline" onClick={() => setDlg("project")}>添加项目</Button></div>
        {o.projects.length === 0 && <span className="muted small">未直接加入项目（组织所有者/管理员自动拥有全部项目的管理权限）</span>}
        {o.projects.map((p) => (
          <div key={p.id} className="pick-row">
            <span>{p.name} <span className="muted small">{ROLE_LABEL[p.role]}</span></span>
            <span className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setDlg({ project: p })}>编辑</Button>
              <Button size="sm" variant="ghost-destructive" disabled={act.busy} onClick={() => run(() => del(`${base}/projects/${p.id}`))}>移除</Button>
            </span>
          </div>
        ))}
      </div>
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between"><span className="text-[13px] font-medium">群组</span><Button size="xs" variant="outline" onClick={() => setDlg("group")}>添加群组</Button></div>
        {o.groups.length === 0 && <span className="muted small">未加入群组</span>}
        {o.groups.map((g) => (
          <div key={g.id} className="pick-row">
            <span>{g.name}{g.project_id && <span className="muted small">（项目群组）</span>}</span>
            <Button size="sm" variant="ghost-destructive" disabled={act.busy} onClick={() => run(() => del(`${base}/groups/${g.id}`))}>移除</Button>
          </div>
        ))}
      </div>
      {dlg === "role" && (
        <RoleDialog title={`修改在「${o.org.name}」的组织角色`} value={o.role} options={ORG_ROLES} onClose={() => setDlg(null)}
          onSave={async (role) => (await put(`${base}/orgs/${o.org.id}`, { role }), onChange())} />
      )}
      {dlg !== null && typeof dlg === "object" && (
        <RoleDialog title={`修改在项目「${dlg.project.name}」的角色`} value={dlg.project.role} options={PROJECT_ROLES} onClose={() => setDlg(null)}
          onSave={async (role) => (await put(`${base}/projects/${dlg.project.id}`, { role }), onChange())} />
      )}
      {(dlg === "project" || dlg === "group") && <AddTargetDialog kind={dlg} userId={userId} a={o} onClose={() => setDlg(null)} onDone={onChange} />}
    </section>
  );
}

function AddTargetDialog({ kind, userId, a: o, onClose, onDone }: { kind: "project" | "group"; userId: string; a: AdminUserOrg; onClose: () => void; onDone: () => void }) {
  const st = useStructure(o.org.id);
  const [pick, setPick] = useState({ id: "", role: "viewer" as ProjectRole });
  const act = useAction();
  const options: [string, string][] = kind === "project"
    ? (st.data?.projects ?? []).filter((p) => !o.projects.some((x) => x.id === p.id)).map((p) => [p.id, p.name])
    : (st.data?.groups ?? []).filter((g) => !o.groups.some((x) => x.id === g.id)).map((g) => [g.id, g.project_id ? `${g.name}（项目群组）` : g.name]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    act.run(async () => {
      await put(`/admin/users/${userId}/${kind === "project" ? "projects" : "groups"}/${pick.id}`, kind === "project" ? { role: pick.role } : {});
      onDone();
      onClose();
    });
  };
  return (
    <FormDialog onClose={onClose} title={kind === "project" ? `添加到「${o.org.name}」的项目` : `添加到「${o.org.name}」的群组`}>
      <form className="form" onSubmit={submit}>
        <Field label={kind === "project" ? "项目" : "群组"}>
          <NativeSelect aria-label={kind === "project" ? "项目" : "群组"} value={pick.id} onChange={(v) => setPick({ ...pick, id: v })} options={[["", "请选择"], ...options]} />
        </Field>
        {kind === "project" && <Field label="项目角色"><NativeSelect aria-label="项目角色" value={pick.role} onChange={(v) => setPick({ ...pick, role: v })} options={PROJECT_ROLES} /></Field>}
        <ErrorBox error={st.error || act.error} />
        <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>取消</Button><Button type="submit" loading={act.busy} disabled={act.busy || !pick.id}>添加</Button></div>
      </form>
    </FormDialog>
  );
}

// ---------- 组织列表 ----------
function Orgs() {
  const [q, setQ] = useState("");
  const list = usePaged<AdminOrg>(`/admin/orgs${qs({ q: q.trim() })}`);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<Secret | null>(null);
  return (
    <div className="stack">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" placeholder="搜索组织名或标识" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button size="sm" className="ml-auto" onClick={() => setCreating(true)}>新建组织</Button>
      </div>
      <ErrorBox error={list.error} />
      {list.loading && list.items.length === 0 && <ListSkeleton />}
      {list.items.length > 0 && (
        <TableCard><Table>
          <TableHeader><TableRow><TableHead>组织</TableHead><TableHead>所有者</TableHead><TableHead>成员</TableHead><TableHead>创建时间</TableHead></TableRow></TableHeader>
          <TableBody>
            {list.items.map((o) => (
              <TableRow key={o.id}>
                <TableCell><div className="font-medium">{o.name}</div><div className="muted small mono">{o.slug}</div></TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-x-2">
                    {o.owners.map((u) => <Link key={u.id} className="link" to={`/admin/users/${u.id}`} title={u.email}>{u.display_name}</Link>)}
                    {o.owners.length === 0 && "—"}
                  </div>
                </TableCell>
                <TableCell>{o.member_count}</TableCell>
                <TableCell className="nowrap">{fmtTime(o.created_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table></TableCard>
      )}
      {!list.loading && list.items.length === 0 && <Empty icon={<Building2 />} title="没有匹配的组织" />}
      <MoreButton p={list} />
      {creating && <NewOrgDialog onClose={() => setCreating(false)} onCreated={(s) => (setCreating(false), s && setSecret(s), list.reload())} />}
      <SecretDialog title="组织已创建，所有者账号已就绪" secret={secret} onClose={() => setSecret(null)} />
    </div>
  );
}

function NewOrgDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (s: Secret | null) => void }) {
  const fallback = useSlugFallback("org");
  const [f, setF] = useState({ name: "", slug: "", mode: "existing", email: "", display_name: "", pw: "generate", password: "" });
  const [owner, setOwner] = useState<AdminUser | null>(null);
  const [q, setQ] = useState("");
  const found = useLoad(() => (q.trim() ? get<Paged<AdminUser>>(`/admin/users${qs({ q: q.trim(), limit: 8 })}`) : Promise.resolve(null)), [q]);
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      const r = await post<{ owner: AdminUser; generated_password: string | null }>("/admin/orgs", {
        name: f.name, slug: f.slug,
        ...(f.mode === "existing"
          ? { owner_user_id: owner?.id }
          : { owner: { email: f.email, display_name: f.display_name, password: f.pw === "manual" ? f.password : undefined } }),
      });
      toast.ok("组织已创建");
      onCreated(f.mode === "new" ? { email: r.owner.email, password: r.generated_password } : null);
    });
  };
  return (
    <FormDialog onClose={onClose} title="新建组织" wide desc="指定所有者（已有账号或同时新建账号）；你本人不会因此加入该组织。">
      <form onSubmit={submit} className="form">
        <Field label="名称"><Input required maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, slug: autoSlug(e.target.value, fallback) })} /></Field>
        <Field label="标识（slug）"><Input required pattern={SLUG_RE.source} value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} className="font-mono" /></Field>
        <Field label="所有者">
          <NativeSelect aria-label="所有者" value={f.mode} onChange={(v) => setF({ ...f, mode: v })} options={[["existing", "已有账号"], ["new", "新建账号"]]} />
        </Field>
        {f.mode === "existing" ? (
          <div className="stack">
            {owner && <p className="text-sm">已选：<b>{owner.display_name}</b> <span className="muted small">{owner.email}</span></p>}
            <Input placeholder="按邮箱或姓名搜索账号" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜索账号" />
            {found.data?.items.map((u) => (
              <div key={u.id} className="pick-row">
                <span>{u.display_name} <span className="muted small">{u.email}</span></span>
                <Button type="button" size="sm" variant="outline" onClick={() => (setOwner(u), setQ(""))}>选择</Button>
              </div>
            ))}
          </div>
        ) : (
          <>
            <Field label="所有者邮箱"><Input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="所有者姓名"><Input required maxLength={50} value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></Field>
            <Field label="初始密码"><NativeSelect aria-label="初始密码" value={f.pw} onChange={(v) => setF({ ...f, pw: v })} options={PW_MODES} /></Field>
            {f.pw === "manual" && (
              <Field label="密码" hint="10–128 个字符">
                <Input type="text" autoComplete="new-password" required minLength={10} maxLength={128} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
              </Field>
            )}
          </>
        )}
        <ErrorBox error={a.error} />
        <div className="form-actions">
          <RegisteredHint error={a.error} />
          <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
          <Button type="submit" loading={a.busy} disabled={a.busy || (f.mode === "existing" && !owner)}>创建组织</Button>
        </div>
      </form>
    </FormDialog>
  );
}

