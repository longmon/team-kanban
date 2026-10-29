// 任务树页面（api.md §7.6）：主区树形列表（展开/折叠、状态徽章、负责人、截止、子任务进度、勾选完成 → 待评审、加子任务、上移/下移、节点历史），
// 右栏整体进度 + 评审人与「待你评审」队列；提交评审 / 评审（驳回必填理由）/ 新建与编辑任务 三个对话框。
// 标题、说明、理由一律按纯文本渲染；证据链接只认 http/https。
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronRight, CircleDot, Clock, ExternalLink, History, ListPlus, MoreHorizontal, Pencil, Plus, RotateCcw, Undo2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { errMsg, get, patch, post } from "../api";
import { ErrorBox, Field, fmtDue, fmtTime, Initial, NativeSelect, Notice, toast, useAction, useLoad, useNow, useSession } from "../ui";
import { patchCachedPage } from "./feed";
import type { PageView, Paged, ProjectMember, Task, TaskEvent, TaskStatus, TaskTree } from "../types";

export const STATUS_LABEL: Record<TaskStatus, string> = { todo: "待办", in_progress: "进行中", in_review: "待评审", done: "已完成" };
const STATUS_CLS: Record<TaskStatus, string> = {
  todo: "bg-secondary text-muted-foreground",
  in_progress: "bg-primary-soft text-primary",
  in_review: "bg-tone-f text-tone-ink",
  done: "bg-mint-soft text-mint-ink",
};
const ACTION_LABEL: Record<TaskEvent["action"], string> = {
  created: "创建了任务", edited: "编辑了", moved: "调整了顺序", started: "开始处理", reverted: "退回待办",
  submitted: "提交评审", approved: "评审通过", rejected: "驳回", deleted: "删除了任务（重发时去掉）", restored: "恢复了任务",
};
const FIELD_LABEL: Record<string, string> = { title: "标题", description: "说明", assignee: "负责人", due_at: "截止时间", parent: "层级", position: "顺序" };
const isHttp = (u: string) => /^https?:\/\/\S+$/i.test(u);

type Dlg = { kind: "submit"; task: Task } | { kind: "review"; task: Task } | { kind: "edit"; task: Task } | { kind: "add"; parent: Task | null };
export type TaskState = ReturnType<typeof useTaskTree>;

/** 任务树状态：初始取自 view.task_tree，改动后重新拉 GET /pages/{id}/tasks；标签页回到前台时也刷新 */
export function useTaskTree(view: PageView | null, live: boolean) {
  const [tree, setTree] = useState<TaskTree | null>(view?.task_tree ?? null);
  useEffect(() => setTree(view?.task_tree ?? null), [view]);
  const pageId = view?.page.id;
  const refresh = useCallback(async () => {
    if (!live || !pageId) return;
    setTree(await get<TaskTree>(`/pages/${pageId}/tasks`));
    patchCachedPage(pageId);
  }, [live, pageId]);
  useEffect(() => {
    if (!live || !view?.task_tree) return;
    const on = () => document.visibilityState === "visible" && refresh().catch(() => {});
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [live, view?.task_tree, refresh]);
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const a = useAction();
  /** 执行一个改动：成功 toast 并刷新，失败 toast 原因 */
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    const r = await a.run(async () => (await fn(), true));
    if (r) {
      toast.ok(ok);
      await refresh().catch(() => {});
    }
    return !!r;
  };
  useEffect(() => void (a.error && toast.err(errMsg(a.error))), [a.error]);
  return { tree, refresh, dlg, setDlg, act, busy: a.busy, pageId: pageId ?? "", projectId: view?.page.project.id ?? "", live };
}

/** parent_id → 子节点（按 position） */
function useChildren(tasks: Task[]) {
  return useMemo(() => {
    const m = new Map<string | null, Task[]>();
    for (const t of tasks) m.set(t.parent_id, [...(m.get(t.parent_id) ?? []), t]);
    for (const v of m.values()) v.sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
    return m;
  }, [tasks]);
}

/** 每个节点的后代统计（不含自身） */
function useDescStats(kids: Map<string | null, Task[]>) {
  return useMemo(() => {
    const out = new Map<string, { total: number; done: number }>();
    const walk = (t: Task): { total: number; done: number } => {
      let total = 0, done = 0;
      for (const c of kids.get(t.id) ?? []) {
        const s = walk(c);
        total += 1 + s.total;
        done += (c.status === "done" ? 1 : 0) + s.done;
      }
      const r = { total, done };
      out.set(t.id, r);
      return r;
    };
    for (const t of kids.get(null) ?? []) walk(t);
    return out;
  }, [kids]);
}

type Filter = "all" | "mine" | "review" | "rejected" | "open";
const FILTERS: [Filter, string][] = [["all", "全部"], ["mine", "我负责的"], ["review", "待我评审"], ["rejected", "被驳回"], ["open", "未完成"]];

export function StatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  return (
    <span data-tone={status === "in_review" ? "flow" : undefined} data-status={status}
      className={cn("inline-flex shrink-0 items-center rounded-full px-2 py-px text-[12px] font-medium whitespace-nowrap", STATUS_CLS[status], className)}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function Bar({ value, className }: { value: number; className?: string }) {
  return (
    <span data-bar="" className={cn("block h-2 overflow-hidden rounded-[4px] bg-muted", className)}>
      <i className="block h-full rounded-[4px] bg-mint transition-[width] duration-500 ease-rise" style={{ width: `${Math.round(Math.min(1, value) * 100)}%` }} />
    </span>
  );
}

const pct = (done: number, total: number) => (total ? Math.round((done / total) * 100) : 0);

// ---------- 主区 ----------
export function TaskBoard({ t }: { t: TaskState }) {
  const { me } = useSession();
  const [filter, setFilter] = useState<Filter>("all");
  const tree = t.tree;
  const tasks = useMemo(() => tree?.tasks ?? [], [tree]);
  const kids = useChildren(tasks);
  const stats = useDescStats(kids);
  // 过滤：命中的节点 + 其祖先（祖先淡显，保留层级上下文）
  const shown = useMemo(() => {
    if (filter === "all") return null;
    const uid = tree?.me.user_id ?? me?.user.id;
    const hit = (x: Task) =>
      filter === "mine" ? !!uid && x.assignee?.user?.id === uid
        : filter === "review" ? x.can_review
        : filter === "rejected" ? x.status === "in_progress" && !!x.reject_reason
        : x.status !== "done";
    const byId = new Map(tasks.map((x) => [x.id, x]));
    const out = new Map<string, boolean>();
    for (const x of tasks.filter(hit)) {
      out.set(x.id, true);
      for (let p = x.parent_id; p && !out.has(p); p = byId.get(p)?.parent_id ?? null) out.set(p, false);
    }
    return out;
  }, [filter, tasks, tree, me]);
  if (!tree) return null;
  const { total, done, in_review } = tree.progress;
  const roots = kids.get(null) ?? [];
  return (
    <section aria-label="任务" data-box="" className="rounded-[16px] border bg-card">
      <header className="flex flex-col gap-3 border-b px-[18px] pt-4 pb-3.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h2 className="text-[16px] font-semibold">任务</h2>
          <div className="flex min-w-[180px] flex-1 items-center gap-2.5 text-[13px] text-muted-foreground" role="img" aria-label={`整体进度：已完成 ${done} / ${total}`}>
            <Bar value={total ? done / total : 0} className="max-w-[260px] flex-1" />
            <span className="shrink-0 tabular-nums"><b className="font-semibold text-foreground">{done}</b> / {total} 已完成{in_review ? `，${in_review} 项待评审` : ""}</span>
          </div>
          {tree.me.can_manage && t.live && (
            <Button size="sm" variant="outline" onClick={() => t.setDlg({ kind: "add", parent: null })}><Plus />添加任务</Button>
          )}
        </div>
        <div role="group" aria-label="筛选任务" className="flex max-w-full gap-0.5 overflow-x-auto rounded-[11px] bg-muted p-[3px] [scrollbar-width:none] sm:w-fit">
          {FILTERS.filter(([f]) => f !== "review" || tree.me.can_review).map(([f, label]) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}
              className={cn("shrink-0 rounded-[8px] px-3 py-1 text-[13px] font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/80",
                filter === f ? "bg-card text-foreground shadow-[0_1px_2px_rgb(22_26_51/0.08)]" : "text-muted-foreground hover:text-foreground")}>
              {label}
            </button>
          ))}
        </div>
      </header>
      {roots.length === 0 ? (
        <p className="px-[18px] py-10 text-center text-sm text-muted-foreground">还没有任务。{tree.me.can_manage && t.live ? "点「添加任务」开始。" : ""}</p>
      ) : shown && shown.size === 0 ? (
        <p className="px-[18px] py-10 text-center text-sm text-muted-foreground">没有符合条件的任务。</p>
      ) : (
        <ul role="tree" aria-label="任务树" className="flex flex-col p-2 [--task-indent:14px] max-sm:px-1 sm:[--task-indent:22px]">
          {roots.filter((r) => !shown || shown.has(r.id)).map((r, i, arr) => (
            <Node key={r.id} task={r} depth={0} kids={kids} stats={stats} shown={shown} t={t} first={i === 0} last={i === arr.length - 1} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Node({ task, depth, kids, stats, shown, t, first, last }: {
  task: Task; depth: number; kids: Map<string | null, Task[]>; stats: Map<string, { total: number; done: number }>;
  shown: Map<string, boolean> | null; t: TaskState; first: boolean; last: boolean;
}) {
  const now = useNow();
  const children = (kids.get(task.id) ?? []).filter((c) => !shown || shown.has(c.id));
  const s = stats.get(task.id) ?? { total: 0, done: 0 };
  const [open, setOpen] = useState(depth < 2);
  const [details, setDetails] = useState(false);
  const dim = shown?.get(task.id) === false;
  const overdue = !!task.due_at && task.status !== "done" && new Date(task.due_at).getTime() < now;
  const rejected = task.status === "in_progress" && !!task.reject_reason;
  const edit = task.can_edit && t.live;
  const openKids = (kids.get(task.id) ?? []).filter((c) => c.status !== "done").length;
  const who = task.assignee?.user?.display_name ?? task.assignee?.label ?? null;
  const evidence = task.evidence.filter(isHttp);
  // 行内「开始」只给自己负责的任务，其余放在更多菜单里，避免整列按钮
  const mine = !!t.tree?.me.user_id && task.assignee?.user?.id === t.tree.me.user_id;
  return (
    <li role="treeitem" aria-expanded={children.length ? open : undefined} aria-selected={false} data-task={task.key} data-status={task.status}>
      <div className={cn("group flex items-start gap-1.5 rounded-[12px] py-2 pr-2 transition-colors hover:bg-accent/60 sm:gap-2", dim && "opacity-60")}
        style={{ paddingLeft: `calc(${Math.min(depth, 5)} * var(--task-indent, 22px) + 4px)` }}>
        {children.length ? (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-label={open ? "折叠" : "展开"}
            className="mt-[3px] grid size-6 shrink-0 place-items-center rounded-[7px] text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/80">
            <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
          </button>
        ) : <span className="size-6 shrink-0" aria-hidden="true" />}
        <Check3 task={task} t={t} blocked={openKids > 0} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <button type="button" onClick={() => setDetails((d) => !d)} aria-expanded={details}
              className={cn("min-w-0 text-left text-[14px] leading-[1.45] font-medium [overflow-wrap:anywhere] outline-none hover:underline hover:underline-offset-4 focus-visible:ring-[3px] focus-visible:ring-ring/80",
                task.status === "done" && "text-muted-foreground line-through decoration-faint")}>
              {task.title}
            </button>
            <StatusBadge status={task.status} />
            {rejected && <span className="rounded-full bg-coral-soft px-2 py-px text-[12px] font-medium text-coral-ink">被驳回</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
            {who ? (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Initial name={who} className="size-5 text-[10px] ring-0" />
                <span className="truncate">{task.assignee?.user?.display_name ?? task.assignee?.label}{task.assignee?.user && task.assignee.label ? `（${task.assignee.label}）` : ""}</span>
              </span>
            ) : <span className="inline-flex items-center gap-1"><UserRound className="size-3.5" />未分配</span>}
            {task.due_at && (
              <span className={cn("inline-flex items-center gap-1", overdue && "font-medium text-coral-ink")}>
                <Clock className="size-3.5" />{fmtDue(task.due_at, new Date(now))}{overdue ? " 已逾期" : " 截止"}
              </span>
            )}
            {s.total > 0 && (
              <span className="inline-flex items-center gap-1.5 tabular-nums" aria-label={`子任务 ${s.done} / ${s.total} 已完成`}>
                <Bar value={s.done / s.total} className="h-1.5 w-14" />{s.done}/{s.total}
              </span>
            )}
          </div>
          {rejected && (
            <p className="mt-1.5 rounded-[10px] bg-coral-soft px-3 py-2 text-[13px] whitespace-pre-wrap text-coral-ink [overflow-wrap:anywhere]">
              <b className="font-semibold">驳回理由：</b>{task.reject_reason}{task.reviewed_by ? `（${task.reviewed_by.display_name}）` : ""}
            </p>
          )}
          {/* 完成说明只在待评审时展开给评审人看；已完成的收进详情里的历史 */}
          {task.status === "in_review" && (task.submit_note || evidence.length > 0) && (
            <div className="mt-1.5 rounded-[10px] bg-background px-3 py-2 text-[13px] text-muted-foreground">
              {task.submit_note && <p className="whitespace-pre-wrap [overflow-wrap:anywhere]"><b className="font-medium text-foreground">完成说明：</b>{task.submit_note}</p>}
              <Evidence urls={evidence} />
            </div>
          )}
          {details && <Details task={task} t={t} />}
        </div>
        <div className="flex shrink-0 items-center gap-1 max-sm:flex-col max-sm:items-end">
          {task.can_review && t.live && (
            <Button size="xs" onClick={() => t.setDlg({ kind: "review", task })}>评审</Button>
          )}
          {edit && task.status === "todo" && mine && (
            <Button size="xs" variant="outline" className="max-sm:hidden" disabled={t.busy} onClick={() => t.act(() => patch(`/tasks/${task.id}`, { status: "in_progress" }), "已开始")}>开始</Button>
          )}
          {edit && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label={`更多操作：${task.title}`}
                  className="grid size-7 place-items-center rounded-[8px] text-faint outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/80">
                  <MoreHorizontal className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {task.status === "todo" && <DropdownMenuItem onSelect={() => t.act(() => patch(`/tasks/${task.id}`, { status: "in_progress" }), "已开始")}><CircleDot />开始处理</DropdownMenuItem>}
                {(task.status === "todo" || task.status === "in_progress") && (
                  <DropdownMenuItem disabled={openKids > 0} onSelect={() => t.setDlg({ kind: "submit", task })}><Check />{openKids > 0 ? `还有 ${openKids} 个子任务未完成` : "完成并提交评审"}</DropdownMenuItem>
                )}
                {task.status === "in_progress" && <DropdownMenuItem onSelect={() => t.act(() => patch(`/tasks/${task.id}`, { status: "todo" }), "已退回待办")}><Undo2 />退回待办</DropdownMenuItem>}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => t.setDlg({ kind: "edit", task })}><Pencil />编辑</DropdownMenuItem>
                {task.status !== "done" && task.status !== "in_review" && <DropdownMenuItem onSelect={() => t.setDlg({ kind: "add", parent: task })}><ListPlus />加子任务</DropdownMenuItem>}
                <DropdownMenuItem disabled={first} onSelect={() => t.act(() => patch(`/tasks/${task.id}`, { move: "up" }), "已上移")}><ArrowUp />上移</DropdownMenuItem>
                <DropdownMenuItem disabled={last} onSelect={() => t.act(() => patch(`/tasks/${task.id}`, { move: "down" }), "已下移")}><ArrowDown />下移</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setDetails(true)}><History />查看历史</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      {open && children.length > 0 && (
        <ul role="group" className="relative flex flex-col">
          {children.map((c, i) => (
            <Node key={c.id} task={c} depth={depth + 1} kids={kids} stats={stats} shown={shown} t={t} first={i === 0} last={i === children.length - 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** 勾选圈：待办（空圈）/ 进行中（半圈）/ 待评审（时钟）/ 已完成（勾）。能编辑且未提交时点它 = 完成并提交评审 */
function Check3({ task, t, blocked }: { task: Task; t: TaskState; blocked: boolean }) {
  const can = task.can_edit && t.live && (task.status === "todo" || task.status === "in_progress");
  const icon = task.status === "done" ? <Check className="size-3.5" strokeWidth={3} />
    : task.status === "in_review" ? <Clock className="size-3.5" />
    : task.status === "in_progress" ? <i className="block size-2 rounded-full bg-primary" /> : null;
  const cls = cn("mt-[3px] grid size-6 shrink-0 place-items-center rounded-full border-2 outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/80",
    task.status === "done" ? "border-mint bg-mint text-white"
      : task.status === "in_review" ? "border-tone bg-tone-f text-tone-ink"
      : task.status === "in_progress" ? "border-primary" : "border-input",
    can && "cursor-pointer hover:border-mint hover:bg-mint-soft");
  const label = `${task.title}：${STATUS_LABEL[task.status]}`;
  if (!can) return <span role="img" aria-label={label} data-tone={task.status === "in_review" ? "flow" : undefined} data-check3={task.status} className={cls}>{icon}</span>;
  return (
    <button type="button" data-check3={task.status} className={cls} aria-label={blocked ? `${label}（子任务未全部完成，暂不能提交）` : `勾选完成：${task.title}`} title={blocked ? "子任务全部完成后才能提交评审" : "完成并提交评审"}
      onClick={() => (blocked ? toast.err("子任务全部完成后才能提交评审") : t.setDlg({ kind: "submit", task }))}>
      {icon}
    </button>
  );
}

function Evidence({ urls }: { urls: string[] }) {
  if (!urls.length) return null;
  return (
    <ul className="mt-1 flex flex-col gap-0.5">
      {urls.map((u, i) => (
        <li key={i} className="min-w-0">
          <a href={u} target="_blank" rel="noopener noreferrer nofollow" className="link inline-flex max-w-full items-center gap-1 text-[13px]">
            <ExternalLink className="size-3.5 shrink-0" /><span className="truncate">{u}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** 节点详情：说明 + 历史时间线（展开时才拉） */
function Details({ task, t }: { task: Task; t: TaskState }) {
  const ev = useLoad(() => (t.live ? get<{ items: TaskEvent[] }>(`/tasks/${task.id}/events`) : Promise.resolve({ items: [] as TaskEvent[] })), [task.id, task.updated_at, t.live]);
  return (
    <div className="mt-2 grid gap-3 rounded-[12px] border bg-background px-3.5 py-3 text-[13px]">
      {task.description ? <p className="whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{task.description}</p> : <p className="text-faint">没有说明。</p>}
      {t.live && (
        <div>
          <h4 className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-faint"><History className="size-3.5" />历史</h4>
          <ErrorBox error={ev.error} />
          {ev.data && (
            <ol className="relative grid gap-2.5 border-l pl-4">
              {ev.data.items.map((e) => (
                <li key={e.id} className="relative">
                  <i aria-hidden="true" className={cn("absolute top-1.5 -left-[21px] size-2.5 rounded-full ring-2 ring-background",
                    e.action === "approved" ? "bg-mint" : e.action === "rejected" ? "bg-coral" : e.action === "submitted" ? "bg-tone" : "bg-input")} data-tone="flow" />
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    <b className="font-semibold">{e.actor?.display_name ?? "系统"}</b>
                    {e.via_token && <span className="rounded bg-secondary px-1 text-[11px] text-muted-foreground">令牌</span>}
                    <span className="text-muted-foreground">{ACTION_LABEL[e.action] ?? e.action}
                      {e.action === "edited" && Array.isArray(e.meta?.fields) ? (e.meta.fields as string[]).map((f) => FIELD_LABEL[f] ?? f).join("、") : ""}</span>
                    {e.from_status && e.to_status && <span className="inline-flex items-center gap-1"><StatusBadge status={e.from_status} />→<StatusBadge status={e.to_status} /></span>}
                    <time dateTime={e.at} className="ml-auto text-[12px] text-faint tabular-nums">{fmtTime(e.at)}</time>
                  </div>
                  {e.note && <p className={cn("mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]", e.action === "rejected" ? "text-coral-ink" : "text-muted-foreground")}>{e.note}</p>}
                  <Evidence urls={(e.evidence ?? []).filter(isHttp)} />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- 右栏 ----------
export function TaskAside({ t, Box }: { t: TaskState; Box: (p: { title: ReactNode; note?: ReactNode; children: ReactNode }) => ReactNode }) {
  const tree = t.tree;
  if (!tree) return null;
  const { total, done } = tree.progress;
  const counts = { todo: 0, in_progress: 0, in_review: 0, done: 0 } as Record<TaskStatus, number>;
  for (const x of tree.tasks) counts[x.status]++;
  const queue = tree.tasks.filter((x) => x.can_review);
  const rv = tree.reviewers;
  return (
    <>
      <Box title="整体进度" note={total ? `${pct(done, total)}%` : undefined}>
        <div className="flex items-baseline justify-between text-[13px]">
          <span><b className="font-mono text-[20px] font-semibold tabular-nums">{done}</b><span className="tabular-nums"> / {total}</span> 项已完成</span>
          {total > done && <span className="text-faint">还剩 {total - done} 项</span>}
        </div>
        <Bar value={total ? done / total : 0} className="mt-1.5 mb-3" />
        <dl className="grid grid-cols-2 gap-2 text-[12px]">
          {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((k) => (
            <div key={k} className="flex items-center justify-between rounded-[10px] bg-background px-2.5 py-1.5">
              <dt><StatusBadge status={k} /></dt><dd className="font-semibold tabular-nums">{counts[k]}</dd>
            </div>
          ))}
        </dl>
      </Box>
      <Box title="评审" note={tree.me.can_review ? "你是评审人" : undefined}>
        <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
          {rv.fallback ? <span className="text-muted-foreground">未指定，由项目管理员评审</span> : (
            <>
              {rv.users.map((u) => <span key={u.id} className="inline-flex items-center gap-1.5 rounded-full bg-background py-0.5 pr-2.5 pl-0.5"><Initial name={u.display_name} className="size-6 text-[11px] ring-0" />{u.display_name}</span>)}
              {rv.groups.map((g) => <span key={g.id} className="rounded-full bg-secondary px-2.5 py-0.5 text-muted-foreground">群组：{g.name}</span>)}
            </>
          )}
        </div>
        {tree.me.can_review && (
          <div className="mt-3.5" aria-label="待你评审">
            <h4 className="mb-2 flex items-center gap-2 text-[13px] font-semibold">待你评审<span className={cn("rounded-full px-[7px] text-[12px] leading-[18px] font-semibold tabular-nums", queue.length ? "bg-coral text-white" : "bg-secondary text-muted-foreground")}>{queue.length}</span></h4>
            {queue.length === 0 ? <p className="text-[13px] text-faint">暂时没有要你评审的任务。</p> : (
              <ul className="grid gap-2">
                {queue.map((x) => (
                  <li key={x.id} className="flex items-center gap-2.5 rounded-[12px] bg-background px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <b className="block truncate text-[13px] font-semibold">{x.title}</b>
                      <small className="block truncate text-[12px] text-faint">{x.submitted_by?.display_name ?? "有人"} 提交{x.submitted_at ? `，${fmtTime(x.submitted_at)}` : ""}</small>
                    </div>
                    {t.live && <Button size="xs" onClick={() => t.setDlg({ kind: "review", task: x })}>评审</Button>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Box>
    </>
  );
}

// ---------- 对话框 ----------
export function TaskDialogs({ t }: { t: TaskState }) {
  const d = t.dlg;
  const close = () => t.setDlg(null);
  return (
    <Dialog open={!!d} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto rounded-[18px] p-6 sm:max-w-lg">
        {d?.kind === "submit" && <SubmitForm key={d.task.id} task={d.task} t={t} done={close} />}
        {d?.kind === "review" && <ReviewForm key={d.task.id} task={d.task} t={t} done={close} />}
        {(d?.kind === "edit" || d?.kind === "add") && <EditForm key={d.kind === "edit" ? d.task.id : `add-${d.parent?.id}`} dlg={d} t={t} done={close} />}
      </DialogContent>
    </Dialog>
  );
}

function SubmitForm({ task, t, done }: { task: Task; t: TaskState; done: () => void }) {
  const [note, setNote] = useState("");
  const [links, setLinks] = useState("");
  const urls = links.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  const bad = urls.filter((u) => !isHttp(u));
  return (
    <form className="grid gap-4" onSubmit={async (e) => {
      e.preventDefault();
      if (bad.length || urls.length > 10) return;
      if (await t.act(() => patch(`/tasks/${task.id}`, { status: "in_review", note: note.trim() || undefined, evidence: urls.length ? urls : undefined }), "已提交评审")) done();
    }}>
      <DialogHeader>
        <DialogTitle>完成并提交评审</DialogTitle>
        <DialogDescription className="[overflow-wrap:anywhere]">「{task.title}」提交后进入待评审，评审人通过后才算完成；驳回会退回进行中。</DialogDescription>
      </DialogHeader>
      <Field label="完成说明" hint="做了什么、怎么验证的（可选，≤2000 字）">
        <Textarea value={note} maxLength={2000} rows={4} onChange={(e) => setNote(e.target.value)} placeholder="例如：联调通过，回调验签已补，见 CI 记录" />
      </Field>
      <Field label="证据链接" hint="一行一个，只接受 http:// 或 https:// 开头的链接，最多 10 条">
        <Textarea value={links} rows={3} onChange={(e) => setLinks(e.target.value)} placeholder="https://" aria-invalid={bad.length > 0 || urls.length > 10 || undefined} />
      </Field>
      {bad.length > 0 && <Notice tone="error">这些不是 http/https 链接：{bad.join("、")}</Notice>}
      {urls.length > 10 && <Notice tone="error">证据链接最多 10 条</Notice>}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={done}>取消</Button>
        <Button type="submit" loading={t.busy}><Check />提交评审</Button>
      </DialogFooter>
    </form>
  );
}

function ReviewForm({ task, t, done }: { task: Task; t: TaskState; done: () => void }) {
  const [note, setNote] = useState("");
  const [need, setNeed] = useState(false);
  const decide = async (decision: "approve" | "reject") => {
    if (decision === "reject" && !note.trim()) return setNeed(true);
    if (await t.act(() => post(`/tasks/${task.id}/review`, { decision, note: note.trim() || undefined }), decision === "approve" ? "已通过" : "已驳回")) done();
  };
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>评审任务</DialogTitle>
        <DialogDescription className="[overflow-wrap:anywhere]">「{task.title}」由 {task.submitted_by?.display_name ?? "有人"} 提交{task.submitted_at ? `于 ${fmtTime(task.submitted_at)}` : ""}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-1 rounded-[12px] bg-background px-3.5 py-3 text-[13px] text-muted-foreground">
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]"><b className="font-medium text-foreground">完成说明：</b>{task.submit_note || "（未填写）"}</p>
        <Evidence urls={task.evidence.filter(isHttp)} />
      </div>
      <Field label="评审意见" hint="驳回必须写理由，告诉负责人要改什么">
        <Textarea value={note} maxLength={2000} rows={4} autoFocus aria-invalid={need && !note.trim() ? true : undefined}
          onChange={(e) => (setNote(e.target.value), setNeed(false))} placeholder="通过可不填；驳回必填" />
      </Field>
      {need && !note.trim() && <p role="alert" className="-mt-2 text-[13px] text-destructive">驳回必须写理由</p>}
      <DialogFooter>
        <Button type="button" variant="outline" className="border-coral/50 text-coral-ink hover:bg-coral-soft" disabled={t.busy} onClick={() => decide("reject")}><RotateCcw />驳回</Button>
        <Button type="button" loading={t.busy} onClick={() => decide("approve")}><Check />通过</Button>
      </DialogFooter>
    </div>
  );
}

/** ISO → datetime-local 的本地时间值 */
const toLocal = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function EditForm({ dlg, t, done }: { dlg: Extract<Dlg, { kind: "edit" | "add" }>; t: TaskState; done: () => void }) {
  const { me } = useSession();
  const task = dlg.kind === "edit" ? dlg.task : null;
  const [title, setTitle] = useState(task?.title ?? "");
  const [desc, setDesc] = useState(task?.description ?? "");
  const [assignee, setAssignee] = useState(task?.assignee?.user?.id ?? "none");
  const [label, setLabel] = useState(task?.assignee?.label ?? "");
  const [due, setDue] = useState(toLocal(task?.due_at ?? null));
  const members = useLoad(() => get<Paged<ProjectMember>>(`/projects/${t.projectId}/members?limit=200`), [t.projectId]);
  const opts = useMemo(() => {
    const m = new Map<string, string>();
    if (me) m.set(me.user.id, `${me.user.display_name}（我）`);
    for (const x of members.data?.items ?? []) if (!m.has(x.user.id)) m.set(x.user.id, x.user.display_name);
    if (task?.assignee?.user && !m.has(task.assignee.user.id)) m.set(task.assignee.user.id, task.assignee.user.display_name);
    return [["none", "不指定"], ...m] as [string, string][];
  }, [members.data, me, task]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = {
      title: title.trim(), description: desc, assignee: assignee === "none" ? null : assignee,
      assignee_label: label.trim() || null, due_at: due ? new Date(due).toISOString() : null,
    };
    const ok = task
      ? await t.act(() => patch(`/tasks/${task.id}`, body), "已保存")
      : await t.act(() => post(`/pages/${t.pageId}/tasks`, { ...body, parent_id: dlg.kind === "add" ? dlg.parent?.id ?? null : null }), "已添加");
    if (ok) done();
  };
  return (
    <form className="grid gap-4" onSubmit={save}>
      <DialogHeader>
        <DialogTitle>{task ? "编辑任务" : dlg.kind === "add" && dlg.parent ? "添加子任务" : "添加任务"}</DialogTitle>
        <DialogDescription className="[overflow-wrap:anywhere]">{dlg.kind === "add" && dlg.parent ? `加到「${dlg.parent.title}」下面` : task ? "状态不在这里改：用勾选完成或评审" : "加到最外层"}</DialogDescription>
      </DialogHeader>
      <Field label="标题"><Input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></Field>
      <Field label="说明"><Textarea maxLength={5000} rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="负责人"><NativeSelect aria-label="负责人" value={assignee} onChange={setAssignee} options={opts} /></Field>
        <Field label="负责人备注" hint="如 agent 名称"><Input maxLength={50} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="可选" /></Field>
      </div>
      <Field label="截止时间"><Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={done}>取消</Button>
        <Button type="submit" loading={t.busy} disabled={!title.trim()}>{task ? "保存" : "添加"}</Button>
      </DialogFooter>
    </form>
  );
}
