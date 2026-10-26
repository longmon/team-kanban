// OpenUI 渲染与 onAction → 提交（api.md §10）。单独 chunk，管理页不加载组件库与图表
import { Component, useMemo, useRef, useState, type ReactNode } from "react";
import { Renderer, type ActionEvent, type OpenUIError } from "@openuidev/react-lang";
import { kanbanLibrary } from "../openui-lib";
import { SubmitContext, type SubmitState } from "../openui-lib/forms";
import { errMsg } from "../api";
import { submissionData } from "../data";
import { Notice, toast } from "../ui";

export default function OpenUIView({ spec, submit, readOnly }: { spec: string; submit: (data: Record<string, unknown>) => Promise<number>; readOnly?: boolean }) {
  const [errors, setErrors] = useState<OpenUIError[]>([]);
  // 提交状态交给触发按钮显示；进行中忽略重复提交，成功后按钮显示「已提交 ✓」1.8s
  const [state, setState] = useState<SubmitState>({ phase: "idle", owner: null, n: 0 });
  const claimed = useRef<string | null>(null);
  const busy = useRef(false);
  const ctx = useMemo(() => ({ state, claim: (id: string) => void (claimed.current = id), readOnly }), [state, readOnly]);

  const onAction = (e: ActionEvent) => {
    if (e.type === "open_url") {
      const url = String(e.params?.url ?? "");
      if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    if (e.type !== "continue_conversation" || busy.current || readOnly) return;
    busy.current = true;
    const owner = claimed.current;
    claimed.current = null;
    setState((s) => ({ phase: "busy", owner, n: s.n + 1 }));
    submit(submissionData(e)).then(
      (seq) => {
        toast.ok(`已提交（#${seq}）`);
        setState((s) => ({ ...s, phase: "done" }));
        setTimeout(() => setState((s) => (s.phase === "done" && s.owner === owner ? { ...s, phase: "idle" } : s)), 1800);
      },
      (err) => {
        toast.err(errMsg(err));
        setState((s) => ({ ...s, phase: "error", n: s.n + 1, error: errMsg(err) }));
      },
    ).finally(() => void (busy.current = false));
  };

  const real = errors.filter((e) => e.severity !== "warning");
  return (
    <div className="flex flex-col gap-4">
      {real.length > 0 && (
        <Notice tone="warning">
          <div className="font-medium text-foreground">页面部分内容无法渲染</div>
          <ul className="list-disc pl-4">{real.map((e, i) => <li key={i}>{e.message}</li>)}</ul>
        </Notice>
      )}
      <Boundary>
        <SubmitContext.Provider value={ctx}>
          <Renderer response={spec} library={kanbanLibrary} toolProvider={null} publishObservability={false}
            onAction={onAction} onError={setErrors} />
        </SubmitContext.Provider>
      </Boundary>
    </div>
  );
}

/** agent 生成的内容渲染崩溃时只影响内容区，不白屏 */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error
      ? <Notice tone="error"><b>页面渲染失败：</b>{this.state.error.message}</Notice>
      : this.props.children;
  }
}
