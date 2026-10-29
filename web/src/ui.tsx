// 通用小部件与 hooks；视觉组件来自 shadcn/ui（components/ui）
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { toast as sonner } from "sonner";
import { BookOpen, Braces, Check, CircleAlert, ClipboardList, Copy, FileChartColumn, Layers, ListChecks, Vote, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { errMsg, get, setCsrf } from "./api";
import { setQuery, useQuery } from "./router";
import { PixelIcon, TONE_PIXEL } from "./pixel-icons";
import type { Me, MyProject, Paged } from "./types";

/** 系统「减少动态效果」：motion 动画时长归零、不播入场（只在加载时读一次，与 main.tsx 的 tempo 一致） */
export const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- 会话 ----------
type Session = { me: Me | null; loading: boolean; refresh: () => Promise<Me | null>; setMe: (m: Me | null) => void };
const SessionCtx = createContext<Session>(null as unknown as Session);
export const useSession = () => useContext(SessionCtx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMeState] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const setMe = useCallback((m: Me | null) => {
    setCsrf(m?.csrf_token ?? null);
    // 换了登录身份：丢掉上一个人的项目缓存
    if ((m?.user.id ?? null) !== cacheUid) {
      cacheUid = m?.user.id ?? null;
      myProjects = null;
      projListeners.forEach((l) => l());
    }
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
  // 每次整表重载（首次、换筛选、reload）完成 +1：列表容器用作 key，重播依次入场动画
  const [gen, setGen] = useState(0);
  const load = useCallback(
    async (c: string | null, reset: boolean) => {
      if (!path) return;
      setLoading(true);
      try {
        const sep = path.includes("?") ? "&" : "?";
        const r = await get<Paged<T>>(path + (c ? `${sep}cursor=${encodeURIComponent(c)}` : ""));
        setItems((old) => (reset ? r.items : [...old, ...r.items]));
        if (reset) setGen((g) => g + 1);
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
    items, error, loading, hasMore: !!cursor, gen,
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

// ---------- 我的项目（GET /api/me/projects，跨组织；整个会话缓存一份，登录身份变化或增删项目后 reload） ----------
let myProjects: Promise<MyProject[]> | null = null;
let cacheUid: string | null = null;
const projListeners = new Set<() => void>();
export function loadMyProjects(force = false) {
  if (force || !myProjects) {
    myProjects = get<{ items: MyProject[] }>("/me/projects").then((r) => r.items, (e) => ((myProjects = null), Promise.reject(e)));
    if (force) projListeners.forEach((l) => l());
  }
  return myProjects;
}
export const resetMyProjects = () => void (myProjects = null);
export function useMyProjects() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const l = () => setN((x) => x + 1);
    projListeners.add(l);
    return () => void projListeners.delete(l);
  }, []);
  return useLoad(() => loadMyProjects(), [n]);
}

// ---------- 当前组织（命令栏「邀请成员」「组织设置」的默认目标） ----------
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

/** 详情页所属项目（顶栏项目胶囊据此高亮）：详情页挂载时设置、卸载时清掉 */
let activeProject: string | null = null;
const apListeners = new Set<() => void>();
export function useActiveProject(id?: string) {
  useEffect(() => {
    if (id === undefined) return;
    activeProject = id;
    apListeners.forEach((l) => l());
    return () => {
      activeProject = null;
      apListeners.forEach((l) => l());
    };
  }, [id]);
  return useSyncExternalStore((l) => (apListeners.add(l), () => void apListeners.delete(l)), () => activeProject);
}

// ---------- 主题（亮/暗）与皮肤（默认 / 经典） ----------
// 键名与旧版一致（值为 JSON 字符串），已保存的偏好继续生效；未设置时跟随系统
const THEME_KEY = "openui-theme-mode";
type Mode = "light" | "dark";
/** 皮肤：default = 方向 A 长春花工作台；classic = Windows 98 经典（<html data-skin="classic">，强制亮色）。只存本机，读不到用默认 */
const SKIN_KEY = "tk-skin";
export type Skin = "default" | "classic";
const readSkin = (): Skin => {
  try {
    return localStorage.getItem(SKIN_KEY) === "classic" ? "classic" : "default";
  } catch {
    return "default";
  }
};
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
const currentMode = (): Mode => (readSkin() === "classic" ? "light" : readPref() ?? (mq.matches ? "dark" : "light"));
const applyMode = () => {
  const root = document.documentElement;
  root.classList.toggle("dark", currentMode() === "dark");
  if (readSkin() === "classic") root.dataset.skin = "classic";
  else delete root.dataset.skin;
};
applyMode();
mq.addEventListener("change", () => (applyMode(), themeListeners.forEach((l) => l())));
const subscribeTheme = (l: () => void) => (themeListeners.add(l), () => void themeListeners.delete(l));
/** 当前是否经典皮肤 */
export const useClassic = () => useSyncExternalStore(subscribeTheme, readSkin) === "classic";
export function useTheme() {
  const mode = useSyncExternalStore(subscribeTheme, currentMode);
  const skin = useSyncExternalStore(subscribeTheme, readSkin);
  const setSkin = (s: Skin) => {
    try {
      localStorage.setItem(SKIN_KEY, s);
    } catch { /* 隐私模式下只在本次会话生效 */ }
    applyMode();
    themeListeners.forEach((l) => l());
  };
  const setMode = (m: Mode) => {
    try {
      localStorage.setItem(THEME_KEY, JSON.stringify(m));
    } catch { /* 隐私模式下只在本次会话生效 */ }
    applyMode();
    themeListeners.forEach((l) => l());
  };
  return { mode, setMode, skin, setSkin };
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

/** Tab 状态进 URL（?tab=）：刷新、后退、转发链接都保留；默认 Tab 不写参数，无效值回到默认 */
export function useTab(valid: string[], def = valid[0]): [string, (v: string) => void] {
  const q = useQuery("tab");
  return [q && valid.includes(q) ? q : def, (v) => setQuery("tab", v === def ? null : v)];
}

/** 页内一级 tabs：下划线样式，窄屏横向滚动 */
export const PAGE_TABS_LIST = "h-auto w-full justify-start gap-5 overflow-x-auto rounded-none border-b bg-transparent p-0 [scrollbar-width:none]";
export const PAGE_TABS_TRIGGER = "h-auto flex-none rounded-none border-0 border-b-2 border-transparent px-0.5 pt-1 pb-2.5 text-muted-foreground hover:text-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:border-primary dark:data-[state=active]:bg-transparent";

/** 表格外框 */
export function TableCard({ children }: { children: ReactNode }) {
  return <div className="surface overflow-hidden [&_td]:px-4 [&_td]:py-3 [&_th]:px-4 [&_thead]:bg-muted/50">{children}</div>;
}

/** 管理端页面：居中，最宽 1024px */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto flex w-full max-w-5xl flex-col gap-6", className)}>{children}</div>;
}

/** 居中小卡片：登录、注册、错误提示等 */
export function AuthCard({ title, desc, children }: { title?: ReactNode; desc?: ReactNode; children?: ReactNode }) {
  // 经典：Win98 登录对话框（标题栏 + 左侧钥匙图标 + 右侧内容）
  if (useClassic())
    return (
      <div className="cl-auth">
        <section className="cl-win" aria-label={typeof title === "string" ? title : undefined}>
          <div className="cl-titlebar"><PixelIcon name="key" /><span className="cl-t">{title ?? "Team Kanban"}</span></div>
          <div className="cl-auth-body">
            <PixelIcon name="key" size={32} />
            <div className="cl-auth-main">
              {title && <h1 className="sr-only">{title}</h1>}
              {desc && <p>{desc}</p>}
              {children}
            </div>
          </div>
        </section>
      </div>
    );
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

/** 列表页的「新增 / 编辑」弹窗：标题、说明 + 表单；内容超高时内部滚动 */
export function FormDialog({ open = true, onClose, title, desc, children, wide }: {
  open?: boolean; onClose: () => void; title: ReactNode; desc?: ReactNode; children: ReactNode; wide?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={cn("max-h-[calc(100dvh-2rem)] overflow-y-auto", wide && "sm:max-w-xl")} {...(desc ? {} : { "aria-describedby": undefined })}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {desc && <DialogDescription>{desc}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** 管理端内容面板：标题/说明 + 内容 */
export function Panel({ title, desc, actions, children, className, danger }: {
  title?: ReactNode; desc?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; danger?: boolean;
}) {
  return (
    <section data-panel="" className={cn("surface", danger && "ring-1 ring-destructive/30", className)}>
      {(title || actions) && (
        <div data-panel-head="" className={cn("flex flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-6", children != null && "border-b")}>
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
    <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed bg-card/50 px-6 py-10 text-center">
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

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
/** 动态流分组：今天 / 昨天 / 本周（周一起）/ 更早 */
export function dayBucket(iso: string, now = new Date()): "今天" | "昨天" | "本周" | "更早" {
  const t = dayStart(new Date(iso)), today = dayStart(now);
  if (t >= today) return "今天";
  if (t >= today - 864e5) return "昨天";
  return t >= today - ((now.getDay() + 6) % 7) * 864e5 ? "本周" : "更早";
}
/** 相对时间：今天 10:42 / 昨天 10:42 / 周三 10:42 / 10月3日 */
export function fmtRel(iso: string, now = new Date()) {
  const d = new Date(iso), hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const b = dayBucket(iso, now);
  if (b === "今天") return hm;
  if (b === "昨天") return `昨天 ${hm}`;
  if (b === "本周") return `周${"日一二三四五六"[d.getDay()]} ${hm}`;
  return d.toLocaleDateString("zh-CN", { month: "long", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

/** 复制到剪贴板并 toast；非安全上下文（http 内网）没有 clipboard API 时退回 execCommand */
export async function copyText(text: string, msg = "已复制") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
  toast.ok(msg);
}

export function CopyText({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted/60 px-3 py-2 text-[13px] whitespace-nowrap">{text}</code>
      <Button size="sm" variant="outline" onClick={() => copyText(text).then(() => setDone(true))}>
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
  general: "通用", report: "报告", knowledge: "知识库", flowchart: "流程图", architecture: "架构图", api_doc: "接口文档", vote: "投票",
  requirement: "需求对接", task: "任务页", task_tree: "任务树",
};
/** 页面类型 → 糖纸色调（index.css [data-tone]）。通用页按大类：收集类算表单，只读类算知识库；接口文档、任务树各自一色，其它协作类暂归表单 */
export type Tone = "vote" | "form" | "report" | "flow" | "arch" | "book" | "api" | "task";
export function toneOf(type: string, category?: string): Tone {
  switch (type) {
    case "vote": return "vote";
    case "report": return "report";
    case "flowchart": return "flow";
    case "architecture": return "arch";
    case "knowledge": return "book";
    case "api_doc": return "api";
    case "task_tree": return "task";
    case "general": return category === "read" ? "book" : "form";
    default: return "form";
  }
}
/** 六个线性类型图标 */
export const TONE_ICON: Record<Tone, typeof Vote> = {
  vote: Vote, form: ClipboardList, report: FileChartColumn, flow: Workflow, arch: Layers, book: BookOpen, api: Braces, task: ListChecks,
};
/** 圆角方块里的类型图标（格子、题头、动态）；白底 + 类型强调色 */
export function ToneIcon({ tone, className }: { tone: Tone; className?: string }) {
  const Icon = TONE_ICON[tone];
  // 经典：像素图标（题头大图标 32px，其余 16px）
  if (useClassic()) return <PixelIcon name={TONE_PIXEL[tone]} size={/size-12\b/.test(className ?? "") ? 32 : 16} />;
  return (
    <span data-tone={tone} aria-hidden="true" className={cn("grid size-[30px] shrink-0 place-items-center rounded-[10px] bg-card text-tone-ink", className)}>
      <Icon className="size-4" />
    </span>
  );
}

// ---------- 截止与倒计时 ----------
/** 每分钟（整分）刷新一次的当前时间；页面不可见时不刷新，回来立即刷新 */
const nowListeners = new Set<() => void>();
let nowVal = Date.now();
let nowTimer = 0;
const schedule = () => {
  clearTimeout(nowTimer);
  nowTimer = window.setTimeout(tickNow, 60000 - (Date.now() % 60000) + 50);
};
const tickNow = () => {
  nowVal = Date.now();
  nowListeners.forEach((l) => l());
  schedule();
};
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && nowListeners.size && tickNow());
const subscribeNow = (l: () => void) => {
  if (!nowListeners.size) (nowVal = Date.now()), schedule();
  nowListeners.add(l);
  return () => {
    nowListeners.delete(l);
    if (!nowListeners.size) clearTimeout(nowTimer);
  };
};
export const useNow = () => useSyncExternalStore(subscribeNow, () => nowVal);
export const isClosed = (closesAt: string | null | undefined, now = Date.now()) => !!closesAt && new Date(closesAt).getTime() <= now;
/** 剩余时间：「2 天 3 时」「5 时 20 分」「12 分」；已过返回 null */
export function fmtLeft(closesAt: string, now = Date.now()): string | null {
  const m = Math.floor((new Date(closesAt).getTime() - now) / 60000);
  if (m < 0) return null;
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d} 天 ${h} 时` : h ? `${h} 时 ${mm} 分` : `${Math.max(mm, 1)} 分`;
}
/** 截止时间短格式：今天 18:00 / 明天 18:00 / 周四 18:00 / 10月31日 18:00 */
export function fmtDue(iso: string, now = new Date()) {
  const d = new Date(iso), hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const days = Math.round((dayStart(d) - dayStart(now)) / 864e5);
  if (days === 0) return `今天 ${hm}`;
  if (days === 1) return `明天 ${hm}`;
  if (days > 1 && days < 7) return `周${"日一二三四五六"[d.getDay()]} ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 头像底色：白字在上面都 ≥ 4.5:1（亮暗模式通用） */
const AVATAR_BG = ["#6c4cf5", "#9e5627", "#ae4064", "#286cac", "#1a776d", "#42782a"];
/** 名字首字头像（圆形）；颜色按名字稳定取色；muted：未参与的人（灰底） */
export function Initial({ name, className, muted }: { name: string; className?: string; muted?: boolean }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span title={name} data-initial="" className={cn("grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold text-white ring-2 ring-card", muted && "bg-muted text-muted-foreground", className)}
      style={muted ? undefined : { background: AVATAR_BG[h % AVATAR_BG.length] }}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
export const CATEGORY_LABEL: Record<string, string> = { read: "只读", collect: "收集", collab: "协作" };
/** 大类 → 包含的页面类型（列表筛选展开成 ?page_type=）。协作类尚未开放，不列 */
export const CATEGORY_TYPES: Record<string, string[]> = {
  read: ["report", "knowledge", "flowchart", "architecture", "api_doc"],
  collect: ["vote", "general"],
};
