// 图表渲染实现（Recharts），由 charts.tsx 按需懒加载：没有图表的页面不下载 Recharts
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ComponentRenderProps } from "@openuidev/react-lang";
import {
  Area, AreaChart as RArea, Bar, BarChart as RBar, CartesianGrid, Cell, Line, LineChart as RLine, Pie, PieChart as RPie,
  PolarAngleAxis, PolarGrid, Radar, RadarChart as RRadar, Scatter, ScatterChart as RScatter, XAxis, YAxis, ZAxis, Label,
} from "recharts";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { asArray, buildChartData } from "./util";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type P = ComponentRenderProps<any>;

// ponytail: 超过 5 个序列按 token 循环取色；真需要更多时应拆图或并入「其他」
const color = (i: number) => `var(--chart-${(i % 5) + 1})`;
const configOf = (names: string[]): ChartConfig => Object.fromEntries(names.map((n, i) => [`s${i}`, { label: n, color: color(i) }]));
const tick = (v: unknown) => {
  const s = String(v ?? "");
  return s.length > 12 ? s.slice(0, 11) + "…" : s;
};
const compact = (v: unknown) => (typeof v === "number" ? Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(v) : String(v));


function Frame({ config, height, draw, children }: { config: ChartConfig; height?: number; draw: Draw; children: ReactNode }) {
  // key 随 draw.on 变化：进入视口时重新挂载一次，Recharts 从 0 开始播进入动画
  return (
    <ChartContainer key={String(draw.on)} ref={draw.ref} config={config} className="aspect-auto w-full" style={{ height: Math.min(Math.max(height ?? 260, 160), 640) }}>
      {children as never}
    </ChartContainer>
  );
}

// 进入动画：折线描边、柱从 0 生长、饼/环扫过，550ms ease-out；减少动态时关闭
const MOTION = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * 图表只在首次进入视口时绘制一次：挂载时已在视口内直接播；在视口外先静态完整渲染（打印、截图不缺图），
 * 滚到可见时重新挂载播一次。
 */
function useDraw() {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !MOTION) return;
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) return setOn(true);
    const io = new IntersectionObserver(([e]) => e.isIntersecting && (setOn(true), io.disconnect()));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, on, anim: { isAnimationActive: on, animationDuration: 550, animationEasing: "ease-out" } as const };
}
type Draw = ReturnType<typeof useDraw>;

/** 悬停高亮：图例或图形悬停时对应系列保持不透明，其余变淡 */
function useHighlight() {
  const [hi, setHi] = useState<string | null>(null);
  return {
    hi, setHi,
    op: (k: string) => (hi && hi !== k ? 0.3 : 1),
    hover: (k: string) => ({ onMouseEnter: () => setHi(k), onMouseLeave: () => setHi(null) }),
  };
}
type HL = ReturnType<typeof useHighlight>;

/** 容器宽度 ≥ min 时为 true（饼图图例放右侧用） */
function useWide(min: number) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWide(e.contentRect.width >= min));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, min]);
  return [setEl, wide] as const;
}

const legend = (n: number, h: HL) => (n > 1 ? <ChartLegend content={<ChartLegendContent active={h.hi} onActive={h.setHi} />} /> : null);
const xLab = (t?: string) => (t ? <Label value={t} position="insideBottom" offset={-4} className="fill-muted-foreground text-xs" /> : null);
const yLab = (t?: string) => (t ? <Label value={t} angle={-90} position="insideLeft" className="fill-muted-foreground text-xs" style={{ textAnchor: "middle" }} /> : null);

const curve = (v?: string) => (v === "linear" ? "linear" : v === "step" ? "step" : "monotone");
const unwrap = (n: unknown) => ((n as { type?: string; props?: Record<string, unknown> })?.type === "element" ? (n as { props: Record<string, unknown> }).props : (n as Record<string, unknown>));

export const BarChartView = ({ props }: P) => {
    const h = useHighlight();
    const d = useDraw();
    const { rows, names } = buildChartData(props.labels, props.series);
    if (!rows.length || !names.length) return null;
    const stacked = props.variant === "stacked";
    return (
      <Frame draw={d} config={configOf(names)} height={props.height}>
        <RBar data={rows} margin={{ top: 8, right: 8, left: props.yLabel ? 8 : 0, bottom: props.xLabel ? 12 : 0 }}
          barCategoryGap={names.length > 1 && !stacked ? "24%" : "32%"} barGap={2}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="category" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={tick} minTickGap={8}>{xLab(props.xLabel)}</XAxis>
          <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={compact}>{yLab(props.yLabel)}</YAxis>
          <ChartTooltip cursor={{ fillOpacity: 0.5 }} content={<ChartTooltipContent />} />
          {legend(names.length, h)}
          {names.map((_, i) => (
            <Bar key={i} dataKey={`s${i}`} fill={`var(--color-s${i})`} fillOpacity={h.op(`s${i}`)} {...h.hover(`s${i}`)} maxBarSize={48} {...d.anim}
              stackId={stacked ? "a" : undefined} stroke={stacked ? "var(--card)" : undefined} strokeWidth={stacked ? 1 : 0}
              radius={stacked ? (i === names.length - 1 ? [4, 4, 0, 0] : 0) : [4, 4, 0, 0]} />
          ))}
        </RBar>
      </Frame>
    );
  };

export const HorizontalBarChartView = ({ props }: P) => {
    const h = useHighlight();
    const d = useDraw();
    const { rows, names } = buildChartData(props.labels, props.series);
    if (!rows.length || !names.length) return null;
    const stacked = props.variant === "stacked";
    const per = stacked ? 1 : names.length;
    const height = rows.length * Math.max(28, per * 18 + 12) + (names.length > 1 ? 48 : 24);
    const longest = Math.max(...rows.map((r) => String(r.category).length));
    return (
      <Frame draw={d} config={configOf(names)} height={height}>
        <RBar data={rows} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: props.xLabel ? 12 : 0 }} barCategoryGap="24%" barGap={2}>
          <CartesianGrid horizontal={false} strokeDasharray="3 3" />
          <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={compact}>{xLab(props.xLabel)}</XAxis>
          <YAxis type="category" dataKey="category" tickLine={false} axisLine={false} tickMargin={6}
            width={Math.min(150, Math.max(56, longest * 14 + 14))} tickFormatter={(v) => { const s = String(v); return s.length > 10 ? s.slice(0, 9) + "…" : s; }} />
          <ChartTooltip cursor={{ fillOpacity: 0.5 }} content={<ChartTooltipContent />} />
          {legend(names.length, h)}
          {names.map((_, i) => (
            <Bar key={i} dataKey={`s${i}`} fill={`var(--color-s${i})`} fillOpacity={h.op(`s${i}`)} {...h.hover(`s${i}`)} maxBarSize={28} {...d.anim}
              stackId={stacked ? "a" : undefined} stroke={stacked ? "var(--card)" : undefined} strokeWidth={stacked ? 1 : 0}
              radius={stacked ? (i === names.length - 1 ? [0, 4, 4, 0] : 0) : [0, 4, 4, 0]} />
          ))}
        </RBar>
      </Frame>
    );
  };

export const LineChartView = ({ props }: P) => {
    const h = useHighlight();
    const d = useDraw();
    const { rows, names } = buildChartData(props.labels, props.series);
    if (!rows.length || !names.length) return null;
    return (
      <Frame draw={d} config={configOf(names)} height={props.height}>
        <RLine data={rows} margin={{ top: 8, right: 12, left: props.yLabel ? 8 : 0, bottom: props.xLabel ? 12 : 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="category" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={tick} minTickGap={12}>{xLab(props.xLabel)}</XAxis>
          <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={compact}>{yLab(props.yLabel)}</YAxis>
          <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
          {legend(names.length, h)}
          {names.map((_, i) => (
            <Line key={i} dataKey={`s${i}`} type={curve(props.variant)} stroke={`var(--color-s${i})`} strokeOpacity={h.op(`s${i}`)} strokeWidth={h.hi === `s${i}` ? 3 : 2} {...d.anim}
              dot={rows.length <= 12 ? { r: 3, strokeWidth: 2, fill: "var(--card)" } : false} activeDot={{ r: 5, stroke: "var(--card)", strokeWidth: 2 }} />
          ))}
        </RLine>
      </Frame>
    );
  };

export const AreaChartView = ({ props }: P) => {
    const h = useHighlight();
    const d = useDraw();
    const { rows, names } = buildChartData(props.labels, props.series);
    if (!rows.length || !names.length) return null;
    return (
      <Frame draw={d} config={configOf(names)} height={props.height}>
        <RArea data={rows} margin={{ top: 8, right: 12, left: props.yLabel ? 8 : 0, bottom: props.xLabel ? 12 : 0 }}>
          <defs>
            {names.map((_, i) => (
              <linearGradient key={i} id={`fill-s${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={`var(--color-s${i})`} stopOpacity={0.35} />
                <stop offset="95%" stopColor={`var(--color-s${i})`} stopOpacity={0.03} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="category" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={tick} minTickGap={12}>{xLab(props.xLabel)}</XAxis>
          <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={compact}>{yLab(props.yLabel)}</YAxis>
          <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
          {legend(names.length, h)}
          {names.map((_, i) => (
            <Area key={i} dataKey={`s${i}`} type={curve(props.variant)} stroke={`var(--color-s${i})`} strokeWidth={2}
              strokeOpacity={h.op(`s${i}`)} fillOpacity={h.op(`s${i}`)} fill={`url(#fill-s${i})`} {...d.anim} />
          ))}
        </RArea>
      </Frame>
    );
  };

export const RadarChartView = ({ props }: P) => {
    const h = useHighlight();
    const d = useDraw();
    const { rows, names } = buildChartData(props.labels, props.series);
    if (!rows.length || !names.length) return null;
    return (
      <Frame draw={d} config={configOf(names)} height={300}>
        <RRadar data={rows} outerRadius="72%">
          <PolarGrid />
          <PolarAngleAxis dataKey="category" tickFormatter={tick} className="text-xs" />
          <ChartTooltip content={<ChartTooltipContent />} />
          {legend(names.length, h)}
          {names.map((_, i) => (
            <Radar key={i} dataKey={`s${i}`} stroke={`var(--color-s${i})`} strokeWidth={2} strokeOpacity={h.op(`s${i}`)} fill={`var(--color-s${i})`}
              fillOpacity={0.18 * h.op(`s${i}`)} {...d.anim} dot={{ r: 3, fillOpacity: 1 }} />
          ))}
        </RRadar>
      </Frame>
    );
  };

export const PieChartView = ({ props }: P) => {
    const h = useHighlight();
    const d = useDraw();
    const [ref, side] = useWide(420);
    const labels = asArray(props.labels).map(String);
    const values = asArray(props.values);
    const data = labels.map((l, i) => ({ key: `s${i}`, name: l, value: typeof values[i] === "number" ? (values[i] as number) : 0, fill: `var(--color-s${i})` }));
    if (!data.length) return null;
    const donut = props.variant === "donut";
    const semi = props.appearance === "semiCircular";
    const total = data.reduce((a, d) => a + d.value, 0);
    // 环形图中心显示占比最大的一项（如「52%」+「直销」）
    const top = data.reduce((a, d) => (d.value > a.value ? d : a), data[0]);
    // 宽度够时图例放在图右侧并整体居中，不够时回落到下方
    return (
      <div ref={ref} className={side ? "mx-auto w-full max-w-[460px]" : undefined}>
      <Frame draw={d} config={configOf(labels)} height={semi ? 220 : 280}>
        <RPie>
          <ChartTooltip content={<ChartTooltipContent nameKey="key" hideLabel />} />
          <Pie data={data} dataKey="value" nameKey="key" {...d.anim}
            onMouseEnter={(_: unknown, i: number) => h.setHi(data[i]?.key ?? null)} onMouseLeave={() => h.setHi(null)}
            innerRadius={donut ? "58%" : 0} outerRadius="82%" paddingAngle={donut ? 2 : 0} cornerRadius={donut ? 4 : 0}
            stroke="var(--card)" strokeWidth={2}
            startAngle={semi ? 180 : 90} endAngle={semi ? 0 : -270} cy={semi ? "80%" : side ? "50%" : "45%"}>
            {data.map((d) => <Cell key={d.key} fill={d.fill} fillOpacity={h.op(d.key)} />)}
            {donut && total > 0 && (
              <Label content={({ viewBox }) => {
                const vb = viewBox as { cx?: number; cy?: number } | undefined;
                if (!vb?.cx || !vb?.cy) return null;
                return (
                  <text x={vb.cx} y={vb.cy} textAnchor="middle" dominantBaseline="middle">
                    <tspan x={vb.cx} y={vb.cy - 7} className="fill-foreground text-[22px] font-bold">{Math.round((top.value / total) * 100)}%</tspan>
                    <tspan x={vb.cx} y={vb.cy + 15} className="fill-muted-foreground text-xs font-semibold">{tick(top.name)}</tspan>
                  </text>
                );
              }} />
            )}
          </Pie>
          {side
            ? <ChartLegend layout="vertical" align="right" verticalAlign="middle"
                content={<ChartLegendContent nameKey="key" active={h.hi} onActive={h.setHi} verticalAlign="middle" className="flex-col items-start gap-y-2 pt-0 pl-6" />} />
            : <ChartLegend content={<ChartLegendContent nameKey="key" active={h.hi} onActive={h.setHi} />} />}
        </RPie>
      </Frame>
      </div>
    );
  };

export const ScatterChartView = ({ props }: P) => {
    const h = useHighlight();
    const d = useDraw();
    const sets = asArray(props.datasets).map((d) => {
      const p = unwrap(d) ?? {};
      return {
        name: String(p.name ?? ""),
        data: asArray(p.points).map((pt) => {
          const q = unwrap(pt) ?? {};
          return { x: Number(q.x), y: Number(q.y), z: q.z != null ? Number(q.z) : 1 };
        }),
      };
    });
    if (!sets.length) return null;
    const hasZ = asArray(props.datasets).some((d) => asArray(unwrap(d)?.points).some((pt) => unwrap(pt)?.z != null));
    return (
      <Frame draw={d} config={configOf(sets.map((s) => s.name))} height={300}>
        <RScatter margin={{ top: 8, right: 12, left: props.yLabel ? 8 : 0, bottom: props.xLabel ? 12 : 0 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis type="number" dataKey="x" tickLine={false} axisLine={false} tickFormatter={compact} name={props.xLabel ?? "x"}>{xLab(props.xLabel)}</XAxis>
          <YAxis type="number" dataKey="y" tickLine={false} axisLine={false} width={44} tickFormatter={compact} name={props.yLabel ?? "y"}>{yLab(props.yLabel)}</YAxis>
          <ZAxis type="number" dataKey="z" range={hasZ ? [40, 400] : [64, 64]} />
          <ChartTooltip cursor={{ strokeDasharray: "3 3" }} content={<ChartTooltipContent hideLabel />} />
          {legend(sets.length, h)}
          {sets.map((s, i) => (
            <Scatter key={i} name={`s${i}`} data={s.data} fill={`var(--color-s${i})`} fillOpacity={0.8 * h.op(`s${i}`)} stroke="var(--card)" strokeWidth={1.5} {...d.anim} />
          ))}
        </RScatter>
      </Frame>
    );
  };

