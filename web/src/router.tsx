// 极简路由：history API + useSyncExternalStore，路径见 api.md §13
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { flushSync } from "react-dom";

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 等新页面的标题渲染出来（数据异步加载），最多 maxMs；过渡期间页面冻结，所以上限要短 */
const waitFor = <T,>(get: () => T | null, maxMs: number) =>
  new Promise<T | null>((done) => {
    const t0 = performance.now();
    const tick = () => {
      const v = get();
      if (v || performance.now() - t0 > maxMs) done(v);
      else setTimeout(tick, 16);
    };
    tick();
  });

/**
 * 共享元素过渡：from 元素作为 page-title 过渡到 update 之后 target() 找到的元素，其余内容交叉淡入。
 * 最多等新页面元素 300ms（数据异步加载；过渡期间页面冻结，所以上限要短）；不支持 View Transitions 或开了减少动态时直接切换。
 */
function sharedTitle(from: HTMLElement | null | undefined, update: () => void, target: () => HTMLElement | null) {
  if (!from || !document.startViewTransition || reduced()) return update();
  from.style.viewTransitionName = "page-title";
  let to: HTMLElement | null = null;
  const vt = document.startViewTransition(async () => {
    from.style.viewTransitionName = "";
    flushSync(update);
    to = await waitFor(target, 300);
    if (to) to.style.viewTransitionName = "page-title";
  });
  vt.ready.catch(() => {}); // 过渡被跳过（标签页隐藏、连点）时不报未处理的 AbortError
  vt.finished.finally(() => to && (to.style.viewTransitionName = ""));
}

/**
 * from：动态流里被点的标题（带 data-vt=页面 id）。标题作为共享元素移到详情页 h1；浏览器后退时反向（详情 h1 → 流里同一行的标题）。
 */
export function navigate(to: string, replace = false, from?: HTMLElement) {
  sharedTitle(from, () => {
    history[replace ? "replaceState" : "pushState"](null, "", to);
    window.scrollTo(0, 0);
    emit();
  }, () => document.querySelector<HTMLElement>("main h1"));
}

window.addEventListener("popstate", () => {
  const h = document.querySelector<HTMLElement>("main h1[data-vt]");
  const id = h?.dataset.vt;
  sharedTitle(h, emit, () => document.querySelector<HTMLElement>(`main a[data-vt="${CSS.escape(id ?? "")}"]`));
});

/** 改查询参数（Tab、筛选）：替换历史记录、不滚动、不重播路由入场 */
export function setQuery(name: string, value: string | null) {
  const u = new URL(location.href);
  if (value === null) u.searchParams.delete(name);
  else u.searchParams.set(name, value);
  history.replaceState(null, "", u.pathname + u.search + u.hash);
  emit();
}

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
export const useLocation = () => useSyncExternalStore(subscribe, () => location.pathname + location.search);
export const useQuery = (name: string) => {
  useLocation();
  return new URLSearchParams(location.search).get(name);
};

/** viewTransition：链接文字作为共享元素过渡到目标页标题（列表 → 页面） */
export function Link({ to, onClick, viewTransition, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; viewTransition?: boolean }) {
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to, false, viewTransition ? e.currentTarget : undefined);
  };
  return <a href={to} onClick={click} {...rest} />;
}

/** "/pages/:id" 匹配 "/pages/abc" → { id: "abc" } */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/"), s = path.split("/");
  if (p.length !== s.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) {
      if (!s[i]) return null;
      out[p[i].slice(1)] = decodeURIComponent(s[i]);
    } else if (p[i] !== s[i]) return null;
  }
  return out;
}
