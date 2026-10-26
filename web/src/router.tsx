// 极简路由：history API + useSyncExternalStore，路径见 api.md §13
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { flushSync } from "react-dom";

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
window.addEventListener("popstate", emit);

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
 * from：列表里被点的标题。浏览器支持 View Transitions 且未开减少动态时，标题作为共享元素（page-title）移到新页面的 h1，
 * 其余内容交叉淡入；不支持时直接切换。
 */
export function navigate(to: string, replace = false, from?: HTMLElement) {
  const go = () => {
    history[replace ? "replaceState" : "pushState"](null, "", to);
    window.scrollTo(0, 0);
    emit();
  };
  if (!from || !document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return go();
  from.style.viewTransitionName = "page-title";
  const title = () => document.querySelector<HTMLElement>("main h1");
  const vt = document.startViewTransition(async () => {
    from.style.viewTransitionName = "";
    flushSync(go);
    const h = await waitFor(title, 300);
    if (h) h.style.viewTransitionName = "page-title";
  });
  vt.ready.catch(() => {}); // 过渡被跳过（标签页隐藏、连点）时不报未处理的 AbortError
  vt.finished.finally(() => {
    const h = title();
    if (h) h.style.viewTransitionName = "";
  });
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
