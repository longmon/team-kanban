// Diagram 渲染实现（Mermaid），由 diagram.tsx 懒加载：不用图的页面不下载 Mermaid
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import mermaid from "mermaid";
import { Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

// 暗色切换（<html class="dark">）、经典主题切换（data-skin）时重新渲染
const subscribeDark = (cb: () => void) => {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-skin"] });
  return () => mo.disconnect();
};
const isDark = () => document.documentElement.classList.contains("dark");
const isClassic = () => document.documentElement.dataset.skin === "classic";
const themeKey = () => `${isDark()}:${isClassic()}`;

/** 陶土 token → Mermaid themeVariables（只认颜色值，所以从计算样式取实际色值） */
function themeVariables() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  // 经典主题（Win98）近似：白底黑框、宋体/Tahoma、黑色连线、灰色分组
  const classic = isClassic() ? {
    fontFamily: v("--font-body"), fontSize: "12px", primaryColor: "#ffffff", primaryBorderColor: "#000000", nodeBorder: "#000000",
    lineColor: "#000000", mainBkg: "#ffffff", clusterBkg: "#c0c0c0", clusterBorder: "#808080", edgeLabelBackground: "#c0c0c0",
  } : {};
  return {
    darkMode: isDark(),
    background: v("--card"),
    fontFamily: "system-ui, -apple-system, Segoe UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC, sans-serif",
    fontSize: "14px",
    primaryColor: v("--card"),
    primaryTextColor: v("--foreground"),
    primaryBorderColor: v("--primary"),
    secondaryColor: v("--muted"),
    tertiaryColor: v("--accent"),
    lineColor: v("--muted-foreground"),
    textColor: v("--foreground"),
    titleColor: v("--foreground"),
    mainBkg: v("--card"),
    nodeBorder: v("--primary"),
    clusterBkg: v("--muted"),
    clusterBorder: v("--border"),
    edgeLabelBackground: v("--card"),
    noteBkgColor: v("--muted"),
    noteTextColor: v("--foreground"),
    noteBorderColor: v("--border"),
    ...classic,
  };
}

// mermaid.render 共享全局配置，串行执行避免并发渲染互相覆盖主题
let queue: Promise<unknown> = Promise.resolve();
function render(id: string, code: string) {
  const job = queue.then(async () => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict", // 编码标签、禁用 click 回调，输出经 DOMPurify
      htmlLabels: false, // 不用 foreignObject
      flowchart: { htmlLabels: false },
      theme: "base",
      themeVariables: themeVariables(),
    });
    return (await mermaid.render(id, code)).svg;
  });
  queue = job.catch(() => undefined);
  return job;
}

export default function DiagramView({ code, caption }: { code: string; caption?: string }) {
  const dark = useSyncExternalStore(subscribeDark, themeKey);
  const rid = "mmd-" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    render(rid, code).then(
      (s) => alive && (setSvg(s), setError(null)),
      (e) => {
        document.getElementById("d" + rid)?.remove(); // 渲染失败时 Mermaid 会留下错误图
        if (alive) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => void (alive = false);
  }, [rid, code, dark]);

  if (error)
    return (
      <div className="flex flex-col gap-2 text-sm" role="alert">
        <p className="font-semibold text-destructive">图表语法有误，无法渲染</p>
        <p className="text-[13px] break-words text-muted-foreground">{error.split("\n")[0]}</p>
        <details className="text-[13px]">
          <summary className="cursor-pointer text-muted-foreground">查看源码</summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 text-xs">{code}</pre>
        </details>
      </div>
    );
  if (!svg) return <div className="h-[260px] animate-pulse rounded-lg bg-muted/60" />;

  // SVG 由 Mermaid（securityLevel=strict + DOMPurify）生成
  const figure = (cls: string) => <div className={cls} dangerouslySetInnerHTML={{ __html: svg }} />;
  return (
    <figure className="flex flex-col gap-3" data-diagram>
      <div className="flex items-start justify-between gap-3">
        {caption ? <figcaption className="text-base leading-snug font-bold">{caption}</figcaption> : <span />}
        <Dialog>
          <DialogTrigger asChild>
            <Button size="xs" variant="ghost" aria-label="放大查看"><Maximize2 />放大查看</Button>
          </DialogTrigger>
          <DialogContent className="max-h-[90vh] w-[95vw] max-w-[95vw] overflow-auto sm:max-w-[95vw]">
            <DialogTitle>{caption || "图"}</DialogTitle>
            {figure("diagram-svg [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-none [&_svg]:min-w-full")}
          </DialogContent>
        </Dialog>
      </div>
      {figure("diagram-svg overflow-x-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full")}
    </figure>
  );
}
