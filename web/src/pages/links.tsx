// 临时链接管理（api.md §11）
import { useState, type FormEvent } from "react";
import { Link2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, del, get, post, qs } from "../api";
import { Link } from "../router";
import { AuthCard, CheckField, CopyText, Empty, ErrorBox, Field, fmtTime, FormDialog, Loading, NativeSelect, Page, PageHeader, TableCard, useAction, useLoad, useOwnOrg } from "../ui";
import type { PageView, ShareLink } from "../types";

const EXPIRES: [string, string][] = [
  ["3600", "1 小时"], ["86400", "1 天"], ["604800", "7 天"], ["2592000", "30 天"], ["7776000", "90 天"],
];
const STATUS: Record<ShareLink["status"], [string, "success" | "secondary" | "warning" | "destructive"]> = {
  active: ["有效", "success"], expired: ["已过期", "secondary"], revoked: ["已撤销", "destructive"], exhausted: ["次数用完", "warning"],
};

export function LinksPage({ id }: { id: string }) {
  // 用 view 端点取标题与权限，避免 GET /pages/{id} 带回最多 5MiB 的 content
  const page = useLoad(() => get<PageView>(`/pages/${id}/view`), [id]);
  useOwnOrg(page.data?.page.org.id);
  const [inactive, setInactive] = useState(false);
  const links = useLoad(() => get<{ items: ShareLink[] }>(`/pages/${id}/share-links${qs({ include_inactive: inactive })}`), [id, inactive]);
  const a = useAction();
  const [creating, setCreating] = useState(false);

  if (page.loading) return <Page><Loading /></Page>;
  if (page.error || !page.data!.can_manage) {
    const nf = !page.error || (page.error instanceof ApiError && page.error.code === "not_found");
    return <AuthCard><ErrorBox error={nf ? new Error("页面不存在或你不是页面管理者") : page.error} /></AuthCard>;
  }
  return (
    <Page>
      <PageHeader crumbs={<Link to={`/pages/${id}`}>{page.data!.page.title}</Link>} title="临时链接"
        desc="临时链接让不在项目里的人（含未登录用户）查看并提交此页面，不受页面可见性限制。"
        actions={<Button onClick={() => setCreating(true)}>新建链接</Button>} />
      <div className="stack">
      <CheckField checked={inactive} onChange={setInactive}>显示已失效</CheckField>
      <ErrorBox error={links.error} />
      {!!links.data?.items.length && <TableCard>
        <Table>
          <TableHeader><TableRow><TableHead>备注</TableHead><TableHead>状态</TableHead><TableHead>使用</TableHead><TableHead>到期</TableHead><TableHead>创建</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {links.data?.items.map((l) => (
              <TableRow key={l.id}>
                <TableCell><span className="font-medium">{l.label || "未命名"}</span><div className="muted small mono">{l.token_prefix}…{l.has_password && "，有密码"}</div></TableCell>
                <TableCell><Badge variant={STATUS[l.status][1]}>{STATUS[l.status][0]}</Badge></TableCell>
                <TableCell>{l.use_count}{l.max_uses !== null && ` / ${l.max_uses}`}</TableCell>
                <TableCell className="nowrap">{fmtTime(l.expires_at)}</TableCell>
                <TableCell>{l.created_by.display_name}<div className="muted small">{fmtTime(l.created_at)}</div></TableCell>
                <TableCell className="text-right">
                  {l.status !== "revoked" && (
                    <Button size="sm" variant="ghost-destructive" disabled={a.busy}
                      onClick={() => confirm("撤销后该链接立即失效，确定？") && a.run(async () => (await del(`/share-links/${l.id}`), links.reload()))}>撤销</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableCard>}
      {links.data?.items.length === 0 && <Empty icon={<Link2 />} title="暂无链接">点右上角「新建链接」，发给需要查看或提交的人。</Empty>}
      </div>
      {creating && <FormDialog onClose={() => setCreating(false)} title="新建链接"><ShareLinkForm pageId={id} onCreated={links.reload} /></FormDialog>}
    </Page>
  );
}

/** 新建临时链接表单（临时链接页与页面详情「管理」共用） */
export function ShareLinkForm({ pageId, onCreated }: { pageId: string; onCreated?: () => void }) {
  const [f, setF] = useState({ label: "", expires_in: "604800", max_uses: "", password: "" });
  const [created, setCreated] = useState<string | null>(null);
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      const r = await post<{ share_link: ShareLink; url: string }>(`/pages/${pageId}/share-links`, {
        label: f.label.trim() || undefined,
        expires_in: Number(f.expires_in),
        max_uses: f.max_uses ? Number(f.max_uses) : null,
        password: f.password || undefined,
      });
      setCreated(r.url);
      setF({ ...f, label: "", password: "" });
      onCreated?.();
    });
  };
  return (
    <form onSubmit={submit} className="form">
      <Field label="备注"><Input maxLength={100} placeholder="例如：发给客户 A" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
      <Field label="有效期"><NativeSelect value={f.expires_in} onChange={(v) => setF({ ...f, expires_in: v })} options={EXPIRES} /></Field>
      <Field label="最多提交次数" hint="留空表示不限；用完后仍可查看到过期为止">
        <Input type="number" min={1} max={1000000} value={f.max_uses} onChange={(e) => setF({ ...f, max_uses: e.target.value })} />
      </Field>
      <Field label="访问密码（可选）" hint="4–128 个字符">
        <Input type="password" autoComplete="new-password" minLength={4} maxLength={128} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
      </Field>
      <ErrorBox error={a.error} />
      <div className="form-actions"><Button type="submit" loading={a.busy} disabled={a.busy}>创建链接</Button></div>
      {created && <div className="stack"><span className="small">链接只显示这一次，请立即复制：</span><CopyText text={created} /></div>}
    </form>
  );
}
