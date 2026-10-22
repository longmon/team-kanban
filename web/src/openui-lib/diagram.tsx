// 流程图 / 架构图组件 Diagram(code, caption?) 的 schema；渲染实现在 diagram-impl.tsx，首次用到时才加载 Mermaid（自托管，CSP script-src 'self'）
import { lazy, Suspense } from "react";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";
import { Surface } from "./util";

const DiagramView = lazy(() => import("./diagram-impl"));

export const Diagram = defineComponent({
  name: "Diagram",
  props: z.object({ code: z.string(), caption: z.string().optional() }),
  description:
    'Mermaid diagram for flowcharts and architecture: Diagram("flowchart LR\\n  A[Start] --> B{OK?}\\n  B -->|yes| C[Done]", "caption"). Supports flowchart (with subgraph), sequenceDiagram, stateDiagram-v2, erDiagram, classDiagram, C4Context, architecture-beta. Use \\n for line breaks; no %%{init}%% directives or click handlers.',
  component: ({ props }) => (
    <Surface className="p-5" plain="min-w-0">
      <Suspense fallback={<div className="h-[260px] animate-pulse rounded-lg bg-muted/60" />}>
        <DiagramView code={String(props.code ?? "")} caption={props.caption ? String(props.caption) : undefined} />
      </Suspense>
    </Surface>
  ),
});
