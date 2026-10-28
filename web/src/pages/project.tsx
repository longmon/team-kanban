// 项目页：页面格子墙、成员与权限（直接成员、项目群组、邀请）、设置（api.md §4.3、§4.4、§7.1）；页面元数据编辑器供详情页「管理」使用
import { useState, type FormEvent, type ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { del, get, patch, post, put, qs } from "../api";
import { Link, navigate } from "../router";
import {
  AuthCard, CheckField, Empty, ErrorBox, Field, fmtTime, loadMyProjects, Loading, MoreButton, NativeSelect, Page as Shell,
  PageHeader, Panel, ROLE_LABEL, TableCard, VIS_LABEL, toast, useAction, useLoad, usePaged,
  useSession, useTab,
} from "../ui";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SLUG_RE } from "./home";
import { Wall } from "./feed";
import { GroupDetail, Invites, MemberPicker } from "./org";
import { AgentOnboarding } from "./settings";
import type { Group, Org, Page, Paged, Project, ProjectGroupGrant, ProjectMember, ProjectRole, Visibility } from "../types";

const PROJECT_ROLES: [ProjectRole, string][] = (["viewer", "editor", "admin"] as ProjectRole[]).map((r) => [r, ROLE_LABEL[r]]);

/** 先从 /api/me/projects（跨组织、整会话缓存）按 slug 找；组织管理员可能没有项目角色而不在其中，再翻组织项目列表 */
async function findProject(org: Org, slug: string): Promise<Project | null> {
  const mine = (await loadMyProjects()).find((p) => p.org.id === org.id && p.slug === slug);
  if (mine) return get<Project>(`/projects/${mine.id}`);
  if (org.my_role === "member") return null;
  let cursor: string | null = null;
  do {
    const r: Paged<Project> = await get(`/orgs/${org.id}/projects${qs({ limit: 200, cursor })}`);
    const p = r.items.find((x) => x.slug === slug);
    if (p) return p;
    cursor = r.next_cursor;
  } while (cursor);
  return null;
}

export function ProjectPage({ orgSlug, projectSlug }: { orgSlug: string; projectSlug: string }) {
  const { me } = useSession();
  const org = me!.orgs.find((o) => o.slug === orgSlug);
  const proj = useLoad(() => (org ? findProject(org, projectSlug) : Promise.resolve(null)), [org?.id, projectSlug]);
  const admin = proj.data?.my_role === "admin" || org?.my_role === "owner" || org?.my_role === "admin";
  const [tab, setTab] = useTab(admin ? ["pages", "members", "settings"] : ["pages", "members"]);
  if (proj.loading && !proj.data) return <Loading />;
  if (!org || !proj.data) return <AuthCard title="项目不存在或无权访问"><p className="text-sm"><Link className="link" to={org ? `/o/${org.slug}` : "/"}>返回</Link></p></AuthCard>;
  const p = proj.data;
  return (
    <Tabs value={tab} onValueChange={setTab} className="gap-5">
      {/* 项目页 = 同一套格子墙只看该项目；成员与设置在右上角 Tab 里 */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-[13px] text-muted-foreground">
        <span className="flex min-w-0 items-center gap-2">
          <Link to={`/o/${org.slug}`} className="hover:text-foreground">{org.name}</Link><span aria-hidden="true">/</span>
          <span className="truncate">{p.name}</span>
          <Badge variant="secondary">{p.my_role ? ROLE_LABEL[p.my_role] : "组织管理员"}</Badge>
        </span>
        <TabsList className="h-auto rounded-full bg-muted p-1">
          <TabsTrigger value="pages" className="rounded-full px-3.5">页面</TabsTrigger>
          <TabsTrigger value="members" className="rounded-full px-3.5">成员与权限</TabsTrigger>
          {admin && <TabsTrigger value="settings" className="rounded-full px-3.5">设置</TabsTrigger>}
        </TabsList>
      </div>
      <TabsContent value="pages">
        <Wall projectId={p.id} title={p.name}
          empty={<AgentOnboarding title="这个项目还没有页面" note="让 agent 调用 MCP 的 publish_page 发布到本项目。还没接入的话，两步：" />} />
      </TabsContent>
      <TabsContent value="members">
        <Shell>
          <PageHeader title={p.name} desc={p.description || undefined} />
          <div className="flex flex-col gap-10">
            <Section title="直接成员" desc="组织所有者/管理员自动拥有项目管理员权限。"><Members org={org} project={p} admin={admin} /></Section>
            <Section title="项目群组" desc="本项目自己的群组（成员自动获得所选角色）和已授权的组织级群组。4 小时内有页面发给它的群组标为活跃，agent 发页面时优先发给活跃群组。"><ProjectGroups org={org} project={p} admin={admin} /></Section>
            {admin && <Section title="邀请" desc="组织外的人用邀请链接加入本项目。"><Invites org={org} listPath={`/projects/${p.id}/invites`} targets={["project"]} projectId={p.id} /></Section>}
          </div>
        </Shell>
      </TabsContent>
      {admin && <TabsContent value="settings"><Shell><PageHeader title={p.name} /><ProjectSettings org={org} project={p} onSaved={proj.reload} /></Shell></TabsContent>}
    </Tabs>
  );
}

function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <div><h2 className="text-base font-bold">{title}</h2>{desc && <p className="mt-0.5 text-[13px] text-muted-foreground">{desc}</p>}</div>
      {children}
    </section>
  );
}

/** 页面设置（详情页「管理」）：标题、可见性、提交开关、结果可见范围、删除。改成「公开」与删除都要在对话框里显式确认 */
export function PageMetaEditor({ page, groups, onSaved, onDeleted }: { page: Page; groups: Group[]; onSaved: () => void; onDeleted: () => void }) {
  const [f, setF] = useState({
    title: page.title, visibility: page.visibility, group_ids: page.group_ids,
    accept_responses: page.accept_responses, results_visible_to: page.results_visible_to,
  });
  const [ask, setAsk] = useState<null | "public" | "delete">(null);
  const a = useAction();
  const doSave = () =>
    a.run(async () => {
      await patch(`/pages/${page.id}`, { ...f, group_ids: f.visibility === "groups" ? f.group_ids : [] });
      toast.ok("已保存");
      onSaved();
    });
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (f.visibility === "public" && page.visibility !== "public") setAsk("public");
    else doSave();
  };
  // 候选：本项目的项目群组在前，再组织级群组；不显示其他项目的群组
  const candidates = [...groups.filter((g) => g.project_id === page.project_id), ...groups.filter((g) => !g.project_id)];
  const toggleGroup = (id: string) =>
    setF({ ...f, group_ids: f.group_ids.includes(id) ? f.group_ids.filter((g) => g !== id) : [...f.group_ids, id] });
  return (
    <form onSubmit={save} className="form">
      <Field label="标题"><Input required maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="可见性">
        <NativeSelect<Visibility> aria-label="可见性" value={f.visibility} onChange={(v) => setF({ ...f, visibility: v })}
          options={(["public", "org", "project", "groups"] as Visibility[]).map((v) => [v, VIS_LABEL[v]])} />
      </Field>
      {f.visibility === "groups" && (
        <div className="checks">
          {candidates.length === 0 && <span className="muted small">本项目和组织都还没有群组。</span>}
          {candidates.map((g) => (
            <CheckField key={g.id} checked={f.group_ids.includes(g.id)} onChange={() => toggleGroup(g.id)}>
              {g.name}{g.project_id && <span className="muted small">（本项目）</span>}
            </CheckField>
          ))}
        </div>
      )}
      {page.category !== "read" && <CheckField checked={f.accept_responses} onChange={(v) => setF({ ...f, accept_responses: v })}>接受提交</CheckField>}
      <Field label="结果可见范围">
        <NativeSelect value={f.results_visible_to} onChange={(v) => setF({ ...f, results_visible_to: v })}
          options={[["managers", "仅页面管理者"], ["viewers", "所有能查看页面的人"]]} />
      </Field>
      <ErrorBox error={a.error} />
      <div className="form-actions">
        <Button type="submit" loading={a.busy} disabled={a.busy || (f.visibility === "groups" && f.group_ids.length === 0)}>保存</Button>
        <Button type="button" variant="ghost-destructive" disabled={a.busy} onClick={() => setAsk("delete")}>删除页面</Button>
      </div>
      <AlertDialog open={ask !== null} onOpenChange={(o) => !o && setAsk(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{ask === "delete" ? `删除页面「${page.title}」？` : "改为公开？"}</AlertDialogTitle>
            <AlertDialogDescription>
              {ask === "delete" ? "删除后页面和临时链接都无法访问，已收集的提交一并不可见。" : "公开后，任何拿到链接的人（包括未登录的人）都能查看这个页面。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant={ask === "delete" ? "destructive" : "default"}
              onClick={() => (ask === "delete" ? a.run(async () => (await del(`/pages/${page.id}`), onDeleted())) : doSave())}>
              {ask === "delete" ? "删除" : "确认公开"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}

function Members({ org, project, admin }: { org: Org; project: Project; admin: boolean }) {
  const { me } = useSession();
  const list = usePaged<ProjectMember>(`/projects/${project.id}/members`);
  const [role, setRole] = useState<ProjectRole>("editor");
  const a = useAction();
  const remove = (uid: string, self: boolean) =>
    confirm(self ? "确定退出该项目？" : "确定移除该成员？") &&
    a.run(async () => {
      await del(`/projects/${project.id}/members/${uid}`);
      if (self) {
        await loadMyProjects(true);
        navigate(`/o/${org.slug}`);
      } else list.reload();
    });
  return (
    <div className={admin ? "split" : "stack"}>
    <div className="stack">
      <ErrorBox error={list.error || a.error} />
      <TableCard><Table>
        <TableHeader><TableRow><TableHead>成员</TableHead><TableHead>角色</TableHead><TableHead>加入时间</TableHead><TableHead /></TableRow></TableHeader>
        <TableBody>
          {list.items.map((m) => {
            const self = m.user.id === me!.user.id;
            return (
              <TableRow key={m.user.id}>
                <TableCell><div className="font-medium">{m.user.display_name}{self && <span className="muted font-normal">（我）</span>}</div><div className="muted small">{m.user.email}</div></TableCell>
                <TableCell>
                  {admin ? (
                    <NativeSelect aria-label="角色" value={m.role} options={PROJECT_ROLES}
                      onChange={(r) => a.run(async () => (await patch(`/projects/${project.id}/members/${m.user.id}`, { role: r }), list.reload()))} />
                  ) : ROLE_LABEL[m.role]}
                </TableCell>
                <TableCell>{fmtTime(m.joined_at)}</TableCell>
                <TableCell className="text-right">
                  {(admin || self) && (
                    <Button size="sm" variant="ghost-destructive" disabled={a.busy} onClick={() => remove(m.user.id, self)}>{self ? "退出" : "移除"}</Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table></TableCard>
      <MoreButton p={list} />
    </div>
      {admin && (
        <Panel title="添加成员" desc="只能添加本组织成员；组织外的人用下方「邀请」。">
          <div className="form">
            <Field label="角色"><NativeSelect value={role} onChange={setRole} options={PROJECT_ROLES} /></Field>
            <MemberPicker orgId={org.id}
              onPick={async (uid) => (post(`/projects/${project.id}/members`, { user_id: uid, role }), list.reload())} />
          </div>
        </Panel>
      )}
    </div>
  );
}

/** 项目群组：本项目自己的群组（可新建、管理成员，授权不能单独撤销）+ 已授权的组织级群组（可授权/撤销） */
function ProjectGroups({ org, project, admin }: { org: Org; project: Project; admin: boolean }) {
  const grants = useLoad(() => get<{ items: ProjectGroupGrant[] }>(`/projects/${project.id}/groups`), [project.id]);
  const groups = useLoad(() => (admin ? get<Paged<Group>>(`/orgs/${org.id}/groups?limit=200`) : Promise.resolve({ items: [], next_cursor: null })), [org.id, admin]);
  const [pick, setPick] = useState({ group_id: "", role: "viewer" as ProjectRole });
  const [f, setF] = useState({ name: "", role: "viewer" as ProjectRole });
  const [open, setOpen] = useState<string | null>(null);
  const a = useAction();
  const setRole = (gid: string, role: ProjectRole) =>
    a.run(async () => (await put(`/projects/${project.id}/groups/${gid}`, { role }), grants.reload()));
  const create = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      await post(`/projects/${project.id}/groups`, f);
      toast.ok("已创建项目群组");
      setF({ ...f, name: "" });
      grants.reload();
    });
  };
  const items = grants.data?.items ?? [];
  const granted = new Set(items.map((g) => g.group.id));
  return (
    <div className={admin ? "split" : "stack"}>
    <div className="stack">
      <ErrorBox error={grants.error || a.error} />
      {items.length > 0 && (
        <div className="list">
          {items.map((g) => {
            const own = g.project_id === project.id;
            return (
              <div key={g.group.id} className="list-row">
                <div className="list-main">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="list-title">{g.group.name}</span>
                    <Badge variant={own ? "info" : "secondary"}>{own ? "项目群组" : "组织群组"}</Badge>
                    {g.active && <Badge variant="success">活跃</Badge>}
                  </div>
                  <div className="list-meta">{g.last_page_at ? `最近发页 ${fmtTime(g.last_page_at)}` : "还没有页面发给它"}</div>
                </div>
                <div className="list-stat">{g.member_count !== undefined && <><b>{g.member_count}</b> 人</>}</div>
                <div className="list-actions">
                  {admin ? <NativeSelect aria-label="角色" value={g.role} options={own ? PROJECT_ROLES.filter(([r]) => r !== "admin") : PROJECT_ROLES} onChange={(r) => setRole(g.group.id, r)} /> : ROLE_LABEL[g.role]}
                  {own && <Button size="sm" variant="ghost" onClick={() => setOpen(open === g.group.id ? null : g.group.id)}>{open === g.group.id ? "收起" : "成员"}</Button>}
                  {admin && !own && (
                    <Button size="sm" variant="ghost-destructive" disabled={a.busy}
                      onClick={() => a.run(async () => (await del(`/projects/${project.id}/groups/${g.group.id}`), grants.reload()))}>撤销授权</Button>
                  )}
                </div>
                {own && open === g.group.id && (
                  <div className="list-expand">
                    <GroupDetail org={org} canManage={admin} onChange={grants.reload}
                      group={{ id: g.group.id, org_id: org.id, name: g.group.name, description: g.description ?? "", member_count: g.member_count ?? 0, created_at: g.created_at, project_id: project.id }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {grants.data?.items.length === 0 && <Empty icon={<ShieldCheck />} title="还没有项目群组">新建项目群组后，群组成员会按所选角色访问本项目，agent 也能把页面直接发给这个群组。</Empty>}
    </div>
      {admin && (
        <div className="stack">
          <Panel title="新建项目群组" desc="只属于本项目；你会自动加入，成员按所选角色访问本项目。">
            <form onSubmit={create} className="form">
              <Field label="名称"><Input required maxLength={100} placeholder="例如：前端组" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
              <Field label="成员角色"><NativeSelect value={f.role} onChange={(v) => setF({ ...f, role: v })} options={PROJECT_ROLES.filter(([r]) => r !== "admin")} /></Field>
              <div className="form-actions"><Button type="submit" loading={a.busy} disabled={a.busy}>创建群组</Button></div>
            </form>
          </Panel>
          <Panel title="授权组织级群组">
            <div className="form">
              <NativeSelect aria-label="群组" value={pick.group_id} onChange={(v) => setPick({ ...pick, group_id: v })}
                options={[["", "选择群组"], ...(groups.data?.items.filter((g) => !g.project_id && !granted.has(g.id)).map((g) => [g.id, g.name] as [string, string]) ?? [])]} />
              <NativeSelect aria-label="角色" value={pick.role} onChange={(v) => setPick({ ...pick, role: v })} options={PROJECT_ROLES} />
              <div className="form-actions">
                <Button size="sm" disabled={!pick.group_id || a.busy}
                  onClick={() => setRole(pick.group_id, pick.role)?.then(() => setPick({ ...pick, group_id: "" }))}>授权</Button>
              </div>
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

function ProjectSettings({ org, project, onSaved }: { org: Org; project: Project; onSaved: () => void }) {
  const [f, setF] = useState({ name: project.name, slug: project.slug, description: project.description });
  const a = useAction();
  const save = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      const p = await patch<Project>(`/projects/${project.id}`, f);
      await loadMyProjects(true);
      toast.ok("已保存");
      if (p.slug !== project.slug) navigate(`/o/${org.slug}/p/${p.slug}`, true);
      else onSaved();
    });
  };
  return (
    <div className="cols-2">
      <Panel title="基本信息">
      <form onSubmit={save} className="form">
        <Field label="名称"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="标识（slug）"><Input required pattern={SLUG_RE.source} value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} /></Field>
        <Field label="描述"><Textarea rows={3} maxLength={2000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <ErrorBox error={a.error} />
        <div className="form-actions"><Button type="submit" loading={a.busy} disabled={a.busy}>保存</Button></div>
      </form>
      </Panel>
      <Panel title="删除项目" desc="删除后项目内所有页面将不可访问。" danger
        actions={<Button variant="destructive" disabled={a.busy}
          onClick={() => confirm(`确定删除项目「${project.name}」？`) && a.run(async () => (await del(`/projects/${project.id}`), await loadMyProjects(true), navigate(`/o/${org.slug}`)))}>删除项目</Button>} />
    </div>
  );
}
