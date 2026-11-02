// 需求页面（对外英文名 Story，api.md §7.8）：/pages/:id 上 page_type=requirement 时的详情（题头 + 状态条与操作、正文、补充文档三区：附件 / 补充说明 / 关联页面；
// 右栏指派、需求群组、信息、状态历史）；/stories/new 与 /stories/:id/edit 是独立的新建 / 编辑页（复杂表单）；
// 追加补充说明、关联页面、改指派、改状态（写说明）用弹窗。正文与说明走 react-markdown（不渲染原始 HTML、过滤 javascript: 链接）。
// 经典主题：外层 ClassicSheet，分区用 data-box，附件用「详细信息」列表（.cl-list）。
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Download, FileUp, History, ImagePlus, Link2, Lock, Paperclip, Pencil, Plus, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { del, errMsg, get, patch, post, qs } from "../api";
import { Link, navigate, useQuery } from "../router";
import {
  AuthCard, CheckField, ErrorBox, Field, fmtDue, fmtRel, fmtTime, FormDialog, Initial, Loading, NativeSelect, Notice, Page as PageBox, PageHeader,
  PAGE_TYPE_LABEL, REQ_STATUS_LABEL, toast, toneOf, ToneIcon, useAction, useActiveProject, useClassic, useLoad, useMyProjects, useNow, useOwnOrg, VIS_LABEL,
} from "../ui";
import { ClassicSheet, useClassicTitle } from "../classic";
import { patchCachedPage } from "./feed";
import type { Page, Paged, ProjectGroupGrant, ProjectMember, ReqStatus, Requirement } from "../types";

const STEPS: ReqStatus[] = ["open", "analyzing", "developing", "in_review", "done"];
const PRIORITIES = ["P0", "P1", "P2", "P3"];
const STATUS_CLS: Record<string, string> = {
  open: "bg-secondary text-muted-foreground", analyzing: "bg-primary-soft text-primary", developing: "bg-primary-soft text-primary",
  in_review: "bg-tone-f text-tone-ink", done: "bg-mint-soft text-mint-ink", rejected: "bg-coral-soft text-coral-ink", on_hold: "bg-secondary text-muted-foreground",
};
const EVENT_LABEL: Record<string, string> = { created: "创建了需求", claimed: "认领了需求", group_created: "创建了需求群组", assigned: "修改了指派", edited: "编辑了需求" };

/** 按钮文案：从哪个状态到哪个状态 */
function actionLabel(from: ReqStatus, to: ReqStatus) {
  if (to === "developing") return from === "analyzing" ? "开始开发" : from === "in_review" ? "验收不通过" : from === "done" ? "重新打开" : "回到开发中";
  if (to === "in_review") return "提交验收";
  if (to === "done") return "验收通过";
  if (to === "rejected") return "拒绝";
  if (to === "on_hold") return "搁置";
  if (to === "open") return from === "rejected" ? "重新打开" : "退回待认领";
  return "回到分析中";
}
const needNote = (from: ReqStatus, to: ReqStatus) => to === "rejected" || (from === "in_review" && to === "developing");

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);

export function Md({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]} components={{ img: ({ node: _n, ...p }) => <img {...p} loading="lazy" className="my-2 max-w-full rounded-[8px] border" /> }}>{text}</Markdown>
    </div>
  );
}

function Box({ title, note, actions, children, label }: { title: ReactNode; note?: ReactNode; actions?: ReactNode; children: ReactNode; label?: string }) {
  return (
    <section data-box="" aria-label={label} className="rounded-[16px] border bg-card px-[18px] py-4">
      <h3 className="mb-3 flex items-center gap-2 text-[14px] font-semibold">{title}{note && <small className="text-[12px] font-normal text-faint">{note}</small>}
        {actions && <span className="ml-auto flex gap-1.5">{actions}</span>}
      </h3>
      {children}
    </section>
  );
}

type Dlg = { kind: "status"; to: ReqStatus } | { kind: "doc" } | { kind: "link" } | { kind: "assign" };

/** /pages/:id 上的需求详情（view.tsx 在 page_type=requirement 时渲染） */
export default function RequirementView({ id }: { id: string }) {
  const now = useNow();
  const classic = useClassic();
  const q = useLoad(() => get<Requirement>(`/stories/${id}`), [id]);
  const r = q.data;
  useOwnOrg(r?.org.id);
  useActiveProject(r?.project.id);
  useClassicTitle(r ? `${r.code} ${r.title}` : undefined);
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => (q.reload(), patchCachedPage(id));
  /** 执行一个改动：成功 toast 并刷新，失败 toast 原因 */
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.ok(ok);
      refresh();
    } catch (e) {
      toast.err(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  if (q.error) return <AuthCard><ErrorBox error={q.error} /></AuthCard>;
  if (!r) return <PageBox><Loading rows={6} /></PageBox>;

  const me = r.me;
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const f of Array.from(files)) {
      if (f.size > r.limits.max_file_bytes) {
        toast.err(`${f.name} 超过 ${fmtSize(r.limits.max_file_bytes)} 上限`);
        continue;
      }
      await act(() => post(`/stories/${id}/files${qs({ name: f.name })}`, f), `已上传 ${f.name}`);
    }
    if (fileRef.current) fileRef.current.value = "";
  };
  const terminal = r.status === "rejected" || r.status === "on_hold";
  const stepAt = STEPS.indexOf(r.status);

  const body = (
    <article data-tone="task" data-req="" className="flex flex-col">
      <nav aria-label="路径" className="cl-hide flex min-w-0 flex-wrap items-center gap-2 text-[13px] text-faint [&_a:hover]:text-foreground [&_a:hover]:underline [&>*+*]:before:mr-2 [&>*+*]:before:content-['/']">
        <Link to="/">首页</Link><span>{r.project.name}</span><span>需求</span><span className="min-w-0 truncate">{r.code}</span>
      </nav>
      <div className="mt-[18px] grid items-start gap-7 min-[1100px]:grid-cols-[minmax(0,1fr)_340px] min-[1500px]:grid-cols-[minmax(0,1fr)_392px]">
        <div className="flex min-w-0 flex-col gap-4">
          <section className="band flex items-start gap-4">
            <ToneIcon tone="task" className="size-12 rounded-[14px] bg-tone-f text-tone [&_svg]:size-6 max-sm:hidden" />
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-[13px]">
                <b data-req-code="" className="rounded-[6px] bg-tone-f px-1.5 font-mono text-tone-ink">{r.code}</b>
                <span data-req-status={r.status} className={cn("rounded-full px-2 py-px font-medium", STATUS_CLS[r.status])}>{REQ_STATUS_LABEL[r.status]}</span>
                {r.priority && <span className={cn("rounded-full px-2 py-px font-medium", r.priority === "P0" ? "bg-coral-soft text-coral-ink" : "bg-secondary")}>{r.priority}</span>}
              </div>
              <h1 data-vt={r.id} className="mb-1.5 w-fit text-[28px] leading-[1.25] font-semibold tracking-[-0.01em] [overflow-wrap:anywhere] max-sm:text-[24px]">{r.title}</h1>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-muted-foreground [&>span]:inline-flex [&>span]:items-center [&>span]:gap-[5px]">
                <span><Initial name={r.created_by.display_name} className="size-5 text-[10px] ring-0" />{r.created_by.display_name} 提出，{fmtRel(r.created_at, new Date(now))}</span>
                {r.due_at && <span>期望 {fmtDue(r.due_at, new Date(now))} 完成</span>}
                {r.claimed_by && <span>{r.claimed_by.display_name} 认领</span>}
              </div>
            </div>
          </section>
          {r.closed_at && (
            <div role="status" className="flex items-center gap-2 rounded-[12px] bg-secondary px-4 py-2.5 text-sm text-muted-foreground">
              <Lock className="size-[18px] shrink-0" />需求页面已关闭：只有发起人和项目管理员能看到，不能再改状态、上传或追加说明。
            </div>
          )}
          {/* 状态条 + 操作 */}
          <section data-box="" aria-label="状态" className="rounded-[16px] border bg-card px-[18px] py-4">
            <ol className="mb-3 grid grid-cols-5 gap-1.5 text-center text-[12px]" aria-label="状态流转">
              {STEPS.map((s, i) => (
                <li key={s} aria-current={s === r.status ? "step" : undefined}
                  className={cn("rounded-[8px] px-1 py-1.5", i < stepAt || (s === r.status && s === "done") ? "bg-mint-soft text-mint-ink" : s === r.status ? "bg-primary font-semibold text-primary-foreground" : "bg-muted text-muted-foreground")}>
                  {REQ_STATUS_LABEL[s]}
                </li>
              ))}
            </ol>
            {terminal && <p className="mb-3 text-[13px] text-muted-foreground">当前：<b className="text-foreground">{REQ_STATUS_LABEL[r.status]}</b></p>}
            <div className="flex flex-wrap gap-2">
              {me.can_claim && <Button loading={busy} disabled={busy} onClick={() => act(() => post(`/stories/${id}/claim`), "已认领，需求群组已就绪")}>认领</Button>}
              {me.transitions.map((to) => (
                <Button key={to} variant={to === "done" || to === "in_review" ? "default" : "outline"} disabled={busy} onClick={() => setDlg({ kind: "status", to })}>{actionLabel(r.status, to)}</Button>
              ))}
              {me.can_create_group && !me.can_claim && (
                <Button variant="outline" disabled={busy} onClick={() => act(() => post(`/stories/${id}/group`), "已创建需求群组")}><Users />创建需求群组</Button>
              )}
              {me.can_create_group && me.can_claim && (
                <Button variant="ghost" disabled={busy} onClick={() => act(() => post(`/stories/${id}/group`), "已创建需求群组")}>只建群组不认领</Button>
              )}
              {me.can_edit && <Button variant="ghost" asChild><Link to={`/stories/${id}/edit`}><Pencil />编辑需求</Link></Button>}
              {!me.can_claim && !me.transitions.length && !me.can_edit && <span className="text-[13px] text-muted-foreground">你可以查看这个需求；被指派者、发起人和项目管理员可以推进状态。</span>}
            </div>
          </section>
          <Box title="需求正文" label="需求正文">
            {r.body.trim() ? <Md text={r.body} /> : <p className="text-[13px] text-muted-foreground">（没有正文）</p>}
          </Box>
          {/* 补充文档：附件 */}
          <Box title={<><Paperclip className="size-4" />附件</>} note={`${r.files.length} / ${r.limits.max_files}`} label="附件"
            actions={me.can_contribute && (
              <>
                <input ref={fileRef} type="file" multiple hidden aria-label="选择附件" onChange={(e) => upload(e.target.files)} />
                <Button size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}><FileUp />上传</Button>
              </>
            )}>
            {r.files.length === 0 ? <p className="text-[13px] text-muted-foreground">还没有附件。支持 PDF、Word、Excel、PPT、图片、压缩包等，单个不超过 {fmtSize(r.limits.max_file_bytes)}。</p> : (
              <div className="cl-list overflow-x-auto" data-req-files="">
                <table className="w-full text-[13px]">
                  <thead className="text-left text-[12px] text-faint"><tr><th className="w-[55%] py-1 font-normal">名称</th><th className="font-normal">大小</th><th className="font-normal max-sm:hidden">上传者</th><th className="font-normal max-sm:hidden">时间</th><th /></tr></thead>
                  <tbody>
                    {r.files.map((f) => (
                      <tr key={f.id} className="border-t">
                        <td className="max-w-0 py-1.5 pr-2">
                          <span className="nm flex min-w-0 items-center gap-2">
                            {f.inline_url ? <img src={f.inline_url} alt="" className="size-7 shrink-0 rounded-[4px] border object-cover" /> : <Paperclip className="size-4 shrink-0 text-faint" />}
                            <a href={`/api/stories/${id}/files/${f.id}`} download={f.name} className="truncate hover:underline">{f.name}</a>
                          </span>
                        </td>
                        <td className="pr-2 whitespace-nowrap tabular-nums">{fmtSize(f.size)}</td>
                        <td className="pr-2 whitespace-nowrap max-sm:hidden">{f.uploaded_by.display_name}</td>
                        <td className="pr-2 whitespace-nowrap max-sm:hidden">{fmtRel(f.created_at, new Date(now))}</td>
                        <td className="text-right whitespace-nowrap">
                          <Button size="icon" variant="ghost" asChild><a href={`/api/stories/${id}/files/${f.id}`} download={f.name} aria-label={`下载 ${f.name}`}><Download /></a></Button>
                          {f.can_delete && <Button size="icon" variant="ghost" aria-label={`删除 ${f.name}`} disabled={busy}
                            onClick={() => confirm(`删除附件「${f.name}」？`) && act(() => del(`/stories/${id}/files/${f.id}`), "已删除附件")}><Trash2 /></Button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Box>
          {/* 补充文档：Markdown 补充说明 */}
          <Box title="补充说明" note={r.docs.length ? `${r.docs.length} 篇` : undefined} label="补充说明"
            actions={me.can_contribute && <Button size="sm" variant="outline" onClick={() => setDlg({ kind: "doc" })}><Plus />追加说明</Button>}>
            {r.docs.length === 0 ? <p className="text-[13px] text-muted-foreground">还没有补充说明。</p> : (
              <div className="flex flex-col gap-3">
                {r.docs.map((d) => (
                  <article key={d.id} data-req-doc="" className="rounded-[12px] border bg-background px-4 py-3">
                    <header className="mb-1.5 flex items-center gap-2">
                      <h4 className="min-w-0 flex-1 truncate text-[14px] font-semibold">{d.title}</h4>
                      <small className="shrink-0 text-[12px] text-faint">{d.created_by.display_name} · {fmtRel(d.created_at, new Date(now))}</small>
                      {d.can_delete && <Button size="icon" variant="ghost" aria-label={`删除说明 ${d.title}`} disabled={busy}
                        onClick={() => confirm(`删除补充说明「${d.title}」？`) && act(() => del(`/stories/${id}/docs/${d.id}`), "已删除")}><Trash2 /></Button>}
                    </header>
                    <Md text={d.body} />
                  </article>
                ))}
              </div>
            )}
          </Box>
          {/* 补充文档：关联页面 */}
          <Box title={<><Link2 className="size-4" />关联页面</>} note={r.links.length ? `${r.links.length} 个` : undefined} label="关联页面"
            actions={me.can_contribute && <Button size="sm" variant="outline" onClick={() => setDlg({ kind: "link" })}><Plus />关联页面</Button>}>
            {r.links.length === 0 ? <p className="text-[13px] text-muted-foreground">还没有关联页面。agent 发布时带 story={r.code} 会自动挂到这里，也可以手动关联报告、知识库、接口文档、流程图、任务树等。</p> : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {r.links.map((l) => (
                  <li key={l.page_id} className="flex min-w-0 items-center gap-2.5 rounded-[12px] border bg-background px-3 py-2.5">
                    {l.visible ? (
                      <>
                        <ToneIcon tone={toneOf(l.page_type)} className="size-[30px] bg-tone-f text-tone" />
                        <Link to={`/pages/${l.page_id}`} className="min-w-0 flex-1">
                          <b className="block truncate text-[13px] font-semibold hover:underline">{l.title}</b>
                          <small className="block truncate text-[12px] text-faint">{PAGE_TYPE_LABEL[l.page_type]}{l.closed_at ? "，已关闭" : ""}</small>
                        </Link>
                      </>
                    ) : (
                      <span className="flex min-w-0 flex-1 items-center gap-2 text-[13px] text-muted-foreground"><Lock className="size-4 shrink-0" />无权限查看</span>
                    )}
                    {me.can_contribute && <Button size="icon" variant="ghost" aria-label="取消关联" disabled={busy}
                      onClick={() => act(() => del(`/stories/${id}/links/${l.page_id}`), "已取消关联")}><Trash2 /></Button>}
                  </li>
                ))}
              </ul>
            )}
          </Box>
        </div>
        <aside aria-label="需求信息" className="flex min-w-0 flex-col gap-3.5">
          <Box title={<><Users className="size-4" />指派</>} label="指派" actions={me.can_edit && <Button size="sm" variant="ghost" onClick={() => setDlg({ kind: "assign" })}>改指派</Button>}>
            {r.assignees.users.length + r.assignees.groups.length === 0 ? <p className="text-[13px] text-muted-foreground">还没有指派。</p> : (
              <ul className="flex flex-wrap gap-1.5 text-[13px]">
                {r.assignees.users.map((u) => <li key={u.id} className="inline-flex items-center gap-1.5 rounded-full bg-secondary py-0.5 pr-2.5 pl-0.5"><Initial name={u.display_name} className="size-5 text-[10px] ring-0" />{u.display_name}</li>)}
                {r.assignees.groups.map((g) => <li key={g.id} className="inline-flex items-center gap-1.5 rounded-full bg-primary-soft px-2.5 py-0.5 text-primary"><Users className="size-3.5" />{g.name}</li>)}
              </ul>
            )}
          </Box>
          <Box title="需求群组" label="需求群组">
            {r.group ? (
              <p className="text-[13px]"><Link to={`/o/${r.org.slug}/groups/${r.group.id}`} className="link font-medium">{r.group.name}</Link>
                <span className="mt-1 block text-faint">相关文档发到这个群组；agent 发布时带 story={r.code}。</span></p>
            ) : <p className="text-[13px] text-muted-foreground">认领时自动创建；也可以不认领先创建。</p>}
          </Box>
          <Box title="需求信息" label="需求信息">
            <dl className="grid grid-cols-[72px_1fr] gap-x-2.5 gap-y-[7px] text-[13px] [&_dd]:min-w-0 [&_dt]:text-faint">
              <dt>编号</dt><dd className="font-mono">{r.code}</dd>
              <dt>项目</dt><dd className="truncate">{r.project.name}</dd>
              <dt>发起人</dt><dd>{r.created_by.display_name}</dd>
              <dt>认领人</dt><dd>{r.claimed_by?.display_name ?? "—"}</dd>
              <dt>优先级</dt><dd>{r.priority ?? "—"}</dd>
              <dt>期望完成</dt><dd>{r.due_at ? fmtTime(r.due_at) : "—"}</dd>
              <dt>可见范围</dt><dd>{VIS_LABEL[r.visibility]}</dd>
            </dl>
            <p className="mt-3 rounded-[10px] bg-muted px-3 py-2 font-mono text-[12px] text-muted-foreground">tkanban story pull {r.code}</p>
          </Box>
          <Box title={<><History className="size-4" />状态历史</>} label="状态历史">
            <ol className="relative grid gap-3 border-l pl-4 text-[13px]" data-req-history="">
              {[...r.events].reverse().map((e) => (
                <li key={e.id} className="relative">
                  <span className="absolute top-1.5 -left-[21px] size-2.5 rounded-full bg-primary ring-2 ring-card" aria-hidden="true" />
                  <b className="font-medium">{e.actor?.display_name ?? "有人"}</b>{" "}
                  {e.action === "status" && e.from_status && e.to_status ? <>把状态从「{REQ_STATUS_LABEL[e.from_status]}」改为「{REQ_STATUS_LABEL[e.to_status]}」</> : EVENT_LABEL[e.action]}
                  {e.action === "group_created" && typeof e.meta?.name === "string" && <>「{e.meta.name}」</>}
                  {e.via_token && <small className="ml-1 text-faint">（经令牌）</small>}
                  {e.note && <p className="mt-0.5 rounded-[8px] bg-muted px-2.5 py-1.5 text-muted-foreground [overflow-wrap:anywhere]">{e.note}</p>}
                  <time dateTime={e.at} className="block text-[12px] text-faint">{fmtTime(e.at)}</time>
                </li>
              ))}
            </ol>
          </Box>
        </aside>
      </div>
      {dlg?.kind === "status" && <StatusDialog r={r} to={dlg.to} onClose={() => setDlg(null)} onDone={refresh} />}
      {dlg?.kind === "doc" && <DocDialog id={id} onClose={() => setDlg(null)} onDone={refresh} />}
      {dlg?.kind === "link" && <LinkDialog r={r} onClose={() => setDlg(null)} onDone={refresh} />}
      {dlg?.kind === "assign" && <AssignDialog r={r} onClose={() => setDlg(null)} onDone={refresh} />}
    </article>
  );
  if (!classic) return body;
  const up = () => (history.length > 1 ? history.back() : navigate("/"));
  return (
    <ClassicSheet title={`${r.code} ${r.title}`} icon="tasks" onClose={up}
      tabs={[{ label: "需求", on: true }, ...(me.can_edit ? [{ label: "编辑", onClick: () => navigate(`/stories/${id}/edit`) }] : [])]}>
      {body}
    </ClassicSheet>
  );
}

function StatusDialog({ r, to, onClose, onDone }: { r: Requirement; to: ReqStatus; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState("");
  const a = useAction();
  const must = needNote(r.status, to);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      await post(`/stories/${r.id}/status`, { status: to, note: note.trim() || null });
      toast.ok(`已改为「${REQ_STATUS_LABEL[to]}」`);
      onDone();
      onClose();
    });
  };
  return (
    <FormDialog onClose={onClose} title={`${actionLabel(r.status, to)}：${r.code}`} desc={`状态将从「${REQ_STATUS_LABEL[r.status]}」改为「${REQ_STATUS_LABEL[to]}」，会记入状态历史。`}>
      <form onSubmit={submit} className="form">
        <Field label={must ? "原因（必填）" : "说明（可选）"}>
          <Textarea required={must} maxLength={2000} rows={4} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder={to === "in_review" ? "做了什么、怎么验证的" : must ? "写清楚原因，发起人和被指派者都能看到" : ""} />
        </Field>
        <ErrorBox error={a.error} />
        <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>取消</Button><Button type="submit" loading={a.busy} disabled={a.busy}>确定</Button></div>
      </form>
    </FormDialog>
  );
}

function DocDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(false);
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      await post(`/stories/${id}/docs`, { title, body: text });
      toast.ok("已追加补充说明");
      onDone();
      onClose();
    });
  };
  return (
    <FormDialog wide onClose={onClose} title="追加补充说明" desc="Markdown 格式；追加后所有能看需求的人都能看到。">
      <form onSubmit={submit} className="form">
        <Field label="标题"><Input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="正文">
          {preview ? <div className="min-h-[160px] rounded-md border px-3 py-2"><Md text={text || "（空）"} /></div>
            : <Textarea required rows={9} className="font-mono text-[13px]" value={text} onChange={(e) => setText(e.target.value)} placeholder={"## 小标题\n- 要点"} />}
        </Field>
        <Button type="button" size="sm" variant="ghost" className="w-fit" onClick={() => setPreview((p) => !p)}>{preview ? "继续编辑" : "预览"}</Button>
        <ErrorBox error={a.error} />
        <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>取消</Button><Button type="submit" loading={a.busy} disabled={a.busy}>追加</Button></div>
      </form>
    </FormDialog>
  );
}

function LinkDialog({ r, onClose, onDone }: { r: Requirement; onClose: () => void; onDone: () => void }) {
  const pages = useLoad(() => get<Paged<Page>>(`/pages${qs({ project_id: r.project.id, limit: 100 })}`), [r.project.id]);
  const linked = new Set(r.links.map((l) => l.page_id));
  const options = (pages.data?.items ?? []).filter((p) => p.id !== r.id && !linked.has(p.id) && !p.closed_at);
  const [pick, setPick] = useState("");
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    // 也接受粘贴的页面链接
    const pid = pick.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
    a.run(async () => {
      if (!pid) throw new Error("请选择页面，或粘贴页面链接");
      await post(`/stories/${r.id}/links`, { page_id: pid });
      toast.ok("已关联");
      onDone();
      onClose();
    });
  };
  return (
    <FormDialog onClose={onClose} title="关联已有页面" desc="只能关联同组织、你能看到的页面；看不到它的人只会看到「无权限查看」。">
      <form onSubmit={submit} className="form">
        {pages.loading ? <Loading rows={2} /> : (
          <Field label="本项目的页面">
            <NativeSelect aria-label="选择页面" value={pick} onChange={setPick}
              options={[["", options.length ? "选择页面" : "没有可关联的页面"], ...options.map((p) => [p.id, `${p.title}（${PAGE_TYPE_LABEL[p.page_type]}）`] as [string, string])]} />
          </Field>
        )}
        <Field label="或粘贴页面链接" hint="其他项目的页面也可以，只要你能看到"><Input value={pick} onChange={(e) => setPick(e.target.value)} placeholder="https://…/pages/…" /></Field>
        <ErrorBox error={a.error ?? pages.error} />
        <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>取消</Button><Button type="submit" loading={a.busy} disabled={a.busy}>关联</Button></div>
      </form>
    </FormDialog>
  );
}

/** 项目成员 + 已授权给项目的群组（指派候选；指派对象必须能看到需求） */
function useCandidates(projectId: string | undefined) {
  return useLoad(async () => {
    if (!projectId) return { members: [] as ProjectMember[], groups: [] as ProjectGroupGrant[] };
    const [m, g] = await Promise.all([
      get<Paged<ProjectMember>>(`/projects/${projectId}/members${qs({ limit: 200 })}`),
      get<{ items: ProjectGroupGrant[] }>(`/projects/${projectId}/groups`),
    ]);
    return { members: m.items, groups: g.items };
  }, [projectId]);
}

function AssigneePicker({ projectId, users, groups, onUsers, onGroups }: {
  projectId: string | undefined; users: string[]; groups: string[]; onUsers: (v: string[]) => void; onGroups: (v: string[]) => void;
}) {
  const c = useCandidates(projectId);
  const toggle = (list: string[], v: string, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));
  if (c.loading) return <Loading rows={2} />;
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-req-assign="">
      <fieldset className="grid content-start gap-2 rounded-[10px] border px-3 py-2.5">
        <legend className="px-1 text-[13px] font-medium">成员</legend>
        {c.data?.members.length ? c.data.members.map((m) => (
          <CheckField key={m.user.id} checked={users.includes(m.user.id)} onChange={(on) => onUsers(toggle(users, m.user.id, on))}>{m.user.display_name}<small className="text-faint">{m.user.email}</small></CheckField>
        )) : <p className="text-[12px] text-muted-foreground">项目里还没有成员</p>}
      </fieldset>
      <fieldset className="grid content-start gap-2 rounded-[10px] border px-3 py-2.5">
        <legend className="px-1 text-[13px] font-medium">群组（团队）</legend>
        {c.data?.groups.length ? c.data.groups.map((g) => (
          <CheckField key={g.group.id} checked={groups.includes(g.group.id)} onChange={(on) => onGroups(toggle(groups, g.group.id, on))}>{g.group.name}</CheckField>
        )) : <p className="text-[12px] text-muted-foreground">没有授权给本项目的群组</p>}
      </fieldset>
      <ErrorBox error={c.error} />
    </div>
  );
}

function AssignDialog({ r, onClose, onDone }: { r: Requirement; onClose: () => void; onDone: () => void }) {
  const [users, setUsers] = useState(r.assignees.users.map((u) => u.id));
  const [groups, setGroups] = useState(r.assignees.groups.map((g) => g.id));
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      await patch(`/stories/${r.id}`, { assignees: { users, groups } });
      toast.ok("已更新指派");
      onDone();
      onClose();
    });
  };
  return (
    <FormDialog wide onClose={onClose} title="修改指派" desc="可以指派给多个成员和群组；群组成员都会在首页「等我处理」看到这个需求。">
      <form onSubmit={submit} className="form">
        <AssigneePicker projectId={r.project.id} users={users} groups={groups} onUsers={setUsers} onGroups={setGroups} />
        <ErrorBox error={a.error} />
        <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>取消</Button><Button type="submit" loading={a.busy} disabled={a.busy}>保存</Button></div>
      </form>
    </FormDialog>
  );
}

// ---------------------------------------------------------------- 新建 / 编辑（独立页面）

/** datetime-local 值 ↔ ISO（带本地时区偏移） */
const toLocal = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null);

export function RequirementEdit({ id }: { id?: string }) {
  const projects = useMyProjects();
  const qp = useQuery("project");
  const existing = useLoad(() => (id ? get<Requirement>(`/stories/${id}`) : Promise.resolve(null)), [id]);
  const publishable = useMemo(() => (projects.data ?? []).filter((p) => p.can_publish), [projects.data]);
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [priority, setPriority] = useState("");
  const [due, setDue] = useState("");
  const [visibility, setVisibility] = useState<"project" | "org">("project");
  const [summary, setSummary] = useState("");
  const [users, setUsers] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [preview, setPreview] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const imgRef = useRef<HTMLInputElement>(null);
  const a = useAction();
  const r = existing.data;
  useClassicTitle(id ? (r ? `编辑 ${r.code}` : undefined) : "新建需求");
  useEffect(() => {
    if (!r) return;
    setProjectId(r.project.id);
    setTitle(r.title);
    setText(r.body);
    setPriority(r.priority ?? "");
    setDue(toLocal(r.due_at));
    setUsers(r.assignees.users.map((u) => u.id));
    setGroups(r.assignees.groups.map((g) => g.id));
  }, [r]);
  useEffect(() => {
    if (id || projectId || !publishable.length) return;
    setProjectId(publishable.find((p) => p.id === qp)?.id ?? publishable[0].id);
  }, [id, projectId, publishable, qp]);

  // 编辑时插入图片：先上传为附件，再把内联地址写进正文
  const insertImage = async (f: File | undefined) => {
    if (!f || !id) return;
    const up = await a.run(() => post<{ inline_url: string | null; name: string }>(`/stories/${id}/files${qs({ name: f.name })}`, f));
    if (imgRef.current) imgRef.current.value = "";
    if (!up) return;
    if (!up.inline_url) return toast.err("只有 PNG / JPG / GIF / WebP 能内联显示，已作为附件上传");
    const md = `![${up.name}](${up.inline_url})`;
    const el = area.current;
    const at = el?.selectionStart ?? text.length;
    setText((t) => t.slice(0, at) + md + t.slice(at));
    toast.ok("已插入图片");
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      let pid = id;
      if (id) {
        await patch(`/stories/${id}`, { title, body: text, priority: priority || null, due_at: fromLocal(due), assignees: { users, groups } });
      } else {
        const p = await post<Page>("/pages", {
          project_id: projectId, title, kind: "openui", page_type: "requirement", visibility, summary: summary.trim() || undefined,
          story: { body: text, priority: priority || null, due_at: fromLocal(due), assignees: { users, groups } },
        });
        pid = p.id;
        for (const f of files) {
          try {
            await post(`/stories/${pid}/files${qs({ name: f.name })}`, f);
          } catch (err) {
            toast.err(`${f.name} 上传失败：${(err as Error).message}`);
          }
        }
      }
      patchCachedPage(pid!);
      toast.ok(id ? "已保存" : "已创建需求");
      navigate(`/pages/${pid}`);
    });
  };
  if (existing.error) return <AuthCard><ErrorBox error={existing.error} /></AuthCard>;
  if ((id && !r) || projects.loading) return <PageBox><Loading rows={6} /></PageBox>;
  if (r && !r.me.can_edit) return <AuthCard><Notice tone="warning">只有项目编辑及以上可以编辑需求。</Notice></AuthCard>;
  if (!id && !publishable.length) return <AuthCard><Notice tone="warning">你还没有可以提需求的项目（需要项目编辑及以上角色）。</Notice></AuthCard>;

  return (
    <PageBox className="max-w-4xl" >
      <div data-req-form="">
        <PageHeader crumbs={<><Link to="/">首页</Link>{r ? <Link to={`/pages/${r.id}`}>{r.code}</Link> : <span>需求</span>}</>}
          title={r ? `编辑 ${r.code}` : "新建需求"} desc={r ? undefined : "提给团队的新需求：写清背景与目标，附上补充文档，指派给成员或群组；被指派者会在首页「等我处理」看到。"} />
        <form onSubmit={submit} className="form mt-6 grid gap-5">
          {!id && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="项目">
                <NativeSelect aria-label="项目" value={projectId} onChange={(v) => (setProjectId(v), setUsers([]), setGroups([]))}
                  options={publishable.map((p) => [p.id, `${p.org.name} / ${p.name}`] as [string, string])} />
              </Field>
              <Field label="可见范围">
                <NativeSelect aria-label="可见范围" value={visibility} onChange={setVisibility} options={[["project", VIS_LABEL.project], ["org", VIS_LABEL.org]]} />
              </Field>
            </div>
          )}
          <Field label="标题"><Input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：支持订单部分退款" /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="优先级">
              <NativeSelect aria-label="优先级" value={priority || "none"} onChange={(v) => setPriority(v === "none" ? "" : v)}
                options={[["none", "不设"], ...PRIORITIES.map((p) => [p, p] as [string, string])]} />
            </Field>
            <Field label="期望完成时间"><Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          </div>
          <div className="grid gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium">正文（Markdown）</span>
              <span className="ml-auto flex gap-1.5">
                {id && (
                  <>
                    <input ref={imgRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden aria-label="选择图片" onChange={(e) => insertImage(e.target.files?.[0])} />
                    <Button type="button" size="sm" variant="ghost" disabled={a.busy} onClick={() => imgRef.current?.click()}><ImagePlus />插入图片</Button>
                  </>
                )}
                <Button type="button" size="sm" variant="ghost" onClick={() => setPreview((p) => !p)}>{preview ? "继续编辑" : "预览"}</Button>
              </span>
            </div>
            {preview ? <div className="min-h-[260px] rounded-md border px-4 py-3"><Md text={text || "（空）"} /></div>
              : <Textarea ref={area} rows={14} className="font-mono text-[13px]" value={text} onChange={(e) => setText(e.target.value)}
                  placeholder={"## 背景\n\n## 目标\n\n## 验收标准\n- "} aria-label="正文" />}
            {!id && <span className="text-xs text-muted-foreground">图片可在创建后的编辑页用「插入图片」上传并插入正文。</span>}
          </div>
          <div className="grid gap-2">
            <span className="text-[13px] font-medium">指派给</span>
            <AssigneePicker projectId={projectId || undefined} users={users} groups={groups} onUsers={setUsers} onGroups={setGroups} />
          </div>
          {!id && (
            <>
              <Field label="卡片摘要（可选）" hint="首页卡片上显示的一句话"><Input maxLength={300} value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
              <Field label="附件（可选）" hint="PDF、Word、Excel、PPT、图片、压缩包等；创建后自动上传">
                <Input type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
              </Field>
            </>
          )}
          <ErrorBox error={a.error} />
          <div className="form-actions">
            <Button type="button" variant="ghost" onClick={() => (history.length > 1 ? history.back() : navigate("/"))}>取消</Button>
            <Button type="submit" loading={a.busy} disabled={a.busy || !projectId}>{id ? "保存" : "创建需求"}</Button>
          </div>
        </form>
      </div>
    </PageBox>
  );
}
