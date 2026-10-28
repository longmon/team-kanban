// 表单与按钮。字段值经 react-lang 表单状态（useStateField）保存，onAction 时由 data.ts 规范化为 api.md §10 的 values；
// 各字段的值格式与原 openuiLibrary 一致（CheckBoxGroup / SwitchGroup 为 {name: boolean}，Chips 单选为字符串、多选为数组）。
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ACTION_STEPS, defineComponent, FormNameContext, FormValidationContext, parseStructuredRules, reactive, useCreateFormValidation,
  useFormName, useFormValidation, useGetFieldValue, useIsStreaming, useSetDefaultValue, useSetFieldValue, useStateField, useTriggerAction, action,
  isReactiveAssign,
} from "@openuidev/react-lang";
import { Check, CircleAlert } from "lucide-react";
import { useAnimate } from "motion/react";
import { z } from "zod";
import { cn } from "@/lib/utils";
import { Button as UIButton } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input as UIInput } from "@/components/ui/input";
import { Label as UILabel } from "@/components/ui/label";
import { RadioGroup as UIRadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select as UISelect, SelectContent, SelectItem as UISelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider as UISlider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Icon, LucideIcon } from "./content";
import { asArray, InSurface } from "./util";
import { splitLetter, type Tally } from "../data";

const rulesSchema = z.object({
  required: z.boolean().optional(),
  email: z.boolean().optional(),
  url: z.boolean().optional(),
  numeric: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  pattern: z.string().optional(),
}).optional();

/** 已提交锁定：按提交数据（values）回填，只读展示；选中项高亮、未选项置灰（DIM），交互由 Form 的 inert 屏蔽 */
function useLocked(name: string): { v: unknown } | null {
  const l = useContext(SubmitContext)?.locked;
  return l ? { v: l.values[name] } : null;
}
const DIM = "opacity-45 saturate-50";

const itemsOf = (v: unknown) => asArray(v).map((n) => ((n as { props?: Record<string, unknown> })?.props ?? {}) as Record<string, unknown>);

/** 字段默认值：字面量 value，其次 defaultValue；reactive 绑定（$变量）由 store 自管，不写默认 */
export const fieldDefault = (value: unknown, def?: unknown) => (isReactiveAssign(value) ? undefined : value ?? def);
/** CheckBoxGroup / SwitchGroup 默认值：有子项 defaultChecked 时为 { 子项 name: 是否勾选 }（含所有子项），否则 undefined */
export const checkedDefault = (items: Record<string, unknown>[]) =>
  items.some((it) => it.defaultChecked === true) ? Object.fromEntries(items.map((it) => [String(it.name), it.defaultChecked === true])) : undefined;

/** 字段状态 + 校验注册（各输入组件共用） */
function useField<T>(name: string, value: unknown, rawRules: unknown, def?: unknown) {
  const streaming = useIsStreaming();
  const fv = useFormValidation();
  const field = useStateField(name, value);
  const formName = useFormName();
  const getFieldValue = useGetFieldValue();
  // 默认值在流式结束后写进表单状态（用户未改时）：不改直接提交时，校验、提交、锁定回填拿到的都是界面上显示的默认项
  useSetDefaultValue({ formName, name: field.name, existingValue: getFieldValue(formName, field.name), defaultValue: fieldDefault(value, def) });
  const rules = useMemo(() => parseStructuredRules(rawRules as never), [rawRules]);
  const has = rules.length > 0;
  useEffect(() => {
    if (streaming || !has || !fv) return;
    fv.registerField(field.name, rules, () => field.value);
    return () => fv.unregisterField(field.name);
  }, [field.name, field.value, fv, has, streaming, rules]);
  return {
    name: field.name,
    value: field.value as T | undefined,
    disabled: streaming,
    invalid: !!fv?.errors[field.name],
    set: (v: unknown, validate = true) => {
      field.setValue(v as never);
      if (has && validate) fv?.validateField(field.name, v, rules);
    },
    clear: () => fv?.clearFieldError(field.name),
    validate: (v: unknown) => has && fv?.validateField(field.name, v, rules),
  };
}

/** react-lang 内置校验文案是英文，展示时换成中文 */
const ERR_ZH: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^This field is required$/, () => "此项必填"],
  [/^At least one option is required$/, () => "请至少选择一项"],
  [/^Please enter a valid email$/, () => "请输入有效的邮箱"],
  [/^Please enter a valid URL$/, () => "请输入有效的网址"],
  [/^Must be a number$/, () => "请输入数字"],
  [/^Invalid format$/, () => "格式不正确"],
  [/^Must be at least (\S+) characters$/, (m) => `至少 ${m[1]} 个字符`],
  [/^Must be no more than (\S+) characters$/, (m) => `最多 ${m[1]} 个字符`],
  [/^Must be at least (\S+)$/, (m) => `不能小于 ${m[1]}`],
  [/^Must be no more than (\S+)$/, (m) => `不能大于 ${m[1]}`],
];
const zhError = (e: string) => {
  for (const [re, f] of ERR_ZH) {
    const m = e.match(re);
    if (m) return f(m);
  }
  return e;
};

// ---------- 文本输入 ----------
export const Input = defineComponent({
  name: "Input",
  props: z.object({
    name: z.string(),
    placeholder: z.string().optional(),
    type: z.enum(["text", "email", "password", "number", "url"]).optional(),
    rules: rulesSchema,
    value: reactive(z.string().optional()),
  }),
  description: "",
  component: ({ props }) => {
    const f = useField<string>(props.name, props.value, props.rules);
    const lk = useLocked(props.name);
    return (
      <UIInput id={f.name} name={f.name} type={props.type || "text"} placeholder={lk ? "" : props.placeholder || ""} value={lk ? String(lk.v ?? "") : f.value ?? ""} readOnly={!!lk} className={FIELD_W}
        aria-invalid={f.invalid || undefined} disabled={f.disabled}
        onFocus={f.clear} onChange={(e) => (f.set(e.target.value, false), f.clear())} onBlur={(e) => f.validate(e.target.value)} />
    );
  },
});

export const TextArea = defineComponent({
  name: "TextArea",
  props: z.object({
    name: z.string(),
    placeholder: z.string().optional(),
    rows: z.number().optional(),
    rules: rulesSchema,
    value: reactive(z.string().optional()),
  }),
  description: "",
  component: ({ props }) => {
    const f = useField<string>(props.name, props.value, props.rules);
    const lk = useLocked(props.name);
    return (
      <Textarea id={f.name} name={f.name} rows={props.rows || 3} placeholder={lk ? "" : props.placeholder || ""} value={lk ? String(lk.v ?? "") : f.value ?? ""} readOnly={!!lk} className={FIELD_W}
        style={{ minHeight: `${(props.rows || 3) * 1.5 + 1}rem` }} aria-invalid={f.invalid || undefined} disabled={f.disabled}
        onFocus={f.clear} onChange={(e) => (f.set(e.target.value, false), f.clear())} onBlur={(e) => f.validate(e.target.value)} />
    );
  },
});

// ---------- 选择 ----------
const FIELD_W = "max-w-3xl";

/**
 * 票卡（单选 RadioGroup / 多选 CheckBoxGroup 共用）：竖排选项行（字母方块、名称、说明）。
 * 选中 = 2px 主色描边 + 主色浅底、字母方块实色；已提交锁定后选中项加「你投的」标签、其余置灰（data-dim）；
 * 已提交或截止且有结果数据时，选项行从左侧按得票比例涨出填充并显示票数、百分比、领先。
 * 结果首次出现（刚提交）时整组沿 Y 轴翻面 500ms 露出结果；减少动态时直接切换。
 */
function Tickets({ field, items, isOn, control, locked, multi }: {
  field: string; items: Record<string, unknown>[]; isOn: (v: string) => boolean; multi?: boolean; locked: boolean;
  /** 每项的输入控件（Radix radio / checkbox，视觉隐藏，承担键盘与读屏） */
  control: (it: Record<string, unknown>, i: number, id: string, label: string) => ReactNode;
}) {
  const uid = useId();
  const sub = useContext(SubmitContext);
  const t = sub?.tally?.[field] ?? null;
  const show = useFlip(!!t);
  const [scope] = show;
  const res = show[1] ? t : null;
  const rows = true;
  const max = res ? Math.max(0, ...Object.values(res.counts)) : 0;
  return (
    <div ref={scope} className={cn("tickets grid min-w-0 gap-2.5", rows ? "grid-cols-1" : "grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))]")}
>
      {items.map((it, i) => {
        const id = `${uid}-${i}`;
        const v = String((multi ? it.name : it.value) ?? "");
        const label = String(it.label ?? "");
        const [letter, name] = splitLetter(label, i);
        const on = isOn(v);
        const dim = locked && !on;
        const c = res?.counts[v] ?? 0;
        const pct = res && res.total ? Math.round((c / res.total) * 100) : 0;
        const lead = !!res && c > 0 && c === max;
        return (
          <label key={i} htmlFor={id} data-on={on || undefined} data-dim={dim || undefined} data-ticket=""
            className={cn(
              "ticket relative isolate flex cursor-pointer overflow-hidden rounded-[14px] bg-card transition-[background-color,border-color,opacity,scale] has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/80 active:scale-[.99]",
              rows ? "min-h-[68px] items-center gap-4 px-4 py-3" : "min-h-[220px] flex-col px-5 py-4.5 max-sm:min-h-[150px]",
              on ? "border-2 border-primary bg-primary-soft" : "border-[1.5px] border-border hover:border-input",
              dim && "opacity-50",
            )}>
            {res && (
              <span aria-hidden="true" className={cn("ticket-fill absolute -z-10", rows ? "inset-y-0 left-0 origin-left" : "inset-x-0 bottom-0 origin-bottom", on ? "bg-primary/10" : "bg-foreground/[0.05]")}
                style={rows ? { width: `${pct}%` } : { height: `${pct}%` }} />
            )}
            {control(it, i, id, label)}
            <span className={cn("grid size-10 shrink-0 place-items-center rounded-[11px] text-[16px] leading-none font-bold tabular-nums", on ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground")}>{letter}</span>
            <span className={cn("grid min-w-0 gap-0.5", rows ? "flex-1" : "mt-2.5")}>
              <span className={cn("leading-snug font-semibold [overflow-wrap:anywhere]", rows ? "text-[15px]" : "text-[18px]")}>{name}</span>
              {!!it.description && <span className="text-[13px] text-muted-foreground">{String(it.description)}</span>}
            </span>
            {res && (
              <span className={cn("ticket-num flex items-baseline gap-1.5 tabular-nums", rows ? "shrink-0" : "mt-auto pt-3")}>
                <b className={cn("leading-none font-semibold", rows ? "text-[22px]" : "text-[30px]", on && "text-primary")}>{c}</b>
                <span className="text-[13px] text-muted-foreground">票，{pct}%{lead && "，领先"}</span>
              </span>
            )}
            {on && locked && (
              <span className={cn("inline-flex items-center gap-[5px] rounded-full bg-primary px-2.5 py-[3px] text-[12px] font-semibold whitespace-nowrap text-primary-foreground", rows ? "shrink-0" : "absolute top-4 right-4")}>
                <Check className="size-3.5" strokeWidth={3} />{multi ? "你选的" : "你投的"}
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}

/** 结果出现：刚从无到有时（提交瞬间）整组翻面——前半程转到侧面，切换内容，后半程从另一侧转回；初次渲染或减少动态时直接显示 */
function useFlip(show: boolean) {
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const [shown, setShown] = useState(show);
  useEffect(() => {
    if (show === shown) return;
    // 不引 ui.tsx（check-examples 在 Node 里加载组件库）；在 effect 里读系统设置
    if (!show || !scope.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return setShown(show);
    animate(scope.current, { rotateY: [0, 90], transformPerspective: 2400 }, { duration: 0.25, ease: "easeIn" }).then(() => {
      setShown(true);
      if (scope.current) animate(scope.current, { rotateY: [-90, 0], transformPerspective: 2400 }, { duration: 0.25, ease: "easeOut" });
    });
  }, [show]); // eslint-disable-line react-hooks/exhaustive-deps
  return [scope, shown] as const;
}

export const SelectItem = defineComponent({
  name: "SelectItem",
  props: z.object({ value: z.string(), label: z.string() }),
  description: "Option for Select",
  component: () => null,
});

export const Select = defineComponent({
  name: "Select",
  props: z.object({
    name: z.string(),
    items: z.array(SelectItem.ref),
    placeholder: z.string().optional(),
    rules: rulesSchema,
    value: reactive(z.string().optional()),
    size: z.enum(["small", "medium", "large"]).optional(),
  }),
  description: "",
  component: ({ props }) => {
    const f = useField<string>(props.name, props.value, props.rules);
    const lk = useLocked(props.name);
    const items = itemsOf(props.items).filter((i) => i.value);
    return (
      <UISelect name={f.name} value={lk ? String(lk.v ?? "") : f.value ?? ""} onValueChange={(v) => f.set(v)} disabled={f.disabled}>
        <SelectTrigger id={f.name} size={props.size === "small" ? "sm" : "default"} aria-invalid={f.invalid || undefined}
          className={cn("w-full sm:max-w-xs", props.size === "large" && "h-10")}>
          <SelectValue placeholder={props.placeholder || "请选择"} />
        </SelectTrigger>
        <SelectContent>
          {items.map((i, k) => <UISelectItem key={k} value={String(i.value)}>{String(i.label || i.value)}</UISelectItem>)}
        </SelectContent>
      </UISelect>
    );
  },
});

export const RadioItem = defineComponent({
  name: "RadioItem",
  props: z.object({ label: z.string(), description: z.string(), value: z.string() }),
  description: "",
  component: () => null,
});

export const RadioGroup = defineComponent({
  name: "RadioGroup",
  props: z.object({
    name: z.string(),
    items: z.array(RadioItem.ref),
    defaultValue: z.string().optional(),
    rules: rulesSchema,
    value: reactive(z.string().optional()),
  }),
  description: "",
  component: ({ props }) => {
    const f = useField<string>(props.name, props.value, props.rules, props.defaultValue);
    const lk = useLocked(props.name);
    const items = itemsOf(props.items);
    if (!items.length) return null;
    const value = lk ? String(lk.v ?? "") : f.value ?? props.defaultValue ?? "";
    return (
      <UIRadioGroup name={f.name} value={value} onValueChange={(v) => f.set(v)} disabled={f.disabled} className="block min-w-0" aria-invalid={f.invalid || undefined}>
        <Tickets field={props.name} items={items} isOn={(v) => value === v} locked={!!lk}
          control={(it, _i, id, label) => <RadioGroupItem id={id} value={String(it.value ?? "")} aria-label={label} className="sr-only" />} />
      </UIRadioGroup>
    );
  },
});

export const CheckBoxItem = defineComponent({
  name: "CheckBoxItem",
  props: z.object({ label: z.string(), description: z.string(), name: z.string(), defaultChecked: z.boolean().optional() }),
  description: "",
  component: () => null,
});

/** CheckBoxGroup / SwitchGroup 的值：{ 子项 name: 是否勾选 }，包含所有子项（与原库一致） */
function useAggregate(f: { value: Record<string, boolean> | undefined }, items: Record<string, unknown>[]) {
  return useCallback(() => {
    const out: Record<string, boolean> = {};
    for (const it of items) out[String(it.name)] = f.value?.[String(it.name)] ?? (it.defaultChecked as boolean | undefined) ?? false;
    return out;
  }, [f.value, items]);
}

export const CheckBoxGroup = defineComponent({
  name: "CheckBoxGroup",
  props: z.object({
    name: z.string(),
    items: z.array(CheckBoxItem.ref),
    rules: rulesSchema,
    value: reactive(z.record(z.string(), z.boolean()).optional()),
  }),
  description: "",
  component: ({ props }) => {
    const items = useMemo(() => itemsOf(props.items), [props.items]);
    const f = useField<Record<string, boolean>>(props.name, props.value, props.rules, checkedDefault(items));
    const aggregate = useAggregate(f, items);
    const lk = useLocked(props.name);
    if (!items.length) return null;
    const cur = lk ? (lk.v && typeof lk.v === "object" ? (lk.v as Record<string, boolean>) : {}) : aggregate();
    return (
      <Tickets field={props.name} items={items} isOn={(n) => !!cur[n]} locked={!!lk} multi
        control={(it, _i, id, label) => {
          const n = String(it.name);
          return <Checkbox id={id} checked={!!cur[n]} disabled={f.disabled} aria-label={label} className="sr-only"
            onCheckedChange={(c) => f.set({ ...aggregate(), [n]: c === true })} />;
        }} />
    );
  },
});

export const SwitchItem = defineComponent({
  name: "SwitchItem",
  props: z.object({
    label: z.string().optional(),
    description: z.string().optional(),
    name: z.string(),
    defaultChecked: z.boolean().optional(),
  }),
  description: "Individual switch toggle",
  component: () => null,
});

export const SwitchGroup = defineComponent({
  name: "SwitchGroup",
  props: z.object({
    name: z.string(),
    items: z.array(SwitchItem.ref),
    variant: z.enum(["clear", "card", "sunk"]).optional(),
    value: reactive(z.record(z.string(), z.boolean()).optional()),
  }),
  description: "Group of switch toggles",
  component: ({ props }) => {
    const uid = useId();
    const items = useMemo(() => itemsOf(props.items), [props.items]);
    const f = useField<Record<string, boolean>>(props.name, props.value, undefined, checkedDefault(items));
    const aggregate = useAggregate(f, items);
    const lk = useLocked(props.name);
    if (!items.length) return null;
    const cur = lk ? (lk.v && typeof lk.v === "object" ? (lk.v as Record<string, boolean>) : {}) : aggregate();
    const box = props.variant === "card" ? "rounded-lg border bg-card" : props.variant === "sunk" ? "rounded-lg bg-muted/60" : "";
    return (
      <div className={cn("divide-y", box, box && "px-3.5")}>
        {items.map((it, i) => {
          const id = `${uid}-${i}`;
          const n = String(it.name);
          return (
            <div key={i} className="flex items-center justify-between gap-4 py-3">
              <label htmlFor={id} className="grid cursor-pointer gap-0.5">
                <span className="text-sm font-medium">{String(it.label ?? n)}</span>
                {!!it.description && <span className="text-[13px] text-muted-foreground">{String(it.description)}</span>}
              </label>
              <Switch id={id} checked={!!cur[n]} disabled={f.disabled} onCheckedChange={(c) => f.set({ ...aggregate(), [n]: c })} />
            </div>
          );
        })}
      </div>
    );
  },
});

export const ChipItem = defineComponent({
  name: "ChipItem",
  props: z.object({
    value: z.string(),
    label: z.string(),
    icon: z.optional(Icon.ref),
    disabled: z.boolean().optional(),
  }),
  description: "A single selectable chip inside a Chips group, with a value, label and optional icon.",
  component: () => null,
});

export const Chips = defineComponent({
  name: "Chips",
  props: z.object({
    name: z.string(),
    type: z.enum(["single", "multiple"]).default("multiple"),
    items: z.array(ChipItem.ref).default([]),
    rules: rulesSchema,
    defaultValue: z.union([z.string(), z.array(z.string())]).optional(),
  }),
  description: "A form field of compact selectable chips for choosing one or many short options; the selection is stored under `name`.",
  component: ({ props }) => {
    const formName = useFormName();
    const getFieldValue = useGetFieldValue();
    const setFieldValue = useSetFieldValue();
    const streaming = useIsStreaming();
    const fv = useFormValidation();
    const type = props.type ?? "multiple";
    const rules = useMemo(() => parseStructuredRules(props.rules as never), [props.rules]);
    const items = itemsOf(props.items).filter((i) => i.value);
    const stored = getFieldValue(formName, props.name);
    const def = type === "single"
      ? (Array.isArray(props.defaultValue) ? props.defaultValue[0] : props.defaultValue)
      : (props.defaultValue == null ? undefined : asArray(props.defaultValue).map(String));
    const lk = useLocked(props.name);
    const raw = lk ? lk.v : stored ?? def;
    const selection: string[] = raw == null || raw === "" ? [] : asArray(raw).map(String);

    // 默认值在流式结束后写入表单状态（用户未选时），提交时能带上
    useEffect(() => {
      if (!streaming && stored === undefined && def !== undefined) setFieldValue(formName, "Chips", props.name, def, false);
    }, [streaming, stored, JSON.stringify(def), formName, props.name]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
      if (streaming || !rules.length || !fv) return;
      fv.registerField(props.name, rules, () => {
        const v = getFieldValue(formName, props.name) ?? def;
        return type === "single" ? (typeof v === "string" && v ? v : undefined) : Array.isArray(v) && v.length ? v : undefined;
      });
      return () => fv.unregisterField(props.name);
    }, [props.name, formName, fv, getFieldValue, streaming, rules, type]); // eslint-disable-line react-hooks/exhaustive-deps

    const toggle = (v: string) => {
      if (streaming) return;
      const next = type === "single" ? (selection.includes(v) ? [] : [v]) : selection.includes(v) ? selection.filter((x) => x !== v) : [...selection, v];
      const value = type === "single" ? next[0] : next;
      setFieldValue(formName, "Chips", props.name, value, true);
      if (rules.length) fv?.validateField(props.name, type === "single" ? next[0] : next.length ? next : undefined, rules);
    };

    return (
      <div role={type === "single" ? "radiogroup" : "group"} className="flex flex-wrap gap-2" aria-invalid={!!fv?.errors[props.name] || undefined}>
        {items.map((it, i) => {
          const v = String(it.value);
          const on = selection.includes(v);
          const ic = it.icon as { props?: { name?: string; category?: string } } | undefined;
          return (
            <button key={i} type="button" role={type === "single" ? "radio" : "checkbox"} aria-checked={on}
              disabled={streaming || it.disabled === true} onClick={() => toggle(v)}
              className={cn(
                "inline-flex h-9 items-center gap-1.5 rounded-full border bg-card px-3.5 text-sm font-semibold transition-[background-color,border-color,box-shadow,scale,opacity,filter] outline-none hover:border-primary/50 focus-visible:ring-[3px] focus-visible:ring-ring/80 active:scale-[.97] disabled:opacity-50",
                on && "border-primary bg-primary/10 shadow-[inset_0_0_0_0.5px_var(--primary)] hover:border-primary",
                lk && !on && DIM,
              )}>
              {on && <Check className="-ml-1 size-4 text-primary animate-in zoom-in-50 fade-in-0 duration-150 ease-pop" strokeWidth={3} aria-hidden="true" />}
              {ic?.props?.name && <LucideIcon name={ic.props.name} category={ic.props.category} className="size-3.5" />}
              {String(it.label ?? v)}
            </button>
          );
        })}
      </div>
    );
  },
});

export const Slider = defineComponent({
  name: "Slider",
  props: z.object({
    name: z.string(),
    variant: z.enum(["continuous", "discrete"]),
    min: z.number(),
    max: z.number(),
    step: z.number().optional(),
    defaultValue: z.array(z.number()).optional(),
    label: z.string().optional(),
    rules: rulesSchema,
    value: reactive(z.array(z.number()).optional()),
  }),
  description: "Numeric slider input; supports continuous and discrete (stepped) variants",
  component: ({ props }) => {
    const f = useField<number[]>(props.name, props.value, props.rules, props.defaultValue);
    const [dragging, setDragging] = useState(false);
    const lk = useLocked(props.name);
    const value = (lk && Array.isArray(lk.v) ? (lk.v as number[]) : undefined) ?? f.value ?? props.defaultValue ?? [props.min];
    const step = props.step ?? (props.variant === "discrete" ? Math.max(1, (props.max - props.min) / 10) : 1);
    return (
      <div className="grid gap-3">
        <div className="flex items-baseline justify-between text-[13px]">
          <span className="text-muted-foreground">{props.label}</span>
          {/* 拖动时数值变主色并略放大 */}
          <span className={cn("origin-right text-base font-bold tabular-nums transition-[color,scale]", dragging && "scale-110 text-primary")}>{value.join(" – ")}</span>
        </div>
        <UISlider name={f.name} min={props.min} max={props.max} step={step} value={value} disabled={f.disabled}
          onValueChange={(v) => (setDragging(true), f.set(v, false))} onValueCommit={(v) => (setDragging(false), f.validate(v[0]))}
          onPointerUp={() => setDragging(false)} onBlur={() => setDragging(false)} />
        <div className="flex justify-between text-xs text-muted-foreground tabular-nums"><span>{props.min}</span><span>{props.max}</span></div>
      </div>
    );
  },
});

export const DatePicker = defineComponent({
  name: "DatePicker",
  props: z.object({
    name: z.string(),
    mode: z.enum(["single", "range"]).optional(),
    rules: rulesSchema,
    value: reactive(z.unknown().optional()),
  }),
  description: "",
  component: ({ props }) => {
    const f0 = useField<unknown>(props.name, props.value, props.rules);
    const lk = useLocked(props.name);
    const f = lk ? { ...f0, value: lk.v } : f0;
    const cls = "w-full sm:w-44 [&::-webkit-calendar-picker-indicator]:opacity-60 dark:[color-scheme:dark]";
    if (props.mode === "range") {
      const r = (f.value ?? {}) as { from?: string; to?: string };
      const set = (k: "from" | "to", v: string) => {
        const next = { ...r, [k]: v || undefined };
        f.set(next.from || next.to ? next : undefined);
      };
      return (
        <div className="flex flex-wrap items-center gap-2">
          <UIInput type="date" id={f.name} aria-label="开始日期" className={cls} value={r.from ?? ""} max={r.to} disabled={f.disabled}
            aria-invalid={f.invalid || undefined} onChange={(e) => set("from", e.target.value)} />
          <span className="text-muted-foreground">–</span>
          <UIInput type="date" aria-label="结束日期" className={cls} value={r.to ?? ""} min={r.from} disabled={f.disabled}
            aria-invalid={f.invalid || undefined} onChange={(e) => set("to", e.target.value)} />
        </div>
      );
    }
    return (
      <UIInput type="date" id={f.name} className={cls} value={typeof f.value === "string" ? f.value : ""} disabled={f.disabled}
        aria-invalid={f.invalid || undefined} onChange={(e) => f.set(e.target.value || undefined)} />
    );
  },
});

export const Label = defineComponent({
  name: "Label",
  props: z.object({ text: z.string() }),
  description: "Text label",
  component: ({ props }) => <UILabel>{props.text}</UILabel>,
});

export const FormControl = defineComponent({
  name: "FormControl",
  props: z.object({
    label: z.string(),
    input: z.union([Input.ref, TextArea.ref, Select.ref, DatePicker.ref, Slider.ref, CheckBoxGroup.ref, RadioGroup.ref, Chips.ref]),
    hint: z.string().optional(),
  }),
  description: "Field with label, input component, and optional hint text",
  component: ({ props, renderNode }) => {
    const fv = useFormValidation();
    const input = props.input as { type?: string; props?: { name?: unknown; rules?: { required?: boolean } } } | undefined;
    const raw = input?.type === "element" ? input.props?.name : undefined;
    const name = typeof raw === "object" && raw && "name" in raw ? String((raw as { name: unknown }).name) : (raw as string | undefined);
    const error = name ? fv?.errors[name] : undefined;
    const required = input?.props?.rules?.required === true;
    return (
      <div className="grid gap-2">
        <UILabel htmlFor={name} className="text-sm font-semibold">
          {props.label}{required && <span className="text-destructive" aria-hidden="true">*</span>}
        </UILabel>
        {renderNode(props.input)}
        {error ? (
          <p className="flex items-center gap-1.5 text-[13px] text-destructive"><CircleAlert className="size-3.5" />{zhError(error)}</p>
        ) : props.hint ? <p className="text-[13px] text-muted-foreground">{props.hint}</p> : null}
      </div>
    );
  },
});

// ---------- 按钮 ----------
/** 提交反馈：OpenUIView 提供状态，触发这次提交的按钮（owner）显示 提交中 spinner → 「已提交 ✓」，失败时抖动并标红 */
export type SubmitState = { phase: "idle" | "busy" | "done" | "error"; owner: string | null; n: number; error?: string };
/** locked：已提交（当前看的版本），values 为提交数据里的 values，version 为该版本号 */
export type Locked = { values: Record<string, unknown>; version: number };
/** tally：票卡显示的结果（已提交或截止且结果对我可见时才有） */
export const SubmitContext = createContext<{ state: SubmitState; claim: (id: string) => void; readOnly?: boolean; locked?: Locked | null; tally?: Tally | null } | null>(null);

/** 重新触发一次抖动动画（连续失败也能看到） */
function shake(el: HTMLElement | null) {
  if (!el) return;
  el.classList.remove("shake");
  void el.offsetWidth;
  el.classList.add("shake");
}

const BTN_VARIANT = { primary: "default", secondary: "outline", tertiary: "ghost" } as const;
const BTN_SIZE = { "extra-small": "xs", small: "sm", medium: "default", large: "lg" } as const;

export const Button = defineComponent({
  name: "Button",
  props: z.object({
    label: z.string(),
    action: action().optional(),
    variant: z.enum(["primary", "secondary", "tertiary"]).optional(),
    type: z.enum(["normal", "destructive"]).optional(),
    size: z.enum(["extra-small", "small", "medium", "large"]).optional(),
  }),
  description: "Clickable button",
  component: ({ props }) => {
    const trigger = useTriggerAction();
    const formName = useFormName();
    const streaming = useIsStreaming();
    const fv = useFormValidation();
    const sub = useContext(SubmitContext);
    const id = useId();
    const ref = useRef<HTMLButtonElement>(null);
    const phase = sub?.state.owner === id ? sub.state.phase : "idle";
    useEffect(() => {
      if (phase === "error") shake(ref.current);
      // 回到空闲/失败时解除宽度锁定
      if ((phase === "idle" || phase === "error") && ref.current) ref.current.style.minWidth = "";
    }, [phase, sub?.state.n]);
    const variant = props.variant || "primary";
    const destructive = props.type === "destructive";
    const act = props.action as { steps?: { type: string; refType?: string }[] } | undefined;
    const submits = !act?.steps || act.steps.some((s) => s.type === ACTION_STEPS.ToAssistant);
    // 已提交：提交按钮固定为「✓ 已提交（第 N 版）」，不可再点；刚提交时带一圈柔光
    if (sub?.locked && submits)
      return (
        <UIButton type="button" size={BTN_SIZE[props.size ?? "medium"]} aria-disabled tabIndex={-1} data-locked=""
          variant={BTN_VARIANT[variant]} className={cn("pointer-events-none", phase === "done" && "submit-glow")}>
          <span key="locked" className="inline-flex items-center gap-2 animate-in fade-in-0"><Check strokeWidth={3} className="check-draw" />已提交（第 {sub.locked.version} 版）</span>
        </UIButton>
      );
    // 只读页面：会触发提交的按钮（@ToAssistant 或缺省动作）不渲染，open_url 等照常
    if (sub?.readOnly && submits) return null;
    return (
      <>
      <UIButton ref={ref} type="button" size={BTN_SIZE[props.size ?? "medium"]}
        disabled={streaming} loading={phase === "busy"} aria-invalid={phase === "error" || undefined}
        aria-disabled={phase === "done" || undefined} className={cn(phase === "done" && "submit-glow pointer-events-none")}
        onAnimationEnd={(e) => e.currentTarget.classList.remove("shake")}
        variant={destructive ? (variant === "primary" ? "destructive" : "ghost-destructive") : BTN_VARIANT[variant]}
        onClick={() => {
          if (phase === "done") return;
          // 主按钮触发提交前先校验表单（与原库一致）
          if (fv && variant === "primary") {
            const needs = act?.steps
              ? act.steps.some((s) => s.type === ACTION_STEPS.ToAssistant || s.type === "custom_action" || (s.type === ACTION_STEPS.Run && s.refType === "mutation"))
              : true;
            if (needs && !fv.validateForm()) return shake(ref.current);
          }
          // 锁定宽度：提交中 / 已提交时按钮不跳宽
          if (sub && ref.current) ref.current.style.minWidth = `${ref.current.offsetWidth}px`;
          sub?.claim(id);
          trigger(props.label, formName, act as never);
        }}>
        {/* 状态切换时内容交叉淡入（key 变化重新挂载） */}
        <span key={phase} className={cn("inline-flex items-center gap-2", phase !== "idle" && "animate-in fade-in-0 slide-in-from-bottom-1")}>
          {phase === "done" ? <><Check strokeWidth={3} className="check-draw" />已提交</> : props.label}
        </span>
      </UIButton>
      {phase === "error" && sub?.state.error && (
        <span role="alert" className="flex items-center gap-1.5 text-[13px] text-destructive animate-in fade-in-0">
          <CircleAlert className="size-3.5 shrink-0" />{sub.state.error}
        </span>
      )}
      </>
    );
  },
});

export const Buttons = defineComponent({
  name: "Buttons",
  props: z.object({ buttons: z.array(Button.ref), direction: z.enum(["row", "column"]).optional() }),
  description: 'Group of Button components. direction: "row" (default) | "column".',
  component: ({ props, renderNode }) => (
    <div className={cn("flex gap-2", props.direction === "column" ? "flex-col items-stretch" : "flex-wrap items-center max-sm:*:flex-1")}>{renderNode(props.buttons)}</div>
  ),
});

export const Form = defineComponent({
  name: "Form",
  props: z.object({ name: z.string(), buttons: Buttons.ref, fields: z.array(FormControl.ref).default([]) }),
  description: "Form container with fields and explicit action buttons",
  component: ({ props, renderNode }) => {
    const validation = useCreateFormValidation();
    // 不在卡片里时自成一张承托卡片（控件宽度由各字段自己限制）
    const inside = useContext(InSurface);
    const sub = useContext(SubmitContext);
    const readOnly = !!sub?.readOnly;
    const locked = !!sub?.locked;
    return (
      <FormValidationContext.Provider value={validation}>
        <FormNameContext.Provider value={props.name}>
          <InSurface.Provider value>
            <div role="form" className={cn("flex flex-col gap-5", !inside && "surface p-5 sm:p-6")}>
              {/* 只读页面：字段禁用；已提交：inert 屏蔽交互但不套禁用样式（选中项保持高亮，未选项由各字段置灰） */}
              <fieldset disabled={readOnly && !locked} inert={locked} data-locked={locked || undefined} className="contents">{renderNode(props.fields)}</fieldset>
              <div className="pt-1">{renderNode(props.buttons)}</div>
            </div>
          </InSurface.Provider>
        </FormNameContext.Provider>
      </FormValidationContext.Provider>
    );
  },
});
