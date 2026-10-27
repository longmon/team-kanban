// 页面查看与提交：/pages/:id 与 /s/:token（api.md §7.2、§8.1、§9、§10）
import { Fragment, lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { Link2, Lock, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, errMsg, get, nicknameStore, post, qs, responseStore, shareGrant, type StoredResponse } from "../api";
import { cn } from "@/lib/utils";
import { Link, navigate, setQuery, useQuery } from "../router";
import {
  AuthCard, copyText, ErrorBox, fmtRel, fmtTime, loadMyProjects, Loading, NativeSelect, Notice, PAGE_TYPE_LABEL, REDUCED, toast, useAction, useLoad, useOwnOrg, useSession,
} from "../ui";
import { cachedPage, patchCachedPage } from "./feed";
import { ShareLinkForm } from "./links";
import { PageMetaEditor } from "./project";
import { ResultsView } from "./results";
import type { Locked } from "../openui-lib/forms";
import type { Group, Page, Paged, PageView } from "../types";

const OpenUIView = lazy(() => import("./openui-view"));

// 含图表/表格/KPI 块、知识库（左侧目录）的 OpenUI 页面与 HTML 页面放宽到 1024px；其余 OpenUI 正文 720px 居中
const WIDE_RE = /\b(?:BarChart|LineChart|AreaChart|PieChart|RadarChart|HorizontalBarChart|ScatterChart|Table|SnippetCardBlock|OverviewCardBlock|Diagram)\s*\(/;
const isWide = (v: PageView) => v.content.kind === "html" || v.page.page_type === "knowledge" || WIDE_RE.test(v.content.spec);

export type Source = { kind: "page"; id: string } | { kind: "share"; token: string };

export const BLOCK_MSG: Record<string, string> = {
  read_only: "只读页面，不接受提交",
  responses_closed: "页面已停止接受提交",
  share_link_exhausted: "该临时链接的提交次数已用完",
  share_link_expired: "该临时链接已过期",
  share_link_revoked: "该临时链接已被撤销",
  already_submitted: "你已提交过这个版本",
  nickname_required: "请先在页面顶部填写昵称",
  not_allowed: "当前身份不能提交",
  busy: "上一次提交尚未完成",
};

const shareHeaders = (src: Source): Record<string, string> => {
  if (src.kind !== "share") return {};
  const g = shareGrant.get(src.token);
  return g ? { "X-Share-Grant": g } : {};
};

export function PageViewRoute({ id }: { id: string }) {
  return <Viewer src={{ kind: "page", id }} />;
}
export function ShareViewRoute({ token }: { token: string }) {
  return <Viewer src={{ kind: "share", token }} />;
}

/** 面包屑「组织 / 项目」：登录且能在我的项目里找到时是链接，否则（未登录、分享链接、无项目角色）是文字，不依赖需登录的数据 */
export function Crumbs({ view }: { view: PageView }) {
  const { me } = useSession();
  const mine = useLoad(() => (me ? loadMyProjects().catch(() => []) : Promise.resolve([])), [me?.user.id]);
  const p = mine.data?.find((x) => x.id === view.page.project.id);
  const org = me?.orgs.find((o) => o.id === view.page.org.id);
  return (
    <>
      {org ? <Link to={`/o/${org.slug}`}>{view.page.org.name}</Link> : <span>{view.page.org.name}</span>}
      {p ? <Link to={`/o/${p.org.slug}/p/${p.slug}`}>{view.page.project.name}</Link> : <span>{view.page.project.name}</span>}
    </>
  );
}

type Panel = "content" | "results" | "manage";

function Viewer({ src }: { src: Source }) {
  const { me } = useSession();
  const [view, setView] = useState<PageView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [panel, setPanel] = useState<Panel>(() => (readQuery("panel") === "results" ? "results" : "content"));
  // 刚提交的记录（立即锁定，不等重新加载）
  const [mine, setMine] = useState<StoredResponse | null>(null);
  const pageId0 = src.kind === "page" ? src.id : "";
  const [count, setCount] = useState<number | null>(() => cachedPage(pageId0)?.response_count ?? null);
  // ?version=N 看历史版本（临时链接只有当前版本）
  const qv = useQuery("version");
  const path = src.kind === "page" ? `/pages/${src.id}/view${qs({ version: qv && /^\d+$/.test(qv) ? qv : undefined })}` : `/s/${encodeURIComponent(src.token)}`;

  const load = useCallback(() => {
    setError(null);
    get<PageView>(path, { headers: shareHeaders(src) }).then(setView, (e) => {
      // grant 失效（链接撤销/过期后重建等）时清掉，回到解锁界面
      if (src.kind === "share" && e instanceof ApiError && e.code === "share_password_required") shareGrant.set(src.token, null);
      setError(e);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  // 登录状态变化时重新判定权限
  useEffect(load, [load, me?.user.id]);
  useOwnOrg(view?.page.org.id);

  const cv = view ? view.content.version ?? view.page.version : 0;
  const historical = !!view && cv < view.page.version;
  // 匿名访客与临时链接访问：服务端不记，按 localStorage 锁定
  const anonLike = !!view && (view.viewer.type === "anonymous" || src.kind === "share");
  // 提交成功：立即锁定（写 localStorage）；结果对我可见时稍等锁定动效再切到结果，否则显示「已提交」
  const onSubmitted = useCallback((data: Record<string, unknown>, seq: number) => {
    if (!view) return;
    const rec = { seq, page_version: cv, data, created_at: new Date().toISOString() };
    setMine(rec);
    if (anonLike) responseStore.set(view.page.id, cv, rec);
    setCount((c) => (c === null ? c : c + 1));
    if (view.can_view_results) setTimeout(() => setPanel("results"), REDUCED ? 0 : 900);
  }, [view, cv, anonLike]);
  // 当前版本没交过、但交过上一版：提示「页面已更新到第 M 版，可以重新提交」（登录用户多查一次上一版的 my_response）
  const [resubmit, setResubmit] = useState(false);
  const checkPrev = !!view && !historical && cv > 1 && view.page.category !== "read" && view.can_submit && !view.my_response;
  useEffect(() => {
    setResubmit(false);
    if (!checkPrev || !view) return;
    if (anonLike) return setResubmit(!responseStore.get(view.page.id, cv) && !!responseStore.get(view.page.id, cv - 1));
    if (src.kind !== "page") return;
    let live = true;
    get<PageView>(`/pages/${view.page.id}/view?version=${cv - 1}`).then((v) => live && setResubmit(!!v.my_response), () => {});
    return () => void (live = false);
  }, [checkPrev, view?.page.id, cv, anonLike]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    const code = error instanceof ApiError ? error.code : "";
    if (src.kind === "share" && code === "share_password_required") return <Unlock token={src.token} onUnlocked={load} />;
    if (code === "share_link_expired" || code === "share_link_revoked")
      return <AuthCard><Notice tone="warning">{BLOCK_MSG[code]}</Notice></AuthCard>;
    if (code === "not_found")
      return (
        <AuthCard>
          <Notice tone="warning">{me ? "页面不存在，或你没有查看权限。" : "页面不存在，或需要登录后才能查看。"}</Notice>
          {!me && <Button asChild><Link to={"/login?next=" + encodeURIComponent(location.pathname)}>去登录</Link></Button>}
        </AuthCard>
      );
    return <AuthCard><ErrorBox error={error} /><Button variant="outline" onClick={load}>重试</Button></AuthCard>;
  }
  if (!view) return <ViewerSkeleton />;

  const pageId = view.page.id;
  const collect = view.page.category !== "read";
  const showResults = view.can_view_results && collect;
  const manage = view.can_manage && src.kind === "page";
  // 我对所看版本的提交：刚交的 → 服务端记录（登录用户）→ localStorage（匿名）
  const resp = (mine?.page_version === cv ? mine : null)
    ?? (view.my_response?.page_version === cv ? view.my_response : null)
    ?? (anonLike ? responseStore.get(pageId, cv) : null);
  const locked: Locked | null = collect && resp ? { values: valuesOf(resp.data), version: cv } : null;
  const versions = view.versions ?? [];
  const meta = [
    view.page.page_type !== "general" && PAGE_TYPE_LABEL[view.page.page_type],
    view.page.generated_by && `由 ${view.page.generated_by} 生成`,
    `更新于 ${fmtRel(view.page.updated_at)}`,
    versions.length < 2 && view.page.version > 1 && `第 ${view.page.version} 版`,
    resp && `你已提交第 ${cv} 版`,
  ].filter(Boolean) as string[];
  return (
    <article className={cn("mx-auto flex w-full flex-col gap-6", isWide(view) ? "max-w-5xl" : "max-w-[720px]")}>
      <header className="grid gap-2">
        <nav aria-label="路径" className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground [&>*+*]:before:mr-1.5 [&>*+*]:before:text-border [&>*+*]:before:content-['/'] [&_a]:underline-offset-4 [&_a]:transition-colors [&_a:hover]:text-foreground [&_a:hover]:underline">
          <Crumbs view={view} />
        </nav>
        <h1 data-vt={pageId} className="w-fit text-[28px] leading-tight font-bold [overflow-wrap:anywhere] max-sm:text-[23px]">{(historical && view.content.title) || view.page.title}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-[13px] text-muted-foreground">
            {meta.map((m, i) => <Fragment key={m}>{i > 0 && "，"}<span>{m}</span></Fragment>)}
          </p>
          {versions.length > 1 && (
            <NativeSelect aria-label="版本" size="sm" className="h-7 w-auto gap-1 rounded-full px-3 text-[13px]" value={String(cv)}
              onChange={(v) => setQuery("version", Number(v) === view.page.version ? null : v)}
              options={versions.map((x) => [String(x.version), `第 ${x.version} 版${x.version === view.page.version ? "（当前）" : ""}`])} />
          )}
        </div>
        {view.share_link && (
          <p className="text-[13px] text-muted-foreground">
            通过临时链接「{view.share_link.label || "未命名"}」访问，有效至 {fmtTime(view.share_link.expires_at)}
            {view.share_link.remaining_uses !== null && `，剩余 ${view.share_link.remaining_uses} 次提交`}
          </p>
        )}
      </header>
      {historical && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-highlight bg-highlight/25 px-4 py-2.5 text-sm">
          <span>你在看第 {cv} 版，当前是第 {view.page.version} 版。历史版本只读。</span>
          <Button size="sm" variant="outline" onClick={() => setQuery("version", null)}>回到最新版</Button>
        </div>
      )}
      {resubmit && !resp && <Notice tone="info">页面已更新到第 {cv} 版，可以重新提交。</Notice>}
      {mine && !view.can_view_results && <Notice tone="success">已提交，结果仅页面管理者可见。</Notice>}
      {panel === "results" && showResults && (
        <section aria-label="结果" className="page-enter">
          <ResultsView src={src} pageId={pageId} manager={view.can_manage} compact={!isWide(view)} mine={mine?.data ?? null} onCount={setCount}
            spec={view.content.kind === "openui" ? view.content.spec : undefined} />
        </section>
      )}
      {panel === "manage" && manage && <ManagePanel view={view} onSaved={load} />}
      {/* 内容保持挂载（表单填写状态、iframe 不丢），切到结果/管理时隐藏 */}
      <div hidden={panel !== "content"}>
        <Submitter key={cv} view={view} src={src} onSubmitted={onSubmitted} historical={historical} locked={locked} resp={resp} />
      </div>
      <Dock
        items={[
          ["content", collect && view.page.accept_responses && !historical ? (view.page.page_type === "vote" ? "投票" : "填写") : "内容"],
          ...(showResults ? [["results", count === null ? "结果" : `结果 ${count}`] as [Panel, string]] : []),
          ...(manage ? [["manage", "管理"] as [Panel, string]] : []),
        ]}
        panel={panel} setPanel={setPanel}
      />
    </article>
  );
}

/** 提交数据 → 字段值：OpenUI 提交是 {action, form, values, params}，HTML 提交是任意对象 */
const valuesOf = (d: Record<string, unknown>) =>
  (d.values && typeof d.values === "object" && !Array.isArray(d.values) ? d.values : d) as Record<string, unknown>;

/** 只在首次渲染时读一次查询参数（?panel=results 从动态流「看结果」进来） */
const readQuery = (name: string) => new URLSearchParams(location.search).get(name);

/** 底部浮动操作条：入场弹起；切换时选中底块滑动；复制链接直接复制当前地址 */
function Dock({ items, panel, setPanel }: { items: [Panel, string][]; panel: Panel; setPanel: (p: Panel) => void }) {
  const btn = "relative rounded-full px-3.5 py-1.5 text-[13px] font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-highlight/70";
  // 挂到 body：路由入场动画的 transform 会让 fixed 相对内容区定位
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-3 sm:bottom-6">
      <motion.div role="toolbar" aria-label="页面操作"
        initial={REDUCED ? false : { y: 28, opacity: 0, scale: 0.96 }} animate={{ y: 0, opacity: 1, scale: 1 }}
        transition={{ type: "spring", bounce: 0.35, duration: 0.4, delay: 0.1 }}
        className="pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full bg-foreground p-1 text-background shadow-dock [scrollbar-width:none]">
        {items.map(([k, label]) => (
          <button key={k} type="button" aria-pressed={panel === k} onClick={() => setPanel(panel === k && k !== "content" ? "content" : k)}
            className={cn(btn, panel === k ? "text-highlight-foreground" : "text-background/80 hover:text-background")}>
            {panel === k && <motion.span layoutId="dock-sel" className="absolute inset-0 rounded-full bg-highlight" transition={{ type: "spring", bounce: 0.2, duration: 0.3 }} />}
            <span className="relative">{label}</span>
          </button>
        ))}
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-background/20" />
        <button type="button" className={cn(btn, "flex items-center gap-1.5 text-background/80 hover:text-background")} onClick={() => copyText(location.href, "已复制链接")}>
          <Link2 className="size-3.5" />复制链接
        </button>
      </motion.div>
    </div>,
    document.body,
  );
}

/** 页面设置：PageMetaEditor 需要可见性、群组等完整字段，先从动态流缓存取，取不到再请求 GET /pages/{id} */
function ManagePanel({ view, onSaved }: { view: PageView; onSaved: () => void }) {
  const { me } = useSession();
  const id = view.page.id;
  const page = useLoad(async () => {
    const c = cachedPage(id);
    return c ?? (await get<Page>(`/pages/${id}`));
  }, [id, view.page.updated_at]);
  const inOrg = !!me?.orgs.some((o) => o.id === view.page.org.id);
  const groups = useLoad(() => (inOrg ? get<Paged<Group>>(`/orgs/${view.page.org.id}/groups?limit=200`) : Promise.resolve({ items: [], next_cursor: null })), [view.page.org.id, inOrg]);
  return (
    <section aria-label="管理" className="page-enter grid gap-8">
      <div className="grid gap-3">
        <h2 className="text-base font-bold">页面设置</h2>
        <ErrorBox error={page.error} />
        {page.data ? (
          <PageMetaEditor key={page.data.updated_at} page={{ ...page.data, title: view.page.title, accept_responses: view.page.accept_responses, results_visible_to: view.page.results_visible_to }}
            groups={groups.data?.items ?? []}
            onSaved={() => (patchCachedPage(id), onSaved())}
            onDeleted={() => (toast.ok("已删除"), navigate("/", true))} />
        ) : !page.error && <Loading />}
      </div>
      <div className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-bold">临时链接</h2>
          <Link className="link text-[13px]" to={`/pages/${id}/links`}>管理全部临时链接</Link>
        </div>
        <p className="text-[13px] text-muted-foreground">让不在项目里的人（含未登录用户）查看并提交此页面，不受可见性限制。</p>
        <ShareLinkForm pageId={id} />
      </div>
    </section>
  );
}

function Unlock({ token, onUnlocked }: { token: string; onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      const r = await post<{ grant: string; expires_at: string }>(`/s/${encodeURIComponent(token)}/unlock`, { password });
      shareGrant.set(token, r.grant);
      onUnlocked();
    });
  };
  const wrong = a.error instanceof ApiError && a.error.code === "share_password_invalid";
  return (
    <AuthCard title={<span className="flex items-center gap-2"><Lock className="size-4.5 text-muted-foreground" />需要密码</span>} desc="此链接受密码保护，请输入分享者提供的密码。">
      <form onSubmit={submit} className="grid gap-3">
        <Input type="password" autoFocus required value={password} onChange={(e) => setPassword(e.target.value)} aria-label="密码" />
        {wrong ? <Notice tone="error">密码错误</Notice> : <ErrorBox error={a.error} />}
        <Button type="submit" loading={a.busy} disabled={a.busy}>解锁</Button>
      </form>
    </AuthCard>
  );
}

/** 昵称栏 + 提交通道；openui 与 html 两种内容共用。onSubmitted：提交成功后（数据为提交的 data） */
function Submitter({ view, src, onSubmitted, historical, locked, resp }: {
  view: PageView; src: Source; onSubmitted: (data: Record<string, unknown>, seq: number) => void;
  historical: boolean; locked: Locked | null; resp: StoredResponse | null;
}) {
  const anon = view.viewer.type === "anonymous";
  const [nickname, setNickname] = useState(nicknameStore.get);
  const nickRef = useRef<HTMLInputElement>(null);
  const nickVal = useRef(nickname);
  nickVal.current = nickname;

  const submit = useCallback(
    async (data: Record<string, unknown>): Promise<number> => {
      if (locked || resp) throw new ApiError(409, "already_submitted", BLOCK_MSG.already_submitted);
      if (!view.can_submit || historical) throw new ApiError(409, view.submit_block_reason ?? "not_allowed", BLOCK_MSG[view.submit_block_reason ?? "not_allowed"]);
      const nick = nickVal.current.trim();
      if (anon && !nick) {
        nickRef.current?.focus();
        throw new ApiError(400, "nickname_required", BLOCK_MSG.nickname_required);
      }
      const url = src.kind === "page" ? `/pages/${src.id}/responses` : `/s/${encodeURIComponent(src.token)}/responses`;
      const r = await post<{ id: string; seq: number }>(url, anon ? { data, nickname: nick } : { data }, { headers: shareHeaders(src) });
      onSubmitted(data, r.seq);
      return r.seq;
    },
    [view, src, anon, onSubmitted, locked, resp, historical],
  );
  // 外壳 h1 已是页面标题：OpenUI 正文第一个大标题与之相同时隐藏，避免标题重复
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = body.current;
    if (!el || view.content.kind !== "openui") return;
    const t = view.page.title.trim();
    const check = () => {
      const h = el.querySelector<HTMLElement>('[class*="text-[22px]"]');
      if (!h) return false;
      if (h.textContent?.trim() === t) h.hidden = true;
      return true;
    };
    if (check()) return;
    const mo = new MutationObserver(() => check() && mo.disconnect());
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [view.content.kind, view.page.title]);

  // OpenUI 内容直接放在页面底色上（内部卡片自带表面）；html iframe 仍放在一张卡片里
  return (
    <div ref={body} className="flex flex-col gap-4">
      {/* 只读页面本来就没有提交入口，不提示 */}
      {!view.can_submit && !historical && !resp && view.submit_block_reason && view.submit_block_reason !== "read_only" && <Notice tone="warning">{BLOCK_MSG[view.submit_block_reason]}</Notice>}
      {anon && view.can_submit && !historical && !resp && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-muted/60 px-4 py-3">
          <Label htmlFor="relay-nick" className="text-[13px] whitespace-nowrap">你的昵称</Label>
          <Input id="relay-nick" ref={nickRef} maxLength={50} placeholder="提交前请填写" value={nickname} className="h-8 max-w-60 flex-[1_1_160px] bg-background"
            onChange={(e) => (setNickname(e.target.value), nicknameStore.set(e.target.value))} />
          <span className="text-xs text-muted-foreground">未登录提交时，页面管理者会看到这个名字</span>
        </div>
      )}
      {view.content.kind === "openui" ? (
        <Suspense fallback={<ContentSkeleton />}>
          {view.page.page_type === "knowledge"
            ? <KnowledgeLayout><OpenUIView spec={view.content.spec} submit={submit} readOnly /></KnowledgeLayout>
            : <OpenUIView spec={view.content.spec} submit={submit} readOnly={view.page.category === "read" || historical} locked={locked} />}
        </Suspense>
      ) : (
        <div className="surface overflow-hidden">
          <HtmlFrame view={view} frameUrl={view.content.frame_url} submit={submit} nickname={anon ? nickname.trim() || null : null}
            canSubmit={view.can_submit && !historical && !resp} version={view.content.version ?? view.page.version} resp={resp} />
        </div>
      )}
    </div>
  );
}

type Toc = { id: string; text: string; level: number }[];

/** 知识库页：从正文 Markdown 的 h2/h3 生成目录，xl 起左侧 240px sticky；没有标题时不显示 */
function KnowledgeLayout({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [toc, setToc] = useState<Toc>([]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scan = () => {
      const items: Toc = [];
      el.querySelectorAll<HTMLElement>(".md h2, .md h3").forEach((h, i) => {
        h.id ||= `kb-${i + 1}`;
        items.push({ id: h.id, text: h.textContent ?? "", level: h.tagName === "H2" ? 2 : 3 });
      });
      setToc((old) => (JSON.stringify(old) === JSON.stringify(items) ? old : items));
    };
    scan();
    // 内容懒加载、流式渲染：DOM 变化时重新扫描
    const mo = new MutationObserver(scan);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
  const go = (id: string) => {
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(id)?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  };
  return (
    <div className={cn("grid gap-6", toc.length > 0 && "xl:grid-cols-[240px_minmax(0,1fr)]")}>
      {toc.length > 0 && (
        <nav aria-label="目录" className="hidden xl:block">
          <div className="sticky top-6 flex max-h-[calc(100vh-3rem)] flex-col gap-1 overflow-y-auto border-l pl-4 text-[13px]">
            <div className="mb-1 font-semibold">目录</div>
            {toc.map((t) => (
              <a key={t.id} href={`#${t.id}`} className={cn("py-0.5 text-muted-foreground transition-colors hover:text-foreground", t.level === 3 && "pl-3")}
                onClick={(e) => (e.preventDefault(), go(t.id))}>{t.text}</a>
            ))}
          </div>
        </nav>
      )}
      <div ref={ref} className="min-w-0">{children}</div>
    </div>
  );
}

type Submit = (data: Record<string, unknown>) => Promise<number>;

function HtmlFrame({ view, frameUrl, submit, nickname, canSubmit, version, resp }: {
  view: PageView; frameUrl: string; submit: Submit; nickname: string | null; canSubmit: boolean; version: number; resp: StoredResponse | null;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(600);
  const inflight = useRef(false);

  const init = useCallback(() => {
    ref.current?.contentWindow?.postMessage(
      {
        v: 1, type: "relay:init", can_submit: canSubmit, submit_block_reason: resp ? "already_submitted" : view.submit_block_reason,
        viewer: view.viewer.type === "user" ? { type: "user", display_name: view.viewer.display_name } : { type: "anonymous", nickname },
        // 桥接脚本据此回填并锁定 <form data-kanban>（api.md §9）
        version, my_response: resp,
      },
      "*", // 不透明源只能用 "*"，只发非敏感内容（§9）
    );
    // resp 每次渲染可能是新对象（localStorage 读出），按内容比较，避免反复 init
  }, [view, nickname, canSubmit, version, JSON.stringify(resp)]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onMsg = async (ev: MessageEvent) => {
      const win = ref.current?.contentWindow;
      const d = ev.data;
      if (!win || ev.source !== win || !d || d.v !== 1 || typeof d.type !== "string" || !d.type.startsWith("relay:")) return;
      const reply = (m: Record<string, unknown>) => win.postMessage({ v: 1, type: "relay:submit_result", ...m }, "*");
      if (d.type === "relay:ready") init();
      else if (d.type === "relay:resize" && typeof d.height === "number" && isFinite(d.height)) setHeight(Math.min(20000, Math.max(200, d.height)));
      else if (d.type === "relay:submit") {
        const req_id = typeof d.req_id === "string" ? d.req_id.slice(0, 64) : "";
        if (!req_id) return;
        if (typeof d.data !== "object" || d.data === null || Array.isArray(d.data))
          return reply({ req_id, ok: false, error: { code: "validation_failed", message: "data 必须是对象" } });
        if (inflight.current) return reply({ req_id, ok: false, error: { code: "busy", message: BLOCK_MSG.busy } });
        inflight.current = true;
        try {
          const seq = await submit(d.data);
          toast.ok(`已提交（#${seq}）`);
          reply({ req_id, ok: true, seq });
        } catch (e) {
          const code = e instanceof ApiError ? e.code : "internal";
          if (code !== "nickname_required") toast.err(errMsg(e));
          reply({ req_id, ok: false, error: { code, message: errMsg(e) } });
        } finally {
          inflight.current = false;
        }
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [init, submit]);

  // 昵称或权限变化后同步给 iframe
  useEffect(init, [init]);

  return (
    <div className="overflow-hidden">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-5 py-2 text-xs text-muted-foreground sm:px-8">
        <ShieldAlert className="size-3.5 shrink-0" />以下内容由 agent 生成，请勿在其中输入密码等敏感信息
      </div>
      <iframe
        ref={ref}
        title={view.page.title}
        src={frameUrl}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        style={{ height }}
        className="html-frame block w-full border-0 bg-white"
      />
    </div>
  );
}

function ContentSkeleton() {
  return (
    <div className="grid gap-4" role="status" aria-label="加载中">
      <Skeleton className="h-6 w-1/2" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

function ViewerSkeleton() {
  return (
    <div className="flex w-full flex-col gap-6">
      <div className="grid gap-2"><Skeleton className="h-3.5 w-40" /><Skeleton className="h-7 w-72" /><Skeleton className="h-3.5 w-52" /></div>
      <ContentSkeleton />
    </div>
  );
}
