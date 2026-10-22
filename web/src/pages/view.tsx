// 页面查看与提交：/pages/:id 与 /s/:token（api.md §7.2、§8.1、§9、§10）
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Lock, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, errMsg, get, nicknameStore, post, shareGrant } from "../api";
import { cn } from "@/lib/utils";
import { Link, navigate } from "../router";
import { AuthCard, ErrorBox, fmtTime, Notice, PageHeader, toast, useAction, useOwnOrg, useSession } from "../ui";
import { ResultsView } from "./results";
import type { PageView } from "../types";

const OpenUIView = lazy(() => import("./openui-view"));

// 含图表/表格/KPI 块的 OpenUI 页面铺满版心；纯表单/文字页收窄到 max-w-5xl 居中（表单卡本身也是 max-w-5xl）
const WIDE_RE = /\b(?:BarChart|LineChart|AreaChart|PieChart|RadarChart|HorizontalBarChart|ScatterChart|Table|SnippetCardBlock|OverviewCardBlock)\s*\(/;
const isNarrow = (v: PageView) => v.content.kind === "openui" && !WIDE_RE.test(v.content.spec);

export type Source = { kind: "page"; id: string } | { kind: "share"; token: string };

export const BLOCK_MSG: Record<string, string> = {
  responses_closed: "页面已停止接受提交",
  share_link_exhausted: "该临时链接的提交次数已用完",
  share_link_expired: "该临时链接已过期",
  share_link_revoked: "该临时链接已被撤销",
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

function Viewer({ src }: { src: Source }) {
  const { me } = useSession();
  const [view, setView] = useState<PageView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [showResults, setShowResults] = useState(false);
  const path = src.kind === "page" ? `/pages/${src.id}/view` : `/s/${encodeURIComponent(src.token)}`;

  const load = useCallback(() => {
    setError(null);
    get<PageView>(path, { headers: shareHeaders(src) }).then(setView, (e) => {
      // grant 失效（链接吊销/过期后重建等）时清掉，回到解锁界面
      if (src.kind === "share" && e instanceof ApiError && e.code === "share_password_required") shareGrant.set(src.token, null);
      setError(e);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  // 登录状态变化时重新判定权限
  useEffect(load, [load, me?.user.id]);
  useOwnOrg(view?.page.org.id);

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
  return (
    <div className={cn("mx-auto flex w-full flex-col gap-6", isNarrow(view) && "max-w-5xl")}>
      <PageHeader
        crumbs={<><span>{view.page.org.name}</span><span>{view.page.project.name}</span></>}
        title={view.page.title}
        desc={
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]">
            <span>v{view.page.version}</span>
            <span>更新于 {fmtTime(view.page.updated_at)}</span>
            {view.share_link && (
              <>
                <Badge variant="info">临时链接：{view.share_link.label || "未命名"}</Badge>
                <span>有效至 {fmtTime(view.share_link.expires_at)}</span>
                {view.share_link.remaining_uses !== null && <span>剩余 {view.share_link.remaining_uses} 次提交</span>}
              </>
            )}
          </div>
        }
        actions={(view.can_view_results || view.can_manage) && (
          <>
            {view.can_view_results && (src.kind === "page"
              ? <Button size="sm" variant="outline" onClick={() => navigate(`/pages/${pageId}/results`)}>查看结果</Button>
              : <Button size="sm" variant="outline" onClick={() => setShowResults((x) => !x)}>{showResults ? "隐藏结果" : "查看结果"}</Button>)}
            {view.can_manage && <Button size="sm" variant="outline" onClick={() => navigate(`/pages/${pageId}/links`)}>临时链接</Button>}
          </>
        )}
      />
      {showResults && src.kind === "share" && <div className="rounded-xl bg-muted/50 p-4"><ResultsView src={src} pageId={pageId} manager={false} /></div>}
      <Submitter view={view} src={src} />
    </div>
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

/** 昵称栏 + 提交通道；openui 与 html 两种内容共用 */
function Submitter({ view, src }: { view: PageView; src: Source }) {
  const anon = view.viewer.type === "anonymous";
  const [nickname, setNickname] = useState(nicknameStore.get);
  const nickRef = useRef<HTMLInputElement>(null);
  const nickVal = useRef(nickname);
  nickVal.current = nickname;

  const submit = useCallback(
    async (data: Record<string, unknown>): Promise<number> => {
      if (!view.can_submit) throw new ApiError(409, view.submit_block_reason ?? "not_allowed", BLOCK_MSG[view.submit_block_reason ?? "not_allowed"]);
      const nick = nickVal.current.trim();
      if (anon && !nick) {
        nickRef.current?.focus();
        throw new ApiError(400, "nickname_required", BLOCK_MSG.nickname_required);
      }
      const url = src.kind === "page" ? `/pages/${src.id}/responses` : `/s/${encodeURIComponent(src.token)}/responses`;
      const r = await post<{ id: string; seq: number }>(url, anon ? { data, nickname: nick } : { data }, { headers: shareHeaders(src) });
      return r.seq;
    },
    [view, src, anon],
  );

  // OpenUI 内容直接放在页面底色上（内部卡片自带表面）；html iframe 仍放在一张卡片里
  return (
    <div className="flex flex-col gap-4">
      {!view.can_submit && view.submit_block_reason && <Notice tone="warning">{BLOCK_MSG[view.submit_block_reason]}</Notice>}
      {anon && view.can_submit && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-muted/60 px-5 py-3">
          <Label htmlFor="relay-nick" className="text-[13px] whitespace-nowrap">你的昵称</Label>
          <Input id="relay-nick" ref={nickRef} maxLength={50} placeholder="提交前请填写" value={nickname} className="h-8 max-w-60 flex-[1_1_160px] bg-background"
            onChange={(e) => (setNickname(e.target.value), nicknameStore.set(e.target.value))} />
          <span className="text-xs text-muted-foreground">未登录提交时，页面管理者会看到这个名字</span>
        </div>
      )}
      {view.content.kind === "openui" ? (
        <Suspense fallback={<ContentSkeleton />}>
          <OpenUIView spec={view.content.spec} submit={submit} />
        </Suspense>
      ) : (
        <div className="surface overflow-hidden">
          <HtmlFrame view={view} frameUrl={view.content.frame_url} submit={submit} nickname={anon ? nickname.trim() || null : null} />
        </div>
      )}
    </div>
  );
}

type Submit = (data: Record<string, unknown>) => Promise<number>;

function HtmlFrame({ view, frameUrl, submit, nickname }: { view: PageView; frameUrl: string; submit: Submit; nickname: string | null }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(600);
  const inflight = useRef(false);

  const init = useCallback(() => {
    ref.current?.contentWindow?.postMessage(
      {
        v: 1, type: "relay:init", can_submit: view.can_submit, submit_block_reason: view.submit_block_reason,
        viewer: view.viewer.type === "user" ? { type: "user", display_name: view.viewer.display_name } : { type: "anonymous", nickname },
      },
      "*", // 不透明源只能用 "*"，只发非敏感内容（§9）
    );
  }, [view, nickname]);

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
