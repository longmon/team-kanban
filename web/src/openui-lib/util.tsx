import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 数字滚动计数：文本里第一个数字从 0（首次）或上一次的值补间到新值，450ms ease-out，保留前后缀、小数位与千分位；
 * 播完显示原文。减少动态时直接显示。span 的文字由这里写，不交给 React（避免与逐帧改写冲突）。
 */
export function CountUp({ value, className }: { value: string | number; className?: string }) {
  const text = String(value);
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = text;
    const m = text.match(/-?\d[\d,]*(?:\.\d+)?/);
    if (!m) return;
    const to = Number(m[0].replace(/,/g, ""));
    const from = prev.current;
    prev.current = to;
    if (from === to || !isFinite(to) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const dec = m[0].split(".")[1]?.length ?? 0;
    const fmt = (v: number) => (m[0].includes(",") ? v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }) : v.toFixed(dec));
    const pre = text.slice(0, m.index), post = text.slice(m.index! + m[0].length);
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / 450);
      el.textContent = p < 1 ? pre + fmt(from + (to - from) * (1 - (1 - p) ** 3)) + post : text;
      if (p < 1) raf = requestAnimationFrame(step);
    };
    step(t0);
    return () => (cancelAnimationFrame(raf), void (el.textContent = text));
  }, [text]);
  return <span ref={ref} className={cn("tabular-nums", className)} />;
}

/** 是否已在卡片表面内：OpenUI 根内容直接放在页面底色上，表格/表单/图表不在卡片里时自己做 surface，避免卡片套卡片 */
export const InSurface = createContext(false);

/** 不在卡片里时包一层 surface（并告知子组件已在表面内）；已在卡片里时原样输出 */
export function Surface({ className, plain, children }: { className?: string; plain?: string; children: ReactNode }) {
  const inside = useContext(InSurface);
  return inside
    ? <div className={plain}>{children}</div>
    : <InSurface.Provider value><div className={cn("surface", className)}>{children}</div></InSurface.Provider>;
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

const props = (n: unknown) => (typeof n === "object" && n !== null && "props" in n ? (n as { props: Record<string, unknown> }).props : (n as Record<string, unknown>) ?? {});

/** labels + Series(...) → recharts 行数据。series 键用 s0、s1…（名字可能含空格/中文，不能直接做 CSS 变量名） */
export function buildChartData(labels: unknown, series: unknown) {
  const ss = asArray(series).map(props).filter((s) => typeof s?.category === "string" && Array.isArray(s.values));
  const rows = asArray(labels).map((label, i) => {
    const row: Record<string, string | number> = { category: String(label ?? "") };
    ss.forEach((s, k) => {
      const v = (s.values as unknown[])[i];
      row[`s${k}`] = typeof v === "number" ? v : Number(v) || 0;
    });
    return row;
  });
  return { rows, names: ss.map((s) => String(s.category)) };
}
