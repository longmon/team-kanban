// Team Kanban 的 OpenUI 组件库：组件名与参数和 @openuidev/react-ui openuiLibrary 兼容，渲染用 shadcn/ui + Recharts。
// 构建时由 scripts/gen-openui.ts 导出 library.schema.json 与 prompt.md（design §2、§8.2），MCP 用同一份 schema 校验。
import { createLibrary, type PromptOptions } from "@openuidev/react-lang";
import { AreaChart, BarChart, HorizontalBarChart, LineChart, PieChart, Point, RadarChart, ScatterChart, ScatterSeries, Series } from "./charts";
import {
  BoldText, Callout, CardHeader, Col, Icon, IconText, Image, MarkDownRenderer, MetricIndicatorInline, OverviewCardBlock, OverviewCardItem,
  Separator, SnippetCardBlock, SnippetCardItem, Steps, StepsItem, Table, Tag, TagBlock, Text, TextCallout, TextContent,
} from "./content";
import { Diagram } from "./diagram";
import {
  Button, Buttons, CheckBoxGroup, CheckBoxItem, ChipItem, Chips, DatePicker, Form, FormControl, Input, Label, RadioGroup, RadioItem,
  Select, SelectItem, Slider, SwitchGroup, SwitchItem, TextArea,
} from "./forms";
import { Accordion, AccordionItem, Card, Stack, TabItem, Tabs } from "./layout";

const componentGroups = [
  {
    name: "Layout",
    components: ["Stack", "Tabs", "TabItem", "Accordion", "AccordionItem", "Steps", "StepsItem", "Separator"],
    notes: [
      "- Pages render in a WIDE desktop layout (content up to ~1680px). Consecutive chart Cards in a column Stack are placed side by side automatically (2 per row from 1280px, 3 from 1800px); Tables, long text, Markdown and Forms always take a full row — no extra layout needed for these.",
      '- Use Stack with direction "row" and wrap=true only for explicit side-by-side groups such as KPI cards or short facts; each item gets at least ~220px.',
      '- For grid-like layouts, use Stack with direction "row" and wrap set to true.',
      '- Prefer justify "start" (or omit justify) with wrap=true for stable columns instead of uneven gutters.',
      "- Use nested Stacks when you need explicit rows/sections.",
      "- Use Tabs for alternative views (chart types, data sections).",
    ],
  },
  {
    name: "Content",
    components: ["Card", "CardHeader", "TextContent", "MarkDownRenderer", "Callout", "TextCallout", "Image"],
    notes: [
      '- Use Cards to group related KPIs or sections. Stack with direction "row" for side-by-side layouts.',
      '- KPI card: Card([TextContent("Label", "small"), TextContent("1,284", "large-heavy")])',
    ],
  },
  {
    name: "Tables",
    components: ["Table", "Col"],
    notes: ['- Table is COLUMN-oriented: Table([Col("Label", dataArray), Col("Count", countArray, "number")]). Every column array must have the same length.'],
  },
  {
    name: "Charts (2D)",
    components: ["BarChart", "LineChart", "AreaChart", "RadarChart", "HorizontalBarChart", "Series"],
    notes: [
      '- Charts accept column arrays: LineChart(labels, [Series("Name", values)]).',
      "- Use Cards to wrap charts with CardHeader for titled sections.",
      '- Multiple chart views: use Tabs — Tabs([TabItem("line", "Line", [LineChart(...)]), TabItem("bar", "Bar", [BarChart(...)])])',
      '- BarChart "grouped" for side-by-side comparison, "stacked" for part-to-whole; prefer HorizontalBarChart when category labels are long.',
      '- For large values, scale the data and put the unit in the axis label (e.g. yLabel "Revenue ($k)").',
    ],
  },
  {
    name: "Charts (1D)",
    components: ["PieChart"],
    notes: ['- PieChart needs NUMBERS: PieChart(["Low", "Med", "High"], [12, 30, 8], "donut").'],
  },
  { name: "Charts (Scatter)", components: ["ScatterChart", "ScatterSeries", "Point"] },
  {
    name: "Diagrams",
    components: ["Diagram"],
    notes: [
      '- Flowcharts and architecture diagrams: Diagram(mermaidCode, caption?) with Mermaid syntax, e.g. Diagram("flowchart TD\\n  A[提交] --> B{审核}\\n  B -->|通过| C[发布]", "发布流程").',
      "- Architecture: flowchart LR with subgraph per layer/zone (or C4Context / architecture-beta). Sequence: sequenceDiagram. States: stateDiagram-v2.",
      "- Do NOT use %%{init}%% directives, click handlers or javascript: links. A linear list of steps can use Steps instead.",
    ],
  },
  {
    name: "Forms",
    components: [
      "Form", "FormControl", "Label", "Input", "TextArea", "Select", "SelectItem", "DatePicker", "Slider",
      "CheckBoxGroup", "CheckBoxItem", "RadioGroup", "RadioItem", "SwitchGroup", "SwitchItem", "Chips", "ChipItem",
    ],
    notes: [
      "- Chips: compact single/multiple selection pills. Use ChipItem references for each option.",
      "- For Form fields, define EACH FormControl as its own reference — do NOT inline all controls in one array. This allows progressive field-by-field streaming.",
      "- NEVER nest Form inside Form — each Form should be a standalone container.",
      "- Form requires explicit buttons. Always pass a Buttons(...) reference as the second Form argument.",
      "- rules is an optional object: {required: true, email: true, minLength: 8, maxLength: 100}",
      "- Available rules: required, email, min, max, minLength, maxLength, pattern, url, numeric",
      "- The renderer shows error messages automatically — do NOT generate error text in the UI",
      '- DatePicker stores "YYYY-MM-DD" (mode "single") or { from, to } (mode "range").',
    ],
  },
  { name: "Buttons", components: ["Button", "Buttons"] },
  {
    name: "Data Display",
    components: ["TagBlock", "Tag", "Icon"],
    notes: [
      '- Color-mapped Tag: Tag(value, null, "sm", value == "high" ? "danger" : value == "medium" ? "warning" : "neutral")',
      "- Icon renders a lucide icon by kebab-case name; it is also used inside Tag, IconText and ChipItem.",
    ],
  },
  {
    name: "Cards",
    components: [
      "SnippetCardBlock", "SnippetCardItem", "OverviewCardBlock", "OverviewCardItem", "Text", "BoldText", "IconText", "MetricIndicatorInline",
    ],
    notes: [
      "- Card blocks lay out 2+ items in a responsive grid. Every item in a block must have the same structure.",
      "- SnippetCardItem: small card with lhs IconText and optional rhs (Text | BoldText) — good for key/value facts and KPIs.",
      "- OverviewCardItem: small card with top (IconText | Text) and optional bottom MetricIndicatorInline — good for KPIs.",
      "- Text / BoldText / IconText / MetricIndicatorInline are inline building blocks used INSIDE card items; do not place them directly in a Stack or Card.",
    ],
  },
];

export const kanbanLibrary = createLibrary({
  root: "Stack",
  componentGroups,
  components: [
    Card, CardHeader, TextContent, MarkDownRenderer, Callout, TextCallout, Image,
    Table, Col,
    BarChart, LineChart, AreaChart, RadarChart, HorizontalBarChart, Series,
    PieChart,
    ScatterChart, ScatterSeries, Point,
    Diagram,
    Form, FormControl, Label, Input, TextArea, Select, SelectItem, DatePicker, Slider,
    CheckBoxGroup, CheckBoxItem, RadioGroup, RadioItem, SwitchGroup, SwitchItem, ChipItem, Chips,
    Button, Buttons,
    Stack, Tabs, TabItem, Accordion, AccordionItem, Steps, StepsItem, Separator,
    TagBlock, Tag, Icon,
    Text, BoldText, IconText, MetricIndicatorInline,
    SnippetCardItem, SnippetCardBlock, OverviewCardItem, OverviewCardBlock,
  ],
});

export const kanbanPromptOptions: PromptOptions = {
  examples: [
    `Example 1 — Table (column-oriented):

root = Stack([title, tbl])
title = TextContent("Top Languages", "large-heavy")
tbl = Table([Col("Language", langs), Col("Users (M)", users, "number"), Col("Year", years, "number")])
langs = ["Python", "JavaScript", "Java", "TypeScript", "Go"]
users = [15.7, 14.2, 12.1, 8.5, 5.2]
years = [1991, 1995, 1995, 2012, 2009]`,
    `Example 2 — KPIs and charts:

root = Stack([title, kpis, row])
title = CardHeader("Q4 Revenue", "Oct – Dec")
kpis = SnippetCardBlock([kpi1, kpi2])
kpi1 = SnippetCardItem("revenue", IconText(Icon("circle-dollar-sign", "finance"), "neutral", "m", "Revenue", "Quarter to date"), BoldText("number", "$48,200", "+8.1%", "metric"))
kpi2 = SnippetCardItem("users", IconText(Icon("users", "people"), "neutral", "m", "Active Users", "December"), BoldText("number", "1,204", "-0.3%", "metric"))
row = Stack([barCard, pieCard], "row", "m", "stretch", "start", true)
barCard = Card([CardHeader("Revenue by month ($k)"), BarChart(["Oct", "Nov", "Dec"], [s1, s2], "grouped")])
s1 = Series("Product A", [120, 150, 180])
s2 = Series("Product B", [90, 110, 140])
pieCard = Card([CardHeader("Channel mix"), PieChart(["Direct", "Partner", "Online"], [52, 28, 20], "donut")])`,
    `Example 3 — Form with validation:

root = Stack([title, form])
title = TextContent("Contact Us", "large-heavy")
form = Form("contact", btns, [nameField, emailField, countryField, topicField, msgField])
nameField = FormControl("Name", Input("name", "Your name", "text", { required: true, minLength: 2 }))
emailField = FormControl("Email", Input("email", "you@example.com", "email", { required: true, email: true }))
countryField = FormControl("Country", Select("country", countryOpts, "Select...", { required: true }))
countryOpts = [SelectItem("us", "United States"), SelectItem("uk", "United Kingdom"), SelectItem("de", "Germany")]
topicField = FormControl("Topics", Chips("topics", "multiple", [ChipItem("billing", "Billing"), ChipItem("bug", "Bug"), ChipItem("other", "Other")]), "Select all that apply")
msgField = FormControl("Message", TextArea("message", "Tell us more...", 4, { required: true, minLength: 10 }))
btns = Buttons([Button("Submit", @ToAssistant("Submit"), "primary")])`,
    `Example 4 — Tabs with mixed content:

root = Stack([title, tabs])
title = TextContent("React vs Vue", "large-heavy")
tabs = Tabs([tabReact, tabVue])
tabReact = TabItem("react", "React", reactContent)
tabVue = TabItem("vue", "Vue", vueContent)
reactContent = [TextContent("React is a library by Meta for building UIs."), Callout("info", "Note", "React uses JSX syntax.")]
vueContent = [TextContent("Vue is a progressive framework by Evan You."), Callout("success", "Tip", "Vue has a gentle learning curve.")]`,
  ],
  additionalRules: [
    "When asked about data, generate realistic/plausible data",
    "Pages are shown on wide desktop screens: put related charts one after another (each in its own Card) so they line up side by side; do not wrap the whole page in a single Card.",
    'For grid-like layouts, use Stack with direction "row" and wrap=true. Avoid justify="between" unless you specifically want large gutters.',
    "For forms, define one FormControl reference per field so controls can stream progressively.",
    "For forms, always provide the second Form argument with Buttons(...) actions: Form(name, buttons, fields).",
    "Never nest Form inside Form.",
    "Card blocks (SnippetCardBlock, OverviewCardBlock) need at least 2 items; every item in a block must have the same structure.",
    "Text / BoldText / IconText / MetricIndicatorInline are inline building blocks used INSIDE card items — do not place them directly in a Stack or Card.",
    "Image URLs must be real (from a tool result or the user) — never invent or template an image URL.",
    "Always pass a category to Icon — it enables a topical fallback when the exact icon name is unavailable.",
    "Use only the components listed above; anything else fails validation.",
  ],
};
