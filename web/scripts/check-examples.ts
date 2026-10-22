// 自检：examples/*.openui 与 mcp/guide/*.oui 必须能被 createParser 无错解析（同 MCP 本地校验规则，design §8.3）
import { readdirSync, readFileSync } from "node:fs";
import { createParser } from "@openuidev/react-lang";
import { kanbanLibrary } from "../src/openui-lib";

const parser = createParser(kanbanLibrary.toJSONSchema(), "Stack");
let failed = 0;
for (const [rel, ext] of [["../examples/", ".openui"], ["../../mcp/guide/", ".oui"]] as const) {
  const dir = new URL(rel, import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(ext))) {
    const r = parser.parse(readFileSync(new URL(f, dir), "utf8"));
    const problems = [
      ...(r.root ? [] : ["root == null"]),
      ...(r.meta.incomplete ? ["incomplete"] : []),
      ...r.meta.unresolved.map((n) => `unresolved ${n}`),
      ...r.meta.errors.map((e) => JSON.stringify(e)),
    ];
    if (r.meta.orphaned.length) console.warn(`${f}: orphaned ${r.meta.orphaned.join(", ")}`);
    console.log(`${problems.length ? "FAIL" : "ok  "} ${f} (${r.meta.statementCount} statements)`);
    problems.forEach((p) => console.log("     " + p));
    failed += problems.length ? 1 : 0;
  }
}
process.exit(failed ? 1 : 0);
