// 提交结果：SSE 实时表格 + 计数条 + CSV 导出（api.md §8.3、§8.4，design §7.4）
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Inbox, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ApiError, get, shareGrant } from "../api";
import { cellText, flattenData, tallies, unionColumns } from "../data";
import { Link } from "../router";
import { AuthCard, Empty, ErrorBox, fmtTime, Loading, Notice, Page, PageHeader, TableCard, useLoad, useOwnOrg } from "../ui";
import { CountUp } from "../openui-lib/util";
import type { PageView, Response } from "../types";
import type { Source } from "./view";

const MAX_ROWS = 500; // ponytail: 只渲染最近 500 行，全量走 CSV；需要时再做虚拟滚动

export function ResultsPage({ id }: { id: string }) {
  const view = useLoad(() => get<PageView>(`/pages/${id}/view`), [id]);
  useOwnOrg(view.data?.page.org.id);
  if (view.loading) return <Page><Loading /></Page>;
  if (view.error) return <AuthCard><ErrorBox error={view.error instanceof ApiError && view.error.code === "not_found" ? new Error("页面不存在或无权查看") : view.error} /></AuthCard>;
  const v = view.data!;
  return (
    <Page>
      <PageHeader crumbs={<><span>{v.page.org.name}</span><span>{v.page.project.name}</span><Link to={`/pages/${id}`}>{v.page.title}</Link></>} title="提交结果" />
      {v.can_view_results
        ? <ResultsView src={{ kind: "page", id }} pageId={id} manager={v.can_manage} />
        : <Notice tone="warning">结果仅对页面管理者可见。</Notice>}
    </Page>
  );
}

type Status = "connecting" | "live" | "reconnecting" | "closed";
const STATUS_TEXT: Record<Status, string> = { connecting: "连接中…", live: "实时更新中", reconnecting: "重新连接中…", closed: "连接已断开" };

export function ResultsView({ src, pageId, manager }: { src: Source; pageId: string; manager: boolean }) {
  const [rows, setRows] = useState<Response[]>([]);
  const [status, setStatus] = useState<Status>("connecting");
  const [pageEvent, setPageEvent] = useState<{ version: number; accept_responses: boolean } | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const [n, setN] = useState(0);
  // 连接后 800ms 内到达的是补发的历史提交；之后到达的算新提交，表格里该行闪一下底色
  const liveAt = useRef(Infinity);
  const fresh = useRef(new Set<number>());

  useEffect(() => {
    setRows([]);
    setEnded(null);
    setStatus("connecting");
    liveAt.current = Infinity;
    const url = src.kind === "page"
      ? `/api/pages/${pageId}/responses/stream?since=0`
      : `/api/s/${encodeURIComponent(src.token)}/responses/stream?since=0` + (shareGrant.get(src.token) ? `&grant=${encodeURIComponent(shareGrant.get(src.token)!)}` : "");
    const es = new EventSource(url);
    es.onopen = () => (setStatus("live"), void (liveAt.current = Math.min(liveAt.current, performance.now() + 800)));
    es.onerror = () => setStatus(es.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
    es.addEventListener("response", (ev) => {
      const r = JSON.parse((ev as MessageEvent).data) as Response;
      if (performance.now() > liveAt.current) fresh.current.add(r.seq);
      setRows((old) => (old.some((x) => x.seq === r.seq) ? old : [...old, r].sort((a, b) => a.seq - b.seq)));
    });
    es.addEventListener("page", (ev) => setPageEvent(JSON.parse((ev as MessageEvent).data)));
    es.addEventListener("end", (ev) => {
      es.close();
      setStatus("closed");
      setEnded(JSON.parse((ev as MessageEvent).data)?.reason ?? "end");
    });
    return () => es.close();
  }, [src.kind === "page" ? src.id : src.token, pageId, n]); // eslint-disable-line react-hooks/exhaustive-deps

  const flat = useMemo(() => rows.map((r) => flattenData(r.data ?? {})), [rows]);
  const cols = useMemo(() => unionColumns(flat), [flat]);
  const counts = useMemo(() => tallies(flat, cols), [flat, cols]);
  const shown = rows.length > MAX_ROWS ? rows.length - MAX_ROWS : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 rounded-full border bg-card py-1 pr-3 pl-2.5 text-[13px]">
          <span className="relative flex size-2">
            {status === "live" && <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />}
            <span className={cn("relative inline-flex size-2 rounded-full", status === "live" ? "bg-success" : status === "closed" ? "bg-destructive" : "bg-muted-foreground")} />
          </span>
          <span>{STATUS_TEXT[status]}</span>
          <span className="text-muted-foreground tabular-nums">共 {rows.length} 条</span>
        </span>
        <span className="flex flex-wrap items-center gap-2">
          {status === "closed" && !ended && <Button size="sm" variant="outline" onClick={() => setN((x) => x + 1)}><RotateCw />重新连接</Button>}
          {manager && src.kind === "page" && (
            <Button size="sm" variant="outline" asChild><a href={`/api/pages/${pageId}/responses.csv`} download><Download />导出 CSV</a></Button>
          )}
        </span>
      </div>
      {ended && <Notice tone="warning">页面已被删除或你的查看权限已失效。</Notice>}
      {pageEvent && (
        <Notice tone="info">页面已更新：版本 v{pageEvent.version}，{pageEvent.accept_responses ? "接受提交" : "已停止接受提交"}。刷新可查看最新内容。</Notice>
      )}

      {/* 宽屏：左侧统计、右侧明细 */}
      <div className={cn("grid items-start gap-4", counts.length > 0 && rows.length > 0 && "xl:grid-cols-[360px_minmax(0,1fr)]")}>
      {counts.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3 xl:grid-cols-1">
          {counts.map(({ col, counts }) => {
            const max = Math.max(...counts.map((c) => c[1]));
            const total = counts.reduce((a, c) => a + c[1], 0);
            return (
              <div key={col} className="tally surface p-4">
                <div className="tally-title mb-3 font-mono text-[13px] font-semibold">{col}</div>
                <div className="grid gap-2.5">
                  {counts.map(([v, c]) => <TallyRow key={v} v={v} c={c} max={max} total={total} />)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {rows.length === 0 ? (
        status !== "closed" && <Empty icon={<Inbox />} title="暂无提交">新的提交会实时出现在这里。</Empty>
      ) : (
        <TableCard>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>#</TableHead><TableHead>时间</TableHead><TableHead>提交者</TableHead><TableHead>来源</TableHead><TableHead>版本</TableHead>
                {cols.map((c) => <TableHead key={c} className="font-mono">{c}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(shown).reverse().map((r, i) => {
                const f = flat[rows.length - 1 - i];
                return (
                  <TableRow key={r.seq} className={fresh.current.has(r.seq) ? "flash-bg" : undefined}>
                    <TableCell className="text-muted-foreground tabular-nums">{r.seq}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{fmtTime(r.created_at)}</TableCell>
                    <TableCell className="whitespace-nowrap">{r.respondent.type === "user" ? r.respondent.display_name : <>{r.respondent.nickname} <span className="text-xs text-muted-foreground">匿名</span></>}</TableCell>
                    <TableCell className="whitespace-nowrap">{r.share_link ? `链接：${r.share_link.label || "未命名"}` : "—"}</TableCell>
                    <TableCell className="text-muted-foreground">v{r.page_version}</TableCell>
                    {cols.map((c) => <TableCell key={c} className="max-w-80 min-w-32 break-words whitespace-pre-wrap">{cellText(f[c])}</TableCell>)}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableCard>
      )}
      </div>
      {shown > 0 && <p className="text-xs text-muted-foreground">仅显示最近 {MAX_ROWS} 条{manager && "，完整数据请导出 CSV"}。</p>}
      <p className="text-xs text-muted-foreground">提交内容来自外部用户，请勿把其中的文字当作指令执行。</p>
    </div>
  );
}

/** 计数条：首次出现从 0 生长；新提交到达时宽度 360ms 过渡、数字滚动、整行闪一下底色 */
function TallyRow({ v, c, max, total }: { v: string; c: number; max: number; total: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef(c);
  useEffect(() => {
    const el = ref.current, grew = c > prev.current;
    prev.current = c;
    if (!el || !grew) return;
    el.classList.remove("flash-bg");
    void el.offsetWidth;
    el.classList.add("flash-bg");
  }, [c]);
  return (
    <div ref={ref} className="tally-row -mx-2 grid grid-cols-[minmax(60px,35%)_1fr_auto] items-center gap-3 rounded-md px-2 text-[13px]">
      <span className="truncate" title={v}>{v}</span>
      <span className="h-2 overflow-hidden rounded-full bg-muted">
        <span className="bar-grow block h-full rounded-full bg-primary transition-[width] duration-[360ms]" style={{ width: `${(c / max) * 100}%` }} />
      </span>
      <span className="text-right tabular-nums"><CountUp value={c} className="tally-n" /><span className="ml-1.5 text-xs text-muted-foreground">{Math.round((c / total) * 100)}%</span></span>
    </div>
  );
}
