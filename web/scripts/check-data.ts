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

// 结果标签：取 OpenUI 里的字段/选项标签
import { colLabel, specLabels, valLabel } from "../src/data";
const L = specLabels(`root = Stack([form])
form = Form("vote", btns, [choiceField, c2, pick])
choiceField = FormControl("方案", RadioGroup("choice", [optA, optB], null, { required: true }))
optA = RadioItem("A. Kafka", "吞吐高", "A")
optB = RadioItem("B. \\"NATS\\"", "轻量", "B")
c2 = FormControl("评价", chips)
chips = Chips("score", "single", [c1])
c1 = ChipItem("good", "有帮助")
pick = FormControl("同意上线", CheckBoxGroup("approved", [i1]))
i1 = CheckBoxItem("CH-101", "支付回调重试", "ch101")`);
assert.equal(colLabel("choice", L), "方案");
assert.equal(valLabel("choice", "B", L), 'B. "NATS"');
assert.equal(colLabel("score", L), "评价");
assert.equal(valLabel("score", "good", L), "有帮助");
assert.equal(colLabel("approved.ch101", L), "同意上线：CH-101");
assert.equal(colLabel("comment", L), "comment");
assert.equal(valLabel("choice", "Z", L), "Z");
console.log("labels ok");

// 默认值不改直接提交：useField 把 fieldDefault / checkedDefault 写进表单状态，提交的 values 就是界面显示的默认项
import { checkedDefault, fieldDefault } from "../src/openui-lib/forms";
assert.equal(fieldDefault(undefined, "B"), "B"); // RadioGroup defaultValue
assert.equal(fieldDefault("草稿", undefined), "草稿"); // Input / TextArea / Select / DatePicker 字面量 value
assert.deepEqual(fieldDefault(undefined, [30]), [30]); // Slider defaultValue
assert.equal(fieldDefault({ __reactive: "assign", target: "$x", expr: null }, "B"), undefined); // $变量绑定不写默认
assert.equal(fieldDefault(undefined, undefined), undefined);
assert.deepEqual(checkedDefault([{ name: "a", defaultChecked: true }, { name: "b" }]), { a: true, b: false });
assert.equal(checkedDefault([{ name: "a" }, { name: "b", defaultChecked: false }]), undefined);
assert.deepEqual(normalizeValues({ vote: { choice: { value: fieldDefault(undefined, "B") } } }, "vote"), { choice: "B" });
console.log("defaults ok");
