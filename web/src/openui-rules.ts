// 本项目对 agent 的提交规则（design §8.2），拼在官方提示词之后
export const KANBAN_RULES = `## Team Kanban 页面规则

- 根组件必须是 \`root = Stack([...])\`；不要使用 \`Query()\` / \`Mutation()\`（页面没有数据源，会报错）；不要编造图片 URL。
- **每个 \`@ToAssistant("…")\` 按钮点击 = 一次提交**，提交内容是按钮文字 + 所在 Form 的字段值；一个 Form 只放一个提交按钮，不要放「取消」按钮。
- 表单字段用稳定的英文 \`name\`，agent 拿回的 \`data.values\` 以它为键。
- 页面类型（publish_page 的 \`page_type\`）：report / knowledge / flowchart / architecture 是只读页面，**不要放 Form 或 \`@ToAssistant\` 按钮**（不会显示）；需要回复用 vote。
- knowledge 知识库：正文用 \`MarkDownRenderer\`，以 \`##\` / \`###\` 标题分节，宽屏时自动生成左侧目录。flowchart / architecture 用 \`Diagram\` 写 Mermaid。
- 外部用户不在项目里：发布后用 \`create_share_link\` 生成临时链接发出去，或 \`visibility=public\`。
- html 兜底：自包含 HTML，\`<form data-kanban>\` 或 \`kanban.submit({...})\` 提交；页面在沙箱 iframe 中，不能用 cookie/localStorage/弹窗。
`;
