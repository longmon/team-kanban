// 通用小部件与 hooks；视觉组件来自 shadcn/ui（components/ui）
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { toast as sonner } from "sonner";
import { BookOpen, Check, CircleAlert, Copy, FileChartColumn, FileText, Network, Vote, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { errMsg, get, setCsrf } from "./api";
import type { Me, Paged } from "./types";

// ---------- 会话 ----------
type Session = { me: Me | null; loading: boolean; refresh: () => Promise<Me | null>; setMe: (m: Me | null) => void };
const SessionCtx = createContext<Session>(null as unknown as Session);
export const useSession = () => useContext(SessionCtx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMeState] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const setMe = useCallback((m: Me | null) => {
    setCsrf(m?.csrf_token ?? null);
    setMeState(m);
  }, []);
  const refresh = useCallback(async () => {
    try {
      const m = await get<Me>("/auth/me");
      setMe(m);
      return m;
    } catch {
      setMe(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, [setMe]);
  useEffect(() => void refresh(), [refresh]);
  return <SessionCtx.Provider value={{ me, loading, refresh, setMe }}>{children}</SessionCtx.Provider>;
}

// ---------- 数据加载 ----------
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => live && setState({ data, loading: false }),
      (error) => live && setState({ error, loading: false }),
    );
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return {
    ...state,
    reload: () => setN((x) => x + 1),
    setData: (f: (d: T) => T) => setState((s) => (s.data === undefined ? s : { ...s, data: f(s.data) })),
  };
}

/** 游标分页列表（api.md §1.2），「加载更多」追加 */
export function usePaged<T>(path: string | null) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const [n, setN] = useState(0);
  const load = useCallback(
    async (c: string | null, reset: boolean) => {
      if (!path) return;
      setLoading(true);
      try {
        const sep = path.includes("?") ? "&" : "?";
        const r = await get<Paged<T>>(path + (c ? `${sep}cursor=${encodeURIComponent(c)}` : ""));
        setItems((old) => (reset ? r.items : [...old, ...r.items]));
        setCursor(r.next_cursor ?? null);
        setError(undefined);
      } catch (e) {
        setError(e);
      } finally {
        setLoading(false);
      }
    },
    [path],
  );
  useEffect(() => void load(null, true), [load, n]);
  return {
    items, error, loading, hasMore: !!cursor,
    more: () => load(cursor, false),
    reload: () => setN((x) => x + 1),
  };
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const run = async <R,>(fn: () => Promise<R>): Promise<R | undefined> => {
    setBusy(true);
    setError(undefined);
    try {
      return await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

// ---------- 当前组织（顶栏组织切换器） ----------
// 在 /o/:slug 下取路径里的组织；页面查看、结果、设置等页没有组织路径时，显示页面所属组织或最近一次进入的组织
const ORG_KEY = "relay-current-org";
const orgListeners = new Set<() => void>();
const readOrg = () => {
  try {
    return localStorage.getItem(ORG_KEY);
  } catch {
    return null;
  }
};
export function setCurrentOrg(id: string) {
  if (readOrg() === id) return;
  try {
    localStorage.setItem(ORG_KEY, id);
  } catch { /* 隐私模式下不记忆 */ }
  orgListeners.forEach((l) => l());
}
export const useCurrentOrgId = () => useSyncExternalStore((l) => (orgListeners.add(l), () => void orgListeners.delete(l)), readOrg);
/** 页面属于某组织且当前用户是成员时，把它记为当前组织 */
export function useOwnOrg(orgId: string | undefined) {
  const { me } = useSession();
  useEffect(() => {
    if (orgId && me?.orgs.some((o) => o.id === orgId)) setCurrentOrg(orgId);
  }, [orgId, me]);
}

// ---------- 主题（亮/暗） ----------
// 键名与旧版一致（值为 JSON 字符串），已保存的偏好继续生效；未设置时跟随系统
const THEME_KEY = "openui-theme-mode";
type Mode = "light" | "dark";
const themeListeners = new Set<() => void>();
const mq = window.matchMedia("(prefers-color-scheme: dark)");
const readPref = (): Mode | null => {
  try {
    const v = JSON.parse(localStorage.getItem(THEME_KEY) ?? "null");
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
};
const currentMode = (): Mode => readPref() ?? (mq.matches ? "dark" : "light");
const applyMode = () => document.documentElement.classList.toggle("dark", currentMode() === "dark");
applyMode();
mq.addEventListener("change", () => (applyMode(), themeListeners.forEach((l) => l())));
export function useTheme() {
  const mode = useSyncExternalStore((l) => (themeListeners.add(l), () => void themeListeners.delete(l)), currentMode);
  const setMode = (m: Mode) => {
    try {
      localStorage.setItem(THEME_KEY, JSON.stringify(m));
    } catch { /* 隐私模式下只在本次会话生效 */ }
    applyMode();
    themeListeners.forEach((l) => l());
  };
  return { mode, setMode };
}

// ---------- 展示 ----------
export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <Notice tone="error">{errMsg(error)}</Notice>;
}

/** 行内提示条：error / warning / success / info */
export function Notice({ tone, children, className }: { tone: "error" | "warning" | "success" | "info"; children: ReactNode; className?: string }) {
  return (
    <Alert variant={tone === "error" ? "destructive" : tone} className={className}>
      <CircleAlert />
      <AlertDescription className={tone === "error" ? "" : "text-foreground/85"}>{children}</AlertDescription>
    </Alert>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="grid gap-2">
      <span className="text-[13px] font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** 勾选项 */
export function CheckField({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <Label className="w-fit cursor-pointer gap-2.5 text-[13px] font-normal">
      <Checkbox checked={checked} onCheckedChange={(c) => onChange(c === true)} />
      {children}
    </Label>
  );
}

/** 选项值为 "" 的那一项作为占位文字（Radix Select 不允许空值选项） */
export function NativeSelect<V extends string>(props: {
  value: V; onChange: (v: V) => void; options: [V, string][]; disabled?: boolean; "aria-label"?: string;
  size?: "sm" | "md"; className?: string;
}) {
  const placeholder = props.options.find(([v]) => v === "")?.[1];
  return (
    <Select value={props.value} disabled={props.disabled} onValueChange={(v) => props.onChange(v as V)}>
      <SelectTrigger size={props.size === "sm" ? "sm" : "default"} className={cn("w-full", props.className)} aria-label={props["aria-label"]}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {props.options.filter(([v]) => v !== "").map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="grid max-w-lg gap-3 py-4" role="status" aria-label="加载中">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className={cn("h-4", i === rows - 1 ? "w-2/3" : "w-full")} />)}
    </div>
  );
}

/** 列表/表格加载骨架 */
export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="surface overflow-hidden" role="status" aria-label="加载中">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-b px-5 py-4 last:border-0">
          <div className="grid flex-1 gap-2"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-3 w-1/2" /></div>
          <Skeleton className="h-8 w-16" />
        </div>
      ))}
    </div>
  );
}

/** 页内一级 tabs：下划线样式，窄屏横向滚动 */
export const PAGE_TABS_LIST = "h-auto w-full justify-start gap-5 overflow-x-auto rounded-none border-b bg-transparent p-0 [scrollbar-width:none]";
export const PAGE_TABS_TRIGGER = "h-auto flex-none rounded-none border-0 border-b-2 border-transparent px-0.5 pt-1 pb-2.5 text-muted-foreground hover:text-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:border-primary dark:data-[state=active]:bg-transparent";

/** 表格外框 */
export function TableCard({ children }: { children: ReactNode }) {
  return <div className="surface overflow-hidden [&_td]:px-4 [&_td]:py-3 [&_th]:px-4 [&_thead]:bg-muted/50">{children}</div>;
}

/** 版心（顶栏与内容区共用）：宽屏优先，左右留白随宽度增大，内容最宽 1680px（1808 − 2×64） */
export const WRAP = "mx-auto w-full max-w-[1808px] px-4 sm:px-6 lg:px-10 2xl:px-16";

/** 管理端页面：宽度跟随版心 */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex w-full flex-col gap-6", className)}>{children}</div>;
}

/** 居中小卡片：登录、注册、错误提示等 */
export function AuthCard({ title, desc, children }: { title?: ReactNode; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mx-auto mt-6 w-full max-w-[400px] sm:mt-14">
      <div className="surface flex flex-col gap-5 p-6 sm:p-8">
        {(title || desc) && (
          <div className="grid gap-1.5">
            {title && <h1 className="text-[22px] leading-tight font-bold">{title}</h1>}
            {desc && <p className="text-sm text-muted-foreground">{desc}</p>}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

/** 管理端内容面板：标题/说明 + 内容 */
export function Panel({ title, desc, actions, children, className, danger }: {
  title?: ReactNode; desc?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; danger?: boolean;
}) {
  return (
    <section className={cn("surface", danger && "ring-1 ring-destructive/30", className)}>
      {(title || actions) && (
        <div className={cn("flex flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-6", children != null && "border-b")}>
          <div className="min-w-0">
            {title && <h2 className={cn("text-base leading-snug font-bold", danger && "text-destructive")}>{title}</h2>}
            {desc && <p className="mt-1 text-[13px] text-muted-foreground">{desc}</p>}
          </div>
          {actions}
        </div>
      )}
      {children != null && <div className="flex flex-col gap-4 px-5 py-5 sm:px-6">{children}</div>}
    </section>
  );
}

/** 页头：面包屑、标题（可带角标）、说明、右侧操作 */
export function PageHeader({ crumbs, title, badge, desc, actions }: {
  crumbs?: ReactNode; title: ReactNode; badge?: ReactNode; desc?: ReactNode; actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 flex-[1_1_320px]">
        {crumbs && (
          <nav aria-label="路径" className="mb-2 flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground [&>*+*]:before:mr-1.5 [&>*+*]:before:text-border [&>*+*]:before:content-['/'] [&_a]:transition-colors [&_a:hover]:text-foreground">
            {crumbs}
          </nav>
        )}
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-[26px] leading-tight font-bold [overflow-wrap:anywhere] max-sm:text-[22px]">{title}</h1>
          {badge}
        </div>
        {desc && <div className="mt-1.5 max-w-[72ch] text-sm text-muted-foreground">{desc}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl border border-dashed bg-card/50 px-6 py-10 text-center">
      {icon && <div className="mb-2 grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-5">{icon}</div>}
      <div className="text-sm font-medium">{title}</div>
      {children && <div className="max-w-sm text-[13px] text-muted-foreground">{children}</div>}
    </div>
  );
}

export function MoreButton({ p }: { p: { hasMore: boolean; loading: boolean; more: () => void } }) {
  if (!p.hasMore) return null;
  return <div className="flex justify-center"><Button variant="ghost" size="sm" disabled={p.loading} onClick={p.more}>加载更多</Button></div>;
}

export const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—";

export function CopyText({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted/60 px-3 py-2 text-[13px] whitespace-nowrap">{text}</code>
      <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(text).then(() => setDone(true))}>
        {done ? <Check /> : <Copy />}{done ? "已复制" : "复制"}
      </Button>
    </div>
  );
}

// ---------- toast（sonner；class "toast" 供 e2e 定位）：toast.ok 成功（带勾）、toast.err 失败（带叹号，写明原因） ----------
export const toast = Object.assign((m: string) => void sonner(m), {
  ok: (m: string) => void sonner.success(m),
  err: (m: string) => void sonner.error(m),
});

export const ROLE_LABEL: Record<string, string> = {
  owner: "所有者", admin: "管理员", member: "成员", editor: "编辑", viewer: "查看者",
};
export const VIS_LABEL: Record<string, string> = {
  public: "公开（持链接即可）", org: "组织成员", project: "项目成员", groups: "指定群组",
};
export const PAGE_TYPE_LABEL: Record<string, string> = {
  general: "通用", report: "报告", knowledge: "知识库", flowchart: "流程图", architecture: "架构图", vote: "投票",
  requirement: "需求对接", task: "任务页", task_tree: "任务树",
};
const PAGE_TYPE_ICON: Record<string, typeof FileText> = {
  report: FileChartColumn, knowledge: BookOpen, flowchart: Workflow, architecture: Network, vote: Vote,
};
/** 页面类型图标 + 中文名（徽标内用） */
export function PageTypeTag({ type }: { type: string }) {
  const Icon = PAGE_TYPE_ICON[type] ?? FileText;
  return <><Icon className="size-3.5" />{PAGE_TYPE_LABEL[type] ?? type}</>;
}
export const CATEGORY_LABEL: Record<string, string> = { read: "只读", collect: "收集", collab: "协作" };
/** 大类 → 包含的页面类型（列表筛选展开成 ?page_type=）。协作类尚未开放，不列 */
export const CATEGORY_TYPES: Record<string, string[]> = {
  read: ["report", "knowledge", "flowchart", "architecture"],
  collect: ["vote", "general"],
};
