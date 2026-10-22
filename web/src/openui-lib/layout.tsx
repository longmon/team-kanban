// 布局组件：Stack / Card / Tabs / Accordion，以及它们可容纳的内容联合类型
import { useContext, useEffect, useState, type ReactNode } from "react";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";
import { cn } from "@/lib/utils";
import { Accordion as UIAccordion, AccordionContent, AccordionItem as UIAccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Tabs as UITabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AreaChart, BarChart, HorizontalBarChart, LineChart, PieChart, RadarChart, ScatterChart } from "./charts";
import {
  Callout, CardHeader, Image, MarkDownRenderer, OverviewCardBlock, Separator, SnippetCardBlock, Steps, Table, TagBlock, TextCallout, TextContent,
} from "./content";
import { Buttons, Form } from "./forms";
import { asArray, InSurface } from "./util";

export const ContentChildUnion = z.union([
  TextContent.ref, MarkDownRenderer.ref, CardHeader.ref, Callout.ref, TextCallout.ref, Image.ref, Separator.ref,
  HorizontalBarChart.ref, RadarChart.ref, PieChart.ref, ScatterChart.ref, AreaChart.ref, BarChart.ref, LineChart.ref,
  Table.ref, TagBlock.ref, Form.ref, Buttons.ref, Steps.ref, SnippetCardBlock.ref, OverviewCardBlock.ref,
]);

const flexProps = z.object({
  direction: z.enum(["row", "column"]).optional(),
  gap: z.enum(["none", "xs", "s", "m", "l", "xl", "2xl"]).optional(),
  align: z.enum(["start", "center", "end", "stretch", "baseline"]).optional(),
  justify: z.enum(["start", "center", "end", "between", "around", "evenly"]).optional(),
  wrap: z.boolean().optional(),
});
type Flex = z.infer<typeof flexProps>;

const GAP = { none: "gap-0", xs: "gap-1", s: "gap-2", m: "gap-4", l: "gap-6", xl: "gap-8", "2xl": "gap-12" } as const;
const ALIGN = { start: "items-start", center: "items-center", end: "items-end", stretch: "items-stretch", baseline: "items-baseline" } as const;
const JUSTIFY = { start: "justify-start", center: "justify-center", end: "justify-end", between: "justify-between", around: "justify-around", evenly: "justify-evenly" } as const;

/** row 方向在窄屏自动换行；wrap=true 时子项等分（网格式布局） */
function flexClass(p: Flex, fallbackGap: keyof typeof GAP = "m") {
  const row = p.direction === "row";
  const justify = p.wrap && p.justify === "between" ? "start" : p.justify;
  return cn(
    "flex min-w-0",
    row ? "flex-row flex-wrap" : "flex-col",
    GAP[p.gap ?? fallbackGap] ?? GAP.m,
    p.align && ALIGN[p.align],
    justify && JUSTIFY[justify],
    row && "*:min-w-0",
    row && p.wrap && "*:flex-[1_1_220px]",
  );
}

// 宽屏自动多列：纵向 Stack 里连续 ≥2 个图表卡（或裸图表）并排，≥1280px 两列、≥1800px 三列；其余子项（表格、长文本、表单）占满整行
const CHARTS = new Set(["BarChart", "LineChart", "AreaChart", "PieChart", "RadarChart", "HorizontalBarChart", "ScatterChart"]);
type ENode = { typeName?: string; props?: Record<string, unknown> };
const isChartCard = (n: unknown) => {
  const e = n as ENode;
  if (CHARTS.has(e?.typeName ?? "")) return true;
  if (e?.typeName !== "Card" || e.props?.direction === "row") return false;
  const kids = asArray(e.props?.children) as ENode[];
  return kids.some((k) => CHARTS.has(k?.typeName ?? "")) && !kids.some((k) => k?.typeName === "Table" || k?.typeName === "Form");
};
const CHART_GRID = { 2: "grid gap-4 xl:grid-cols-2", 3: "grid gap-4 xl:grid-cols-2 min-[1800px]:grid-cols-3" } as const;

function columnChildren(children: unknown, renderNode: (n: unknown) => ReactNode) {
  const kids = asArray(children);
  const out: ReactNode[] = [];
  for (let i = 0; i < kids.length; ) {
    let j = i;
    while (j < kids.length && isChartCard(kids[j])) j++;
    if (j - i >= 2) {
      out.push(<div key={i} className={CHART_GRID[j - i >= 3 ? 3 : 2]}>{renderNode(kids.slice(i, j))}</div>);
      i = j;
    } else {
      out.push(<div key={i} className="contents">{renderNode(kids[i])}</div>);
      i++;
    }
  }
  return out;
}

export const Stack = defineComponent({
  name: "Stack",
  props: z.object({ children: z.array(z.any()) }).merge(flexProps),
  description: 'Flex container. direction: "row"|"column" (default "column"). gap: "none"|"xs"|"s"|"m"|"l"|"xl"|"2xl" (default "m"). align: "start"|"center"|"end"|"stretch"|"baseline". justify: "start"|"center"|"end"|"between"|"around"|"evenly". The page is a wide desktop layout: consecutive chart Cards in a column Stack are automatically placed side by side; use direction "row" + wrap=true only for explicit side-by-side groups (KPI cards, short facts).',
  component: ({ props, renderNode }) => (
    <div className={flexClass(props)}>{props.direction === "row" ? renderNode(props.children) : columnChildren(props.children, renderNode)}</div>
  ),
});

export const TabItem = defineComponent({
  name: "TabItem",
  props: z.object({ value: z.string(), trigger: z.string(), content: z.array(ContentChildUnion) }),
  description: "value is unique id, trigger is tab label, content is array of components",
  component: () => null,
});

type Item = { props: Record<string, unknown> };
const itemsOf = (v: unknown) => asArray(v).filter((i): i is Item => (i as Item)?.props?.value != null);

export const Tabs = defineComponent({
  name: "Tabs",
  props: z.object({ items: z.array(TabItem.ref) }),
  description: "Tabbed container",
  component: ({ props, renderNode }) => {
    const items = itemsOf(props.items);
    const [active, setActive] = useState("");
    const first = items[0] ? String(items[0].props.value) : "";
    useEffect(() => {
      if (!active && first) setActive(first);
    }, [active, first]);
    if (!items.length) return null;
    return (
      <UITabs value={active || first} onValueChange={setActive} className="gap-4">
        <TabsList className="max-w-full justify-start overflow-x-auto">
          {items.map((it) => <TabsTrigger key={String(it.props.value)} value={String(it.props.value)} className="flex-none px-3">{String(it.props.trigger ?? "")}</TabsTrigger>)}
        </TabsList>
        {items.map((it) => (
          <TabsContent key={String(it.props.value)} value={String(it.props.value)} className="flex flex-col gap-4">{renderNode(it.props.content)}</TabsContent>
        ))}
      </UITabs>
    );
  },
});

export const AccordionItem = defineComponent({
  name: "AccordionItem",
  props: z.object({ value: z.string(), trigger: z.string(), content: z.array(ContentChildUnion) }),
  description: "value is unique id, trigger is section title",
  component: () => null,
});

export const Accordion = defineComponent({
  name: "Accordion",
  props: z.object({ items: z.array(AccordionItem.ref) }),
  description: "Collapsible sections",
  component: ({ props, renderNode }) => {
    const items = itemsOf(props.items);
    if (!items.length) return null;
    // 默认全部收起，由用户展开
    return (
      <UIAccordion type="single" collapsible className="rounded-lg border bg-card px-4">
        {items.map((it) => (
          <UIAccordionItem key={String(it.props.value)} value={String(it.props.value)}>
            <AccordionTrigger>{String(it.props.trigger ?? "")}</AccordionTrigger>
            <AccordionContent className="flex flex-col gap-3">{renderNode(it.props.content)}</AccordionContent>
          </UIAccordionItem>
        ))}
      </UIAccordion>
    );
  },
});

const CARD_VARIANT = {
  card: "surface p-5",
  sunk: "rounded-xl bg-muted/70 p-5",
  clear: "",
} as const;

export const Card = defineComponent({
  name: "Card",
  props: z.object({
    children: z.array(z.union([...ContentChildUnion.options, Tabs.ref, Stack.ref])),
    variant: z.enum(["card", "sunk", "clear"]).optional(),
  }).merge(flexProps),
  description: 'Styled container. variant: "card" (default, elevated) | "sunk" (recessed) | "clear" (transparent). Always full width. Accepts all Stack flex params (default: direction "column"). Cards flex to share space in row/wrap layouts.',
  component: function CardView({ props, renderNode }) {
    const inside = useContext(InSurface);
    return (
      <InSurface.Provider value={inside || props.variant !== "clear"}>
        <div className={cn("w-full flex-1", CARD_VARIANT[props.variant ?? "card"], flexClass(props, props.direction === "row" ? "m" : "s"))}>
          {renderNode(props.children)}
        </div>
      </InSurface.Provider>
    );
  },
});
