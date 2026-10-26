import * as React from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * 滑动指示块：量出容器内当前选中项（selector）的位置尺寸，写进指示块的 --x/--y/--w/--h，
 * 指示块按 translate/width 过渡 250ms 滑过去。首帧直接到位不滑；选中项变化、尺寸变化（字体加载、勾号出现）时重新量。
 */
export function useSlidingIndicator<T extends HTMLElement>(selector: string) {
  const box = React.useRef<T>(null);
  const bar = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => {
    const el = box.current, ind = bar.current;
    if (!el || !ind) return;
    const place = () => {
      const a = el.querySelector<HTMLElement>(selector);
      ind.style.visibility = a ? "" : "hidden";
      if (!a) return;
      ind.style.setProperty("--x", `${a.offsetLeft}px`);
      ind.style.setProperty("--y", `${a.offsetTop}px`);
      ind.style.setProperty("--w", `${a.offsetWidth}px`);
      ind.style.setProperty("--h", `${a.offsetHeight}px`);
    };
    place();
    const raf = requestAnimationFrame(() => (ind.dataset.ready = ""));
    const mo = new MutationObserver(place);
    mo.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state", "aria-pressed"] });
    const ro = new ResizeObserver(place);
    ro.observe(el);
    for (const c of el.children) ro.observe(c);
    return () => (cancelAnimationFrame(raf), mo.disconnect(), ro.disconnect());
  }, [selector]);
  return { box, bar };
}

/** 指示块默认样式 = 选中 Tab 的胶囊底；className 可覆盖成下划线等 */
const INDICATOR = "pointer-events-none absolute top-0 left-0 h-(--h) w-(--w) translate-x-(--x) translate-y-(--y) data-ready:transition-[translate,width,height] data-ready:duration-(--dur-slow)";
export function SlidingIndicator({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="tabs-indicator" aria-hidden="true" className={cn(INDICATOR, className)} {...props} />;
}

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-2", className)} {...props} />;
}
function TabsList({ className, indicatorClassName, children, ...props }: React.ComponentProps<typeof TabsPrimitive.List> & { indicatorClassName?: string }) {
  const { box, bar } = useSlidingIndicator<HTMLDivElement>("[data-state=active]");
  return (
    <TabsPrimitive.List ref={box} data-slot="tabs-list"
      className={cn("relative inline-flex h-9 w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground", className)}
      {...props}>
      <SlidingIndicator ref={bar} className={cn("rounded-md border border-transparent bg-background shadow-sm dark:border-input dark:bg-input/30", indicatorClassName)} />
      {children}
    </TabsPrimitive.List>
  );
}
function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-foreground transition-[color,background-color,border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/80 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 dark:text-muted-foreground dark:data-[state=active]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props} />
  );
}
function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("flex-1 outline-none data-[state=active]:animate-in data-[state=active]:fade-in-0", className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
