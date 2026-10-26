// 内容与数据展示组件。schema（组件名、参数顺序、枚举值）与 @openuidev/react-ui 的 openuiLibrary 保持一致，
// agent 写的 Lang 与 MCP 校验规则不变；渲染换成 shadcn/ui。
import { useEffect, useState, type ReactNode } from "react";
import { defineComponent, reactive, useStateField } from "@openuidev/react-lang";
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";
import { CircleAlert, CircleCheck, Info, TriangleAlert, ChevronLeft, ChevronRight, TrendingDown, TrendingUp } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator as UISeparator } from "@/components/ui/separator";
import { Table as UITable, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { asArray, CountUp, Surface } from "./util";

export function Md({ text, className }: { text: string; className?: string }) {
  return <div className={cn("md", className)}><Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown></div>;
}

// ---------- 文本 ----------
const TEXT_SIZE = {
  small: "text-[13px] text-muted-foreground",
  default: "",
  large: "text-base",
  "small-heavy": "text-[13px] font-semibold",
  "large-heavy": "text-[22px] font-bold [&_p]:leading-snug",
} as const;

export const TextContent = defineComponent({
  name: "TextContent",
  props: z.object({
    text: z.string(),
    size: z.enum(["small", "default", "large", "small-heavy", "large-heavy"]).optional(),
  }),
  description: 'Text block. Supports markdown. Optional size: "small" | "default" | "large" | "small-heavy" | "large-heavy".',
  component: ({ props }) => <Md text={props.text == null ? "" : String(props.text)} className={TEXT_SIZE[props.size ?? "default"]} />,
});

const SURFACE = { clear: "", card: "surface rounded-lg p-4", sunk: "rounded-lg bg-muted/70 p-4" } as const;

export const MarkDownRenderer = defineComponent({
  name: "MarkDownRenderer",
  props: z.object({
    textMarkdown: z.string(),
    variant: z.enum(["clear", "card", "sunk"]).optional(),
  }),
  description: "Renders markdown text with optional container variant",
  component: ({ props }) => <Md text={String(props.textMarkdown ?? "")} className={SURFACE[props.variant ?? "clear"]} />,
});

export const CardHeader = defineComponent({
  name: "CardHeader",
  props: z.object({ title: z.string().optional(), subtitle: z.string().optional() }),
  description: "Header with optional title and subtitle",
  component: ({ props }) => (
    <div className="flex flex-col gap-1">
      {props.title && <h3 className="text-base leading-snug font-bold">{props.title}</h3>}
      {props.subtitle && <p className="text-[13px] text-muted-foreground">{props.subtitle}</p>}
    </div>
  ),
});

// ---------- 提示 ----------
type Tone = "neutral" | "info" | "success" | "warning" | "danger";
const TONE_ALERT = { neutral: "default", info: "info", success: "success", warning: "warning", danger: "destructive" } as const;
const TONE_ICON = { neutral: Info, info: Info, success: CircleCheck, warning: TriangleAlert, danger: CircleAlert };

function Notice({ tone, title, description }: { tone: Tone; title?: string; description?: string }) {
  const Ico = TONE_ICON[tone];
  return (
    <Alert variant={TONE_ALERT[tone]}>
      <Ico />
      {title && <AlertTitle className="line-clamp-none">{title}</AlertTitle>}
      {description && <AlertDescription><Md text={description} className="text-[13px]" /></AlertDescription>}
    </Alert>
  );
}

export const Callout = defineComponent({
  name: "Callout",
  props: z.object({
    variant: z.enum(["info", "warning", "error", "success", "neutral"]),
    title: z.string(),
    description: z.string(),
    visible: reactive(z.boolean().optional()),
  }),
  description: "Callout banner. Optional visible is a reactive $boolean — auto-dismisses after 3s by setting $visible to false.",
  component: ({ props }) => {
    const field = useStateField("visible", props.visible);
    const bound = field.isReactive;
    const visible = bound ? field.value === true || (field.value as unknown) === "true" : true;
    useEffect(() => {
      if (!bound || !visible) return;
      const t = setTimeout(() => field.setValue(false), 3000);
      return () => clearTimeout(t);
    }, [bound, visible, field]);
    if (!visible) return null;
    const tone: Tone = props.variant === "error" ? "danger" : (props.variant ?? "info");
    return <Notice tone={tone} title={props.title} description={props.description} />;
  },
});

export const TextCallout = defineComponent({
  name: "TextCallout",
  props: z.object({
    variant: z.enum(["neutral", "info", "warning", "success", "danger"]).optional(),
    title: z.string().optional(),
    description: z.string().optional(),
  }),
  description: "Text callout with variant, title, and description",
  component: ({ props }) => <Notice tone={props.variant ?? "neutral"} title={props.title} description={props.description} />,
});

// ---------- 图片、分隔 ----------
export const Image = defineComponent({
  name: "Image",
  props: z.object({ alt: z.string(), src: z.string().optional() }),
  description: "Image with alt text and optional URL",
  component: ({ props }) => {
    const ok = !!props.src && /^https?:\/\//i.test(props.src);
    if (!ok) return <div className="grid aspect-video place-items-center rounded-lg bg-muted text-xs text-muted-foreground">{props.alt}</div>;
    return <img src={props.src} alt={props.alt} loading="lazy" referrerPolicy="no-referrer" className="max-h-[480px] w-full rounded-lg border object-cover" />;
  },
});

export const Separator = defineComponent({
  name: "Separator",
  props: z.object({
    orientation: z.enum(["horizontal", "vertical"]).optional(),
    decorative: z.boolean().optional(),
  }),
  description: "Visual divider between content sections",
  component: ({ props }) => <UISeparator orientation={props.orientation ?? "horizontal"} decorative={props.decorative ?? true}
    className={props.orientation === "vertical" ? "self-stretch !h-auto" : ""} />,
});

// ---------- 图标、标签 ----------
const CATEGORY_FALLBACK: Record<string, IconName> = {
  account: "user", arrows: "arrow-right", buildings: "building", charts: "chart-line", communication: "message-square",
  design: "palette", development: "code", devices: "smartphone", files: "file", finance: "dollar-sign", home: "house",
  mail: "mail", medical: "heart-pulse", multimedia: "music", nature: "tree-pine", navigation: "map-pin",
  notifications: "bell", people: "users", security: "shield", shapes: "circle", shopping: "shopping-cart",
  text: "type", time: "clock", tools: "wrench", travel: "plane", weather: "cloud",
};
const ICONS = new Set<string>(iconNames);

export function LucideIcon({ name, category, className }: { name?: string; category?: string; className?: string }) {
  const n = String(name ?? "").trim().toLowerCase();
  const resolved = (ICONS.has(n) ? n : CATEGORY_FALLBACK[String(category ?? "").trim().toLowerCase()] ?? "circle-dot") as IconName;
  return <DynamicIcon name={resolved} className={cn("size-4", className)} aria-hidden="true" />;
}

const iconProps = z.object({
  name: z.string().describe("lucide-react icon name in kebab-case (e.g. 'circle-check', 'rocket')."),
  category: z.string().optional()
    .describe("Optional icon category (e.g. 'finance', 'charts', 'security', 'travel', 'people', 'time') used to pick a topical fallback icon when `name` doesn't resolve."),
});

export const Icon = defineComponent({
  name: "Icon",
  props: iconProps,
  description: "A lucide icon by kebab-case name (e.g. 'circle-check'). Optional category picks a topical fallback when the name doesn't resolve.",
  component: ({ props }) => (props.name ? <LucideIcon name={props.name} category={props.category} /> : null),
});

type Node = { type?: string; props?: Record<string, unknown> } | null | undefined;
const nodeProps = (n: unknown) => ((n as Node)?.props ?? {}) as Record<string, unknown>;

const TONE_BADGE = { neutral: "secondary", info: "info", success: "success", warning: "warning", danger: "destructive" } as const;
const TAG_SIZE = { sm: "", md: "px-2.5 py-1 text-[13px]", lg: "px-3 py-1 text-sm" } as const;

export const Tag = defineComponent({
  name: "Tag",
  props: z.object({
    text: z.string(),
    icon: z.optional(Icon.ref),
    size: z.enum(["sm", "md", "lg"]).optional(),
    variant: z.enum(["neutral", "info", "success", "warning", "danger"]).optional(),
  }),
  description: "Styled tag/badge with optional Icon and variant",
  component: ({ props }) => {
    const ic = nodeProps(props.icon);
    return (
      <Badge variant={TONE_BADGE[props.variant ?? "neutral"]} className={TAG_SIZE[props.size ?? "sm"]}>
        {typeof ic.name === "string" && <LucideIcon name={ic.name} category={ic.category as string} className="size-3" />}
        {props.text}
      </Badge>
    );
  },
});

export const TagBlock = defineComponent({
  name: "TagBlock",
  props: z.object({ tags: z.array(z.string()), size: z.enum(["sm", "md", "lg"]).optional() }),
  description: "tags is an array of strings; optional size sm | md | lg",
  component: ({ props }) => (
    <div className="flex flex-wrap gap-1.5">
      {asArray(props.tags).map((t, i) => <Badge key={i} variant="secondary" className={TAG_SIZE[props.size ?? "sm"]}>{String(t)}</Badge>)}
    </div>
  ),
});

// ---------- 步骤 ----------
export const StepsItem = defineComponent({
  name: "StepsItem",
  props: z.object({ title: z.string(), details: z.string() }),
  description: "title and details text for one step",
  component: () => null,
});

export const Steps = defineComponent({
  name: "Steps",
  props: z.object({ items: z.array(StepsItem.ref) }),
  description: "Step-by-step guide",
  component: ({ props }) => (
    <ol className="flex flex-col">
      {asArray(props.items).map((it, i, all) => {
        const p = nodeProps(it);
        return (
          <li key={i} className="relative flex gap-3 pb-5 last:pb-0">
            {i < all.length - 1 && <span aria-hidden="true" className="absolute top-7 bottom-1 left-[11px] w-px bg-border" />}
            <span className="grid size-6 shrink-0 place-items-center rounded-full border bg-background text-xs font-medium tabular-nums">{i + 1}</span>
            <div className="min-w-0 pt-0.5">
              <div className="text-sm font-medium">{String(p.title ?? "")}</div>
              {p.details != null && <Md text={String(p.details)} className="mt-1 text-[13px] text-muted-foreground" />}
            </div>
          </li>
        );
      })}
    </ol>
  ),
});

// ---------- 表格 ----------
export const Col = defineComponent({
  name: "Col",
  props: z.object({
    /** Column header label */
    label: z.string(),
    /** Column data — array of values or components (one per row). Use array pluck for text, Each() for styled cells like Tag. */
    data: z.any(),
    /** Optional display type hint */
    type: z.enum(["string", "number", "action"]).optional(),
  }),
  description: "Column definition — holds label + data array",
  component: () => null,
});

const PAGE_SIZE = 10;

export const Table = defineComponent({
  name: "Table",
  props: z.object({ columns: z.array(Col.ref) }),
  description: "Data table — column-oriented. Each Col holds its own data array.",
  component: ({ props, renderNode }) => {
    const [page, setPage] = useState(0);
    const cols = asArray(props.columns).map(nodeProps).filter((c) => c.label != null)
      .map((c) => ({ label: String(c.label), data: asArray(c.data), num: c.type === "number" }));
    if (!cols.length) return null;
    const rows = Math.max(...cols.map((c) => c.data.length), 0);
    const pages = Math.max(1, Math.ceil(rows / PAGE_SIZE));
    const cur = Math.min(page, pages - 1);
    const start = cur * PAGE_SIZE;
    return (
      <Surface className="overflow-hidden" plain="overflow-hidden rounded-lg border">
        <UITable>
          <TableHeader className="bg-muted/40">
            <TableRow className="hover:bg-transparent">
              {cols.map((c, i) => <TableHead key={i} className={cn("px-3", c.num && "text-right")}>{c.label}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: Math.min(PAGE_SIZE, rows - start) }, (_, k) => start + k).map((r) => (
              <TableRow key={r}>
                {cols.map((c, i) => {
                  const cell = c.data[r];
                  return (
                    <TableCell key={i} className={cn("px-3", c.num && "text-right tabular-nums")}>
                      {typeof cell === "object" && cell !== null ? renderNode(cell) : String(cell ?? "")}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </UITable>
        {pages > 1 && (
          <div className="flex items-center justify-end gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
            <span className="tabular-nums">{cur + 1} / {pages}</span>
            <Button variant="outline" size="icon-sm" aria-label="上一页" disabled={cur === 0} onClick={() => setPage(cur - 1)}><ChevronLeft /></Button>
            <Button variant="outline" size="icon-sm" aria-label="下一页" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}><ChevronRight /></Button>
          </div>
        )}
      </Surface>
    );
  },
});

// ---------- 卡片块（KPI） ----------
// Text / BoldText 各用一个 schema 对象（defineComponent 按对象打组件名标签）
const lineSchema = () => z.object({
  variant: z.enum(["text", "number"]).default("text"),
  value: z.string(),
  subtext: z.string().optional(),
  subtextVariant: z.enum(["text", "number", "metric"]).default("text"),
  size: z.enum(["xs", "sm", "md", "lg"]).default("sm"),
});
type LineProps = z.infer<ReturnType<typeof lineSchema>>;
const LINE_SIZE = { xs: "text-xs", sm: "text-sm", md: "text-base", lg: "text-xl" } as const;

function metricTone(s: string) {
  const t = s.trim();
  // metric 涨跌用浅底胶囊（文字色在 12% 浅底上 ≥ 4.5:1）
  return t.startsWith("+") ? "bg-success/12 text-success" : t.startsWith("-") || t.startsWith("−") ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground";
}

function Line({ p, bold }: { p: Partial<LineProps>; bold: boolean }) {
  const num = p.variant === "number";
  return (
    <div className="flex min-w-0 flex-col items-end gap-0.5 text-right">
      <span className={cn(LINE_SIZE[p.size ?? "sm"], bold && "font-bold", num && "tabular-nums", bold && num && p.size !== "xs" && "text-[22px] leading-tight")}>
        {num ? <CountUp value={String(p.value ?? "")} /> : String(p.value ?? "")}
      </span>
      {p.subtext && (
        <span className={cn("text-xs", p.subtextVariant === "metric" ? cn("rounded-full px-2 py-0.5 font-bold", metricTone(p.subtext)) : "text-muted-foreground", p.subtextVariant !== "text" && "tabular-nums")}>
          {p.subtext}
        </span>
      )}
    </div>
  );
}

export const Text = defineComponent({
  name: "Text",
  props: lineSchema(),
  description: "Plain text line with optional subtext. variant 'number' uses tabular number styling; subtextVariant 'metric' colors a leading +/- subtext green/red.",
  component: ({ props }) => <Line p={props} bold={false} />,
});

export const BoldText = defineComponent({
  name: "BoldText",
  props: lineSchema(),
  description: "Emphasized (bold) text line with optional subtext. variant 'number' uses tabular number styling; subtextVariant 'metric' colors a leading +/- subtext green/red.",
  component: ({ props }) => <Line p={props} bold />,
});

const ICON_TONE: Record<string, string> = {
  neutral: "bg-muted text-foreground", soft: "bg-muted text-foreground", info: "bg-info/12 text-info",
  success: "bg-success/12 text-success", warning: "bg-warning/15 text-warning", danger: "bg-destructive/10 text-destructive",
  inverted: "bg-foreground text-background", filled: "bg-primary text-primary-foreground",
};
const ICON_BOX: Record<string, string> = { xs: "size-6", s: "size-7", sm: "size-7", m: "size-8", md: "size-8", l: "size-10", lg: "size-10", xl: "size-12" };

export const IconText = defineComponent({
  name: "IconText",
  props: z.object({
    icon: Icon.ref,
    iconVariant: z.enum(["neutral", "info", "success", "warning", "danger", "inverted", "filled", "soft"]).default("neutral"),
    iconSize: z.enum(["xs", "s", "m", "l", "xl", "sm", "md", "lg"]).default("m"),
    title: z.string(),
    subtitle: z.string().optional(),
    bold: z.boolean().default(false),
    layout: z.enum(["horizontal", "vertical"]).default("horizontal"),
  }),
  description: "An icon badge with a title and optional subtitle, laid out horizontally or vertically. iconVariant sets the badge color.",
  component: ({ props }) => {
    const ic = nodeProps(props.icon);
    return (
      <div className={cn("flex min-w-0 gap-3", props.layout === "vertical" ? "flex-col items-start" : "items-center")}>
        <span className={cn("grid shrink-0 place-items-center rounded-md", ICON_BOX[props.iconSize ?? "m"], ICON_TONE[props.iconVariant ?? "neutral"])}>
          <LucideIcon name={ic.name as string} category={ic.category as string} />
        </span>
        <div className="min-w-0">
          <div className={cn("truncate text-sm", props.bold ? "font-semibold" : "font-medium")}>{props.title}</div>
          {props.subtitle && <div className="truncate text-xs text-muted-foreground">{props.subtitle}</div>}
        </div>
      </div>
    );
  },
});

const trendSchema = z.object({ direction: z.enum(["up", "down"]), value: z.number() });

export const MetricIndicatorInline = defineComponent({
  name: "MetricIndicatorInline",
  props: z.object({ value: z.string(), subtext: z.string().optional(), trend: trendSchema.optional() }),
  description: "Headline metric value with an optional +/- percentage trend and subtext, all on one line.",
  component: ({ props }) => {
    const t = props.trend as { direction?: string; value?: number } | undefined;
    const up = t?.direction === "up";
    return (
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <CountUp value={props.value} className="text-2xl font-semibold tracking-tight" />
        {t && typeof t.value === "number" && (
          <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium tabular-nums", up ? "text-success" : "text-destructive")}>
            {up ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}{t.value}%
          </span>
        )}
        {props.subtext && <span className="text-xs text-muted-foreground">{props.subtext}</span>}
      </div>
    );
  },
});

function CardGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(220px,1fr))]">{children}</div>;
}

export const SnippetCardItem = defineComponent({
  name: "SnippetCardItem",
  props: z.object({
    id: z.string().optional(),
    lhs: IconText.ref,
    rhs: z.union([Text.ref, BoldText.ref]).optional(),
  }),
  description: "One row-style snippet card: a label on the left (IconText) and an optional value on the right (Text or BoldText).",
  component: () => null,
});

export const SnippetCardBlock = defineComponent({
  name: "SnippetCardBlock",
  props: z.object({
    items: z.array(SnippetCardItem.ref).min(2),
    layout: z.enum(["grid"]).default("grid"),
    responsive: z.boolean().default(true),
    gap: z.union([z.number(), z.string()]).optional(),
  }),
  description: "A responsive grid of compact label/value cards for showing several short facts side by side.",
  component: ({ props, renderNode }) => (
    <CardGrid>
      {asArray(props.items).map((it, i) => {
        const p = nodeProps(it);
        return (
          <div key={i} className="surface flex items-center justify-between gap-3 rounded-lg p-4">
            <div className="min-w-0">{renderNode(p.lhs)}</div>
            {p.rhs != null && <div className="shrink-0">{renderNode(p.rhs)}</div>}
          </div>
        );
      })}
    </CardGrid>
  ),
});

export const OverviewCardItem = defineComponent({
  name: "OverviewCardItem",
  props: z.object({
    id: z.string().optional(),
    top: z.union([IconText.ref, Text.ref]),
    bottom: z.optional(MetricIndicatorInline.ref),
  }),
  description: "One overview card: a heading slot at the top (IconText or Text) and an optional MetricIndicatorInline at the bottom.",
  component: () => null,
});

export const OverviewCardBlock = defineComponent({
  name: "OverviewCardBlock",
  props: z.object({
    items: z.array(OverviewCardItem.ref).min(2),
    layout: z.enum(["grid", "carousel"]).default("grid"),
    responsive: z.boolean().default(true),
    gap: z.union([z.number(), z.string()]).optional(),
  }),
  description: "A grid of compact overview cards (KPIs), each with a heading (icon/text) on top and an inline metric below.",
  component: ({ props, renderNode }) => (
    <CardGrid>
      {asArray(props.items).map((it, i) => {
        const p = nodeProps(it);
        return (
          <div key={i} className="surface flex flex-col justify-between gap-4 rounded-lg p-4">
            <div className="[&_.items-end]:items-start [&_.text-right]:text-left">{renderNode(p.top)}</div>
            {p.bottom != null && renderNode(p.bottom)}
          </div>
        );
      })}
    </CardGrid>
  ),
});
