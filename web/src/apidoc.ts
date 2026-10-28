// 接口文档（page_type=api_doc）：内部结构类型（docs/api.md §7.5，与 server/src/apidoc.rs 一致）与请求代码生成。
// 生成器都是纯函数（scripts/check-apidoc.ts 自检）：同一份 Req 生成 8 种语言，保证与参数表一致。
// 字符串一律经各语言的转义函数输出，agent 写的内容不会跳出字符串字面量。

export type Scalar = string | number | boolean;
export type ApiField = {
  name: string; type: string; required?: boolean; description?: string;
  example?: unknown; enum?: Scalar[]; fields?: ApiField[];
};
export type ApiParam = {
  name: string; in: "path" | "query" | "header"; type: string; required?: boolean;
  description?: string; example?: Scalar; enum?: Scalar[];
};
export type ApiEndpoint = {
  method: string; path: string; title: string; description?: string;
  /** 缺省 true；false = 不需要全局鉴权 */
  auth?: boolean; deprecated?: boolean;
  params?: ApiParam[];
  body?: { content_type: string; fields?: ApiField[]; example?: unknown };
  responses?: { status: string; description?: string; fields?: ApiField[]; example?: unknown }[];
  errors?: { code: string; description?: string; http_status?: number }[];
};
export type ApiDoc = {
  title: string; description?: string; version?: string;
  servers: { name: string; url: string }[];
  auth?: { type: "header" | "query" | "bearer"; name?: string; value?: string; description?: string };
  groups: { name: string; description?: string; endpoints: ApiEndpoint[] }[];
};

/** 一次具体请求（已代入示例值与环境） */
export type Req = {
  method: string;
  url: string;
  headers: [string, string][];
  body: null | { contentType: string; text: string; json?: unknown };
};

const isArrayType = (t: string) => /^array|\[\]$/i.test(t.trim());
const baseType = (t: string) => t.trim().toLowerCase();

/** 类型 → 占位示例值 */
export function defaultOf(type: string): unknown {
  const t = baseType(type);
  if (/^(integer|int|long|number|float|double|decimal)/.test(t)) return 0;
  if (/^bool/.test(t)) return false;
  if (isArrayType(t)) return [];
  if (t.startsWith("object") || t.startsWith("map")) return {};
  return "string";
}

const scalarOf = (p: { type: string; example?: unknown; enum?: Scalar[] }) =>
  p.example !== undefined && p.example !== null ? p.example : p.enum?.length ? p.enum[0] : defaultOf(p.type);

/** 字段表 → 示例 JSON：example → enum[0] → 子字段 → 类型占位 */
export function sampleOf(fields: ApiField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.example !== undefined && f.example !== null) out[f.name] = f.example;
    else if (f.enum?.length) out[f.name] = f.enum[0];
    else if (f.fields?.length) out[f.name] = isArrayType(f.type) ? [sampleOf(f.fields)] : sampleOf(f.fields);
    else out[f.name] = defaultOf(f.type);
  }
  return out;
}

export const bodyExample = (ep: ApiEndpoint): unknown =>
  ep.body ? (ep.body.example !== undefined ? ep.body.example : sampleOf(ep.body.fields ?? [])) : undefined;

const enc = encodeURIComponent;
const str = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** 完整请求：path 参数代入并编码、query 拼接、鉴权与 header、请求体 */
export function buildRequest(doc: ApiDoc, ep: ApiEndpoint, server = 0): Req {
  const base = (doc.servers[server] ?? doc.servers[0])?.url.replace(/\/+$/, "") ?? "";
  const params = ep.params ?? [];
  const path = ep.path.replace(/\{([^}]+)\}/g, (m, name: string) => {
    const p = params.find((x) => x.in === "path" && x.name === name);
    return p ? enc(str(scalarOf(p))) : m;
  });
  const query: [string, string][] = [];
  const headers: [string, string][] = [];
  const auth = ep.auth !== false ? doc.auth : undefined;
  if (auth?.type === "bearer") headers.push(["Authorization", `Bearer ${auth.value || "{{TOKEN}}"}`]);
  else if (auth?.type === "header" && auth.name) headers.push([auth.name, auth.value || "{{API_KEY}}"]);
  else if (auth?.type === "query" && auth.name) query.push([auth.name, auth.value || "{{API_KEY}}"]);
  // 可选参数只在给了示例时出现
  for (const p of params) {
    if (p.in === "path" || (!p.required && p.example === undefined)) continue;
    (p.in === "query" ? query : headers).push([p.name, str(scalarOf(p))]);
  }
  let body: Req["body"] = null;
  if (ep.body && !["GET", "HEAD"].includes(ep.method)) {
    const ct = ep.body.content_type;
    const ex = bodyExample(ep);
    if (/json/i.test(ct)) body = { contentType: ct, text: JSON.stringify(ex, null, 2), json: ex };
    else if (/x-www-form-urlencoded/i.test(ct) && ex && typeof ex === "object" && !Array.isArray(ex))
      body = { contentType: ct, text: Object.entries(ex).map(([k, v]) => `${enc(k)}=${enc(str(v))}`).join("&") };
    else body = { contentType: ct, text: typeof ex === "string" ? ex : JSON.stringify(ex, null, 2) };
    headers.push(["Content-Type", ct]);
  }
  const qs = query.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
  return { method: ep.method, url: base + path + (qs ? `?${qs}` : ""), headers, body };
}

// ---------- 各语言字符串字面量 ----------
/** shell 单引号：' → '\'' */
export const shStr = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** PHP 单引号：只有 \\ 与 \' 是转义 */
export const phpStr = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
/** JS/TS、Python、Go、Java 双引号字符串：JSON 转义序列在这几种语言里含义相同 */
export const dqStr = (s: string) => JSON.stringify(s);
/** Rust 普通字符串：控制字符用 \u{..} */
export const rustStr = (s: string) =>
  `"${s.replace(/[\\"]/g, (c) => `\\${c}`).replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
    .replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u{${c.charCodeAt(0).toString(16)}}`)}"`;
/** Rust 原始字符串：# 个数足够多，内容原样 */
export function rustRaw(s: string) {
  let h = "";
  while (s.includes(`"${h}`)) h += "#";
  return `r${h}"${s}"${h}`;
}
/** Go：无反引号/回车时用原始字符串，否则双引号 */
export const goStr = (s: string) => (/[`\r]/.test(s) ? dqStr(s) : `\`${s}\``);

/** JSON → Python 字面量（4 空格缩进） */
export function pyLit(v: unknown, ind = ""): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "None";
  if (typeof v === "string") return dqStr(v);
  const inner = ind + "    ";
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => inner + pyLit(x, inner)).join(",\n")},\n${ind}]` : "[]";
  const es = Object.entries(v as Record<string, unknown>);
  return es.length ? `{\n${es.map(([k, x]) => `${inner}${dqStr(k)}: ${pyLit(x, inner)}`).join(",\n")},\n${ind}}` : "{}";
}

const indent = (s: string, pad: string) => s.split("\n").map((l, i) => (i ? pad + l : l)).join("\n");

// ---------- 生成器 ----------
export const LANGS = [
  ["curl", "cURL"], ["php", "PHP"], ["js", "JavaScript"], ["ts", "TypeScript"],
  ["go", "Go"], ["rust", "Rust"], ["python", "Python"], ["java", "Java"],
] as const;
export type Lang = (typeof LANGS)[number][0];

export function genCurl(r: Req): string {
  const lines = [`curl${r.method === "GET" ? "" : r.method === "HEAD" ? " -I" : ` -X ${r.method}`} ${shStr(r.url)}`];
  for (const [k, v] of r.headers) lines.push(`  -H ${shStr(`${k}: ${v}`)}`);
  if (r.body) lines.push(`  --data-raw ${shStr(r.body.text)}`);
  return lines.join(" \\\n");
}

export function genPhp(r: Req): string {
  const opts = [`    CURLOPT_URL => ${phpStr(r.url)},`, `    CURLOPT_CUSTOMREQUEST => ${phpStr(r.method)},`, `    CURLOPT_RETURNTRANSFER => true,`];
  if (r.method === "HEAD") opts.push(`    CURLOPT_NOBODY => true,`);
  if (r.headers.length) opts.push(`    CURLOPT_HTTPHEADER => [\n${r.headers.map(([k, v]) => `        ${phpStr(`${k}: ${v}`)},`).join("\n")}\n    ],`);
  if (r.body) opts.push(`    CURLOPT_POSTFIELDS => ${phpStr(r.body.text)},`);
  return `<?php
$ch = curl_init();
curl_setopt_array($ch, [
${opts.join("\n")}
]);
$response = curl_exec($ch);
if ($response === false) {
    throw new RuntimeException(curl_error($ch));
}
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);
echo $status, PHP_EOL, $response, PHP_EOL;`;
}

function fetchInit(r: Req, bodyExpr: string | null) {
  const parts = [`  method: ${dqStr(r.method)},`];
  if (r.headers.length) parts.push(`  headers: {\n${r.headers.map(([k, v]) => `    ${dqStr(k)}: ${dqStr(v)},`).join("\n")}\n  },`);
  if (bodyExpr) parts.push(`  body: ${bodyExpr},`);
  return `{\n${parts.join("\n")}\n}`;
}

const jsBody = (r: Req) => (!r.body ? null : r.body.json !== undefined ? `JSON.stringify(${indent(JSON.stringify(r.body.json, null, 2), "  ")})` : dqStr(r.body.text));

export function genJs(r: Req): string {
  return `const res = await fetch(${dqStr(r.url)}, ${fetchInit(r, jsBody(r))});
const text = await res.text();
console.log(res.status, text);`;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const tsComment = (d: string | undefined, pad: string) => (d ? `${pad}/** ${d.replace(/\s+/g, " ").replace(/\*\//g, "* /")} */\n` : "");

/** 字段 → TS 类型 */
export function tsType(f: Pick<ApiField, "type" | "enum" | "fields">, pad = ""): string {
  const t = baseType(f.type);
  if (f.fields?.length) {
    const obj = tsObject(f.fields, pad);
    return isArrayType(t) ? `Array<${obj}>` : obj;
  }
  if (f.enum?.length) return f.enum.map((x) => (typeof x === "string" ? dqStr(x) : String(x))).join(" | ");
  const inner = t.match(/^array<(.+)>$/)?.[1] ?? t.match(/^(.+)\[\]$/)?.[1];
  if (inner) return `${tsType({ type: inner })}[]`;
  if (t === "array") return "unknown[]";
  if (/^(integer|int|long|number|float|double|decimal)/.test(t)) return "number";
  if (/^bool/.test(t)) return "boolean";
  if (/^(string|date|uuid|email|uri)/.test(t)) return "string";
  if (t.startsWith("object") || t.startsWith("map")) return "Record<string, unknown>";
  return "unknown";
}

export function tsObject(fields: ApiField[], pad = ""): string {
  const inner = pad + "  ";
  const props = fields.map((f) => `${tsComment(f.description, inner)}${inner}${IDENT.test(f.name) ? f.name : dqStr(f.name)}${f.required ? "" : "?"}: ${tsType(f, inner)};`);
  return `{\n${props.join("\n")}\n${pad}}`;
}

export function genTs(r: Req, ep: ApiEndpoint): string {
  const ok = ep.responses?.find((x) => x.status.startsWith("2") && x.fields?.length);
  const out: string[] = [];
  const hasReqType = r.body?.json !== undefined && !!ep.body?.fields?.length;
  if (hasReqType) out.push(`interface RequestBody ${tsObject(ep.body!.fields!)}\n`);
  if (ok) out.push(`interface ResponseBody ${tsObject(ok.fields!)}\n`);
  let bodyExpr = jsBody(r);
  if (hasReqType) {
    out.push(`const body: RequestBody = ${JSON.stringify(r.body!.json, null, 2)};\n`);
    bodyExpr = "JSON.stringify(body)";
  }
  out.push(`const res = await fetch(${dqStr(r.url)}, ${fetchInit(r, bodyExpr)});
if (!res.ok) throw new Error(\`HTTP \${res.status}: \${await res.text()}\`);
${ok ? "const data = (await res.json()) as ResponseBody;" : "const data: unknown = await res.text();"}
console.log(res.status, data);`);
  return out.join("\n");
}

export function genGo(r: Req): string {
  const body = r.body ? `strings.NewReader(${goStr(r.body.text)})` : "nil";
  return `package main

import (
	"fmt"
	"io"
	"net/http"${r.body ? `\n\t"strings"` : ""}
)

func main() {
	req, err := http.NewRequest(${dqStr(r.method)}, ${dqStr(r.url)}, ${body})
	if err != nil {
		panic(err)
	}
${r.headers.map(([k, v]) => `\treq.Header.Set(${dqStr(k)}, ${dqStr(v)})\n`).join("")}	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		panic(err)
	}
	fmt.Println(resp.StatusCode, string(data))
}`;
}

export function genRust(r: Req): string {
  const chain = [`.request(reqwest::Method::${r.method}, ${rustStr(r.url)})`, ...r.headers.map(([k, v]) => `.header(${rustStr(k)}, ${rustStr(v)})`)];
  if (r.body) chain.push(`.body(${rustRaw(r.body.text)})`);
  chain.push(".send()?;");
  return `// Cargo.toml: reqwest = { version = "0.12", features = ["blocking"] }
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::blocking::Client::new();
    let resp = client
${chain.map((c) => `        ${c}`).join("\n")}
    println!("{} {}", resp.status(), resp.text()?);
    Ok(())
}`;
}

export function genPython(r: Req): string {
  const args = [`    ${dqStr(r.url)},`];
  if (r.headers.length) args.push(`    headers={\n${r.headers.map(([k, v]) => `        ${dqStr(k)}: ${dqStr(v)},`).join("\n")}\n    },`);
  if (r.body) args.push(r.body.json !== undefined ? `    json=${pyLit(r.body.json, "    ")},` : `    data=${dqStr(r.body.text)}.encode("utf-8"),`);
  return `import requests

resp = requests.${r.method.toLowerCase()}(
${args.join("\n")}
)
print(resp.status_code, resp.text)`;
}

export function genJava(r: Req): string {
  const lines = r.body ? r.body.text.split("\n") : [];
  const body = lines.map((l, i) => dqStr(i < lines.length - 1 ? `${l}\n` : l)).join(" +\n            ");
  const pub = r.body ? "HttpRequest.BodyPublishers.ofString(body)" : "HttpRequest.BodyPublishers.noBody()";
  return `import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

public class Main {
    public static void main(String[] args) throws Exception {
${r.body ? `        String body = ${body};\n` : ""}        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(${dqStr(r.url)}))
${r.headers.map(([k, v]) => `            .header(${dqStr(k)}, ${dqStr(v)})\n`).join("")}            .method(${dqStr(r.method)}, ${pub})
            .build();
        HttpResponse<String> response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());
        System.out.println(response.statusCode() + " " + response.body());
    }
}`;
}

export function genCode(lang: Lang, r: Req, ep: ApiEndpoint): string {
  switch (lang) {
    case "curl": return genCurl(r);
    case "php": return genPhp(r);
    case "js": return genJs(r);
    case "ts": return genTs(r, ep);
    case "go": return genGo(r);
    case "rust": return genRust(r);
    case "python": return genPython(r);
    case "java": return genJava(r);
  }
}
