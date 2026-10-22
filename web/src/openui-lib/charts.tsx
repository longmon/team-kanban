// 图表组件的 schema（与原 openuiLibrary 兼容）；渲染实现在 charts-impl.tsx，首次用到图表时才加载 Recharts
import { lazy, Suspense, type FC, type ReactNode } from "react";
import { defineComponent, type ComponentRenderProps } from "@openuidev/react-lang";
import { z } from "zod";
import { Surface } from "./util";

const impl = () => import("./charts-impl");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lazyView(name: string): (p: ComponentRenderProps<any>) => ReactNode {
  const View = lazy(() => impl().then((m) => ({ default: (m as unknown as Record<string, FC<ComponentRenderProps>>)[name + "View"] })));
  // 裸图表（不在 Card 里）自己做卡片表面
  return (p) => (
    <Surface className="p-5" plain="min-w-0">
      <Suspense fallback={<div className="h-[260px] animate-pulse rounded-lg bg-muted/60" />}><View {...p} /></Suspense>
    </Surface>
  );
}

const seriesSchema = z.object({ category: z.string(), values: z.array(z.number()) });
const axisLabels = { xLabel: z.string().optional(), yLabel: z.string().optional() };

export const Series = defineComponent({
  name: "Series",
  props: seriesSchema,
  description: "One data series",
  component: () => null,
});

export const BarChart = defineComponent({
  name: "BarChart",
  props: z.object({
    labels: z.array(z.string()),
    series: z.array(seriesSchema),
    variant: z.enum(["grouped", "stacked"]).optional(),
    ...axisLabels,
    height: z.number().optional(),
  }),
  description: "Vertical bars; use for comparing values across categories with one or more series",
  component: lazyView("BarChart"),
});

export const HorizontalBarChart = defineComponent({
  name: "HorizontalBarChart",
  props: z.object({
    labels: z.array(z.string()),
    series: z.array(seriesSchema),
    variant: z.enum(["grouped", "stacked"]).optional(),
    ...axisLabels,
  }),
  description: "Horizontal bars; prefer when category labels are long or for ranked lists",
  component: lazyView("HorizontalBarChart"),
});

// 每个组件要独立的 schema 对象：defineComponent 按对象给 schema 打组件名标签
const lineSchema = () => z.object({
  labels: z.array(z.string()),
  series: z.array(seriesSchema),
  variant: z.enum(["linear", "natural", "step"]).optional(),
  ...axisLabels,
  height: z.number().optional(),
});

export const LineChart = defineComponent({
  name: "LineChart",
  props: lineSchema(),
  description: "Lines over categories; use for trends and continuous data over time",
  component: lazyView("LineChart"),
});

export const AreaChart = defineComponent({
  name: "AreaChart",
  props: lineSchema(),
  description: "Filled area under lines; use for cumulative totals or volume trends over time",
  component: lazyView("AreaChart"),
});

export const RadarChart = defineComponent({
  name: "RadarChart",
  props: z.object({ labels: z.array(z.string()), series: z.array(seriesSchema) }),
  description: "Spider/web chart; use for comparing multiple variables across one or more entities",
  component: lazyView("RadarChart"),
});

export const PieChart = defineComponent({
  name: "PieChart",
  props: z.object({
    labels: z.array(z.string()),
    values: z.array(z.number()),
    variant: z.enum(["pie", "donut"]).optional(),
    appearance: z.enum(["circular", "semiCircular"]).optional(),
  }),
  description: "Circular slices; use plucked arrays: PieChart(data.categories, data.values)",
  component: lazyView("PieChart"),
});

const pointSchema = z.object({ x: z.number(), y: z.number(), z: z.number().optional() });

export const Point = defineComponent({
  name: "Point",
  props: pointSchema,
  description: "Data point with numeric coordinates",
  component: () => null,
});

const scatterSeriesSchema = z.object({ name: z.string(), points: z.array(pointSchema) });

export const ScatterSeries = defineComponent({
  name: "ScatterSeries",
  props: scatterSeriesSchema,
  description: "Named dataset",
  component: () => null,
});

export const ScatterChart = defineComponent({
  name: "ScatterChart",
  props: z.object({ datasets: z.array(scatterSeriesSchema), ...axisLabels }),
  description: "X/Y scatter plot; use for correlations, distributions, and clustering",
  component: lazyView("ScatterChart"),
});
