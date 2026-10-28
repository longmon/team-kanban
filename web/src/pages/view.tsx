// 页面查看与提交：/pages/:id 与 /s/:token（api.md §7.2、§8.1、§9、§10）
// 方向 A：面包屑 + 搜索框；题头（类型图标、大标题、元信息）、薄荷色锁定提示条 + 主区（内容、你的回答、大家的理由卡片、结果明细折叠区、同项目相关页面）
// + 右栏（实时结果、版本、还没参与的人、页面信息、分享链接 / 复制链接 / 管理）；< 1100 右栏下沉
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { motion } from "motion/react";
import { Clock, History, Link2, Lock, Settings2, Share2, ShieldAlert, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, errMsg, get, nicknameStore, post, qs, responseStore, shareGrant, type StoredResponse } from "../api";
import { cn } from "@/lib/utils";
import { Link, navigate, setQuery, useQuery } from "../router";
import {
  AuthCard, copyText, ErrorBox, fmtDue, fmtRel, fmtTime, Initial, isClosed, loadMyProjects, Loading, NativeSelect, Notice, PAGE_TYPE_LABEL, REDUCED, toast, toneOf, ToneIcon,
  useAction, useActiveProject, useLoad, useNow, useOwnOrg, useSession, VIS_LABEL,
} from "../ui";
import { picked, specLabels, splitLetter, tallyValues, type SpecLabels } from "../data";
import { cachedPage, patchCachedPage, relatedPages } from "./feed";
import { SearchButton } from "../shell";
import { ShareLinkForm } from "./links";
import { PageMetaEditor } from "./project";
import { ResultsView, useResponseStream } from "./results";
import type { Locked } from "../openui-lib/forms";
import type { Tally } from "../data";
import type { Group, Page, Paged, PageView, Response } from "../types";

const OpenUIView = lazy(() => import("./openui-view"));
const ApiDocView = lazy(() => import("./apidoc-view"));


export type Source = { kind: "page"; id: string } | { kind: "share"; token: string };

export const BLOCK_MSG: Record<string, string> = {
  read_only: "只读页面，不接受提交",
  responses_closed: "页面已停止接受提交",
  closed: "已截止，不再接受提交",
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

/** 提交数据 → 字段值：OpenUI 提交是 {action, form, values, params}，HTML 提交是任意对象 */
const valuesOf = (d: Record<string, unknown>) =>
  (d.values && typeof d.values === "object" && !Array.isArray(d.values) ? d.values : d) as Record<string, unknown>;

/** 只在首次渲染时读一次查询参数（?panel=results 从格子墙或旧链接进来时展开结果） */
const readQuery = (name: string) => new URLSearchParams(location.search).get(name);

/** 一份提交的摘要：第一个选项字段的选择（字母 + 名称）与文本字段（理由等） */
function describe(values: Record<string, unknown>, labels: SpecLabels | null) {
  let choice: [string, string] | null = null;
  const texts: string[] = [];
  for (const [field, opts] of Object.entries(labels?.options ?? {})) {
    const v = picked(values[field])[0];
    if (v === undefined) continue;
    const keys = Object.keys(opts);
    choice = splitLetter(opts[v] ?? v, Math.max(0, keys.indexOf(v)));
    break;
  }
  for (const [k, v] of Object.entries(values)) if (!labels?.options[k] && typeof v === "string" && v.trim()) texts.push(v.trim());
  return { choice, texts };
}
const who = (r: Response) => (r.respondent.type === "user" ? r.respondent.display_name : r.respondent.nickname);

function Viewer({ src }: { src: Source }) {
  const { me } = useSession();
  const now = useNow();
  const [view, setView] = useState<PageView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [resultsOpen, setResultsOpen] = useState(() => readQuery("panel") === "results");
  const [manageOpen, setManageOpen] = useState(false);
  // 刚提交的记录（立即锁定，不等重新加载）
  const [mine, setMine] = useState<StoredResponse | null>(null);
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
  useActiveProject(view?.page.project.id);

  const cv = view ? view.content.version ?? view.page.version : 0;
  const historical = !!view && cv < view.page.version;
  const collect = !!view && view.page.category !== "read";
  const showResults = !!view && view.can_view_results && collect;
  // 一条 SSE 连接：票卡比例、「大家的理由」、结果明细共用
  const stream = useResponseStream(src, view?.page.id ?? "", showResults);
  const rowsCv = useMemo(() => stream.rows.filter((r) => r.page_version === cv), [stream.rows, cv]);
  const labels = useMemo(() => (view?.content.kind === "openui" ? specLabels(view.content.spec) : null), [view]);
  const tallyCv = useMemo<Tally>(() => tallyValues(rowsCv.map((r) => r.data ?? {})), [rowsCv]);
  // 匿名访客与临时链接访问：服务端不记，按 localStorage 锁定
  const anonLike = !!view && (view.viewer.type === "anonymous" || src.kind === "share");
  // 提交成功：立即锁定（写 localStorage）、票卡翻面露出结果；结果对我可见时稍后展开结果明细
  const onSubmitted = useCallback((data: Record<string, unknown>, seq: number) => {
    if (!view) return;
    const rec = { seq, page_version: cv, data, created_at: new Date().toISOString() };
    setMine(rec);
    if (anonLike) responseStore.set(view.page.id, cv, rec);
    patchCachedPage(view.page.id);
    if (view.can_view_results) setTimeout(() => setResultsOpen(true), REDUCED ? 0 : 900);
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
  const resultsRef = useRef<HTMLElement>(null);

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
  const tone = toneOf(view.page.page_type, view.page.category);
  const vote = tone === "vote";
  const manage = view.can_manage && src.kind === "page";
  const cached = cachedPage(pageId);
  const closed = view.submit_block_reason === "closed" || isClosed(view.page.closes_at, now);
  // 我对所看版本的提交：刚交的 → 服务端记录（登录用户）→ localStorage（匿名）
  const resp = (mine?.page_version === cv ? mine : null)
    ?? (view.my_response?.page_version === cv ? view.my_response : null)
    ?? (anonLike ? responseStore.get(pageId, cv) : null);
  const locked: Locked | null = collect && resp ? { values: valuesOf(resp.data), version: cv } : null;
  // 票卡上的结果：已提交 / 截止 / 历史版本，且结果对我可见、流已连上
  const tally = showResults && stream.status !== "connecting" && (locked || closed || historical || !view.page.accept_responses) ? tallyCv : null;
  const versions = view.versions ?? [];
  const mineDesc = resp ? describe(valuesOf(resp.data), labels) : null;
  const reasons = showResults ? rowsCv.map((r) => ({ r, d: describe(valuesOf(r.data ?? {}), labels) })).filter((x) => x.d.texts.length) : [];
  const count = showResults && stream.status !== "connecting" ? stream.rows.length : cached?.response_count ?? null;
  const toggleResults = () => {
    setResultsOpen((o) => !o);
    if (!resultsOpen) setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" }), 50);
  };
  const metas: ReactNode[] = [
    <span key="type">{PAGE_TYPE_LABEL[view.page.page_type]}</span>,
    cached && <span key="by"><Initial name={cached.created_by.display_name} className="size-5 text-[10px] ring-0" />{cached.created_by.display_name} 发布</span>,
    view.page.generated_by && <span key="gen"><Sparkles className="size-[15px]" />{view.page.generated_by} 生成</span>,
    versions.length > 1 ? null : <span key="ver"><History className="size-[15px]" />{view.page.version > 1 ? `第 ${view.page.version} 版，` : ""}{fmtRel(view.page.updated_at, new Date(now))} 更新</span>,
    collect && view.page.closes_at && <span key="due" className={closed ? undefined : "text-coral-ink"}><Clock className="size-[15px]" />{closed ? "已截止" : `${fmtDue(view.page.closes_at, new Date(now))} 截止`}</span>,
  ].filter(Boolean);
  const related = relatedPages(view.page.project.id, pageId);
  return (
    <article data-tone={tone} className="flex flex-col">
      <div className="flex min-w-0 items-center gap-4">
        <nav aria-label="路径" className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-[13px] text-faint [&_a]:underline-offset-4 [&_a]:transition-colors [&_a:hover]:text-foreground [&_a:hover]:underline [&>*+*]:before:mr-2 [&>*+*]:before:content-['/'] [&>a:nth-child(2)]:font-medium [&>a:nth-child(2)]:text-muted-foreground">
          <Crumbs view={view} /><span className="min-w-0 truncate">{(historical && view.content.title) || view.page.title}</span>
        </nav>
        <SearchButton label="搜索" className="w-[260px]" />
      </div>
      {/* 接口文档自带目录与代码栏，占满宽度，右栏下沉到底部 */}
      <div className={cn("mt-[18px] grid items-start gap-7", view.content.kind !== "api" && "min-[1100px]:grid-cols-[minmax(0,1fr)_340px] min-[1500px]:grid-cols-[minmax(0,1fr)_392px]")}>
        <div className="flex min-w-0 flex-col gap-4">
          <section className="band flex items-start gap-4">
            <ToneIcon tone={tone} className="size-12 rounded-[14px] bg-tone-f text-tone [&_svg]:size-6 max-sm:hidden" />
            <div className="min-w-0 flex-1">
              <h1 data-vt={pageId} className="mb-1.5 w-fit text-[28px] leading-[1.25] font-semibold tracking-[-0.01em] [overflow-wrap:anywhere] max-sm:text-[24px]">{(historical && view.content.title) || view.page.title}</h1>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-muted-foreground [&>span]:inline-flex [&>span]:items-center [&>span]:gap-[5px]">
                {metas}
                {versions.length > 1 && (
                  <NativeSelect aria-label="版本" size="sm" className="h-7 w-auto gap-1 rounded-[8px] px-2.5 text-[13px]" value={String(cv)}
                    onChange={(v) => setQuery("version", Number(v) === view.page.version ? null : v)}
                    options={versions.map((x) => [String(x.version), `第 ${x.version} 版${x.version === view.page.version ? "（当前）" : ""}`])} />
                )}
              </div>
              {view.share_link && (
                <p className="mt-2 text-[13px] text-muted-foreground">
                  通过临时链接「{view.share_link.label || "未命名"}」访问，有效至 {fmtTime(view.share_link.expires_at)}
                  {view.share_link.remaining_uses !== null && `，剩余 ${view.share_link.remaining_uses} 次提交`}
                </p>
              )}
            </div>
          </section>
          {locked && (
            <div role="status" className="locknote flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[12px] bg-mint-soft px-3.5 py-[11px] text-[13px] text-mint-ink">
              <Lock className="size-[18px] shrink-0" />
              <span className="min-w-0 flex-1">
                你在第 {cv} 版{mineDesc?.choice ? <>{vote ? "投给了" : "选择了"} <b className="font-semibold">{mineDesc.choice[0]}. {mineDesc.choice[1]}</b>，</> : "已提交，"}
                {historical ? "历史版本只读。" : `答案已锁定。发布新版本后可以重新${vote ? "投" : "提交"}。`}
              </span>
              {resp && <span className="shrink-0 tabular-nums">{fmtRel(resp.created_at, new Date(now))} 提交</span>}
            </div>
          )}
          {historical && (
            <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-highlight px-4 py-2.5 text-sm text-highlight-foreground">
              <span>你在看第 {cv} 版，当前是第 {view.page.version} 版。历史版本只读。</span>
              <Button size="sm" variant="outline" onClick={() => setQuery("version", null)}>回到最新版</Button>
            </div>
          )}
          {resubmit && !resp && <Notice tone="info">页面已更新到第 {cv} 版，可以重新提交。</Notice>}
          {mine && !view.can_view_results && <Notice tone="success">已提交，结果仅页面管理者可见。</Notice>}
          <Submitter key={cv} view={view} src={src} onSubmitted={onSubmitted} historical={historical} locked={locked} resp={resp} tally={tally} closed={closed} />
          {collect && resp && mineDesc && (
            <Box title="你的回答" note={fmtRel(resp.created_at, new Date(now))}>
              <div className="flex items-center gap-3 rounded-r-[10px] border-l-[3px] border-primary bg-background px-3.5 py-2.5">
                {mineDesc.choice && <span className="grid size-10 shrink-0 place-items-center rounded-[11px] bg-primary text-[16px] font-bold text-primary-foreground">{mineDesc.choice[0]}</span>}
                <div className="min-w-0">
                  <b className="font-semibold">{mineDesc.choice?.[1] ?? `第 ${cv} 版已提交`}</b>
                  {mineDesc.texts.map((t, i) => <p key={i} className="text-[13px] [overflow-wrap:anywhere] text-muted-foreground">{t}</p>)}
                </div>
              </div>
              {!historical && <p className="mt-2.5 text-[13px] text-faint">想改答案？页面发布第 {cv + 1} 版后这里会重新打开，旧答案会保留在第 {cv} 版里。</p>}
            </Box>
          )}
          {collect && reasons.length > 0 && (
            <section aria-label={vote ? "大家的理由" : "大家的回答"}>
              <h2 className="mb-2.5 text-[13px] font-medium tracking-normal text-faint">{vote ? "大家的理由" : "大家的回答"}<span className="ml-1.5 tabular-nums">{reasons.length}</span></h2>
              <ul className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                {reasons.slice(-6).reverse().map(({ r, d }) => (
                  <li key={r.seq} className="rounded-[14px] border bg-card px-3.5 py-3 text-[13px] text-muted-foreground">
                    <div className="mb-1.5 flex items-center gap-2 font-medium text-foreground">
                      <Initial name={who(r)} className="size-[22px] text-[11px] ring-0" />
                      <span className="min-w-0 truncate">{who(r)}</span>
                      {d.choice && <em className="ml-auto shrink-0 text-[12px] font-normal text-faint not-italic">{vote ? "投" : "选"} {d.choice[0]}</em>}
                    </div>
                    <p className="[overflow-wrap:anywhere]">{d.texts.join("；")}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {showResults && resultsOpen && (
            <section ref={resultsRef} aria-label="结果" className="page-enter scroll-mt-24 rounded-[16px] border bg-card p-5">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-[16px] font-semibold">全部结果</h2>
                <Link to={`/pages/${pageId}/results`} className="link text-[13px]">在单独页面打开</Link>
              </div>
              <ResultsView src={src} pageId={pageId} manager={view.can_manage} compact mine={mine?.data ?? null} stream={stream}
                spec={view.content.kind === "openui" ? view.content.spec : undefined} />
            </section>
          )}
          {related.length > 0 && (
            <section aria-label="同项目的相关页面" className="mt-2">
              <h2 className="mb-2.5 text-[13px] font-medium tracking-normal text-faint">同项目的相关页面</h2>
              <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                {related.map((p) => (
                  <Link key={p.id} to={`/pages/${p.id}`} className="flex min-w-0 items-center gap-2.5 rounded-[14px] border bg-card px-3.5 py-3 outline-none transition-colors hover:border-input focus-visible:ring-[3px] focus-visible:ring-ring/80">
                    <ToneIcon tone={toneOf(p.page_type, p.category)} className="size-[34px] bg-tone-f text-tone [&_svg]:size-[18px]" />
                    <span className="min-w-0">
                      <b className="block truncate font-semibold">{p.title}</b>
                      <small className="block truncate text-[12px] text-faint">{p.generated_by ? `${p.generated_by} 生成` : `${p.created_by.display_name} 发布`}{p.version > 1 ? `，第 ${p.version} 版` : `，${fmtRel(p.updated_at, new Date(now))}`}</small>
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
        <aside aria-label="页面信息" className="flex min-w-0 flex-col gap-3.5">
          {collect && <Progress view={view} rows={rowsCv} showResults={showResults} vote={vote} now={now} tally={tally} labels={labels} mine={resp ? valuesOf(resp.data) : null} />}
          {versions.length > 0 && (
            <Box title={<><History className="size-4" />版本</>}>
              <div className="flex flex-col gap-1.5">
                {versions.map((x) => (
                  <button key={x.version} type="button" aria-current={x.version === cv || undefined}
                    onClick={() => setQuery("version", x.version === view.page.version ? null : String(x.version))}
                    className="flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-[13px] text-muted-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/80 aria-[current]:bg-primary-soft aria-[current]:text-foreground">
                    <b className="shrink-0 font-semibold text-foreground">第 {x.version} 版</b>
                    <span className="min-w-0 truncate">{fmtRel(x.created_at, new Date(now))}</span>
                    <em className="ml-auto shrink-0 text-[12px] text-faint not-italic">{x.version === view.page.version ? "当前版本" : "只读"}{x.version === cv && resp ? "，你已提交" : ""}</em>
                  </button>
                ))}
              </div>
            </Box>
          )}
          {collect && <Pending view={view} rows={rowsCv} showResults={showResults} vote={vote} />}
          <Box title="页面信息">
            <dl className="grid grid-cols-[72px_1fr] gap-x-2.5 gap-y-[7px] text-[13px] [&_dd]:min-w-0 [&_dt]:text-faint">
              <dt>项目</dt><dd className="truncate">{view.page.project.name}</dd>
              {cached && <><dt>可见范围</dt><dd>{VIS_LABEL[cached.visibility]}</dd></>}
              {collect && <><dt>结果可见</dt><dd>{view.page.results_visible_to === "viewers" ? "所有能查看的人" : "仅页面管理者"}</dd></>}
              {collect && <><dt>截止</dt><dd>{view.page.closes_at ? fmtDue(view.page.closes_at, new Date(now)) : view.page.accept_responses ? "不截止" : "已停止收集"}</dd></>}
              {collect && count !== null && <><dt>提交</dt><dd className="tabular-nums">{count} 份</dd></>}
              <dt>类型</dt><dd>{PAGE_TYPE_LABEL[view.page.page_type]}</dd>
            </dl>
          </Box>
          {showResults && (
            <Button variant="secondary" onClick={toggleResults} aria-expanded={resultsOpen}>{resultsOpen ? "收起结果" : `查看全部结果${count !== null ? ` ${count}` : ""}`}</Button>
          )}
          <div className="flex gap-2 [&>button]:h-[34px] [&>button]:rounded-[10px]">
            <Button variant="outline" className="flex-1" onClick={() => (navigator.share ? navigator.share({ title: view.page.title, url: location.href }).catch(() => {}) : copyText(location.href, "已复制链接"))}>
              <Share2 />分享链接
            </Button>
            <Button variant="outline" className="flex-1" onClick={() => copyText(location.href, "已复制链接")}><Link2 />复制链接</Button>
            {manage && <Button variant="outline" onClick={() => setManageOpen(true)}><Settings2 />管理</Button>}
          </div>
        </aside>
      </div>
      {manage && (
        <Dialog open={manageOpen} onOpenChange={setManageOpen}>
          <DialogContent className="max-h-[88vh] overflow-y-auto rounded-[18px] p-6 sm:max-w-2xl sm:p-7">
            <DialogHeader>
              <DialogTitle>管理页面</DialogTitle>
              <DialogDescription>页面设置与临时链接</DialogDescription>
            </DialogHeader>
            <ManagePanel view={view} onSaved={load} />
          </DialogContent>
        </Dialog>
      )}
    </article>
  );
}

/** 白底 1px 描边的右栏/主区小卡 */
function Box({ title, note, children }: { title: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-[16px] border bg-card px-[18px] py-4">
      <h3 className="mb-3 flex items-center gap-2 text-[14px] font-semibold">{title}{note && <small className="ml-auto text-[12px] font-normal text-faint">{note}</small>}</h3>
      {children}
    </section>
  );
}

/** 已参与人数：participation 与结果流（页面加载后新到的提交，含我刚交的）取较大；旧后端没有 participation 时按流里去重提交者计数，拿不到返回 null */
function useParticipants(view: PageView, rows: Response[], showResults: boolean) {
  const part = view.participation;
  const seen = showResults ? new Set(rows.map((r) => (r.respondent.type === "user" ? r.respondent.user_id : `anon:${r.seq}`))) : null;
  const n = part ? Math.max(part.respondent_count, seen?.size ?? 0) : seen ? seen.size : null;
  return { n, total: part?.eligible_count ?? null, pending: part?.pending?.filter((u) => !seen?.has(u.id)) ?? [] };
}

/** 实时结果：已参与 / 可提交人数与进度条；结果对我可见且已提交（或截止、历史版本）时显示第一个选项字段的结果条（我的选择高亮）与提交者头像 */
function Progress({ view, rows, showResults, vote, now, tally, labels, mine }: {
  view: PageView; rows: Response[]; showResults: boolean; vote: boolean; now: number; tally: Tally | null; labels: SpecLabels | null; mine: Record<string, unknown> | null;
}) {
  const { n, total } = useParticipants(view, rows, showResults);
  if (n === null) return null;
  const v = vote ? "投" : "交";
  const last = rows.at(-1);
  const field = labels && Object.keys(labels.options).find((f) => tally?.[f]);
  const t = field ? tally![field] : null;
  const opts = field ? Object.entries(labels!.options[field]) : [];
  const my = field && mine ? picked(mine[field]) : [];
  const names = [...new Set(rows.map(who))];
  return (
    <Box title={<><i aria-hidden="true" className="size-2 rounded-full bg-live ring-4 ring-live-ring" />实时结果</>}
      note={last ? (now - new Date(last.created_at).getTime() < 5 * 60000 ? `刚刚有人${vote ? "投票" : "提交"}` : `最近一次 ${fmtRel(last.created_at, new Date(now))}`) : `每次${vote ? "投票" : "提交"}即时刷新`}>
      <div className="flex items-baseline justify-between text-[13px]" role="img" aria-label={total ? `已${v} ${n} 人，共 ${total} 人` : `已${v} ${n} 人`}>
        <span><b className="font-mono text-[20px] font-semibold tabular-nums">{n}</b>{total ? <span className="tabular-nums"> / {total}</span> : ""} 人已{v}</span>
        {total ? <span className="text-faint">还差 {Math.max(0, total - n)} 人</span> : null}
      </div>
      <div className="mt-1.5 mb-3.5 h-2 overflow-hidden rounded-[4px] bg-muted">
        <i className="block h-full rounded-[4px] bg-mint transition-[width] duration-500 ease-rise" style={{ width: `${total ? Math.min(1, n / total) * 100 : n ? 100 : 0}%` }} />
      </div>
      {t && opts.map(([val, label], i) => {
        const c = t.counts[val] ?? 0;
        const pct = t.total ? Math.round((c / t.total) * 100) : 0;
        const me = my.includes(val);
        const [letter, name] = splitLetter(label, i);
        return (
          <div key={val} className="mb-3">
            <div className="mb-[5px] flex justify-between gap-2 text-[13px]">
              <span className={cn("min-w-0 truncate", me && "font-semibold text-primary")}>{letter}. {name}{me && "（你）"}</span>
              <b className="shrink-0 font-semibold tabular-nums">{c} {vote ? "票" : "人"}，{pct}%</b>
            </div>
            <span className="block h-2.5 overflow-hidden rounded-[5px] bg-muted">
              <motion.i className={cn("block h-full rounded-[5px]", me ? "bg-primary" : "bg-primary/40")} initial={REDUCED ? false : { width: 0 }} animate={{ width: `${pct}%` }}
                transition={{ type: "spring", stiffness: 260, damping: 18 }} />
            </span>
          </div>
        );
      })}
      {names.length > 0 && (
        <div className="mt-1 flex items-center">
          <span className="flex -space-x-[7px]">{names.slice(0, 5).map((nm) => <Initial key={nm} name={nm} className="size-[26px] text-[11px]" />)}</span>
          <span className="ml-2 text-[12px] text-faint">{names.length > 5 ? `等 ${names.length} 人` : `${names.length} 人`}</span>
        </div>
      )}
    </Box>
  );
}

/** 还没参与的人（participation.pending，只对管理者返回） */
function Pending({ view, rows, showResults, vote }: { view: PageView; rows: Response[]; showResults: boolean; vote: boolean }) {
  const { pending } = useParticipants(view, rows, showResults);
  if (!pending.length) return null;
  return (
    <Box title={`还没${vote ? "投" : "交"}的 ${pending.length} 人`} note={view.can_manage ? "你是管理者" : undefined}>
      <div className="flex flex-wrap items-center gap-1.5">
        {pending.slice(0, 12).map((u) => <Initial key={u.id} name={u.display_name} muted className="size-7 text-[11px] ring-0" />)}
        {pending.length > 12 && <span className="ml-1 text-[12px] text-faint">等 {pending.length} 人</span>}
      </div>
    </Box>
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
  const groups = useLoad(() => (inOrg ? get<Paged<Group>>(`/orgs/${view.page.org.id}/groups?limit=200&include=project`) : Promise.resolve({ items: [], next_cursor: null })), [view.page.org.id, inOrg]);
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
function Submitter({ view, src, onSubmitted, historical, locked, resp, tally, closed }: {
  view: PageView; src: Source; onSubmitted: (data: Record<string, unknown>, seq: number) => void;
  historical: boolean; locked: Locked | null; resp: StoredResponse | null; tally: Tally | null; closed: boolean;
}) {
  const anon = view.viewer.type === "anonymous";
  const [nickname, setNickname] = useState(nicknameStore.get);
  const nickRef = useRef<HTMLInputElement>(null);
  const nickVal = useRef(nickname);
  nickVal.current = nickname;

  const submit = useCallback(
    async (data: Record<string, unknown>): Promise<number> => {
      if (locked || resp) throw new ApiError(409, "already_submitted", BLOCK_MSG.already_submitted);
      if (closed) throw new ApiError(409, "closed", BLOCK_MSG.closed);
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
    [view, src, anon, onSubmitted, locked, resp, historical, closed],
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
      {!historical && !resp && (closed ? <Notice tone="warning">{BLOCK_MSG.closed}</Notice>
        : !view.can_submit && view.submit_block_reason && view.submit_block_reason !== "read_only" && <Notice tone="warning">{BLOCK_MSG[view.submit_block_reason]}</Notice>)}
      {anon && view.can_submit && !closed && !historical && !resp && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-muted/60 px-4 py-3">
          <Label htmlFor="relay-nick" className="text-[13px] whitespace-nowrap">你的昵称</Label>
          <Input id="relay-nick" ref={nickRef} maxLength={50} placeholder="提交前请填写" value={nickname} className="h-8 max-w-60 flex-[1_1_160px] bg-background"
            onChange={(e) => (setNickname(e.target.value), nicknameStore.set(e.target.value))} />
          <span className="text-xs text-muted-foreground">未登录提交时，页面管理者会看到这个名字</span>
        </div>
      )}
      {view.content.kind === "api" ? (
        <Suspense fallback={<ContentSkeleton />}><ApiDocView spec={view.content.spec} pageTitle={(historical && view.content.title) || view.page.title} /></Suspense>
      ) : view.content.kind === "openui" ? (
        <Suspense fallback={<ContentSkeleton />}>
          {view.page.page_type === "knowledge"
            ? <KnowledgeLayout><OpenUIView spec={view.content.spec} submit={submit} readOnly /></KnowledgeLayout>
            : <OpenUIView spec={view.content.spec} submit={submit} readOnly={view.page.category === "read" || historical || closed} locked={locked} tally={tally} />}
        </Suspense>
      ) : (
        <div className="overflow-hidden rounded-[24px] border">
          <HtmlFrame view={view} frameUrl={view.content.frame_url} submit={submit} nickname={anon ? nickname.trim() || null : null}
            canSubmit={view.can_submit && !closed && !historical && !resp} version={view.content.version ?? view.page.version} resp={resp} />
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
    <div className="flex w-full flex-col gap-5">
      <Skeleton className="h-5 w-64" />
      <Skeleton className="h-[72px] max-w-xl rounded-[14px]" />
      <div className="flex gap-7"><div className="flex-1"><ContentSkeleton /></div><Skeleton className="h-64 w-[340px] rounded-[16px] max-[1100px]:hidden" /></div>
    </div>
  );
}
