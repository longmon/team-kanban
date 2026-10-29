// PAT 管理（api.md §6）与账号设置（§3）
import { useState, type FormEvent } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { del, get, patch, post, qs } from "../api";
import { Link } from "../router";
import { CheckField, copyText, CopyText, Empty, ErrorBox, Field, fmtTime, FormDialog, NativeSelect, Notice, Page, PageHeader, Panel, TableCard, toast, useAction, useLoad, useSession, useTheme, type Skin } from "../ui";
import type { Paged, Pat, Project, Scope, UserFull } from "../types";

/** MCP 接入片段（README §3.2–3.3）：服务器地址取当前站点，令牌由 tkanban add 交互输入，不写进片段 */
export const mcpSnippet = () =>
  `tkanban add team-kanban --url ${location.origin} --default\nclaude mcp add team-kanban -s user -- "$(command -v tkanban)" mcp`;

export function McpSnippet() {
  const [done, setDone] = useState(false);
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium">MCP 配置（终端执行，按提示粘贴令牌）</span>
        <Button size="xs" variant="outline" onClick={() => copyText(mcpSnippet(), "已复制配置").then(() => setDone(true))}>{done ? <Check /> : <Copy />}{done ? "已复制" : "复制配置"}</Button>
      </div>
      <pre className="overflow-x-auto rounded-lg border bg-muted/60 px-3 py-2.5 font-mono text-[12.5px] leading-relaxed">{mcpSnippet()}</pre>
      <p className="text-xs text-muted-foreground">需要先安装 tkanban 命令行，见项目 README。Codex 等其他客户端：注册 stdio 服务器，命令 tkanban，参数 mcp。</p>
    </div>
  );
}

/** 空动态流：引导接入 agent（建令牌 + 复制 MCP 配置） */
export function AgentOnboarding({ title = "还没有页面", note }: { title?: string; note?: string }) {
  const { me } = useSession();
  const [token, setToken] = useState<string | null>(null);
  const a = useAction();
  const create = () =>
    a.run(async () => {
      const r = await post<{ pat: Pat; token: string }>("/tokens", { name: `agent ${new Date().toLocaleDateString("zh-CN")}`, scopes: ["publish", "read_responses", "manage"], expires_in: 7776000 });
      setToken(r.token);
    });
  if (me && me.orgs.length === 0)
    return (
      <section className="grid gap-3 border-y py-8">
        <h2 className="text-xl font-bold">先加入一个组织</h2>
        <p className="text-sm text-muted-foreground">agent 发布的页面归属某个组织下的项目。创建一个组织，或打开同事发给你的邀请链接。</p>
        <div><Button asChild><Link to="/orgs">创建组织</Link></Button></div>
      </section>
    );
  return (
    <section className="grid gap-5 border-y py-8" aria-label="接入 agent">
      <div className="grid gap-1.5">
        <h2 className="text-xl font-bold">{title}</h2>
        <p className="text-sm text-muted-foreground">{note ?? "页面由你的 AI agent 通过 MCP 发布到这里。两步接入："}</p>
      </div>
      <ol className="grid gap-5">
        <li className="grid gap-2">
          <span className="text-[13px] font-medium">1. 创建令牌（发布页面 + 读取提交 + 建项目和群组，90 天有效）</span>
          {token ? (
            <div className="grid gap-2"><Notice tone="warning">令牌只显示这一次，请立即复制。</Notice><CopyText text={token} /></div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={create} loading={a.busy} disabled={a.busy}><KeyRound />创建令牌</Button>
              <Button variant="ghost" asChild><Link to="/settings/tokens">自定义范围</Link></Button>
            </div>
          )}
          <ErrorBox error={a.error} />
        </li>
        <li><McpSnippet /></li>
      </ol>
      <p className="text-[13px] text-muted-foreground">配置好后，对 agent 说「把这份周报发布到看板」，页面会出现在这里。</p>
    </section>
  );
}

const SCOPES: [Scope, string][] = [["publish", "发布页面（publish）"], ["read_responses", "读取提交（read_responses）"], ["manage", "管理（建项目、建群组）"]];
const PAT_EXPIRES: [string, string][] = [["2592000", "30 天"], ["7776000", "90 天"], ["31536000", "1 年"], ["", "永不过期"]];

export function TokenSettings() {
  const [showRevoked, setShowRevoked] = useState(false);
  const list = useLoad(() => get<{ items: Pat[] }>(`/tokens${qs({ include_revoked: showRevoked })}`), [showRevoked]);
  const [creating, setCreating] = useState(false);
  const a = useAction();
  return (
    <Page>
      <PageHeader title="个人访问令牌"
        desc={<>令牌供本机 agent 的 MCP 使用（环境变量 <code>TEAM_KANBAN_TOKEN</code>）。令牌的权限不会超过你本人的当前权限。</>}
        actions={<Button onClick={() => setCreating(true)}>新建令牌</Button>} />
      <div className="stack">
      <CheckField checked={showRevoked} onChange={setShowRevoked}>显示已撤销</CheckField>
      <ErrorBox error={list.error || a.error} />
      {!!list.data?.items.length && <TableCard>
        <Table>
          <TableHeader><TableRow><TableHead>名称</TableHead><TableHead>范围</TableHead><TableHead>权限</TableHead><TableHead>到期</TableHead><TableHead>最近使用</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {list.data?.items.map((p) => (
              <TableRow key={p.id}>
                <TableCell><span className="font-medium">{p.name}</span><div className="muted small mono">arp_{p.token_prefix}…</div></TableCell>
                <TableCell>{p.org ? p.org.name : "全部组织"}{p.project && ` / ${p.project.name}`}</TableCell>
                <TableCell><div className="flex flex-wrap gap-1">{p.scopes.map((x) => <Badge key={x} variant="secondary" className="font-mono">{x}</Badge>)}</div></TableCell>
                <TableCell className="nowrap">{p.revoked_at ? "已撤销" : p.expires_at ? fmtTime(p.expires_at) : "永不"}</TableCell>
                <TableCell className="nowrap">{fmtTime(p.last_used_at)}</TableCell>
                <TableCell className="text-right">
                  {!p.revoked_at && (
                    <Button size="sm" variant="ghost-destructive" disabled={a.busy}
                      onClick={() => confirm(`撤销令牌「${p.name}」？使用它的 agent 会立即失去访问权限。`) && a.run(async () => (await del(`/tokens/${p.id}`), list.reload()))}>撤销</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableCard>}
      {list.data?.items.length === 0 && <Empty icon={<KeyRound />} title="暂无令牌">点右上角「新建令牌」，配置到 agent 的 MCP 里。</Empty>}
      </div>
      {creating && <NewTokenDialog onClose={() => setCreating(false)} onCreated={list.reload} />}
    </Page>
  );
}

function NewTokenDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { me } = useSession();
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
      onCreated();
    });
  };
  return (
    <FormDialog onClose={onClose} title="新建令牌" wide>
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
        <McpSnippet />
    </FormDialog>
  );
}

/** 外观：主题（默认 / 经典）与亮暗；只存本机 localStorage。经典主题固定亮色 */
function Appearance() {
  const t = useTheme();
  const classic = t.skin === "classic";
  const opt = "w-fit cursor-pointer gap-2.5 text-[13px] font-normal";
  return (
    <Panel title="外观" desc="只保存在这台设备的浏览器里。">
      <div className="grid gap-2.5">
        <span className="text-[13px] font-medium">主题</span>
        <RadioGroup aria-label="主题" value={t.skin} onValueChange={(v) => t.setSkin(v as Skin)} className="gap-2.5">
          <Label className={opt}><RadioGroupItem value="default" />默认（长春花工作台）</Label>
          <Label className={opt}><RadioGroupItem value="classic" />经典（Windows 98）</Label>
        </RadioGroup>
      </div>
      <div className="grid gap-2.5">
        <span className="text-[13px] font-medium">亮 / 暗</span>
        <RadioGroup aria-label="亮暗模式" value={t.mode} disabled={classic} onValueChange={(v) => t.setMode(v as "light" | "dark")} className="gap-2.5">
          <Label className={opt}><RadioGroupItem value="light" />亮色</Label>
          <Label className={opt}><RadioGroupItem value="dark" />暗色</Label>
        </RadioGroup>
        {classic && <span className="text-xs text-muted-foreground">经典主题固定为亮色。</span>}
      </div>
    </Panel>
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
      <Appearance />
      </div>
    </Page>
  );
}
