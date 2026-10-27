// 格子墙（方向 B 糖纸格）：首页（我能看的全部页面）与项目页（只看该项目）共用。
// 宽屏 bento 网格：等我处理的格子 2×2 饱和底色，有摘要的报告 2×1，其余 1×1，dense 填充；右侧 316px「正在发生」栏（< 1280 移到格子下方）。
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { Check, Clock, Sparkles } from "lucide-react";
import { ApiError, get, qs } from "../api";
import { cn } from "@/lib/utils";
import { Link } from "../router";
import { picked, specLabels, type SpecLabels } from "../data";
import {
  ErrorBox, fmtDue, fmtLeft, fmtRel, Initial, isClosed, PAGE_TYPE_LABEL, REDUCED, toneOf, ToneIcon, useCurrentOrgId, useMyProjects, useNow, useSession, type Tone,
} from "../ui";
import { Skeleton } from "@/components/ui/skeleton";
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

/** 顶栏项目胶囊的页面数：首页列表已全部加载（没有下一页）时按项目计数，否则不显示 */
export function useProjectCounts(orgId: string | undefined) {
  useSyncExternalStore((l) => (cacheListeners.add(l), () => void cacheListeners.delete(l)), () => cacheVer);
  const c = cache.get(HOME);
  if (!c || c.cursor || !orgId) return { all: null as number | null, by: {} as Record<string, number> };
  const by: Record<string, number> = {};
  let all = 0;
  for (const p of c.items) if (p.org_id === orgId) (by[p.project_id] = (by[p.project_id] ?? 0) + 1), all++;
  return { all, by };
}

// ---------- 分类 ----------
/** 等我处理：收集类、仍接受提交、未截止、我还没交当前版本 */
const isTodo = (p: Page, now = Date.now()) => p.category === "collect" && p.accept_responses && !p.my_submitted && !isClosed(p.closes_at, now);
type Filter = "all" | "todo" | "docs" | "mine";
const FILTERS: [Filter, string][] = [["all", "全部"], ["todo", "等我参与"], ["docs", "文档"], ["mine", "我发布的"]];
const verb = (p: Page) => (toneOf(p.page_type, p.category) === "vote" ? "投" : "交");

// 首页错落入场只在本次会话首次加载时播一次（之后切筛选、翻页、返回都不再播）
let played = false;

export function Wall({ projectId, title, empty }: { projectId?: string; title?: ReactNode; empty?: ReactNode }) {
  const { me } = useSession();
  const now = useNow();
  const path = projectId ? `/pages${qs({ project_id: projectId, limit: 30 })}` : HOME;
  const feed = useFeed(path);
  const projects = useMyProjects();
  const [filter, setFilter] = useState<Filter>("all");
  const stagger = useRef(!played && !REDUCED && !projectId);
  useEffect(() => {
    if (feed.items.length) {
      played = true;
      const t = setTimeout(() => (stagger.current = false), 0);
      return () => clearTimeout(t);
    }
  }, [feed.items.length]);

  // 多组织时首页只显示当前组织（顶栏组织切换）；单组织不过滤
  const orgs = me?.orgs ?? [];
  const lastOrg = useCurrentOrgId();
  const orgId = projectId || orgs.length < 2 ? undefined : (orgs.find((o) => o.id === lastOrg) ?? orgs[0]).id;
  const items = orgId ? feed.items.filter((p) => p.org_id === orgId) : feed.items;
  const todos = items.filter((p) => isTodo(p, now)).sort((a, b) => due(a) - due(b));
  const rest = items.filter((p) => !isTodo(p, now)).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const shown = [...todos, ...rest].filter((p) =>
    filter === "todo" ? isTodo(p, now) : filter === "docs" ? p.category === "read" : filter === "mine" ? p.created_by.id === me?.user.id : true);

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
  return (
    <div className="flex flex-col gap-7 xl:flex-row">
      <div className="@container min-w-0 flex-1">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1 className="text-[34px] leading-tight font-semibold [overflow-wrap:anywhere] max-sm:text-[26px]">
              {title ?? (todos.length ? `${name}，有 ${todos.length} 件事等你` : `${name}，暂时没有要你处理的事`)}
            </h1>
            <p className="mt-1 text-[14px] text-muted-foreground">
              {title && todos.length ? `有 ${todos.length} 件事等你，` : ""}
              {todos.length ? `其余 ${rest.length} 个页面按最近更新排列` : `${rest.length} 个页面按最近更新排列`}
            </p>
          </div>
          <div role="group" aria-label="筛选" className="flex flex-wrap gap-1 rounded-full bg-muted p-1">
            {FILTERS.map(([v, label]) => (
              <button key={v} type="button" aria-pressed={filter === v} onClick={() => setFilter(v)}
                className={cn(
                  "relative inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/80",
                  filter === v ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}>
                {filter === v && <motion.span layoutId={`seg-${projectId ?? "home"}`} className="absolute inset-0 rounded-full bg-card shadow-card" transition={{ type: "spring", bounce: 0.15, duration: 0.3 }} />}
                <span className="relative">{label}</span>
                {v === "todo" && todos.length > 0 && (
                  <span data-testid="todo-count" className="relative rounded-full bg-primary px-1.5 text-[11px] leading-4 font-semibold text-primary-foreground tabular-nums">{todos.length}</span>
                )}
              </button>
            ))}
          </div>
        </div>
        <ErrorBox error={feed.error} />
        {!feed.loaded && <WallSkeleton />}
        {feed.loaded && shown.length === 0 && (
          <p className="rounded-[24px] bg-muted py-12 text-center text-sm text-muted-foreground">{filter === "todo" ? "没有等你参与的页面了。" : "没有符合条件的页面。"}</p>
        )}
        <LayoutGroup>
          <div className="bento grid grid-flow-row-dense auto-rows-[184px] grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3.5">
            <AnimatePresence initial={false} mode="popLayout">
              {shown.map((p, i) => {
                const todo = isTodo(p, now);
                const wide = !todo && p.category === "read" && (!!p.summary || !!p.highlights?.length) && p.page_type === "report";
                const enter = stagger.current
                  ? { initial: { opacity: 0, y: 14, scale: 0.98 }, transition: { duration: 0.35, delay: Math.min(i, 10) * 0.04, ease: [0.22, 1, 0.36, 1] as const } }
                  : { initial: REDUCED ? (false as const) : { opacity: 0, scale: 0.98 }, transition: { duration: 0.2 } };
                return (
                  <motion.div key={p.id} layout initial={enter.initial} animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.15 } }}
                    transition={{ ...enter.transition, layout: { duration: 0.35, ease: [0.22, 1, 0.36, 1] } }}
                    className={cn("min-w-0", todo && "row-span-2 @[540px]:col-span-2", wide && "@[540px]:col-span-2")}>
                    <Tile p={p} todo={todo} project={projectId ? undefined : proj(p.project_id)} now={now} lazy={todo && todos.indexOf(p) < 4} />
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        </LayoutGroup>
        <div ref={sentinel} />
        {feed.loading && feed.items.length > 0 && <p className="py-3 text-center text-xs text-muted-foreground" role="status">加载中…</p>}
      </div>
      <ActivityRail projectId={projectId} items={items} />
    </div>
  );
}

const due = (p: Page) => (p.closes_at ? new Date(p.closes_at).getTime() : Infinity);

function WallSkeleton() {
  return (
    <div className="grid auto-rows-[184px] grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3.5" role="status" aria-label="加载中">
      {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className={cn("rounded-[24px]", i < 2 && "row-span-2")} />)}
    </div>
  );
}

// ---------- 格子 ----------
function Tile({ p, todo, project, now, lazy }: { p: Page; todo: boolean; project?: string; now: number; lazy: boolean }) {
  const tone = toneOf(p.page_type, p.category);
  const closed = isClosed(p.closes_at, now);
  const n = p.respondent_count ?? p.response_count;
  const head = (
    <div className="flex min-w-0 items-center gap-2 text-[12px] font-medium text-muted-foreground">
      <ToneIcon tone={tone} className={todo ? "bg-card" : "bg-tone-f"} />
      <span className="min-w-0 truncate">{[project, !todo && p.page_type !== "general" && PAGE_TYPE_LABEL[p.page_type]].filter(Boolean).join("，") || PAGE_TYPE_LABEL[p.page_type]}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {todo && p.closes_at && <Badge><Clock className="size-3.5" />{fmtDue(p.closes_at, new Date(now))} 截止</Badge>}
        {!todo && p.my_submitted && <Badge tinted><Check className="size-3.5" strokeWidth={3} />已{verb(p)}</Badge>}
        {!todo && p.category === "collect" && (closed || !p.accept_responses) && !p.my_submitted && <Badge tinted>已截止</Badge>}
        {!todo && !(p.category === "collect" && (closed || !p.accept_responses || p.my_submitted)) && (
          <span className="font-normal">{p.version > 1 ? `第 ${p.version} 版` : fmtRel(p.updated_at, new Date(now))}</span>
        )}
      </span>
    </div>
  );
  const titleLink = (
    <Link to={`/pages/${p.id}`} data-vt={p.id} viewTransition
      className={cn("tile-title w-fit max-w-full font-semibold outline-none after:absolute after:inset-0 after:rounded-[24px] focus-visible:after:ring-[3px] focus-visible:after:ring-ring/80",
        todo ? "line-clamp-2 text-[24px] leading-tight tracking-[-0.01em] max-sm:text-[20px]" : "line-clamp-2 text-[16px] leading-snug")}>
      {p.title}
    </Link>
  );
  const foot = p.generated_by
    ? <><Sparkles className="size-3.5" />{p.generated_by} 生成</>
    : <>{p.created_by.display_name} 发布</>;
  return (
    <article data-tone={tone} data-todo={todo || undefined}
      className={cn("tile relative flex h-full flex-col gap-2 overflow-hidden rounded-[24px]", todo ? "bg-tone-f px-6 py-5.5" : "bg-tone-l px-5 py-4.5")}>
      {head}
      {titleLink}
      {todo ? <TodoBody p={p} now={now} lazy={lazy} /> : <Body p={p} n={n} tone={tone} />}
      {!todo && <div className="mt-auto flex min-w-0 items-center gap-1.5 truncate text-[12px] text-muted-foreground">{foot}</div>}
    </article>
  );
}

function Badge({ children, tinted }: { children: ReactNode; tinted?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-semibold whitespace-nowrap text-tone-ink", tinted ? "bg-tone-f" : "bg-card")}>
      {children}
    </span>
  );
}

/** 大号数字 + 说明 */
function Count({ big, unit, size = "md" }: { big: ReactNode; unit: ReactNode; size?: "md" | "lg" }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 tabular-nums">
      <b className={cn("leading-none font-semibold tracking-[-0.02em]", size === "lg" ? "text-[46px] max-sm:text-[38px]" : "text-[30px]")}>{big}</b>
      <span className="min-w-0 truncate text-[14px] text-muted-foreground">{unit}</span>
    </div>
  );
}

function Body({ p, n, tone }: { p: Page; n: number; tone: Tone }) {
  if (p.category === "collect")
    return p.eligible_count
      ? <Count big={`${n}/${p.eligible_count}`} unit={`人已${verb(p)}`} />
      : <Count big={n} unit={tone === "vote" ? "人已投" : "份提交"} />;
  if (tone === "flow" || tone === "arch") return (
    <>
      <Wireframe tone={tone} />
      {p.summary && <p className="line-clamp-1 text-[13px] text-muted-foreground">{p.summary}</p>}
    </>
  );
  if (p.highlights?.length)
    return (
      <div className="flex flex-wrap gap-x-7 gap-y-1 tabular-nums">
        {p.highlights.slice(0, 3).map((h, i) => (
          <div key={i} className="min-w-0"><b className="text-[26px] font-semibold tracking-[-0.02em]">{h.value}</b> <span className="text-[13px] text-muted-foreground">{h.label}</span></div>
        ))}
      </div>
    );
  if (p.summary) return <p className="line-clamp-3 text-[13px] text-muted-foreground">{p.summary}</p>;
  return null;
}

/** 流程图/架构图的通用示意线框（不解析真实图） */
function Wireframe({ tone }: { tone: "flow" | "arch" }) {
  const g = { fill: "var(--tone-f)", stroke: "var(--tone)", strokeWidth: 1.4 };
  return tone === "flow" ? (
    <svg viewBox="0 0 220 40" aria-hidden="true" className="h-10 w-full max-w-[260px]">
      <g {...g}><rect x="2" y="12" width="40" height="16" rx="8" /><rect x="62" y="12" width="40" height="16" rx="4" /><rect x="122" y="2" width="40" height="16" rx="4" /><rect x="122" y="22" width="40" height="16" rx="4" /><rect x="180" y="12" width="38" height="16" rx="8" fill="var(--tone)" /></g>
      <path d="M42 20h20M102 20h10V10h10M112 20v10h10M162 10h8v10h10M162 30h8V20" fill="none" stroke="var(--tone)" strokeOpacity=".45" strokeWidth="1.4" />
    </svg>
  ) : (
    <svg viewBox="0 0 220 40" aria-hidden="true" className="h-10 w-full max-w-[260px]">
      <g {...g} strokeWidth={1.3}><rect x="60" y="1" width="100" height="11" rx="4" /><rect x="4" y="15" width="66" height="11" rx="4" /><rect x="77" y="15" width="66" height="11" rx="4" /><rect x="150" y="15" width="66" height="11" rx="4" /><rect x="4" y="29" width="212" height="10" rx="4" fill="var(--card)" /></g>
    </svg>
  );
}

// ---------- 待办格（2×2）：倒计时或进度大字、迷你结果条 / 问题标签与已交头像、主按钮 ----------
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
function TodoBody({ p, now, lazy }: { p: Page; now: number; lazy: boolean }) {
  const [x, setX] = useState<Extra | null>(null);
  useEffect(() => {
    if (!lazy) return;
    let live = true;
    loadExtra(p).then((e) => live && setX(e));
    return () => void (live = false);
  }, [lazy, p]);
  const tone = toneOf(p.page_type, p.category);
  const isVote = tone === "vote";
  const n = p.respondent_count ?? p.response_count;
  const left = p.closes_at ? fmtLeft(p.closes_at, now) : null;
  const max = x?.tally ? Math.max(1, ...x.tally.map((t) => t[1])) : 1;
  return (
    <>
      {left ? (
        <Count size="lg" big={<Roll text={left} />} unit={`后截止，已有 ${n} ${isVote ? "票" : "份"}`} />
      ) : p.eligible_count ? (
        <Count size="lg" big={`${n}/${p.eligible_count}`} unit={`人已${verb(p)}，还差你`} />
      ) : (
        <Count size="lg" big={n} unit={`${isVote ? "票" : "份"}已提交，还差你`} />
      )}
      {x?.tally ? (
        <div className="mt-1 grid gap-1.5" aria-label="当前结果">
          {x.tally.map(([label, c], i) => (
            <div key={label} className="grid grid-cols-[minmax(0,6rem)_1fr_2rem] items-center gap-2 text-[13px]">
              <span className="truncate">{label}</span>
              <span className="h-2.5 overflow-hidden rounded-full bg-card/75">
                <span className="bar-grow block h-full rounded-full bg-tone" style={{ width: `${(c / max) * 100}%`, opacity: i ? 0.55 : 1 }} />
              </span>
              <span className="text-right tabular-nums">{c}</span>
            </div>
          ))}
        </div>
      ) : x?.questions.length ? (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {x.questions.map((q) => <span key={q} className="max-w-full truncate rounded-full bg-card/80 px-2.5 py-0.5 text-[12px] text-muted-foreground">{q}</span>)}
        </div>
      ) : null}
      {x && x.names.length > 0 && !x.tally && (
        <div className="flex -space-x-1.5">
          {x.names.map((nm) => <Initial key={nm} name={nm} />)}
          <span className="grid size-7 place-items-center rounded-full border-[1.5px] border-dashed border-tone bg-card text-[12px] text-muted-foreground">你</span>
        </div>
      )}
      <div className="mt-auto flex min-w-0 items-center gap-3">
        <Link to={`/pages/${p.id}`} className="relative z-10 inline-flex h-10 shrink-0 items-center rounded-full bg-primary px-5 text-[14px] font-semibold text-primary-foreground outline-none transition-[filter] hover:brightness-[1.06] focus-visible:ring-[3px] focus-visible:ring-ring/80">
          {isVote ? "去投票" : "去填写"}
        </Link>
        <span className="min-w-0 truncate text-[13px] text-muted-foreground">
          {p.created_by.display_name} 发起{p.generated_by ? `，${p.generated_by} 生成` : ""}
        </span>
      </div>
    </>
  );
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

// ---------- 正在发生 ----------
const ACT_VERB: Record<Activity["type"], string> = { published: "发布了", updated: "更新了", submitted: "提交了" };

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

function ActivityRail({ projectId, items: pages }: { projectId?: string; items: Page[] }) {
  const { items, off } = useActivity(projectId);
  const now = useNow();
  const stats = useMemo(() => weekStats(pages, now), [pages, now]);
  if (off) return null;
  return (
    <aside aria-label="正在发生" className="w-full shrink-0 xl:w-[316px]">
      <h2 className="mb-3.5 flex items-center gap-2 text-[16px] font-semibold">
        <i aria-hidden="true" className="size-2 rounded-full bg-live ring-4 ring-live-ring" />正在发生
      </h2>
      {items === null ? (
        <div className="grid gap-3" role="status" aria-label="加载中">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-9" />)}</div>
      ) : items.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">还没有动态。</p>
      ) : (
        <ol className="activity relative pl-[22px] before:absolute before:top-1.5 before:bottom-1.5 before:left-1.5 before:w-0.5 before:rounded-full before:bg-border max-xl:grid max-xl:grid-cols-[repeat(auto-fill,minmax(260px,1fr))] max-xl:gap-x-6">
          <AnimatePresence initial={false}>
            {items.slice(0, 12).map((a) => {
              const tone = toneOf(a.page.page_type, a.type === "submitted" ? "collect" : undefined);
              return (
                <motion.li key={`${a.type}:${a.page.id}:${a.at}`} layout initial={{ opacity: 0, y: -14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                  data-tone={tone} className="relative mb-4 text-[13px] text-muted-foreground">
                  <i aria-hidden="true" className="absolute top-[5px] -left-[21px] size-3 rounded-full border-[3px] border-background bg-tone" />
                  <b className="font-semibold text-foreground">{a.actor?.name ?? "有人"}</b>{" "}
                  {a.type === "updated" ? "把 " : `${a.type === "submitted" && a.page.page_type === "vote" ? "投了" : ACT_VERB[a.type]} `}
                  <Link to={`/pages/${a.page.id}`} className="text-foreground underline-offset-4 hover:underline">{a.page.title}</Link>
                  {a.type === "updated" && ` 更新到第 ${a.version} 版`}
                  <time dateTime={a.at} className="block text-[12px]">{ago(a.at, now)}</time>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ol>
      )}
      <h2 className="mt-6 mb-3 text-[16px] font-semibold">本周</h2>
      <div className="grid grid-cols-2 gap-2.5">
        {stats.map(([v, l]) => (
          <div key={l} className="rounded-[18px] bg-muted px-3.5 py-3">
            <b className="block text-[26px] leading-tight font-semibold tabular-nums">{v}</b>
            <small className="text-[12px] text-muted-foreground">{l}</small>
          </div>
        ))}
      </div>
    </aside>
  );
}

/** 「本周」四格：按已加载的页面统计（本周一起） */
function weekStats(pages: Page[], now: number): [string, string][] {
  const d = new Date(now);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
  const week = pages.filter((p) => new Date(p.created_at).getTime() >= monday);
  const collect = pages.filter((p) => p.category === "collect" && p.eligible_count);
  const elig = collect.reduce((t, p) => t + (p.eligible_count ?? 0), 0);
  const resp = collect.reduce((t, p) => t + Math.min(p.respondent_count ?? 0, p.eligible_count ?? 0), 0);
  return [
    [String(week.length), "新页面"],
    [String(pages.reduce((t, p) => t + p.response_count, 0)), "收到回答"],
    [String(week.filter((p) => p.generated_by).length), "AI 生成"],
    [elig ? `${Math.round((resp / elig) * 100)}%` : "—", "参与率"],
  ];
}

/** 格子墙缓存里找页面（详情页拿可见性等字段，省一次请求） */
export function cachedPage(id: string): Page | undefined {
  for (const v of cache.values()) {
    const p = v.items.find((x) => x.id === id);
    if (p) return p;
  }
}

/** 页面设置保存后（或提交后）丢掉缓存里的旧副本（下次进入格子墙会刷新） */
export function patchCachedPage(id: string) {
  for (const [k, v] of cache) if (v.items.some((x) => x.id === id)) cache.delete(k);
  cacheVer++;
  cacheListeners.forEach((l) => l());
}
