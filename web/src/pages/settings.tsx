// PAT 管理（api.md §6）与账号设置（§3）
import { useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { del, get, patch, post, qs } from "../api";
import { CheckField, CopyText, Empty, ErrorBox, Field, fmtTime, NativeSelect, Notice, Page, PageHeader, Panel, TableCard, toast, useAction, useLoad, useSession } from "../ui";
import type { Paged, Pat, Project, Scope, UserFull } from "../types";

const SCOPES: [Scope, string][] = [["publish", "发布页面（publish）"], ["read_responses", "读取提交（read_responses）"]];
const PAT_EXPIRES: [string, string][] = [["2592000", "30 天"], ["7776000", "90 天"], ["31536000", "1 年"], ["", "永不过期"]];

export function TokenSettings() {
  const { me } = useSession();
  const [showRevoked, setShowRevoked] = useState(false);
  const list = useLoad(() => get<{ items: Pat[] }>(`/tokens${qs({ include_revoked: showRevoked })}`), [showRevoked]);
  const [f, setF] = useState({ name: "", scopes: ["publish", "read_responses"] as Scope[], org_id: "", project_id: "", expires_in: "7776000" });
  const projects = useLoad(
    () => (f.org_id ? get<Paged<Project>>(`/orgs/${f.org_id}/projects?limit=200`) : Promise.resolve({ items: [], next_cursor: null })),
    [f.org_id],
  );
  const [token, setToken] = useState<string | null>(null);
  const a = useAction();
  const toggle = (s: Scope) => setF({ ...f, scopes: f.scopes.includes(s) ? f.scopes.filter((x) => x !== s) : [...f.scopes, s] });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      const r = await post<{ pat: Pat; token: string }>("/tokens", {
        name: f.name, scopes: f.scopes,
        org_id: f.org_id || undefined, project_id: f.project_id || undefined,
        expires_in: f.expires_in ? Number(f.expires_in) : null,
      });
      setToken(r.token);
      setF({ ...f, name: "" });
      list.reload();
    });
  };
  return (
    <Page>
      <PageHeader title="个人访问令牌"
        desc={<>令牌供本机 agent 的 MCP 使用（环境变量 <code>TEAM_KANBAN_TOKEN</code>）。令牌的权限不会超过你本人的当前权限。</>} />
      <div className="split">
      <div className="stack">
      <CheckField checked={showRevoked} onChange={setShowRevoked}>显示已吊销</CheckField>
      <ErrorBox error={list.error} />
      {!!list.data?.items.length && <TableCard>
        <Table>
          <TableHeader><TableRow><TableHead>名称</TableHead><TableHead>范围</TableHead><TableHead>权限</TableHead><TableHead>到期</TableHead><TableHead>最近使用</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {list.data?.items.map((p) => (
              <TableRow key={p.id}>
                <TableCell><span className="font-medium">{p.name}</span><div className="muted small mono">arp_{p.token_prefix}…</div></TableCell>
                <TableCell>{p.org ? p.org.name : "全部组织"}{p.project && ` / ${p.project.name}`}</TableCell>
                <TableCell><div className="flex flex-wrap gap-1">{p.scopes.map((x) => <Badge key={x} variant="secondary" className="font-mono">{x}</Badge>)}</div></TableCell>
                <TableCell className="nowrap">{p.revoked_at ? "已吊销" : p.expires_at ? fmtTime(p.expires_at) : "永不"}</TableCell>
                <TableCell className="nowrap">{fmtTime(p.last_used_at)}</TableCell>
                <TableCell className="text-right">
                  {!p.revoked_at && (
                    <Button size="sm" variant="ghost-destructive" disabled={a.busy}
                      onClick={() => confirm(`吊销令牌「${p.name}」？使用它的 agent 会立即失去访问权限。`) && a.run(async () => (await del(`/tokens/${p.id}`), list.reload()))}>吊销</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableCard>}
      {list.data?.items.length === 0 && <Empty icon={<KeyRound />} title="暂无令牌">新建一个令牌，配置到 agent 的 MCP 里。</Empty>}
      </div>
      <Panel title="新建令牌">
        <form onSubmit={submit} className="form">
          <Field label="名称"><Input required maxLength={100} placeholder="例如：笔记本上的 Claude" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <div className="grid gap-2.5"><span className="text-[13px] font-medium">权限</span>
            {SCOPES.map(([s, l]) => <CheckField key={s} checked={f.scopes.includes(s)} onChange={() => toggle(s)}>{l}</CheckField>)}
          </div>
          <Field label="限定组织">
            <NativeSelect value={f.org_id} onChange={(v) => setF({ ...f, org_id: v, project_id: "" })}
              options={[["", "不限"], ...me!.orgs.map((o) => [o.id, o.name] as [string, string])]} />
          </Field>
          {f.org_id && (
            <Field label="限定项目">
              <NativeSelect value={f.project_id} onChange={(v) => setF({ ...f, project_id: v })}
                options={[["", "不限"], ...(projects.data?.items.map((p) => [p.id, p.name] as [string, string]) ?? [])]} />
            </Field>
          )}
          <Field label="有效期"><NativeSelect value={f.expires_in} onChange={(v) => setF({ ...f, expires_in: v })} options={PAT_EXPIRES} /></Field>
          <ErrorBox error={a.error} />
          <div className="form-actions"><Button type="submit" loading={a.busy} disabled={a.busy || f.scopes.length === 0}>创建令牌</Button></div>
        </form>
        {token && (
          <div className="stack">
            <Notice tone="warning">令牌只显示这一次，关闭或刷新页面后无法再查看，请立即复制保存。</Notice>
            <CopyText text={token} />
          </div>
        )}
      </Panel>
      </div>
    </Page>
  );
}

export function AccountSettings() {
  const { me, refresh } = useSession();
  const [name, setName] = useState(me!.user.display_name);
  const [pw, setPw] = useState({ current_password: "", new_password: "" });
  const a = useAction(), b = useAction(), c = useAction();
  return (
    <Page>
      <PageHeader title="账号设置" />
      <div className="cols-2">
      <Panel title="基本信息">
        <p className="flex flex-wrap items-center gap-2 text-sm"><span className="text-muted-foreground">邮箱</span>{me!.user.email}<Badge variant={me!.user.email_verified ? "success" : "warning"}>{me!.user.email_verified ? "已验证" : "未验证"}</Badge></p>
        {!me!.user.email_verified && (
          <div className="stack">
            <ErrorBox error={c.error} />
            <div><Button size="sm" variant="outline" disabled={c.busy}
              onClick={() => c.run(async () => (await post("/auth/resend-verification"), toast.ok("验证邮件已发送")))}>重发验证邮件</Button></div>
          </div>
        )}
        <form className="form" onSubmit={(e) => {
          e.preventDefault();
          a.run(async () => (await patch<{ user: UserFull }>("/auth/me", { display_name: name }), await refresh(), toast.ok("已保存")));
        }}>
          <Field label="显示名"><Input required maxLength={50} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <ErrorBox error={a.error} />
          <div className="form-actions"><Button type="submit" loading={a.busy} disabled={a.busy}>保存</Button></div>
        </form>
      </Panel>
      <Panel title="修改密码" desc="修改后其它设备会被登出。">
        <form className="form" onSubmit={(e) => {
          e.preventDefault();
          b.run(async () => (await post("/auth/password/change", pw), setPw({ current_password: "", new_password: "" }), toast.ok("密码已修改，其它设备已登出")));
        }}>
          <Field label="当前密码"><Input type="password" autoComplete="current-password" required value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} /></Field>
          <Field label="新密码" hint="10–128 个字符">
            <Input type="password" autoComplete="new-password" required minLength={10} maxLength={128} value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} />
          </Field>
          <ErrorBox error={b.error} />
          <div className="form-actions"><Button type="submit" loading={b.busy} disabled={b.busy}>修改密码</Button></div>
        </form>
      </Panel>
      </div>
    </Page>
  );
}
