// 纯函数：OpenUI 提交数据规范化（api.md §10）与结果扁平化（§8.4，结果页与 CSV 同规则）
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export type ActionLike = {
  humanFriendlyMessage: string;
  formName?: string;
  formState?: Record<string, unknown>;
  params?: Record<string, unknown>;
};

const unwrapForm = (form: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(form).map(([k, v]) => [k, isObj(v) && "value" in v ? v.value : v]));

export function normalizeValues(formState: Record<string, unknown> | undefined, formName: string | undefined) {
  const fs = formState ?? {};
  if (formName) return isObj(fs[formName]) ? unwrapForm(fs[formName]) : {};
  const out: Record<string, unknown> = {};
  for (const [name, form] of Object.entries(fs)) if (!name.startsWith("$") && isObj(form)) Object.assign(out, unwrapForm(form));
  return out;
}

export const submissionData = (e: ActionLike) => ({
  action: e.humanFriendlyMessage,
  form: e.formName ?? null,
  values: normalizeValues(e.formState, e.formName),
  params: e.params ?? {},
});

type Leaf = string | number | boolean | null | unknown[];

// CSV 固定列（§8.4）；数据列与之同名时加前缀，和服务端 CSV 保持一致
const FIXED = ["seq", "created_at", "respondent_type", "respondent_name", "user_id", "share_link_label", "page_version"];

/** data → { 列名: 叶子值 }；嵌套对象最多 3 层用 "." 连接，更深的（及空对象）整体保留（展示时 JSON 编码） */
export function flattenData(data: Record<string, unknown>): Record<string, Leaf | Record<string, unknown>> {
  const out: Record<string, Leaf | Record<string, unknown>> = {};
  const walk = (prefix: string, v: unknown, depth: number) => {
    if (isObj(v) && depth < 3 && Object.keys(v).length) for (const [k, c] of Object.entries(v)) walk(`${prefix}.${k}`, c, depth + 1);
    else out[prefix] = v as Leaf;
  };
  if (isObj(data.values)) {
    out.action = (data.action ?? null) as Leaf;
    out.form = (data.form ?? null) as Leaf;
    for (const [k, v] of Object.entries(data.values)) walk(FIXED.includes(k) || k === "action" || k === "form" ? `values.${k}` : k, v, 1);
  } else {
    for (const [k, v] of Object.entries(data)) walk(FIXED.includes(k) ? `data.${k}` : k, v, 1);
  }
  return out;
}

export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.every((x) => x === null || typeof x !== "object") ? v.join("; ") : JSON.stringify(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** 列集合 = 所有行键的并集，按首次出现顺序 */
export function unionColumns(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
}

/** 取值都是字符串/字符串数组且不同取值 ≤ 20 的字段 → 计数（design §7.4 投票统计）。
 *  form 列（表单名）不统计；action 列只有一种取值时不统计，避免噪音 */
export function tallies(rows: Record<string, unknown>[], cols: string[]) {
  const out: { col: string; counts: [string, number][] }[] = [];
  for (const col of cols) {
    if (col === "form") continue;
    const counts = new Map<string, number>();
    let ok = true, any = false;
    for (const r of rows) {
      const v = r[col];
      if (v === undefined || v === null || v === "") continue;
      const vals = typeof v === "string" ? [v] : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
      if (!vals) { ok = false; break; }
      any = true;
      for (const s of vals) counts.set(s, (counts.get(s) ?? 0) + 1);
      if (counts.size > 20) { ok = false; break; }
    }
    if (col === "action" && counts.size < 2) continue;
    if (ok && any) out.push({ col, counts: [...counts].sort((a, b) => b[1] - a[1]) });
  }
  return out;
}
