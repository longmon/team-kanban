// 自检：§10 values 规范化与 §8.4 扁平化规则
import assert from "node:assert/strict";
import { cellText, flattenData, normalizeValues, submissionData, tallies, unionColumns } from "../src/data";

const fs = {
  vote: { choice: { value: "B", componentType: "RadioGroup" }, comment: { value: "成本更低", componentType: "TextArea" } },
  other: { x: { value: 1, componentType: "Input" } },
  $hidden: true,
};
assert.deepEqual(normalizeValues(fs, "vote"), { choice: "B", comment: "成本更低" });
assert.deepEqual(normalizeValues(fs, "missing"), {});
assert.deepEqual(normalizeValues(fs, undefined), { choice: "B", comment: "成本更低", x: 1 });
assert.deepEqual(submissionData({ humanFriendlyMessage: "提交", formName: "vote", formState: fs, params: {} }), {
  action: "提交", form: "vote", values: { choice: "B", comment: "成本更低" }, params: {},
});

const f = flattenData({ action: "提交", form: "vote", values: { choice: "B", tags: ["a", "b"], ck: { a: true }, d: { e: { f: { g: 1 } } } }, params: {} });
assert.deepEqual(Object.keys(f), ["action", "form", "choice", "tags", "ck.a", "d.e.f"]);
assert.equal(cellText(f["d.e.f"]), '{"g":1}');
assert.equal(cellText(f.tags), "a; b");
assert.deepEqual(flattenData({ name: "x", n: { m: 2 } }), { name: "x", "n.m": 2 });
assert.deepEqual(Object.keys(flattenData({ action: "a", form: null, values: { seq: 9, action: "x", form: "f", ok: 1, e: {} } })), ["action", "form", "values.seq", "values.action", "values.form", "ok", "e"]);
assert.deepEqual(flattenData({ seq: 1, user_id: "u", x: 2 }), { "data.seq": 1, "data.user_id": "u", x: 2 });
assert.deepEqual(unionColumns([{ a: 1 }, { b: 1, a: 2 }]), ["a", "b"]);
const t = tallies([{ c: "A", t: ["x", "y"], n: 1 }, { c: "A", t: ["x"], n: 2 }, { c: "B" }], ["c", "t", "n"]);
assert.deepEqual(t, [{ col: "c", counts: [["A", 2], ["B", 1]] }, { col: "t", counts: [["x", 2], ["y", 1]] }]);
assert.deepEqual(tallies([{ action: "提交", form: "f", c: "A" }], ["action", "form", "c"]).map((x) => x.col), ["c"]);
console.log("data ok");
