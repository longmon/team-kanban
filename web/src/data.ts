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

// ---------- 结果显示 OpenUI 标签而非原始 key ----------
export type SpecLabels = { fields: Record<string, string>; options: Record<string, Record<string, string>> };

const STR = String.raw`"((?:[^"\\]|\\.)*)"`;
const unq = (s: string) => { try { return JSON.parse(`"${s}"`) as string; } catch { return s; } };

/**
 * 从 OpenUI Lang 原文里取字段标签与选项标签（不解析整棵树，只认几种固定写法；取不到的退回原始 key）：
 *   FormControl("方案", RadioGroup("choice", [a, b]))  或  FormControl("方案", x) + x = RadioGroup("choice", …)
 *   RadioItem(label, desc, value) / SelectItem(value, label) / ChipItem(value, label) / CheckBoxItem(label, desc, name)
 */
export function specLabels(spec: string): SpecLabels {
  const vars: Record<string, string> = {};
  for (const m of spec.matchAll(/^\s*(\w+)\s*=\s*(.+)$/gm)) vars[m[1]] = m[2];
  // 选项变量 → [value, label]
  const item: Record<string, [string, string]> = {};
  for (const [v, body] of Object.entries(vars)) {
    const args = [...body.matchAll(new RegExp(STR, "g"))].map((m) => unq(m[1]));
    if (/^RadioItem\(/.test(body) && args.length >= 3) item[v] = [args[2], args[0]];
    else if (/^(SelectItem|ChipItem)\(/.test(body) && args.length >= 2) item[v] = [args[0], args[1]];
    else if (/^CheckBoxItem\(/.test(body) && args.length >= 3) item[v] = [args[2], args[0]];
  }
  const out: SpecLabels = { fields: {}, options: {} };
  // 字段组件（含行内写法）：Comp("name", [a, b, …])
  const fieldRe = new RegExp(String.raw`(?:RadioGroup|Select|Chips|CheckBoxGroup|Input|TextArea|Slider|DatePicker|SwitchGroup)\(\s*${STR}(?:\s*,\s*(?:${STR}\s*,\s*)?\[([^\]]*)\])?`, "g");
  for (const m of spec.matchAll(fieldRe)) {
    const name = unq(m[1]);
    const refs = (m[3] ?? "").split(",").map((x) => x.trim()).filter((x) => item[x]);
    if (refs.length) out.options[name] = Object.fromEntries(refs.map((r) => item[r]));
  }
  // FormControl("标签", Comp("name" …)) 或 FormControl("标签", 变量)
  for (const m of spec.matchAll(new RegExp(String.raw`FormControl\(\s*${STR}\s*,\s*(?:\w+\(\s*${STR}|(\w+))`, "g"))) {
    const name = m[2] !== undefined ? unq(m[2]) : vars[m[3]]?.match(new RegExp(String.raw`^\w+\(\s*${STR}`))?.[1];
    if (name !== undefined) out.fields[unq(name)] = unq(m[1]);
  }
  return out;
}

/** 列名 → 显示名：字段标签；"组.项"（多选框）→ "组标签：项标签" */
export function colLabel(col: string, l: SpecLabels | null) {
  if (!l) return col;
  if (l.fields[col]) return l.fields[col];
  const [g, k] = col.split(/\.(.*)/s);
  return k !== undefined && l.options[g]?.[k] ? `${l.fields[g] ?? g}：${l.options[g][k]}` : col;
}
/** 取值 → 显示名（选项标签） */
export const valLabel = (col: string, v: string, l: SpecLabels | null) => l?.options[col]?.[v] ?? v;
