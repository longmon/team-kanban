// 动态流：首页（我能看的全部页面）与项目页（只看该项目）共用。按今天/昨天/本周/更早分组，chip 筛选，滚到底加载下一页
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { get, qs } from "../api";
import { cn } from "@/lib/utils";
import { Link } from "../router";
import { dayBucket, ErrorBox, fmtRel, ListSkeleton, PAGE_TYPE_LABEL, REDUCED, useMyProjects, useSession } from "../ui";
import { AgentOnboarding } from "./settings";
import type { Page, Paged } from "../types";

// ---------- 数据：游标分页 + 模块级缓存（返回动态流时立即渲染上次的列表，后退的标题过渡能找到对应行；随后后台刷新第一页） ----------
const cache = new Map<string, { items: Page[]; cursor: string | null }>();

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
        cache.set(path, next);
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

// ---------- 筛选 ----------
const isTodo = (p: Page) => p.category === "collect" && p.accept_responses && !p.my_submitted;
type Filter = "all" | "todo" | "docs" | "mine";
const FILTERS: [Filter, string][] = [["all", "全部"], ["todo", "等我参与"], ["docs", "文档"], ["mine", "我发布的"]];

/** 类型字形：页面类型中文名的第一个字 */
const glyph = (p: Page) => (PAGE_TYPE_LABEL[p.page_type] ?? "页").slice(0, 1);

/** 每行右侧唯一的动作 */
function action(p: Page): [string, string] {
  if (isTodo(p)) return [p.page_type === "vote" ? "去投票" : "去填写", `/pages/${p.id}`];
  if (p.category === "read") return ["阅读", `/pages/${p.id}`];
  if (p.results_visible_to === "viewers" || p.can_manage) return ["看结果", `/pages/${p.id}?panel=results`];
  return ["查看", `/pages/${p.id}`];
}

// 首页错落入场只在本次会话首次加载时播一次（之后切 chip、翻页、返回都不再播）
let played = false;

export function Feed({ projectId, empty }: { projectId?: string; empty?: ReactNode }) {
  const { me } = useSession();
  const feed = useFeed(`/pages${qs({ project_id: projectId, limit: 30 })}`);
  const projects = useMyProjects();
  const [filter, setFilter] = useState<Filter>("all");
  // 本组件挂载时还没播过，且是第一批数据：这批行错落入场、荧光笔刷出
  const stagger = useRef(!played && !REDUCED && !projectId);
  useEffect(() => {
    if (feed.items.length) {
      played = true;
      const t = setTimeout(() => (stagger.current = false), 0);
      return () => clearTimeout(t);
    }
  }, [feed.items.length]);

  const shown = feed.items.filter((p) =>
    filter === "todo" ? isTodo(p) : filter === "docs" ? p.category === "read" : filter === "mine" ? p.created_by.id === me?.user.id : true);
  const todo = feed.items.filter(isTodo).length;

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

  // 分组标题与行放在同一个列表里，筛选时一起做 layout 重排
  const rows: ({ k: string; day: string } | { k: string; p: Page })[] = [];
  let last = "";
  for (const p of shown) {
    const d = dayBucket(p.created_at);
    // 列表按 id（创建顺序）排；同一分组理论上连续，万一不连续也不让 key 重复
    if (d !== last) rows.push({ k: rows.some((r) => r.k === "d-" + d) ? `d-${d}-${p.id}` : "d-" + d, day: (last = d) });
    rows.push({ k: p.id, p });
  }
  const proj = (id: string) => projects.data?.find((x) => x.id === id);

  if (feed.loaded && !feed.items.length && !feed.error) return <>{empty ?? <AgentOnboarding />}</>;
  let n = 0;
  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="筛选" className="flex flex-wrap gap-1.5">
        {FILTERS.map(([v, label]) => (
          <button key={v} type="button" aria-pressed={filter === v} onClick={() => setFilter(v)}
            className={cn(
              "relative inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/80",
              filter === v ? "border-foreground text-background" : "bg-card text-muted-foreground hover:text-foreground",
            )}>
            {/* 选中底块在 chip 之间滑动 */}
            {filter === v && <motion.span layoutId={`chip-${projectId ?? "home"}`} className="absolute inset-0 -z-0 rounded-full bg-foreground" transition={{ type: "spring", bounce: 0.15, duration: 0.3 }} />}
            <span className="relative">{label}</span>
            {v === "todo" && todo > 0 && (
              <span data-testid="todo-count" className="relative rounded-full bg-highlight px-1.5 font-heading text-[11px] leading-4 font-semibold text-highlight-foreground tabular-nums">{todo}</span>
            )}
          </button>
        ))}
      </div>
      <ErrorBox error={feed.error} />
      {!feed.loaded && <ListSkeleton rows={4} />}
      {feed.loaded && shown.length === 0 && (
        <p className="border-t py-10 text-center text-sm text-muted-foreground">{filter === "todo" ? "没有等你参与的页面了。" : "没有符合条件的页面。"}</p>
      )}
      <div className="feed">
        <AnimatePresence initial={false} mode="popLayout">
          {rows.map((r) => {
            const i = n++;
            const enter = stagger.current
              ? { initial: { opacity: 0, y: 8 }, transition: { duration: 0.3, delay: Math.min(i, 10) * 0.03, ease: [0.2, 0.8, 0.2, 1] as const } }
              : { initial: REDUCED ? false as const : { opacity: 0 }, transition: { duration: 0.2 } };
            return (
              <motion.div key={r.k} layout="position" initial={enter.initial} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.15 } }}
                transition={{ ...enter.transition, layout: { duration: 0.3, ease: [0.2, 0.8, 0.2, 1] } }}>
                {"day" in r ? (
                  <h2 className="pt-5 pb-1.5 font-heading text-[13px] font-bold first:pt-1">{r.day}</h2>
                ) : <FeedRow p={r.p} project={projectId ? undefined : proj(r.p.project_id)?.name} sweep={stagger.current} />}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
      <div ref={sentinel} />
      {feed.loading && feed.items.length > 0 && <p className="py-3 text-center text-xs text-muted-foreground" role="status">加载中…</p>}
    </div>
  );
}

function FeedRow({ p, project, sweep }: { p: Page; project?: string; sweep: boolean }) {
  const todo = isTodo(p);
  const [label, to] = action(p);
  return (
    <div className="feed-row grid grid-cols-[34px_minmax(0,1fr)_auto] items-start gap-x-3 border-b py-3">
      <span aria-hidden="true" className={cn("mt-0.5 grid size-[30px] place-items-center rounded-lg font-heading text-[13px] font-bold", todo ? "bg-highlight text-highlight-foreground" : p.category === "read" ? "bg-muted" : "bg-primary/12")}>{glyph(p)}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link to={`/pages/${p.id}`} data-vt={p.id} viewTransition className="list-title w-fit max-w-full truncate text-[15px] font-semibold outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/80 underline-offset-4">{p.title}</Link>
          {todo && <mark className={cn("hl text-xs leading-5", sweep && "mark-sweep")}>{p.page_type === "vote" ? "等你投票" : "等你填写"}</mark>}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {project && <>{project}，</>}
          {p.created_by.display_name} 发布，
          {p.generated_by && <><span>由 {p.generated_by} 生成</span>，</>}
          {fmtRel(p.created_at)}
          {p.category === "collect" && (p.my_submitted ? `，你已提交，共 ${p.response_count} 份` : `，已有 ${p.response_count} 份${p.accept_responses ? "" : "，已截止"}`)}
        </p>
      </div>
      <Link to={to} className="mt-1 rounded-sm text-[13px] font-semibold whitespace-nowrap text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/80 underline-offset-4">{label}</Link>
    </div>
  );
}

/** 动态流缓存里找页面（详情页拿结果数、管理面板拿可见性等字段，省一次请求） */
export function cachedPage(id: string): Page | undefined {
  for (const v of cache.values()) {
    const p = v.items.find((x) => x.id === id);
    if (p) return p;
  }
}

/** 页面设置保存后丢掉缓存里的旧副本（下次进入动态流会刷新） */
export function patchCachedPage(id: string) {
  for (const [k, v] of cache) if (v.items.some((x) => x.id === id)) cache.delete(k);
}
