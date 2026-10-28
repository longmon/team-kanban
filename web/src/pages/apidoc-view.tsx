// 接口文档页（page_type=api_doc，kind=api）：左侧接口目录（分组、method 色块、搜索）+ 每个接口一张卡（说明与参数表 | 代码样例与响应示例）。
// 单独 chunk。内容全部按纯文本渲染；description 走 react-markdown（默认不渲染原始 HTML、过滤 javascript: 链接）。不发任何请求（不做在线调试）。
import { useMemo, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, ChevronDown, Copy, KeyRound, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { copyText, Notice } from "../ui";
import { bodyExample, buildRequest, genCode, LANGS, type ApiDoc, type ApiEndpoint, type ApiField, type ApiParam, type Lang } from "../apidoc";

const LANG_KEY = "tk.apidoc.lang";
const readLang = (): Lang => {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return LANGS.some(([k]) => k === v) ? (v as Lang) : "curl";
  } catch {
    return "curl";
  }
};

/** method → 糖纸色调（index.css [data-tone]） */
const METHOD_TONE: Record<string, string> = { GET: "report", POST: "vote", PUT: "flow", PATCH: "arch", DELETE: "form" };
function Method({ m, className }: { m: string; className?: string }) {
  return (
    <span data-tone={METHOD_TONE[m] ?? "book"} className={cn("inline-grid h-[22px] min-w-[52px] shrink-0 place-items-center rounded-[6px] bg-tone-f px-1.5 font-mono text-[11px] font-bold tracking-wide text-tone-ink", className)}>
      {m}
    </span>
  );
}

const anchor = (g: number, i: number) => `api-${g}-${i}`;
const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

function Md({ text }: { text?: string }) {
  if (!text) return null;
  return <div className="md text-muted-foreground"><Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown></div>;
}

/** 小复制按钮：点后 1.5s 显示勾 */
function CopyBtn({ text, label, msg, className, children }: { text: string; label: string; msg?: string; className?: string; children?: ReactNode }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" aria-label={label} title={label} data-copied={done || undefined}
      onClick={() => copyText(text, msg ?? `已复制${label.replace(/^复制/, "")}`).then(() => (setDone(true), setTimeout(() => setDone(false), 1500)))}
      className={cn("inline-flex shrink-0 items-center gap-1 rounded-[7px] px-1.5 py-1 text-[12px] text-faint outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/80", className)}>
      {done ? <Check className="size-3.5 text-mint-ink" /> : <Copy className="size-3.5" />}{children}
    </button>
  );
}

/** pageTitle：外壳 h1 已是页面标题，文档标题相同时不再重复 */
export default function ApiDocView({ spec, pageTitle }: { spec: string; pageTitle?: string }) {
  const doc = useMemo<ApiDoc | null>(() => {
    try {
      return JSON.parse(spec) as ApiDoc;
    } catch {
      return null;
    }
  }, [spec]);
  const [server, setServer] = useState(0);
  const [lang, setLangState] = useState<Lang>(readLang);
  const [q, setQ] = useState("");
  const setLang = (l: Lang) => {
    setLangState(l);
    try { localStorage.setItem(LANG_KEY, l); } catch { /* 隐私模式等不可用时只在本页记住 */ }
  };
  if (!doc?.groups) return <Notice tone="error">接口文档内容无法解析</Notice>;
  const total = doc.groups.reduce((n, g) => n + g.endpoints.length, 0);
  const env = doc.servers[server] ?? doc.servers[0];
  const needle = q.trim().toLowerCase();
  const hit = (e: ApiEndpoint) => !needle || `${e.method} ${e.path} ${e.title}`.toLowerCase().includes(needle);
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });

  const nav = (
    <div className="flex flex-col gap-3">
      <label className="relative block">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`搜索 ${total} 个接口`} aria-label="搜索接口" className="h-8 bg-card pl-8 text-[13px]" />
      </label>
      {doc.groups.map((g, gi) => {
        const eps = g.endpoints.map((e, i) => [e, i] as const).filter(([e]) => hit(e));
        if (!eps.length) return null;
        return (
          <div key={gi}>
            <div className="mb-1 px-2 text-[12px] font-semibold text-faint">{g.name}</div>
            {eps.map(([e, i]) => (
              <a key={i} href={`#${anchor(gi, i)}`} onClick={(ev) => (ev.preventDefault(), go(anchor(gi, i)))}
                className="flex min-w-0 items-center gap-2 rounded-[8px] px-2 py-1.5 text-[13px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/80">
                <Method m={e.method} className="h-[18px] min-w-[46px] text-[10px]" />
                <span className={cn("min-w-0 truncate", e.deprecated && "line-through")}>{e.title}</span>
              </a>
            ))}
          </div>
        );
      })}
      {needle && !doc.groups.some((g) => g.endpoints.some(hit)) && <p className="px-2 text-[13px] text-faint">没有匹配的接口</p>}
    </div>
  );

  return (
    <div className="apidoc grid gap-6 min-[1100px]:grid-cols-[232px_minmax(0,1fr)]">
      <nav aria-label="接口目录" className="max-[1099px]:hidden">
        <div className="sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto pr-1">{nav}</div>
      </nav>
      <div className="flex min-w-0 flex-col gap-5">
        <section className="flex flex-col gap-4 rounded-[16px] border bg-card p-5 max-sm:p-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {doc.title.trim() !== pageTitle?.trim() && <h2 className="text-[16px] font-semibold">{doc.title}</h2>}
            {doc.version && <span className="rounded-full bg-secondary px-2 py-px font-mono text-[12px] text-muted-foreground">v{doc.version.replace(/^v/i, "")}</span>}
            <span className="text-[13px] text-faint">{total} 个接口</span>
          </div>
          <Md text={doc.description} />
          <div className="grid gap-2">
            <div className="text-[12px] font-medium text-faint">环境</div>
            <div className="flex flex-wrap items-center gap-2">
              <div role="radiogroup" aria-label="环境" className="inline-flex flex-wrap gap-1 rounded-[10px] bg-muted p-[3px]">
                {doc.servers.map((s, i) => (
                  <button key={i} type="button" role="radio" aria-checked={i === server} onClick={() => setServer(i)}
                    className="rounded-[8px] px-3 py-1 text-[13px] font-medium text-muted-foreground outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/80 aria-checked:bg-card aria-checked:text-foreground aria-checked:shadow-sm">
                    {s.name}
                  </button>
                ))}
              </div>
              <div className="flex min-w-0 flex-1 basis-[220px] items-center gap-1 rounded-[8px] bg-background py-0.5 pr-0.5 pl-2.5">
                <code data-testid="base-url" className="min-w-0 flex-1 text-[12.5px] [overflow-wrap:anywhere]">{env.url}</code>
                <CopyBtn text={env.url} label="复制 Base URL" />
              </div>
            </div>
          </div>
          {doc.auth && (
            <div className="flex items-start gap-2.5 rounded-[12px] bg-primary-soft px-3.5 py-3 text-[13px]">
              <KeyRound className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <b className="font-semibold">鉴权</b>
                  <code className="[overflow-wrap:anywhere]">
                    {doc.auth.type === "bearer" ? `Authorization: Bearer ${doc.auth.value || "{{TOKEN}}"}`
                      : doc.auth.type === "header" ? `${doc.auth.name}: ${doc.auth.value || "{{API_KEY}}"}`
                      : `?${doc.auth.name}=${doc.auth.value || "{{API_KEY}}"}`}
                  </code>
                  <span className="text-faint">{doc.auth.type === "query" ? "查询参数" : "请求头"}，示例值为占位符</span>
                </div>
                {doc.auth.description && <p className="mt-1 whitespace-pre-line text-muted-foreground">{doc.auth.description}</p>}
              </div>
            </div>
          )}
        </section>
        <details className="group rounded-[14px] border bg-card min-[1100px]:hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-[14px] font-semibold">接口目录<ChevronDown className="size-4 transition-transform group-open:rotate-180" /></summary>
          <div className="border-t p-3">{nav}</div>
        </details>
        {doc.groups.map((g, gi) => (
          <section key={gi} aria-label={g.name} className="flex flex-col gap-4">
            <div>
              <h2 className="text-[18px] font-semibold">{g.name}</h2>
              <Md text={g.description} />
            </div>
            {g.endpoints.map((e, i) => <EndpointCard key={i} id={anchor(gi, i)} doc={doc} ep={e} server={server} lang={lang} setLang={setLang} />)}
          </section>
        ))}
      </div>
    </div>
  );
}

function EndpointCard({ id, doc, ep, server, lang, setLang }: { id: string; doc: ApiDoc; ep: ApiEndpoint; server: number; lang: Lang; setLang: (l: Lang) => void }) {
  const req = useMemo(() => buildRequest(doc, ep, server), [doc, ep, server]);
  const code = useMemo(() => genCode(lang, req, ep), [lang, req, ep]);
  const params = ep.params ?? [];
  const body = bodyExample(ep);
  const [resp, setResp] = useState(0);
  const examples = (ep.responses ?? []).filter((r) => r.example !== undefined);
  const shown = examples[resp] ?? examples[0];
  return (
    <article id={id} data-endpoint={`${ep.method} ${ep.path}`} className="scroll-mt-4 grid gap-5 rounded-[16px] border bg-card p-5 max-sm:p-4 min-[1400px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <header className="flex flex-col gap-2">
          <h3 className={cn("text-[16px] font-semibold [overflow-wrap:anywhere]", ep.deprecated && "line-through decoration-faint")}>{ep.title}</h3>
          <div className="flex min-w-0 items-center gap-2 rounded-[10px] bg-background px-2.5 py-1.5">
            <Method m={ep.method} />
            <code className="min-w-0 flex-1 text-[13px] [overflow-wrap:anywhere]">{ep.path}</code>
            <CopyBtn text={req.url} label="复制完整 URL" msg="已复制完整请求 URL" />
          </div>
          {(ep.deprecated || ep.auth === false) && (
            <div className="flex flex-wrap gap-1.5 text-[12px]">
              {ep.deprecated && <span className="rounded-full bg-coral-soft px-2 py-px text-coral-ink">已废弃</span>}
              {ep.auth === false && <span className="rounded-full bg-secondary px-2 py-px text-muted-foreground">无需鉴权</span>}
            </div>
          )}
          <Md text={ep.description} />
        </header>
        {(["path", "query", "header"] as const).map((loc) => {
          const ps = params.filter((p) => p.in === loc);
          return ps.length ? <Block key={loc} title={{ path: "Path 参数", query: "Query 参数", header: "Header 参数" }[loc]}><ParamList items={ps} /></Block> : null;
        })}
        {ep.body && (
          <Block title="请求体" note={<code className="text-[12px]">{ep.body.content_type}</code>}>
            {ep.body.fields?.length ? <FieldList items={ep.body.fields} /> : <p className="text-[13px] text-faint">见右侧示例</p>}
          </Block>
        )}
        {(ep.responses ?? []).filter((r) => r.fields?.length || r.description).map((r, i) => (
          <Block key={i} title={<>响应 <StatusChip s={r.status} /></>} note={r.description}>
            {r.fields?.length ? <FieldList items={r.fields} /> : null}
          </Block>
        ))}
        {!!ep.errors?.length && (
          <Block title="错误码">
            <ul className="divide-y text-[13px]">
              {ep.errors.map((x, i) => (
                <li key={i} className="flex min-w-0 items-start gap-3 py-2">
                  <code className="shrink-0 font-semibold text-coral-ink">{x.code}</code>
                  {x.http_status && <StatusChip s={String(x.http_status)} />}
                  <span className="min-w-0 flex-1 whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]">{x.description}</span>
                </li>
              ))}
            </ul>
          </Block>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-4 min-[1400px]:sticky min-[1400px]:top-4 min-[1400px]:self-start">
        <CodePanel
          head={
            <div role="tablist" aria-label="语言" className="flex min-w-0 flex-1 flex-wrap gap-0.5">
              {LANGS.map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={k === lang} onClick={() => setLang(k)}
                  className="shrink-0 rounded-[7px] px-2 py-1 text-[12px] font-medium text-faint outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/80 aria-selected:bg-card aria-selected:text-foreground aria-selected:shadow-sm">
                  {label}
                </button>
              ))}
            </div>
          }
          copy={<CopyBtn text={code} label="复制代码" msg={`已复制 ${LANGS.find(([k]) => k === lang)![1]} 代码`} />}
          code={code} testid="code"
        />
        {body !== undefined && req.body && (
          <CodePanel head={<span className="flex-1 text-[12px] font-medium text-faint">请求体示例</span>}
            copy={<CopyBtn text={req.body.text} label="复制请求体" msg="已复制请求体示例" />} code={req.body.text} />
        )}
        {shown && (
          <CodePanel
            head={
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
                <span className="mr-1 shrink-0 text-[12px] font-medium text-faint">响应示例</span>
                {examples.map((r, i) => (
                  <button key={i} type="button" aria-pressed={r === shown} onClick={() => setResp(i)}
                    className="shrink-0 rounded-[7px] px-1.5 py-0.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/80 aria-pressed:bg-card aria-pressed:shadow-sm">
                    <StatusChip s={r.status} />
                  </button>
                ))}
              </div>
            }
            copy={<CopyBtn text={JSON.stringify(shown.example, null, 2)} label="复制响应示例" />}
            code={JSON.stringify(shown.example, null, 2)}
          />
        )}
      </div>
    </article>
  );
}

function CodePanel({ head, copy, code, testid }: { head: ReactNode; copy: ReactNode; code: string; testid?: string }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-[12px] border bg-background">
      <div className="flex min-w-0 items-center gap-2 border-b bg-muted/50 px-2 py-1.5">{head}{copy}</div>
      <pre data-testid={testid} className="max-h-[480px] overflow-auto p-3.5 font-mono text-[12.5px] leading-[1.6]"><code>{code}</code></pre>
    </div>
  );
}

function StatusChip({ s }: { s: string }) {
  const tone = s.startsWith("2") ? "bg-mint-soft text-mint-ink" : s.startsWith("4") || s.startsWith("5") ? "bg-coral-soft text-coral-ink" : "bg-secondary text-muted-foreground";
  return <span className={cn("inline-block rounded-[6px] px-1.5 py-px font-mono text-[11.5px] font-semibold", tone)}>{s}</span>;
}

function Block({ title, note, children }: { title: ReactNode; note?: ReactNode; children?: ReactNode }) {
  return (
    <section className="min-w-0">
      <h4 className="mb-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b pb-1.5 text-[13px] font-semibold">
        {title}{note && <span className="min-w-0 text-[12px] font-normal text-faint [overflow-wrap:anywhere]">{note}</span>}
      </h4>
      {children}
    </section>
  );
}

/** 一行：名称（可复制）· 类型 · 必填，下面说明 / 示例（可复制）/ 枚举 */
function Row({ name, type, required, description, example, enums, children }: {
  name: string; type: string; required?: boolean; description?: string; example?: unknown; enums?: unknown[]; children?: ReactNode;
}) {
  return (
    <li className="py-2 text-[13px]">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <code className="font-semibold [overflow-wrap:anywhere]">{name}</code>
        <CopyBtn text={name} label={`复制参数名 ${name}`} msg={`已复制 ${name}`} className="-ml-1.5 p-1" />
        <span className="font-mono text-[12px] text-faint">{type}</span>
        {required ? <span className="text-[12px] font-medium text-coral-ink">必填</span> : <span className="text-[12px] text-faint">可选</span>}
      </div>
      {description && <p className="mt-0.5 whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]">{description}</p>}
      {(example !== undefined || !!enums?.length) && (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
          {example !== undefined && (
            <span className="inline-flex min-w-0 items-center gap-0.5">
              示例 <code className="ml-1 rounded-[5px] bg-background px-1.5 py-px text-foreground [overflow-wrap:anywhere]">{show(example)}</code>
              <CopyBtn text={show(example)} label={`复制 ${name} 示例值`} msg="已复制示例值" className="p-1" />
            </span>
          )}
          {!!enums?.length && (
            <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
              可选值 {enums.map((x, i) => <code key={i} className="rounded-[5px] bg-background px-1.5 py-px text-foreground">{show(x)}</code>)}
            </span>
          )}
        </div>
      )}
      {children}
    </li>
  );
}

function ParamList({ items }: { items: ApiParam[] }) {
  return <ul className="divide-y">{items.map((p) => <Row key={p.name} {...p} enums={p.enum} />)}</ul>;
}

function FieldList({ items }: { items: ApiField[] }) {
  return (
    <ul className="divide-y">
      {items.map((f) => (
        <Row key={f.name} {...f} enums={f.enum}>
          {!!f.fields?.length && <div className="mt-1.5 border-l-2 pl-3"><FieldList items={f.fields} /></div>}
        </Row>
      ))}
    </ul>
  );
}
