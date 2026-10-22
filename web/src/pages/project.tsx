// 项目页：页面列表与元数据编辑、成员、群组授权、邀请、设置（api.md §4.3、§4.4、§7.1）
import { useState, type FormEvent } from "react";
import { Check, FileText, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { del, get, patch, post, put, qs } from "../api";
import { cn } from "@/lib/utils";
import { Link, navigate } from "../router";
import {
  AuthCard, CATEGORY_LABEL, CATEGORY_TYPES, CheckField, Empty, ErrorBox, Field, fmtTime, ListSkeleton, Loading, MoreButton, NativeSelect, Page as Shell,
  PAGE_TABS_LIST, PAGE_TABS_TRIGGER, PAGE_TYPE_LABEL, PageHeader, PageTypeTag, Panel, ROLE_LABEL, TableCard, VIS_LABEL, toast, useAction, useLoad, usePaged,
  useSession,
} from "../ui";
import { SLUG_RE } from "./home";
import { Invites, MemberPicker } from "./org";
import type { Group, Org, Page, Paged, Project, ProjectGroupGrant, ProjectMember, ProjectRole, Visibility } from "../types";

const PROJECT_ROLES: [ProjectRole, string][] = (["viewer", "editor", "admin"] as ProjectRole[]).map((r) => [r, ROLE_LABEL[r]]);

async function findProject(orgId: string, slug: string): Promise<Project | null> {
  let cursor: string | null = null;
  do {
    const r: Paged<Project> = await get(`/orgs/${orgId}/projects${qs({ limit: 200, cursor })}`);
    const p = r.items.find((x) => x.slug === slug);
    if (p) return p;
    cursor = r.next_cursor;
  } while (cursor);
  return null;
}

export function ProjectPage({ orgSlug, projectSlug }: { orgSlug: string; projectSlug: string }) {
  const { me } = useSession();
  const org = me!.orgs.find((o) => o.slug === orgSlug);
  const proj = useLoad(() => (org ? findProject(org.id, projectSlug) : Promise.resolve(null)), [org?.id, projectSlug]);
  if (proj.loading) return <Shell><Loading /></Shell>;
  if (!org || !proj.data) return <AuthCard title="项目不存在或无权访问"><p className="text-sm"><Link className="link" to={org ? `/o/${org.slug}` : "/"}>返回</Link></p></AuthCard>;
  const p = proj.data;
  const admin = p.my_role === "admin";
  return (
    <Shell>
      <PageHeader crumbs={<Link to={`/o/${org.slug}`}>{org.name}</Link>} title={p.name}
        badge={<Badge variant="secondary">{p.my_role ? ROLE_LABEL[p.my_role] : "组织管理员"}</Badge>} desc={p.description || undefined} />
      <Tabs defaultValue="pages" className="gap-6">
        <TabsList className={PAGE_TABS_LIST}>
          <TabsTrigger value="pages" className={PAGE_TABS_TRIGGER}>页面</TabsTrigger>
          <TabsTrigger value="members" className={PAGE_TABS_TRIGGER}>成员</TabsTrigger>
          <TabsTrigger value="groups" className={PAGE_TABS_TRIGGER}>群组授权</TabsTrigger>
          {admin && <TabsTrigger value="invites" className={PAGE_TABS_TRIGGER}>邀请</TabsTrigger>}
          {admin && <TabsTrigger value="settings" className={PAGE_TABS_TRIGGER}>设置</TabsTrigger>}
        </TabsList>
        <TabsContent value="pages"><Pages org={org} project={p} /></TabsContent>
        <TabsContent value="members"><Members org={org} project={p} /></TabsContent>
        <TabsContent value="groups"><GroupGrants org={org} project={p} /></TabsContent>
        {admin && <TabsContent value="invites"><Invites org={org} listPath={`/projects/${p.id}/invites`} targets={["project"]} projectId={p.id} /></TabsContent>}
        {admin && <TabsContent value="settings"><ProjectSettings org={org} project={p} onSaved={proj.reload} /></TabsContent>}
      </Tabs>
    </Shell>
  );
}

/** 列表筛选项：all / 大类（read、collect）/ 具体 page_type */
const FILTERS: [string, string][] = [
  ["all", "全部"],
  ...Object.keys(CATEGORY_TYPES).map((c): [string, string] => [c, CATEGORY_LABEL[c]]),
  ...Object.values(CATEGORY_TYPES).flat().map((t): [string, string] => [t, PAGE_TYPE_LABEL[t]]),
];
const filterTypes = (f: string) => (f === "all" ? undefined : (CATEGORY_TYPES[f] ?? [f]).join(","));

function Pages({ org, project }: { org: Org; project: Project }) {
  const [filter, setFilter] = useState("all");
  const list = usePaged<Page>(`/pages${qs({ project_id: project.id, page_type: filterTypes(filter) })}`);
  const groups = useLoad(() => get<Paged<Group>>(`/orgs/${org.id}/groups?limit=200`), [org.id]);
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="stack">
      <p className="tab-intro">页面内容由 agent 通过 MCP 发布与更新；这里只能修改标题、可见性和提交开关。</p>
      <div role="group" aria-label="按类型筛选" className="flex flex-wrap items-center gap-2">
        {FILTERS.map(([v, label], i) => (
          <button key={v} type="button" aria-pressed={filter === v} onClick={() => setFilter(v)}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-full border px-3 text-[13px] font-semibold transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/80 active:scale-[.97]",
              filter === v ? "border-primary bg-primary/10" : "border-input text-muted-foreground",
              i === Object.keys(CATEGORY_TYPES).length + 1 && "sm:ml-3",
            )}>
            {filter === v && <Check strokeWidth={3} className="size-3.5 animate-in zoom-in-50 duration-150 ease-pop" />}{label}
          </button>
        ))}
      </div>
      <ErrorBox error={list.error} />
      {list.loading && list.items.length === 0 && <ListSkeleton />}
      {!list.loading && list.items.length === 0 && (filter === "all"
        ? <Empty icon={<FileText />} title="还没有页面">让 agent 调用 MCP 的 publish_page 发布第一个页面。</Empty>
        : <Empty icon={<FileText />} title="没有该类型的页面" />)}
      {list.items.length > 0 && (
        <div className="list">
          {list.items.map((pg) => (
            <div key={pg.id} className="list-row">
              <div className="list-main">
                <Link to={`/pages/${pg.id}`} className="list-title">{pg.title}</Link>
                <div className="list-meta">
                  <Badge variant="secondary"><PageTypeTag type={pg.page_type} /></Badge>
                  <Badge variant="outline">{pg.kind === "openui" ? "OpenUI" : "HTML"}</Badge>
                  <Badge variant={pg.visibility === "public" ? "info" : "secondary"}>{VIS_LABEL[pg.visibility]}</Badge>
                  {!pg.accept_responses && pg.category !== "read" && <Badge variant="warning">已关闭提交</Badge>}
                  <span>v{pg.version}</span>
                  <span>{pg.created_by.display_name} 更新于 {fmtTime(pg.updated_at)}</span>
                </div>
              </div>
              <div className="list-stat">{pg.category !== "read" && <><b>{pg.response_count}</b> 条提交</>}</div>
              <div className="list-actions">
                {pg.category !== "read" && <Button size="sm" variant="outline" onClick={() => navigate(`/pages/${pg.id}/results`)}>结果</Button>}
                {pg.can_manage && <Button size="sm" variant="outline" onClick={() => navigate(`/pages/${pg.id}/links`)}>临时链接</Button>}
                {pg.can_manage && <Button size="sm" variant="ghost" onClick={() => setEditing(editing === pg.id ? null : pg.id)}>{editing === pg.id ? "收起" : "编辑"}</Button>}
              </div>
              {editing === pg.id && (
                <div className="list-expand">
                  <PageMetaEditor page={pg} groups={groups.data?.items ?? []} onDone={() => (setEditing(null), list.reload())} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <MoreButton p={list} />
    </div>
  );
}

export function PageMetaEditor({ page, groups, onDone }: { page: Page; groups: Group[]; onDone: () => void }) {
  const [f, setF] = useState({
    title: page.title, visibility: page.visibility, group_ids: page.group_ids,
    accept_responses: page.accept_responses, results_visible_to: page.results_visible_to,
  });
  const a = useAction();
  const save = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      await patch(`/pages/${page.id}`, { ...f, group_ids: f.visibility === "groups" ? f.group_ids : [] });
      toast.ok("已保存");
      onDone();
    });
  };
  const toggleGroup = (id: string) =>
    setF({ ...f, group_ids: f.group_ids.includes(id) ? f.group_ids.filter((g) => g !== id) : [...f.group_ids, id] });
  return (
    <form onSubmit={save} className="form">
      <Field label="标题"><Input required maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="可见性">
        <NativeSelect<Visibility> value={f.visibility} onChange={(v) => setF({ ...f, visibility: v })}
          options={(["public", "org", "project", "groups"] as Visibility[]).map((v) => [v, VIS_LABEL[v]])} />
      </Field>
      {f.visibility === "groups" && (
        <div className="checks">
          {groups.length === 0 && <span className="muted small">组织内还没有群组。</span>}
          {groups.map((g) => (
            <CheckField key={g.id} checked={f.group_ids.includes(g.id)} onChange={() => toggleGroup(g.id)}>{g.name}</CheckField>
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
        <Button type="button" variant="ghost-destructive" disabled={a.busy}
          onClick={() => confirm(`删除页面「${page.title}」？`) && a.run(async () => (await del(`/pages/${page.id}`), onDone()))}>删除页面</Button>
      </div>
    </form>
  );
}

function Members({ org, project }: { org: Org; project: Project }) {
  const { me } = useSession();
  const admin = project.my_role === "admin";
  const list = usePaged<ProjectMember>(`/projects/${project.id}/members`);
  const [role, setRole] = useState<ProjectRole>("editor");
  const a = useAction();
  const remove = (uid: string, self: boolean) =>
    confirm(self ? "确定退出该项目？" : "确定移除该成员？") &&
    a.run(async () => {
      await del(`/projects/${project.id}/members/${uid}`);
      self ? navigate(`/o/${org.slug}`) : list.reload();
    });
  return (
    <div className={admin ? "split" : "stack"}>
    <div className="stack">
      <p className="tab-intro">这里只列直接成员；经群组授权的成员见「群组授权」。组织所有者/管理员自动拥有项目管理员权限。</p>
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
        <Panel title="添加成员" desc="只能添加本组织成员；组织外的人请用「邀请」。">
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

function GroupGrants({ org, project }: { org: Org; project: Project }) {
  const admin = project.my_role === "admin";
  const grants = useLoad(() => get<{ items: ProjectGroupGrant[] }>(`/projects/${project.id}/groups`), [project.id]);
  const groups = useLoad(() => (admin ? get<Paged<Group>>(`/orgs/${org.id}/groups?limit=200`) : Promise.resolve({ items: [], next_cursor: null })), [org.id, admin]);
  const [pick, setPick] = useState({ group_id: "", role: "viewer" as ProjectRole });
  const a = useAction();
  const setRole = (gid: string, role: ProjectRole) =>
    a.run(async () => (await put(`/projects/${project.id}/groups/${gid}`, { role }), grants.reload()));
  const granted = new Set(grants.data?.items.map((g) => g.group.id));
  return (
    <div className="stack">
      <ErrorBox error={grants.error || a.error} />
      {!!grants.data?.items.length && <TableCard><Table>
        <TableHeader><TableRow><TableHead>群组</TableHead><TableHead>角色</TableHead><TableHead>授权时间</TableHead><TableHead /></TableRow></TableHeader>
        <TableBody>
          {grants.data?.items.map((g) => (
            <TableRow key={g.group.id}>
              <TableCell>{g.group.name}</TableCell>
              <TableCell>{admin ? <NativeSelect aria-label="角色" value={g.role} options={PROJECT_ROLES} onChange={(r) => setRole(g.group.id, r)} /> : ROLE_LABEL[g.role]}</TableCell>
              <TableCell>{fmtTime(g.created_at)}</TableCell>
              <TableCell className="text-right">
                {admin && (
                  <Button size="sm" variant="ghost-destructive" disabled={a.busy}
                    onClick={() => a.run(async () => (await del(`/projects/${project.id}/groups/${g.group.id}`), grants.reload()))}>取消授权</Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table></TableCard>}
      {grants.data?.items.length === 0 && <Empty icon={<ShieldCheck />} title="暂无群组授权">授权后，群组成员会按所选角色访问本项目。</Empty>}
      {admin && (
        <div className="row wrap toolbar">
          <NativeSelect aria-label="群组" value={pick.group_id} onChange={(v) => setPick({ ...pick, group_id: v })}
            options={[["", "选择群组"], ...(groups.data?.items.filter((g) => !granted.has(g.id)).map((g) => [g.id, g.name] as [string, string]) ?? [])]} />
          <NativeSelect aria-label="角色" value={pick.role} onChange={(v) => setPick({ ...pick, role: v })} options={PROJECT_ROLES} />
          <Button size="sm" disabled={!pick.group_id || a.busy}
            onClick={() => setRole(pick.group_id, pick.role)?.then(() => setPick({ ...pick, group_id: "" }))}>授权</Button>
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
          onClick={() => confirm(`确定删除项目「${project.name}」？`) && a.run(async () => (await del(`/projects/${project.id}`), navigate(`/o/${org.slug}`)))}>删除项目</Button>} />
    </div>
  );
}
