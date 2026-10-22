import { createContext, useContext, type ReactNode } from "react";
import { cn } from "@/lib/utils";

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
