// 构建时导出 OpenUI 库的 JSON Schema 与提示词（design §2、§8.2）→ dist/openui/
import { mkdirSync, writeFileSync } from "node:fs";
import { kanbanLibrary, kanbanPromptOptions } from "../src/openui-lib";
import { KANBAN_RULES } from "../src/openui-rules";

const out = new URL("../dist/openui/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("library.schema.json", out), JSON.stringify(kanbanLibrary.toJSONSchema()));
writeFileSync(new URL("prompt.md", out), kanbanLibrary.prompt(kanbanPromptOptions) + "\n\n" + KANBAN_RULES);
console.log("openui assets →", out.pathname);
