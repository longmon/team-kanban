// 自检：接口文档请求构造与 8 种语言代码生成（src/apidoc.ts）
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  buildRequest, dqStr, genCode, genCurl, genGo, genJava, genJs, genPhp, genPython, genRust, genTs, goStr, LANGS, phpStr, pyLit, rustRaw, rustStr,
  sampleOf, shStr, tsObject, tsType, type ApiDoc, type ApiEndpoint,
} from "../src/apidoc";

const nasty = `它's "q" \\ \n\t$HOME \`x\` */ </script>`;
const ep: ApiEndpoint = {
  method: "POST", path: "/orders/{order_id}/refund", title: "退款",
  params: [
    { name: "order_id", in: "path", type: "string", example: "o 1/中" },
    { name: "q", in: "query", type: "string", required: true, example: "a&b=c 中" },
    { name: "page", in: "query", type: "integer", required: true },
    { name: "opt", in: "query", type: "string" },
    { name: "X-Trace", in: "header", type: "string", example: "t'1" },
  ],
  body: {
    content_type: "application/json",
    fields: [
      { name: "amount", type: "integer", required: true, example: 100 },
      { name: "reason", type: "string", example: nasty },
      { name: "items", type: "array<object>", fields: [{ name: "sku", type: "string", enum: ["A", "B"] }] },
    ],
  },
  responses: [{ status: "200", fields: [{ name: "refund-id", type: "string", required: true, description: "退款单号 */ x" }, { name: "ok", type: "boolean" }] }],
};
const doc: ApiDoc = {
  title: "t", servers: [{ name: "测试", url: "https://t.example.com/v1/" }, { name: "生产", url: "https://api.example.com" }],
  auth: { type: "header", name: "X-Api-Key", value: "{{API_KEY}}" },
  groups: [{ name: "g", endpoints: [ep] }],
};

// ---------- 请求构造 ----------
const r = buildRequest(doc, ep, 0);
assert.equal(r.url, "https://t.example.com/v1/orders/o%201%2F%E4%B8%AD/refund?q=a%26b%3Dc%20%E4%B8%AD&page=0");
assert.deepEqual(r.headers, [["X-Api-Key", "{{API_KEY}}"], ["X-Trace", "t'1"], ["Content-Type", "application/json"]]);
assert.deepEqual(r.body?.json, { amount: 100, reason: nasty, items: [{ sku: "A" }] });
assert.equal(buildRequest(doc, ep, 1).url.startsWith("https://api.example.com/orders/"), true, "切换环境");
assert.deepEqual(buildRequest({ ...doc, auth: { type: "bearer", value: "{{T}}" } }, ep).headers[0], ["Authorization", "Bearer {{T}}"]);
assert.match(buildRequest({ ...doc, auth: { type: "query", name: "key" } }, ep).url, /\?key=%7B%7BAPI_KEY%7D%7D&q=/);
assert.equal(buildRequest(doc, { ...ep, auth: false }).headers[0][0], "X-Trace", "auth=false 不带鉴权");
const get = buildRequest(doc, { method: "GET", path: "/a", title: "a", body: { content_type: "application/json" } });
assert.equal(get.body, null, "GET 不发请求体");
const form = buildRequest(doc, { method: "POST", path: "/f", title: "f", body: { content_type: "application/x-www-form-urlencoded", example: { a: "x y", b: 1 } } });
assert.equal(form.body?.text, "a=x%20y&b=1");
assert.deepEqual(sampleOf([{ name: "n", type: "integer(int64)" }, { name: "b", type: "bool" }, { name: "o", type: "object", fields: [{ name: "s", type: "string" }] }]), { n: 0, b: false, o: { s: "string" } });

// ---------- 字面量转义：shell 实际回显一遍 ----------
assert.equal(execFileSync("sh", ["-c", `printf %s ${shStr(nasty)}`], { encoding: "utf8" }), nasty);
assert.equal(phpStr(`a'b\\c`), `'a\\'b\\\\c'`);
assert.equal(JSON.parse(dqStr(nasty)), nasty);
assert.equal(rustStr(`a"b\\\n\u0001`), `"a\\"b\\\\\\n\\u{1}"`);
assert.equal(rustRaw(`x"#y`), `r##"x"#y"##`);
assert.equal(rustRaw("plain"), `r"plain"`);
assert.equal(goStr("a\nb"), "`a\nb`");
assert.equal(goStr("a`b"), `"a\`b"`);
assert.equal(pyLit({ a: [true, null, 1.5], "b\"": {} }), `{\n    "a": [\n        True,\n        None,\n        1.5,\n    ],\n    "b\\"": {},\n}`);

// ---------- TS 类型 ----------
assert.equal(tsType({ type: "array<string>" }), "string[]");
assert.equal(tsType({ type: "string", enum: ["A", "B"] }), `"A" | "B"`);
assert.equal(tsType({ type: "integer(int64)" }), "number");
assert.equal(tsType({ type: "weird" }), "unknown");
const obj = tsObject(ep.responses![0].fields!);
assert.ok(obj.includes(`"refund-id": string;`) && obj.includes("ok?: boolean;") && obj.includes("退款单号 * / x") && !obj.includes("*/ x"), obj);

// ---------- 生成器：JS 用替身 fetch 实际执行一遍 ----------
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
let seen: { url: string; init: { method: string; headers: Record<string, string>; body: string } } | null = null;
const fakeFetch = async (url: string, init: never) => ((seen = { url, init }), { status: 200, ok: true, text: async () => "ok", json: async () => ({}) });
await new AsyncFunction("fetch", "console", genJs(r))(fakeFetch, { log() {} });
assert.equal(seen!.url, r.url);
assert.equal(seen!.init.method, "POST");
assert.deepEqual(seen!.init.headers, Object.fromEntries(r.headers));
assert.deepEqual(JSON.parse(seen!.init.body), r.body!.json);

const curl = genCurl(r);
assert.ok(curl.startsWith(`curl -X POST '${r.url}'`) && curl.includes(`-H 'X-Trace: t'\\''1'`), curl);
assert.equal(execFileSync("sh", ["-c", `printf %s ${curl.split("--data-raw ")[1]}`], { encoding: "utf8" }), r.body!.text, "curl 请求体原样");
assert.ok(genPhp(r).includes(`CURLOPT_URL => '${r.url}'`) && genPhp(r).includes(`'X-Trace: t\\'1'`));
const ts = genTs(r, ep);
assert.ok(ts.includes("interface RequestBody {") && ts.includes("interface ResponseBody {") && ts.includes("const body: RequestBody = ") && ts.includes("as ResponseBody"), ts);
const go = genGo(r);
assert.ok(go.includes(`http.NewRequest("POST", "${r.url}", strings.NewReader(`) && go.includes(`req.Header.Set("X-Trace", "t'1")`), go);
assert.ok(!genGo(buildRequest(doc, { method: "GET", path: "/a", title: "a" })).includes(`"strings"`), "无请求体不引入 strings");
const rs = genRust(r);
assert.ok(rs.includes(".request(reqwest::Method::POST,") && rs.includes(`.body(r#"{`), rs);
const py = genPython(r);
assert.ok(py.includes("requests.post(") && py.includes(`"amount": 100,`) && py.includes(`json={`), py);
const java = genJava(r);
assert.ok(java.includes(`.uri(URI.create("${r.url}"))`) && java.includes(`.method("POST", HttpRequest.BodyPublishers.ofString(body))`), java);
// Java 请求体按行拼接后与原文一致
const javaBody = java.split("String body = ")[1].split(";\n")[0];
assert.equal(javaBody.split(" +\n").map((l) => JSON.parse(l.trim())).join(""), r.body!.text);
for (const [lang] of LANGS) assert.ok(genCode(lang, r, ep).length > 50, lang);
console.log("apidoc ok");
