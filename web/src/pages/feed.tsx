// 工作台（方向 A 长春花工作台）：首页（我能看的全部页面）与项目页（只看该项目）共用。
// 中间：问候语 + 搜索框、类型分段（全部 / 投票 / 报告 / 流程与架构 / 表单 / 知识库，带计数）、按「今天 / 本周 / 更早」分组的卡片网格（带内容预览与状态徽章）；
// 右栏：实色「等我处理」面板（按截止排序、倒计时圈、去投票 / 去填写，处理完移出）+「实时动态」。< 1280 时待办面板移到卡片上方、动态移到下方。
import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { Sparkles } from "lucide-react";
import { ApiError, get, qs } from "../api";
import { cn } from "@/lib/utils";
import { Link, useQuery } from "../router";
import { picked, specLabels, type SpecLabels } from "../data";
import {
  dayBucket, ErrorBox, fmtDue, fmtLeft, fmtRel, Initial, isClosed, PAGE_TYPE_LABEL, REDUCED, toneOf, ToneIcon, useClassic, useCurrentOrgId, useMyProjects, useNow, useSession, type Tone,
} from "../ui";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchButton } from "../shell";
import { Dock, MiniWindow } from "../classic";
import { PixelIcon, TONE_PIXEL } from "../pixel-icons";
import { AgentOnboarding } from "./settings";
import type { Activity, Page, PageView, Paged, Response } from "../types";

// ---------- 数据：游标分页 + 模块级缓存（返回格子墙时立即渲染上次的列表，后退的标题过渡能找到对应格子；随后后台刷新第一页） ----------
const cache = new Map<string, { items: Page[]; cursor: string | null }>();
const cacheListeners = new Set<() => void>();
let cacheVer = 0;
const setCache = (k: string, v: { items: Page[]; cursor: string | null }) => {
  cache.set(k, v);
  cacheVer++;
  cacheListeners.forEach((l) => l());
};
const HOME = `/pages${qs({ limit: 30 })}`;

function useFeed(path: string) {
  const [state, setState] = useState(() => cache.get(path) ?? { items: [] as Page[], cursor: null as string | null });
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(cache.has(path));
  const [error, setError] = useState<unknown>();
  const busy = useRef(false);
  const load = useCallback(async (cursor: string | null) => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      const r = await get<Paged<Page>>(path + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));
      setState((old) => {
        let next;
        if (cursor) next = { items: [...old.items, ...r.items.filter((p) => !old.items.some((o) => o.id === p.id))], cursor: r.next_cursor };
        else {
          // 刷新第一页：新数据在前，缓存里更早的部分保留（游标仍指向缓存末尾）
          const fresh = new Set(r.items.map((p) => p.id));
          const tail = old.items.slice(r.items.length).filter((p) => !fresh.has(p.id));
          next = { items: [...r.items, ...tail], cursor: tail.length ? old.cursor : r.next_cursor };
        }
        setCache(path, next);
        return next;
      });
      setError(undefined);
    } catch (e) {
      setError(e);
    } finally {
      busy.current = false;
      setLoading(false);
      setLoaded(true);
    }
  }, [path]);
  useEffect(() => void load(null), [load]);
  return { ...state, loading, loaded, error, more: () => state.cursor && load(state.cursor) };
}


/** 左侧导航的计数（等我处理、我发布的、各项目页面数）：读首页列表缓存，缓存没有时（刷新、提交后被清掉）自己拉一次第一页。
 *  项目页面数与「我发布的」只在首页列表已全部加载（没有下一页）时显示；等我处理按已加载的部分计 */
let homeLoading = false;
export function useHomeStats(orgId: string | undefined) {
  useSyncExternalStore((l) => (cacheListeners.add(l), () => void cacheListeners.delete(l)), () => cacheVer);
  const { me } = useSession();
  const now = useNow();
  const c = cache.get(HOME);
  useEffect(() => {
    if (c || homeLoading || !me) return;
    homeLoading = true;
    get<Paged<Page>>(HOME).then((r) => !cache.has(HOME) && setCache(HOME, { items: r.items, cursor: r.next_cursor }), () => {}).finally(() => (homeLoading = false));
  }, [c, me]);
  if (!c) return { todo: null as number | null, mine: null as number | null, by: {} as Record<string, number>, full: false };
  // 与工作台一致：只有一个组织时不按组织过滤
  const items = orgId && (me?.orgs.length ?? 0) > 1 ? c.items.filter((p) => p.org_id === orgId) : c.items;
  const full = !c.cursor;
  const by: Record<string, number> = {};
  if (full) for (const p of items) by[p.project_id] = (by[p.project_id] ?? 0) + 1;
  return { todo: items.reduce((n, p) => n + todoWeight(p, now), 0), mine: full ? items.filter((p) => p.created_by.id === me?.user.id).length : null, by, full };
}

// ---------- 分类 ----------
/** 任务树页面里等我处理的项数：待我评审 + 分配给我的待办/进行中 */
const taskTodo = (p: Page) => (p.task_stats ? p.task_stats.my_review + p.task_stats.my_todo : 0);
/** 等我处理：收集类、仍接受提交、未截止、我还没交当前版本；任务树里有待我评审或分配给我的未完成任务。已关闭页面不算 */
const isTodo = (p: Page, now = Date.now()) =>
  !p.closed_at && ((p.category === "collect" && p.accept_responses && !p.my_submitted && !isClosed(p.closes_at, now)) || taskTodo(p) > 0);
/** 左导航「等我处理」计数：收集类每页算 1，任务树按项数算 */
const todoWeight = (p: Page, now = Date.now()) => (p.closed_at ? 0 : p.task_stats ? taskTodo(p) : isTodo(p, now) ? 1 : 0);
type Kind = "all" | "vote" | "report" | "diagram" | "form" | "book" | "api" | "task" | "closed";
const KINDS: [Kind, string][] = [["all", "全部"], ["vote", "投票"], ["report", "报告"], ["diagram", "流程与架构"], ["form", "表单"], ["book", "知识库"], ["api", "接口文档"], ["task", "任务"], ["closed", "已关闭"]];
/** 已关闭页面只出现在「已关闭」分段（只有发布者与项目管理员能看到这类页面） */
const kindOf = (p: Page): Kind => {
  if (p.closed_at) return "closed";
  const t = toneOf(p.page_type, p.category);
  return t === "flow" || t === "arch" ? "diagram" : t;
};
const verb = (p: Page) => (toneOf(p.page_type, p.category) === "vote" ? "投" : "交");
const unit = (p: Page) => (toneOf(p.page_type, p.category) === "vote" ? "票" : "份");
const greet = (h: number) => (h < 6 ? "夜深了" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : "晚上好");
const GROUPS = ["今天", "本周", "更早"] as const;

// 首页错落入场只在本次会话首次加载时播一次（之后切筛选、翻页、返回都不再播）
let played = false;

export function Wall({ projectId, title, empty }: { projectId?: string; title?: ReactNode; empty?: ReactNode }) {
  const { me } = useSession();
  const now = useNow();
  const classic = useClassic();
  const path = projectId ? `/pages${qs({ project_id: projectId, limit: 30 })}` : HOME;
  const feed = useFeed(path);
  const projects = useMyProjects();
  const [kind, setKind] = useState<Kind>("all");
  // 左侧导航「等我处理 / 我发布的」：首页 ?view=todo|mine
  const qv = useQuery("view");
  const view = projectId ? null : qv === "todo" || qv === "mine" ? qv : null;
  const stagger = useRef(!played && !REDUCED && !projectId);
  useEffect(() => {
    if (feed.items.length) {
      played = true;
      const t = setTimeout(() => (stagger.current = false), 0);
      return () => clearTimeout(t);
    }
  }, [feed.items.length]);

  // 多组织时首页只显示当前组织（左侧组织切换）；单组织不过滤
  const orgs = me?.orgs ?? [];
  const lastOrg = useCurrentOrgId();
  const orgId = projectId || orgs.length < 2 ? undefined : (orgs.find((o) => o.id === lastOrg) ?? orgs[0]).id;
  const items = orgId ? feed.items.filter((p) => p.org_id === orgId) : feed.items;
  const todos = items.filter((p) => isTodo(p, now)).sort((a, b) => due(a) - due(b));
  const base = items.filter((p) => (view === "todo" ? isTodo(p, now) : view === "mine" ? p.created_by.id === me?.user.id : true))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const counts = { all: 0 } as Record<Kind, number>;
  for (const p of base) {
    counts[kindOf(p)] = (counts[kindOf(p)] ?? 0) + 1;
    if (!p.closed_at) counts.all++;
  }
  const shown = kind === "all" ? base.filter((p) => !p.closed_at) : base.filter((p) => kindOf(p) === kind);
  const groups = GROUPS.map((g) => [g, shown.filter((p) => (dayBucket(p.updated_at, new Date(now)) === "昨天" ? "本周" : dayBucket(p.updated_at, new Date(now))) === g)] as const)
    .filter(([, ps]) => ps.length);
  // 收集类卡片的迷你结果条要额外请求，只给最前面 6 张
  const lazyIds = new Set(shown.filter((p) => p.category === "collect").slice(0, 6).map((p) => p.id));

  // 滚到底加载下一页：哨兵进入视口（提前 400px）且还有下一页时加载；列表变化后重新观察（筛选后列表很短时会继续加载）
  const sentinel = useRef<HTMLDivElement>(null);
  const { cursor, loading, more } = feed;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor || loading) return;
    const io = new IntersectionObserver((es) => es[0].isIntersecting && more(), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loading, shown.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const proj = (id: string) => projects.data?.find((x) => x.id === id)?.name;
  const name = me?.user.display_name ?? "";
  if (feed.loaded && !feed.items.length && !feed.error) return <>{empty ?? <AgentOnboarding />}</>;
  const week = items.filter((p) => ["今天", "昨天", "本周"].includes(dayBucket(p.created_at, new Date(now)))).length;
  const heading = title ?? (view === "todo" ? "等我处理" : view === "mine" ? "我发布的" : `${greet(new Date(now).getHours())}，${name}`);
  const sub = view === "todo" ? `${todos.length} 件事等你处理，按最近更新排列`
    : view === "mine" ? `你发布的 ${base.length} 个页面`
    : `${projectId ? `${items.length} 个页面` : `本周新增 ${week} 个页面`}，${todos.length ? `有 ${todos.length} 件事等你处理` : "暂时没有要你处理的事"}`;
  // 经典主题：「详细信息」列表视图 + 停靠小窗（等我处理、实时动态）
  if (classic)
    return (
      <div className="cl-wall">
        <header className="cl-wall-head">
          <PixelIcon name="logo" size={32} />
          <div className="min-w-0 flex-1"><h1>{heading}</h1><p>{sub}</p></div>
          <button type="button" className="cl-find" onClick={() => window.dispatchEvent(new Event("tk:search"))} aria-label="搜索页面">
            <span><u>查</u>找:</span><span className="cl-field">搜索页面、项目或操作</span>
          </button>
        </header>
        <div role="group" aria-label="筛选" className="cl-tabs">
          {KINDS.filter(([v]) => v !== "closed" || counts.closed || kind === "closed").map(([v, label]) => (
            <button key={v} type="button" aria-pressed={kind === v} onClick={() => setKind(v)}>{label} ({counts[v] ?? 0})</button>
          ))}
        </div>
        <div className="cl-tabpanel">
          <ErrorBox error={feed.error} />
          <ClassicList groups={groups} now={now} proj={projectId ? undefined : proj} loaded={feed.loaded} empty={view === "todo" ? "没有等你处理的页面了。" : "没有符合条件的页面。"} />
          <div ref={sentinel} />
          {feed.loading && feed.items.length > 0 && <p className="py-1 text-center" role="status">加载中…</p>}
        </div>
        <Dock>
          <ClassicTodo todos={todos} now={now} proj={projectId ? undefined : proj} />
          <ClassicActivity projectId={projectId} />
        </Dock>
      </div>
    );
  return (
    <div className="grid grid-cols-1 gap-x-7 gap-y-5 xl:grid-cols-[minmax(0,1fr)_340px] xl:grid-rows-[auto_1fr] min-[1500px]:grid-cols-[minmax(0,1fr)_372px]">
      <header className="order-1 min-w-0 xl:col-start-1 xl:row-start-1">
        <div className="mb-5 flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em] [overflow-wrap:anywhere] max-sm:text-[22px]">{heading}</h1>
            <p className="mt-0.5 text-muted-foreground">{sub}</p>
          </div>
          <SearchButton />
        </div>
        <div role="group" aria-label="筛选" className="flex max-w-full gap-0.5 overflow-x-auto rounded-[11px] bg-muted p-[3px] [scrollbar-width:none] sm:inline-flex">
          {KINDS.filter(([v]) => v !== "closed" || counts.closed || kind === "closed").map(([v, label]) => (
            <button key={v} type="button" aria-pressed={kind === v} onClick={() => setKind(v)}
              className={cn(
                "relative inline-flex shrink-0 items-center gap-1.5 rounded-[8px] px-[13px] py-[5px] text-[13px] font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/80",
                kind === v ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}>
              {kind === v && <motion.span layoutId={`seg-${projectId ?? "home"}`} className="absolute inset-0 rounded-[8px] bg-card shadow-[0_1px_2px_rgb(22_26_51/0.08)]" transition={{ type: "spring", bounce: 0.15, duration: 0.3 }} />}
              <span className="relative">{label}</span>
              <span className="relative tabular-nums">{counts[v] ?? 0}</span>
            </button>
          ))}
        </div>
      </header>
      <div className="contents xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:flex xl:min-w-0 xl:flex-col xl:gap-[18px]">
        <TodoPanel todos={todos} now={now} proj={projectId ? undefined : proj} />
        <ActivityFeed projectId={projectId} />
      </div>
      <div className="order-3 min-w-0 xl:col-start-1 xl:row-start-2">
        <ErrorBox error={feed.error} />
        {!feed.loaded && <WallSkeleton />}
        {feed.loaded && shown.length === 0 && (
          <p className="rounded-[14px] border border-dashed py-12 text-center text-sm text-muted-foreground">{view === "todo" ? "没有等你处理的页面了。" : "没有符合条件的页面。"}</p>
        )}
        <LayoutGroup>
          {groups.map(([g, ps]) => (
            <section key={g} aria-label={g}>
              <h2 className="mt-5 mb-2.5 text-[13px] font-medium tracking-normal text-faint">{g}</h2>
              <div className="bento grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
                <AnimatePresence initial={false} mode="popLayout">
                  {ps.map((p) => {
                    const i = shown.indexOf(p);
                    const enter = stagger.current
                      ? { initial: { opacity: 0, y: 14, scale: 0.98 }, transition: { duration: 0.35, delay: Math.min(i, 10) * 0.04, ease: [0.22, 1, 0.36, 1] as const } }
                      : { initial: REDUCED ? (false as const) : { opacity: 0, scale: 0.98 }, transition: { duration: 0.2 } };
                    return (
                      <motion.div key={p.id} layout initial={enter.initial} animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.15 } }}
                        transition={{ ...enter.transition, layout: { duration: 0.35, ease: [0.22, 1, 0.36, 1] } }}
                        className="min-w-0">
                        <Card p={p} todo={isTodo(p, now)} project={projectId ? undefined : proj(p.project_id)} now={now} lazy={lazyIds.has(p.id)} />
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            </section>
          ))}
        </LayoutGroup>
        <div ref={sentinel} />
        {feed.loading && feed.items.length > 0 && <p className="py-3 text-center text-xs text-muted-foreground" role="status">加载中…</p>}
      </div>
    </div>
  );
}

const due = (p: Page) => (p.closes_at ? new Date(p.closes_at).getTime() : Infinity);

function WallSkeleton() {
  return (
    <div className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4" role="status" aria-label="加载中">
      {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[208px] rounded-[14px]" />)}
    </div>
  );
}

// ---------- 卡片 ----------
function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("ml-auto shrink-0 rounded-full px-[9px] py-px text-[12px] font-medium whitespace-nowrap", className)}>{children}</span>;
}

function Card({ p, todo, project, now, lazy }: { p: Page; todo: boolean; project?: string; now: number; lazy: boolean }) {
  const tone = toneOf(p.page_type, p.category);
  const closed = isClosed(p.closes_at, now);
  const n = p.respondent_count ?? p.response_count;
  const collect = p.category === "collect";
  const v = tone === "vote" ? "投" : "填";
  const ts = p.task_stats;
  const chip = p.closed_at ? <Chip className="bg-secondary text-muted-foreground">已关闭</Chip>
    : ts ? (ts.my_review ? <Chip className="bg-coral-soft text-coral-ink">待你评审 {ts.my_review} 项</Chip>
      : ts.my_todo ? <Chip className="bg-coral-soft text-coral-ink">你有 {ts.my_todo} 项待办</Chip>
      : ts.total && ts.done === ts.total ? <Chip className="bg-mint-soft text-mint-ink">已全部完成</Chip> : null)
    : todo ? <Chip className="bg-coral-soft text-coral-ink">等你{tone === "vote" ? "投票" : "填写"}</Chip>
    : p.my_submitted ? <Chip className="bg-mint-soft text-mint-ink">你已{v}</Chip>
    : collect && (closed || !p.accept_responses) ? <Chip className="bg-secondary text-muted-foreground">已截止</Chip>
    : p.version > 1 ? <Chip className="bg-secondary text-muted-foreground">第 {p.version} 版</Chip>
    : null;
  const right = ts ? `${ts.done} / ${ts.total} 项` : collect
    ? p.closes_at ? (closed ? `${fmtDue(p.closes_at, new Date(now))} 已截止` : `${n} ${unit(p)}，${fmtDue(p.closes_at, new Date(now))} 截止`) : `${n} ${unit(p)}`
    : null;
  return (
    <article data-tone={tone} className="tile relative flex h-full flex-col sm:min-h-[208px] gap-2.5 rounded-[14px] border bg-card p-4 transition-colors has-[a:hover]:border-input">
      <div className="flex min-w-0 items-center gap-2.5">
        <ToneIcon tone={tone} className="size-[34px] bg-tone-f text-tone [&_svg]:size-[18px]" />
        <div className="min-w-0 text-[12px] leading-snug text-faint">
          <b className="block truncate font-medium text-muted-foreground">{project ?? PAGE_TYPE_LABEL[p.page_type]}</b>
          <span className="block truncate">{p.created_by.display_name} {p.version > 1 ? "更新" : "发布"}，{fmtRel(p.updated_at, new Date(now))}</span>
        </div>
        {chip}
      </div>
      <h3 className="text-[15px] leading-[1.4] font-semibold tracking-normal">
        <Link to={`/pages/${p.id}`} data-vt={p.id} viewTransition
          className="tile-title line-clamp-2 w-fit max-w-full outline-none after:absolute after:inset-0 after:rounded-[14px] focus-visible:after:ring-[3px] focus-visible:after:ring-ring/80">
          {p.title}
        </Link>
      </h3>
      <Preview p={p} n={n} tone={tone} lazy={lazy} />
      <div className="mt-auto flex min-w-0 items-center gap-2 text-[12px] text-faint">
        <span className="inline-flex min-w-0 items-center gap-1 truncate">
          {p.generated_by ? <span title={`由 ${p.generated_by} 生成`} className="inline-flex min-w-0 items-center gap-1"><Sparkles className="size-3.5 shrink-0" /><span className="truncate">{p.generated_by}</span></span> : collect ? (closed ? "已结束" : `${p.created_by.display_name} 发起`) : `${p.created_by.display_name} 发布`}
        </span>
        {right && <span className="ml-auto shrink-0 tabular-nums">{right}</span>}
      </div>
    </article>
  );
}

/** 卡片内容预览：投票结果条 / 参与进度、报告关键数字、流程与架构缩略、摘要或目录 */
function Preview({ p, n, tone, lazy }: { p: Page; n: number; tone: Tone; lazy: boolean }) {
  const [x, setX] = useState<Extra | null>(null);
  useEffect(() => {
    if (!lazy) return;
    let live = true;
    loadExtra(p).then((e) => live && setX(e));
    return () => void (live = false);
  }, [lazy, p]);
  if (p.category === "collect") {
    if (x?.tally) {
      const max = Math.max(1, ...x.tally.map((t) => t[1]));
      return (
        <div className="grid gap-[5px]" aria-label="当前结果">
          {x.tally.map(([label, c], i) => (
            <div key={label} className="grid grid-cols-[72px_1fr_28px] items-center gap-2 text-[12px] text-muted-foreground">
              <span className="truncate">{label}</span>
              <span className="h-2 overflow-hidden rounded-[4px] bg-muted">
                <span className={cn("bar-grow block h-full rounded-[4px]", i ? "bg-primary/40" : "bg-primary")} style={{ width: `${(c / max) * 100}%` }} />
              </span>
              <span className="tabular-nums">{c}</span>
            </div>
          ))}
        </div>
      );
    }
    const total = p.eligible_count ?? 0;
    return (
      <div className="grid gap-2 text-[12px] text-muted-foreground">
        <div className="flex justify-between gap-2 tabular-nums">
          <span>{total ? `${n} / ${total} 人已${verb(p)}` : `${n} ${unit(p) === "票" ? "人已投" : "份提交"}`}</span>
          {x?.questions.length ? <span className="truncate">{x.questions.length} 个问题</span> : null}
        </div>
        {total > 0 && (
          <span className="h-2 overflow-hidden rounded-[4px] bg-muted">
            <span className="bar-grow block h-full rounded-[4px] bg-primary" style={{ width: `${Math.min(1, n / total) * 100}%` }} />
          </span>
        )}
      </div>
    );
  }
  if (p.task_stats) {
    const { total, done, in_review } = p.task_stats;
    return (
      <div className="grid gap-2 text-[12px] text-muted-foreground" aria-label="任务进度">
        <div className="flex justify-between gap-2 tabular-nums">
          <span>{PAGE_TYPE_LABEL[p.page_type]}：{done} / {total} 项已完成</span>
          {in_review > 0 && <span className="shrink-0">{in_review} 项待评审</span>}
        </div>
        <span className="h-2 overflow-hidden rounded-[4px] bg-muted">
          <span className="bar-grow block h-full rounded-[4px] bg-mint" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </span>
        {p.summary && <p className="line-clamp-2 text-[13px]">{p.summary}</p>}
      </div>
    );
  }
  if (tone === "flow" || tone === "arch") return (
    <>
      <Wireframe tone={tone} />
      {p.summary && <p className="line-clamp-1 text-[12px] text-muted-foreground">{p.summary}</p>}
    </>
  );
  if (p.highlights?.length)
    return (
      <div className="grid grid-cols-3 gap-2">
        {p.highlights.slice(0, 3).map((h, i) => (
          <div key={i} className="min-w-0 rounded-[10px] bg-background px-2.5 py-2">
            <b className="block truncate text-[20px] leading-tight font-semibold tabular-nums">{h.value}</b>
            <small className="block truncate text-[11px] text-faint">{h.label}</small>
          </div>
        ))}
      </div>
    );
  if (p.summary) {
    const lines = p.summary.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    return lines.length > 1
      ? <div className="grid gap-1 text-[12px] text-muted-foreground">{lines.slice(0, 3).map((l, i) => <span key={i} className="truncate">{l}</span>)}</div>
      : <p className="line-clamp-3 text-[13px] text-muted-foreground">{p.summary}</p>;
  }
  return null;
}

/** 流程图/架构图的通用示意线框（不解析真实图） */
function Wireframe({ tone }: { tone: "flow" | "arch" }) {
  const g = { fill: "var(--tone-f)", stroke: "var(--tone)", strokeWidth: 1.4 };
  const line = { fill: "none", stroke: "var(--input)", strokeWidth: 1.4 };
  return tone === "flow" ? (
    <svg viewBox="0 0 260 64" aria-hidden="true" className="h-16 w-full">
      <g {...g}><rect x="4" y="22" width="44" height="20" rx="5" /><rect x="74" y="6" width="44" height="20" rx="5" /><rect x="74" y="38" width="44" height="20" rx="5" /><rect x="144" y="22" width="44" height="20" rx="5" /><rect x="212" y="22" width="44" height="20" rx="10" fill="var(--tone)" /></g>
      <path {...line} d="M48 32h12v-16h14M60 32v16h14M118 16h12v16h14M118 48h12V32M188 32h24" />
    </svg>
  ) : (
    <svg viewBox="0 0 260 64" aria-hidden="true" className="h-16 w-full">
      <g {...g} strokeWidth={1.3}><rect x="70" y="2" width="120" height="16" rx="4" /><rect x="10" y="26" width="72" height="16" rx="4" /><rect x="94" y="26" width="72" height="16" rx="4" /><rect x="178" y="26" width="72" height="16" rx="4" /></g>
      <rect x="10" y="48" width="240" height="14" rx="4" fill="var(--background)" stroke="var(--input)" strokeWidth="1.3" />
      <path {...line} strokeWidth={1.3} d="M130 18v8M46 18v8h168v-8M46 42v6M130 42v6M214 42v6" />
    </svg>
  );
}

// ---------- 卡片补充数据：结果条（第一个选项字段的计数）与问题数 ----------
type Extra = { labels: SpecLabels | null; tally: [string, number][] | null; names: string[]; questions: string[] };
const extraCache = new Map<string, Promise<Extra>>();

/** 懒加载待办格的补充数据（最多 4 格）：view 取 OpenUI 原文解析标签；结果对我可见时取当前版本的提交做迷你结果条与已交头像。取不到就不显示 */
function loadExtra(p: Page): Promise<Extra> {
  const key = `${p.id}:${p.version}:${p.response_count}`;
  let pr = extraCache.get(key);
  if (!pr) {
    pr = (async () => {
      const v = await get<PageView>(`/pages/${p.id}/view`);
      const labels = v.content.kind === "openui" ? specLabels(v.content.spec) : null;
      const questions = labels ? Object.values(labels.fields).slice(0, 6) : [];
      let rows: Response[] = [];
      if (v.can_manage) rows = (await get<{ responses: Response[] }>(`/pages/${p.id}/responses?since=0&limit=500`)).responses;
      else if (v.can_view_results) rows = await sseOnce(p.id);
      rows = rows.filter((r) => r.page_version === p.version);
      const names = [...new Set(rows.map((r) => (r.respondent.type === "user" ? r.respondent.display_name : r.respondent.nickname)))].slice(0, 5);
      const tally = labels && rows.length ? tallyFirst(labels, rows) : null;
      // 第一个选项字段没人选过（多为表单里的可选题）：不显示结果条，改显示问题标签
      return { labels, tally: tally?.some((t) => t[1] > 0) ? tally : null, names, questions };
    })().catch(() => ({ labels: null, tally: null, names: [], questions: [] }));
    extraCache.set(key, pr);
  }
  return pr;
}

/** 非管理者只能走 SSE 拿结果：连上后历史提交立即补发，1s 后关闭。
 *  ponytail: 用补发窗口代替分页拉取；需要实时更新迷你条时改成常连并共享连接 */
function sseOnce(id: string): Promise<Response[]> {
  return new Promise((done) => {
    const rows: Response[] = [];
    const es = new EventSource(`/api/pages/${id}/responses/stream?since=0`);
    const finish = () => (es.close(), done(rows));
    const t = setTimeout(finish, 4000);
    es.onopen = () => (clearTimeout(t), setTimeout(finish, 1000));
    es.onerror = () => (clearTimeout(t), finish());
    es.addEventListener("response", (ev) => rows.push(JSON.parse((ev as MessageEvent).data)));
  });
}

/** 第一个有选项标签的字段（单选/下拉/多选）的计数，按票数降序取前三 */
function tallyFirst(labels: SpecLabels, rows: Response[]): [string, number][] | null {
  const field = Object.keys(labels.options)[0];
  if (!field) return null;
  const opts = labels.options[field];
  const counts = new Map(Object.values(opts).map((l) => [l, 0]));
  for (const r of rows) {
    const vals = r.data?.values && typeof r.data.values === "object" ? (r.data.values as Record<string, unknown>) : r.data;
    for (const k of picked(vals?.[field])) if (opts[k]) counts.set(opts[k], (counts.get(opts[k]) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3);
}
/** 倒计时数字变化时轻微滚动（旧值上移淡出、新值自下滚入） */
function Roll({ text }: { text: string }) {
  return (
    <span className="relative inline-flex overflow-hidden">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span key={text} initial={{ y: "45%", opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: "-45%", opacity: 0 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}>{text}</motion.span>
      </AnimatePresence>
    </span>
  );
}


// ---------- 等我处理面板 ----------
function TodoPanel({ todos, now, proj }: { todos: Page[]; now: number; proj?: (id: string) => string | undefined }) {
  return (
    <section aria-label="等我处理" className={cn("order-2 rounded-[18px] bg-primary p-[18px] text-primary-foreground", !todos.length && "max-xl:hidden")}>
      <h2 className="flex items-center gap-2 text-[16px] font-semibold tracking-normal">
        等我处理<span className="rounded-full bg-card px-2 text-[12px] leading-5 text-primary tabular-nums">{todos.length}</span>
      </h2>
      <p className="text-[13px] opacity-85">{todos.length ? "按截止时间排序，处理完自动移出" : "都处理完了，暂时没有要你做的事"}</p>
      <AnimatePresence initial={false}>
        {todos.map((p) => (
          <motion.div key={p.id} layout initial={REDUCED ? false : { opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0, x: 0 }}
            exit={{ opacity: 0, x: 40, transition: { duration: 0.25 } }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}>
            <TodoCard p={p} now={now} project={proj?.(p.project_id)} />
          </motion.div>
        ))}
      </AnimatePresence>
    </section>
  );
}

function TodoCard({ p, now, project }: { p: Page; now: number; project?: string }) {
  const tone = toneOf(p.page_type, p.category);
  const n = p.respondent_count ?? p.response_count;
  const end = p.closes_at ? new Date(p.closes_at).getTime() : null;
  const left = p.closes_at ? fmtLeft(p.closes_at, now) : null;
  const urgent = end !== null && end - now < 2 * 864e5;
  const rest = p.eligible_count ? Math.max(0, p.eligible_count - n) : null;
  const ts = p.task_stats;
  const meta = ts
    ? [project, ts.my_review ? `待你评审 ${ts.my_review} 项` : null, ts.my_todo ? `你的待办 ${ts.my_todo} 项` : null].filter(Boolean).join("，")
    : [project, n ? `已有 ${n} ${unit(p)}` : `还没人${verb(p)}`, rest ? `还差 ${rest} 人` : null].filter(Boolean).join("，");
  return (
    <article data-todo data-tone={tone} className="relative mt-2.5 rounded-[13px] bg-card p-3.5 text-card-foreground">
      <div className="flex items-start gap-3">
        <Ring p={p} now={now} urgent={urgent} n={n} />
        <div className="min-w-0">
          <h3 className="text-[14px] leading-[1.4] font-semibold tracking-normal">
            <Link to={`/pages/${p.id}`} className="line-clamp-2 outline-none hover:underline hover:underline-offset-4 focus-visible:ring-[3px] focus-visible:ring-ring/80">{p.title}</Link>
          </h3>
          <small className="block truncate text-[12px] text-faint">{meta}</small>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2.5">
        <span className={cn("min-w-0 text-[12px]", urgent ? "font-medium text-coral-ink" : "text-muted-foreground")}>
          {ts ? `${ts.done} / ${ts.total} 项已完成` : p.closes_at ? `${fmtDue(p.closes_at, new Date(now))} 截止${left && urgent ? `，还剩 ${left}` : ""}` : "不限截止时间"}
        </span>
        <Link to={`/pages/${p.id}`} className="inline-flex h-[34px] shrink-0 items-center rounded-[10px] bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground outline-none transition-[filter] hover:brightness-[1.08] focus-visible:ring-[3px] focus-visible:ring-ring/80">
          {ts ? (ts.my_review ? "去评审" : "去处理") : tone === "vote" ? "去投票" : "去填写"}
        </Link>
      </div>
    </article>
  );
}

/** 倒计时圈：有截止时按剩余时间占比（发布到截止）走，中间等宽大数字（天 / 时 / 分）；没有截止时按参与比例，中间是已交人数 */
function Ring({ p, now, urgent, n }: { p: Page; now: number; urgent: boolean; n: number }) {
  const C = 2 * Math.PI * 19;
  let frac = 0, label: string;
  if (p.task_stats) {
    frac = p.task_stats.total ? p.task_stats.done / p.task_stats.total : 0;
    label = `${p.task_stats.done}/${p.task_stats.total}`;
  } else if (p.closes_at) {
    const end = new Date(p.closes_at).getTime(), start = new Date(p.created_at).getTime();
    frac = Math.max(0, Math.min(1, (end - now) / Math.max(1, end - start)));
    const m = Math.max(0, Math.floor((end - now) / 60000));
    label = m >= 1440 ? `${Math.floor(m / 1440)}天` : m >= 60 ? `${Math.floor(m / 60)}时` : `${Math.max(1, m)}分`;
  } else {
    frac = p.eligible_count ? Math.min(1, n / p.eligible_count) : 0;
    label = p.eligible_count ? `${n}/${p.eligible_count}` : String(n);
  }
  return (
    <span className="relative size-[46px] shrink-0" aria-hidden="true">
      <svg width="46" height="46" className="-rotate-90">
        <circle cx="23" cy="23" r="19" fill="none" strokeWidth="5" className="stroke-primary-soft" />
        <circle cx="23" cy="23" r="19" fill="none" strokeWidth="5" strokeLinecap="round" className={cn("transition-[stroke-dashoffset] duration-500", urgent ? "stroke-coral" : "stroke-primary")}
          strokeDasharray={C} strokeDashoffset={C * (1 - frac)} />
      </svg>
      <b className="absolute inset-0 grid place-items-center font-mono text-[11px] leading-none font-semibold tabular-nums"><Roll text={label} /></b>
    </span>
  );
}

// ---------- 实时动态 ----------
const ACT_VERB: Record<Activity["type"], string> = { published: "发布了", updated: "更新了", submitted: "提交了", task: "更新了任务", closed: "关闭了" };
const TASK_VERB: Record<string, string> = { started: "开始处理", submitted: "提交评审", approved: "评审通过了", rejected: "驳回了" };

function useActivity(projectId?: string) {
  const [items, setItems] = useState<Activity[] | null>(null);
  const [off, setOff] = useState(false);
  useEffect(() => {
    let live = true, timer = 0;
    const tick = async () => {
      clearTimeout(timer);
      if (document.visibilityState !== "visible") return; // 页面不可见时暂停，回来再拉
      try {
        const r = await get<{ items: Activity[] }>(`/activity${qs({ limit: 30, project_id: projectId })}`);
        if (live) setItems(r.items);
      } catch (e) {
        // 旧后端没有这个接口：整栏不显示
        if (e instanceof ApiError && e.status === 404) return live && setOff(true);
      }
      if (live) timer = window.setTimeout(tick, 30000);
    };
    tick();
    document.addEventListener("visibilitychange", tick);
    return () => (live = false, clearTimeout(timer), document.removeEventListener("visibilitychange", tick));
  }, [projectId]);
  return { items, off };
}

function ago(iso: string, now: number) {
  const m = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  if (m < 180) return `${Math.floor(m / 60)} 小时前`;
  return fmtRel(iso, new Date(now));
}


/** 实时动态：发布、更新、提交事件，30 秒轮询，新事件从顶部滑入 */
function ActivityFeed({ projectId }: { projectId?: string }) {
  const { items, off } = useActivity(projectId);
  const now = useNow();
  if (off) return null;
  return (
    <aside aria-label="实时动态" className="order-4 min-w-0 rounded-[16px] border bg-card px-[18px] py-4 xl:flex-1">
      <h2 className="mb-2.5 flex items-center gap-2 text-[15px] font-semibold tracking-normal">
        <i aria-hidden="true" className="size-2 rounded-full bg-live ring-4 ring-live-ring" />实时动态
      </h2>
      {items === null ? (
        <div className="grid gap-3" role="status" aria-label="加载中">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-9" />)}</div>
      ) : items.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">还没有动态。</p>
      ) : (
        <ol className="activity">
          <AnimatePresence initial={false}>
            {items.slice(0, 12).map((a) => (
              <motion.li key={`${a.type}:${a.page.id}:${a.at}:${a.task?.title ?? ""}`} layout initial={{ opacity: 0, y: -14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                className="flex gap-2.5 border-t py-[9px] text-[13px] text-muted-foreground first:border-t-0">
                <Initial name={a.actor?.name ?? "?"} className="ring-0" />
                <div className="min-w-0 [overflow-wrap:anywhere]">
                  <b className="font-semibold text-foreground">{a.actor?.name ?? "有人"}</b>{" "}
                  {a.type === "task" && a.task ? <>
                    {TASK_VERB[a.task.action] ?? ACT_VERB.task} 任务「{a.task.title}」，在{" "}
                    <Link to={`/pages/${a.page.id}`} className="text-foreground underline-offset-4 hover:underline">{a.page.title}</Link>
                  </> : <>
                    {a.type === "updated" ? "把 " : `${a.type === "submitted" && a.page.page_type === "vote" ? "投了" : ACT_VERB[a.type]} `}
                    <Link to={`/pages/${a.page.id}`} className="text-foreground underline-offset-4 hover:underline">{a.page.title}</Link>
                    {a.type === "updated" && ` 更新到第 ${a.version} 版`}
                  </>}
                  <time dateTime={a.at} className="block text-[12px] text-faint">{ago(a.at, now)}</time>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      )}
    </aside>
  );
}

// ---------- 经典主题：列表视图与停靠小窗 ----------
/** 状态列：文字 + 色（red 等你处理 / ok 已完成 / mute 只读、已截止） */
function statusOf(p: Page, now: number): [string, "red" | "ok" | "mute"] {
  const tone = toneOf(p.page_type, p.category);
  const ts = p.task_stats;
  if (p.closed_at) return ["已关闭", "mute"];
  if (ts) return ts.my_review ? [`待你评审 ${ts.my_review} 项`, "red"] : ts.my_todo ? [`你有 ${ts.my_todo} 项待办`, "red"]
    : ts.total && ts.done === ts.total ? ["已全部完成", "ok"] : ts.in_review ? [`${ts.in_review} 项待评审`, "mute"] : ["进行中", "mute"];
  if (isTodo(p, now)) return [`等你${tone === "vote" ? "投票" : "填写"}`, "red"];
  if (p.my_submitted) return [`你已${tone === "vote" ? "投" : "提交"}`, "ok"];
  if (p.category === "collect") return isClosed(p.closes_at, now) || !p.accept_responses ? ["已截止", "mute"] : ["收集中", "mute"];
  return ["只读", "mute"];
}

/** 蓝色分段进度条 */
function Blocks({ value, label }: { value: number; label: string }) {
  return <span className="cl-mini-bar"><span data-bar=""><i style={{ width: `${Math.round(Math.min(1, value) * 100)}%` }} /></span>{label}</span>;
}

function ClassicList({ groups, now, proj, loaded, empty }: {
  groups: (readonly [string, Page[]])[]; now: number; proj?: (id: string) => string | undefined; loaded: boolean; empty: string;
}) {
  const [sel, setSel] = useState<string | null>(null);
  if (!loaded) return <div className="cl-list"><p className="p-2" role="status">加载中…</p></div>;
  if (!groups.length) return <div className="cl-list"><p className="p-2">{empty}</p></div>;
  return (
    <div className="cl-list">
      <table>
        <colgroup><col /><col className="w-[72px]" /><col className="w-[96px]" /><col className="w-[150px]" /><col className="w-[100px]" /><col className="w-[150px]" /><col className="w-[96px]" /><col className="w-[84px]" /></colgroup>
        <thead><tr><th>名称</th><th>类型</th><th>项目</th><th>发布者</th><th>状态</th><th>进度</th><th>截止</th><th>更新时间</th></tr></thead>
        <tbody>
          {groups.map(([g, ps]) => (
            <Fragment key={g}>
              <tr className="cl-grp"><td colSpan={8}>{g}<hr /></td></tr>
              {ps.map((p) => {
                const tone = toneOf(p.page_type, p.category);
                const [st, c] = statusOf(p, now);
                const n = p.respondent_count ?? p.response_count;
                const ts = p.task_stats;
                const prog = ts ? <Blocks value={ts.total ? ts.done / ts.total : 0} label={`${ts.done}/${ts.total}`} />
                  : p.category === "collect" ? (p.eligible_count ? <Blocks value={n / p.eligible_count} label={`${n}/${p.eligible_count}`} /> : `${n} ${unit(p)}`)
                  : p.highlights?.[0] ? `${p.highlights[0].value} ${p.highlights[0].label}` : "—";
                return (
                  <tr key={p.id} aria-selected={sel === p.id} onClick={() => setSel(p.id)}>
                    <td><span className="nm"><PixelIcon name={TONE_PIXEL[tone]} /><Link to={`/pages/${p.id}`} data-vt={p.id} className="tile-title">{p.title}</Link></span></td>
                    <td>{PAGE_TYPE_LABEL[p.page_type]}</td>
                    <td>{proj?.(p.project_id) ?? "—"}</td>
                    <td>{p.created_by.display_name}{p.generated_by ? ` - ${p.generated_by}` : ""}</td>
                    <td className={`tag ${c}`}>{st}</td>
                    <td>{prog}</td>
                    <td>{p.closes_at ? fmtDue(p.closes_at, new Date(now)) : "—"}</td>
                    <td>{fmtRel(p.updated_at, new Date(now))}</td>
                  </tr>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClassicTodo({ todos, now, proj }: { todos: Page[]; now: number; proj?: (id: string) => string | undefined }) {
  return (
    <MiniWindow title={`等我处理 (${todos.length})`} icon="inbox" label="等我处理">
      <p className="cl-mini-note">{todos.length ? "按截止时间排序，处理完自动移出。" : "都处理完了，暂时没有要你做的事。"}</p>
      <ul className="cl-todo">
        {todos.map((p) => {
          const tone = toneOf(p.page_type, p.category);
          const n = p.respondent_count ?? p.response_count;
          const ts = p.task_stats;
          const rest = p.eligible_count ? Math.max(0, p.eligible_count - n) : null;
          const meta = ts ? [proj?.(p.project_id), ts.my_review ? `待你评审 ${ts.my_review} 项` : null, ts.my_todo ? `你的待办 ${ts.my_todo} 项` : null]
            : [proj?.(p.project_id), n ? `已有 ${n} ${unit(p)}` : `还没人${verb(p)}`, rest ? `还差 ${rest} 人` : null];
          const left = p.closes_at ? fmtLeft(p.closes_at, now) : null;
          return (
            <li key={p.id} data-todo>
              <PixelIcon name={TONE_PIXEL[tone]} size={32} />
              <div className="min-w-0 flex-1">
                <b className="block truncate">{p.title}</b>
                <small className="block truncate">{meta.filter(Boolean).join("，")}</small>
                <div className="cl-todo-foot">
                  <span className={p.closes_at ? "tag red" : undefined}>{ts ? `${ts.done} / ${ts.total} 项已完成` : p.closes_at ? `${fmtDue(p.closes_at, new Date(now))} 截止${left ? `（${left}）` : ""}` : "不限截止时间"}</span>
                  <Button size="sm" variant="outline" asChild><Link to={`/pages/${p.id}`}>{ts ? (ts.my_review ? "去评审" : "去处理") : tone === "vote" ? "去投票" : "去填写"}</Link></Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </MiniWindow>
  );
}

function ClassicActivity({ projectId }: { projectId?: string }) {
  const { items, off } = useActivity(projectId);
  const now = useNow();
  if (off) return null;
  return (
    <MiniWindow title="消息 - 实时动态" icon="msg" label="实时动态">
      <ol className="cl-acts">
        {items === null ? <li role="status">加载中…</li> : items.length === 0 ? <li>还没有动态。</li> : items.slice(0, 12).map((a) => (
          <li key={`${a.type}:${a.page.id}:${a.at}:${a.task?.title ?? ""}`}>
            <Initial name={a.actor?.name ?? "?"} />
            <span className="min-w-0 flex-1 truncate">
              <b>{a.actor?.name ?? "有人"}</b>{" "}
              {a.type === "task" && a.task ? `${TASK_VERB[a.task.action] ?? ACT_VERB.task}「${a.task.title}」，在 ` : a.type === "submitted" && a.page.page_type === "vote" ? "投了 " : `${ACT_VERB[a.type]} `}
              <Link to={`/pages/${a.page.id}`}>{a.page.title}</Link>
            </span>
            <time dateTime={a.at}>{ago(a.at, now)}</time>
          </li>
        ))}
      </ol>
      <div className="cl-status"><div className="grow"><i className="cl-led" aria-hidden="true" />已连接 - 实时推送</div></div>
    </MiniWindow>
  );
}

/** 某项目的页面（经典主题文件夹树）：只取格子墙缓存，最近更新的前 12 个，不含已关闭的 */
export function pagesOf(projectId: string): Page[] {
  const seen = new Map<string, Page>();
  for (const v of cache.values()) for (const p of v.items) if (p.project_id === projectId && !p.closed_at) seen.set(p.id, p);
  return [...seen.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 12);
}

/** 格子墙缓存里找页面（详情页拿可见性等字段，省一次请求） */
export function cachedPage(id: string): Page | undefined {
  for (const v of cache.values()) {
    const p = v.items.find((x) => x.id === id);
    if (p) return p;
  }
}

/** 同项目的其他页面（详情页「相关页面」）：只从格子墙缓存里取，最近更新的前 3 个，不含已关闭的；没缓存时为空 */
export function relatedPages(projectId: string, exclude: string): Page[] {
  const seen = new Map<string, Page>();
  for (const v of cache.values()) for (const p of v.items) if (p.project_id === projectId && p.id !== exclude && !p.closed_at) seen.set(p.id, p);
  return [...seen.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 3);
}

/** 页面设置保存后（或提交后）丢掉缓存里的旧副本（下次进入格子墙会刷新） */
export function patchCachedPage(id: string) {
  for (const [k, v] of cache) if (v.items.some((x) => x.id === id)) cache.delete(k);
  cacheVer++;
  cacheListeners.forEach((l) => l());
}
