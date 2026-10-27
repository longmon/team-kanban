// 组织页：项目、群组、成员、邀请、审计、设置（api.md §4、§5、§12）
import { useState, type FormEvent } from "react";
import { FolderKanban, Mail, ScrollText, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { del, get, patch, post, qs } from "../api";
import { Link, navigate } from "../router";
import {
  AuthCard, CheckField, CopyText, Empty, ErrorBox, Field, fmtTime, ListSkeleton, Loading, MoreButton, NativeSelect, Page, PAGE_TABS_LIST, PAGE_TABS_TRIGGER,
  PageHeader, Panel, ROLE_LABEL, TableCard, toast, useAction, useLoad, usePaged, useSession,
} from "../ui";
import { SLUG_RE, slugify, Tile, TILES } from "./home";
import type { AuditEntry, Group, GroupMember, Invite, Org, OrgMember, OrgRole, Project } from "../types";

const isAdmin = (o: Org) => o.my_role === "owner" || o.my_role === "admin";

export function OrgPage({ slug }: { slug: string }) {
  const { me } = useSession();
  const org = me!.orgs.find((o) => o.slug === slug);
  if (!org) return <AuthCard title="组织不存在或你不是成员"><p className="text-sm"><Link className="link" to="/">返回首页</Link></p></AuthCard>;
  const admin = isAdmin(org);
  return (
    <Page>
      <PageHeader title={org.name} badge={<Badge variant="secondary">{ROLE_LABEL[org.my_role]}</Badge>} desc={<span className="font-mono text-[13px]">{org.slug}</span>} />
      <Tabs defaultValue="projects" className="gap-6">
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
  const [f, setF] = useState({ name: "", slug: "", description: "" });
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      const p = await post<Project>(`/orgs/${org.id}/projects`, f);
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
          <Field label="名称"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, slug: slugify(e.target.value) })} /></Field>
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
  const list = usePaged<Group>(`/orgs/${org.id}/groups`);
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
      {!list.loading && list.items.length === 0 && <Empty icon={<Users />} title="还没有群组">群组用来批量授权项目和页面，例如「评审组」。</Empty>}
      {list.items.length > 0 && (
        <div className="list">
          {list.items.map((g) => (
            <div key={g.id} className="list-row">
              <div className="list-main">
                <span className="list-title">{g.name}</span>
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
        <Panel title="新建群组">
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

function GroupDetail({ org, group, onChange }: { org: Org; group: Group; onChange: () => void }) {
  const { me } = useSession();
  const admin = isAdmin(org);
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
  const { me, refresh } = useSession();
  const [q, setQ] = useState("");
  const list = usePaged<OrgMember>(`/orgs/${org.id}/members${qs({ q: q.trim() })}`);
  const a = useAction();
  const roles: [OrgRole, string][] = (org.my_role === "owner" ? ["owner", "admin", "member"] as OrgRole[] : ["admin", "member"] as OrgRole[]).map((r) => [r, ROLE_LABEL[r]]);
  const canEdit = (m: OrgMember) => org.my_role === "owner" || (org.my_role === "admin" && m.role !== "owner");
  const canRemove = (m: OrgMember) => org.my_role === "owner" || (org.my_role === "admin" && m.role === "member");
  const leave = () =>
    confirm(`确定退出组织「${org.name}」？`) &&
    a.run(async () => {
      await del(`/orgs/${org.id}/members/${me!.user.id}`);
      await refresh();
      navigate("/");
    });
  return (
    <div className="stack">
      <Input className="search" placeholder="搜索邮箱或名字" value={q} onChange={(e) => setQ(e.target.value)} />
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
                  {!self && canEdit(m) ? (
                    <NativeSelect aria-label="角色" value={m.role} options={m.role === "owner" && org.my_role !== "owner" ? [["owner", ROLE_LABEL.owner]] : roles}
                      onChange={(role) => a.run(async () => (await patch(`/orgs/${org.id}/members/${m.user.id}`, { role }), list.reload()))} />
                  ) : ROLE_LABEL[m.role]}
                </TableCell>
                <TableCell>{fmtTime(m.joined_at)}</TableCell>
                <TableCell className="text-right">
                  {self ? (
                    <Button size="sm" variant="ghost-destructive" onClick={leave}>退出组织</Button>
                  ) : canRemove(m) && (
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
    </div>
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
