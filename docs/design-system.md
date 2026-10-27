# 设计规范（一条时间流）

改 UI 以本文为依据。token 唯一定义处是 `web/src/theme.css`（`:root` 亮色、`.dark` 暗色），`web/src/index.css` 的 `@theme inline` 把它们注册成 Tailwind 工具类（`bg-primary`、`bg-highlight`、`shadow-pop`、`ease-standard` 等）。组件是 shadcn/ui（`web/src/components/ui`，`web/components.json` 已按官方方式初始化，可用 `npx shadcn@latest add` 管理；新增组件须把默认样式映射到本文 token，例如 `command.tsx` 的弹层圆角 10px、`shadow-pop`），OpenUI 渲染组件 kanbanLibrary 在 `web/src/openui-lib`，两者共用同一套 token。

方向：纸白底 + 深墨字 + 深海青主色。**柠檬黄只当荧光笔**（「等你投票」标记、操作条当前项、待参与计数），珊瑚只做警示点缀（不作文字色）。列表无圆角，靠分隔线分行；输入框、弹层、卡片 10px 圆角；chip 与浮动操作条全圆。**阴影只给浮动操作条和弹层**（菜单、对话框、命令栏、toast），卡片用 1px 线。不用渐变背景、毛玻璃、不规则圆角、手写体；不用全大写小标签、「A · B · C」中点拼接、按钮文字后加 →。

信息架构：顶部居中命令栏（⌘K / Ctrl+K，搜项目、页面、执行动作），首页是跨项目的页面动态流，项目页是同一套动态流只过滤该项目，页面详情沉浸阅读 + 底部浮动操作条（投票/内容、结果、管理、复制链接）。

## 1. 颜色 token

| token | 亮色 | 暗色 | 用途 |
|---|---|---|---|
| `--background` | `#fafaf7` | `#111518` | 页面底色（纸白，中性偏冷） |
| `--foreground` | `#141c26` | `#e8eaec` | 正文、标题、选中 chip 底、操作条底（深墨） |
| `--card` | `#ffffff` | `#181d21` | 卡片、表单承托 |
| `--popover` | `#ffffff` | `#1c2226` | 弹层、命令栏、对话框 |
| `--primary` | `#0b7a82` | `#3fc1c9` | 主按钮、链接与行动作、结果条、焦点环（深海青） |
| `--primary-foreground` | `#ffffff` | `#0b1a1c` | 主色上的文字 |
| `--highlight` | `#e9f45c` | `#e9f45c` | 荧光笔：「等你投票」、操作条当前项、待参与计数（柠檬，暗色不变） |
| `--highlight-foreground` | `#141c26` | `#141c26` | 荧光笔上的文字，一律深墨 |
| `--coral` | `#ff7a59` | `#ff8a6e` | 警示点缀（点、条），不作文字色；其上文字用深墨 |
| `--secondary` / `--muted` | `#f0f1ec` | `#1f262b` | 次级底、表头、骨架屏、结果条轨道 |
| `--muted-foreground` | `#5e6672` | `#9aa3ad` | 次要文字（说明、时间、表头） |
| `--accent` | `#eff1ec` | `#222a30` | 悬停底（ghost/outline 按钮、菜单项、命令栏选中项） |
| `--border` | `#e4e5e0` | `rgb(255 255 255 / .09)` | 分隔线、卡片 1px 线 |
| `--input` | `#d6d8d2` | `rgb(255 255 255 / .15)` | 输入框描边、卡片悬停描边 |
| `--ring` | `#0b7a82` | `#3fc1c9` | 焦点环（统一 `ring-[3px] ring-ring/80`） |
| `--destructive` | `#c2381f` | `#ff8a6e` | 错误、删除 |
| `--success` | `#276d35` | `#6fcf8a` | 成功、上涨 |
| `--warning` | `#a5481c` | `#f2b266` | 警告（文字） |
| `--info` | `#2f63a6` | `#84b4f0` | 提示 |

状态色作为文字使用时配 10–15% 同色浅底（如 `bg-success/12 text-success`）。

### 对比度核对（WCAG AA：正文 ≥ 4.5:1，大字/图形 ≥ 3:1）

改任何颜色后重算这张表。半透明底按卡片色混合后计算。

| 模式 | 组合 | 前景 | 背景 | 对比度 | 要求 | 结果 |
|---|---|---|---|---|---|---|
| 亮 | 正文 foreground / 背景 | `#141c26` | `#fafaf7` | 16.41 | ≥4.5 | 通过 |
| 亮 | 正文 foreground / 卡片 | `#141c26` | `#ffffff` | 17.16 | ≥4.5 | 通过 |
| 亮 | 正文 foreground / muted 底 | `#141c26` | `#f0f1ec` | 15.12 | ≥4.5 | 通过 |
| 亮 | 次要文字 muted-fg / 背景 | `#5e6672` | `#fafaf7` | 5.55 | ≥4.5 | 通过 |
| 亮 | 次要文字 muted-fg / 卡片 | `#5e6672` | `#ffffff` | 5.80 | ≥4.5 | 通过 |
| 亮 | 次要文字 muted-fg / muted 底 | `#5e6672` | `#f0f1ec` | 5.11 | ≥4.5 | 通过 |
| 亮 | 主按钮文字 / 主色 | `#ffffff` | `#0b7a82` | 5.10 | ≥4.5 | 通过 |
| 亮 | 主色文字（链接、行动作）/ 背景 | `#0b7a82` | `#fafaf7` | 4.87 | ≥4.5 | 通过 |
| 亮 | 主色文字 / 卡片 | `#0b7a82` | `#ffffff` | 5.10 | ≥4.5 | 通过 |
| 亮 | 选中项文字 / 10% 主色底 | `#141c26` | `#e7f2f3` | 15.03 | ≥4.5 | 通过 |
| 亮 | 荧光笔文字 / 柠檬 | `#141c26` | `#e9f45c` | 14.35 | ≥4.5 | 通过 |
| 亮 | 操作条文字 / 深墨底 | `#ffffff` | `#141c26` | 17.16 | ≥4.5 | 通过 |
| 亮 | 操作条次要文字 80% / 深墨底 | `#d0d2d4` | `#141c26` | 11.32 | ≥4.5 | 通过 |
| 亮 | 选中 chip 文字 / 深墨底 | `#fafaf7` | `#141c26` | 16.41 | ≥4.5 | 通过 |
| 亮 | 警示点缀上的文字 / 珊瑚 | `#141c26` | `#ff7a59` | 6.68 | ≥4.5 | 通过 |
| 亮 | success 文字 / 12% 浅底（徽标） | `#276d35` | `#e5ede7` | 5.29 | ≥4.5 | 通过 |
| 亮 | warning 文字 / 15% 浅底（徽标） | `#a5481c` | `#f2e4dd` | 4.77 | ≥4.5 | 通过 |
| 亮 | info 文字 / 12% 浅底（徽标） | `#2f63a6` | `#e6ecf4` | 5.11 | ≥4.5 | 通过 |
| 亮 | destructive 文字 / 10% 浅底（徽标） | `#c2381f` | `#f9ebe9` | 4.66 | ≥4.5 | 通过 |
| 亮 | destructive 文字 / 卡片 | `#c2381f` | `#ffffff` | 5.41 | ≥4.5 | 通过 |
| 亮 | 危险按钮文字 / destructive | `#ffffff` | `#c2381f` | 5.41 | ≥4.5 | 通过 |
| 亮 | 焦点环 ring/80 / 卡片（非文字） | `#3c959b` | `#ffffff` | 3.52 | ≥3 | 通过 |
| 亮 | 焦点环 ring/80 / 背景（非文字） | `#3b9499` | `#fafaf7` | 3.41 | ≥3 | 通过 |
| 亮 | 结果条 primary / muted 轨道（图形） | `#0b7a82` | `#f0f1ec` | 4.49 | ≥3 | 通过 |
| 暗 | 正文 foreground / 背景 | `#e8eaec` | `#111518` | 15.22 | ≥4.5 | 通过 |
| 暗 | 正文 foreground / 卡片 | `#e8eaec` | `#181d21` | 14.08 | ≥4.5 | 通过 |
| 暗 | 正文 foreground / muted 底 | `#e8eaec` | `#1f262b` | 12.71 | ≥4.5 | 通过 |
| 暗 | 次要文字 muted-fg / 背景 | `#9aa3ad` | `#111518` | 7.18 | ≥4.5 | 通过 |
| 暗 | 次要文字 muted-fg / 卡片 | `#9aa3ad` | `#181d21` | 6.64 | ≥4.5 | 通过 |
| 暗 | 次要文字 muted-fg / muted 底 | `#9aa3ad` | `#1f262b` | 6.00 | ≥4.5 | 通过 |
| 暗 | 主按钮文字 / 主色 | `#0b1a1c` | `#3fc1c9` | 8.21 | ≥4.5 | 通过 |
| 暗 | 主色文字 / 背景 | `#3fc1c9` | `#111518` | 8.46 | ≥4.5 | 通过 |
| 暗 | 主色文字 / 卡片 | `#3fc1c9` | `#181d21` | 7.83 | ≥4.5 | 通过 |
| 暗 | 选中项文字 / 10% 主色底 | `#e8eaec` | `#1c2d32` | 11.84 | ≥4.5 | 通过 |
| 暗 | 荧光笔文字 / 柠檬 | `#141c26` | `#e9f45c` | 14.35 | ≥4.5 | 通过 |
| 暗 | 操作条文字 / 浅色底（foreground） | `#111518` | `#e8eaec` | 15.22 | ≥4.5 | 通过 |
| 暗 | 操作条次要文字 80% / 浅色底 | `#3c4042` | `#e8eaec` | 8.69 | ≥4.5 | 通过 |
| 暗 | success 文字 / 12% 浅底（徽标） | `#6fcf8a` | `#22322e` | 7.01 | ≥4.5 | 通过 |
| 暗 | warning 文字 / 15% 浅底（徽标） | `#f2b266` | `#39332b` | 6.74 | ≥4.5 | 通过 |
| 暗 | info 文字 / 12% 浅底（徽标） | `#84b4f0` | `#252f3a` | 6.32 | ≥4.5 | 通过 |
| 暗 | destructive 文字 / 10% 浅底（徽标） | `#ff8a6e` | `#2f2829` | 6.26 | ≥4.5 | 通过 |
| 暗 | destructive 文字 / 卡片 | `#ff8a6e` | `#181d21` | 7.37 | ≥4.5 | 通过 |
| 暗 | 危险按钮文字 / destructive | `#0b1a1c` | `#ff8a6e` | 7.73 | ≥4.5 | 通过 |
| 暗 | 焦点环 ring/80 / 卡片（非文字） | `#37a0a7` | `#181d21` | 5.46 | ≥3 | 通过 |
| 暗 | 焦点环 ring/80 / 背景（非文字） | `#369fa6` | `#111518` | 5.83 | ≥3 | 通过 |
| 暗 | 结果条 primary / muted 轨道（图形） | `#3fc1c9` | `#1f262b` | 7.07 | ≥3 | 通过 |

## 2. 字体

- 标题与数字：**Bricolage Grotesque**（可变字重，自托管 `@fontsource-variable/bricolage-grotesque`，由 `web/src/main.tsx` 引入，Vite 打包进 `dist/assets`；CSP 为 `font-src 'self' data:`，不能用 Google Fonts CDN）。`h1–h3` 与 `.font-heading`（KPI、计数、日期分组、字形）使用；中文字符回退系统字体。
- 正文：系统字体 `system-ui` + 中文系统栈（PingFang SC / Hiragino Sans GB / Microsoft YaHei / Noto Sans SC），不加载网络字体。
- **标题字重 600–700**，层级靠字号和颜色：

| 层级 | 字号 / 字重 | 用法 |
|---|---|---|
| 页面详情标题 | 28px（手机 23px）/ 700 | 详情页 h1，带 `data-vt` 做共享元素过渡 |
| 管理页标题 | 26px（手机 22px）/ 700 | `PageHeader` |
| 区块标题 | 16px / 700 | `Panel`、详情页「页面设置」「临时链接」 |
| 动态流标题 | 15px / 600 | 每行页面标题 |
| 日期分组 | 13px / 700，Bricolage | 今天 / 昨天 / 本周 / 更早 |
| 正文 | 14px / 400，行高 1.55 | |
| 标签、按钮 | 13–14px / 500–600 | |
| 次要文字 | 12–13px / 400，`muted-foreground` | 发布者、时间、说明 |
| KPI / 计数 | 22px / 700，`tabular-nums` | 数字一律等宽数字 |

## 3. 圆角

`--radius: 10px`：`rounded-lg` = 10px（输入框、弹层、命令栏、卡片、表单承托）、`rounded-md` = 8px（按钮、菜单项）、`rounded-sm` = 6px；列表行**不加圆角**，用 `border-b` 分隔；chip、徽标、浮动操作条 `rounded-full`。

## 4. 阴影

| 工具类 | 用途 |
|---|---|
| `shadow-pop` | 弹层：下拉菜单、Select、对话框、AlertDialog、命令栏、toast、图表 tooltip |
| `shadow-dock` | 详情页底部浮动操作条 |
| `shadow-card` | 值为 1px `border` 色描边（不是投影）：`surface` 工具类 = `rounded-lg bg-card shadow-card`，OpenUI 卡片沿用 |
| `shadow-card-hover` | 值为 1px `input` 色描边：可点击卡片悬停（`lift`） |

`shadow-primary` / `shadow-primary-press` 保留变量名，值为 `none`（主按钮平面）。

## 5. 动效

原则：静止时外观与无动效时完全一致，只在交互、数据变化或首次进入时出现；每个动效都要能回答「它告诉用户什么」；时长 150–400ms；不做无意义的悬停动效（悬停只换颜色/描边）。交互组件 Tabs / Dialog / AlertDialog / DropdownMenu / Tooltip / Accordion / Checkbox / RadioGroup / Switch 用 animate-ui（`@animate-ui/react/primitives/radix-ui`，基于 motion）；动态流、操作条等页面级动效用 motion（`motion/react`）；其余用浏览器原生能力（CSS、View Transitions、IntersectionObserver）。全部随包打进 bundle，符合 CSP `script-src 'self'`。

| 变量 | 值 | 用途 |
|---|---|---|
| `--dur-fast` | 150ms | 勾选图标弹入、颜色切换、行淡出 |
| `--dur-base` | 200ms | 默认过渡、tw-animate 进出（命令栏缩放淡入/退出） |
| `--dur-slow` | 250ms | 路由切换淡入、Tab 指示块滑动 |
| `--ease-standard` | `cubic-bezier(.2,.8,.2,1)` | 统一缓动 |
| `--ease-pop` | `cubic-bezier(.3,1.5,.5,1)` | 只用于 ≤ 24px 的小元素弹入（勾、圆点） |
| `--ease-spring` | `linear(…)` 过冲约 5% | 按钮松开回弹 |

| 动效 | 规范 | 实现位置 |
|---|---|---|
| 标题共享元素过渡 | 点动态流里的标题进入详情：标题（`data-vt`）作为 `page-title` 300ms 移到详情 h1，其余内容交叉淡入；浏览器后退时反向（详情 h1 → 流里同一行标题，动态流有模块级缓存，返回时立即渲染）；最多等目标 300ms，过渡期间点击 iframe 无效；不支持 View Transitions 时直接切换 | `router.tsx` `sharedTitle` / `navigate` / `popstate`、`pages/feed.tsx`、`pages/view.tsx`、`index.css` `::view-transition-*` |
| 动态流首次错落入场 | 本次会话首页第一次加载：行与日期分组淡入上移 8px，300ms，每项错开 30ms，第 11 项起同时；之后切 chip、翻页、返回都不再播 | `pages/feed.tsx`（模块级 `played`） |
| chip 切换重排 | 列表项 `layout="position"` 300ms 平滑重排，离开的行 150ms 淡出（`AnimatePresence mode="popLayout"`），新出现的行 200ms 淡入；选中底块在 chip 间滑动（`layoutId`，弹簧 300ms） | `pages/feed.tsx` |
| 荧光笔刷出 | 「等你投票」柠檬底从左到右刷出（`background-size` 0→100%，400ms，延迟 120ms），只在首屏首次加载时播 | `index.css` `.hl` / `.mark-sweep` |
| 浮动操作条 | 入场从下方 28px 弹起（弹簧 400ms，过冲轻微）；切换按钮时柠檬选中底块滑动（`layoutId`）；挂到 body，避免路由入场 transform 影响 fixed 定位 | `pages/view.tsx` `Dock` |
| 结果展开 | 计数条首次出现从 0 生长（`scaleX` 360ms），数字从 0 滚动到终值（450ms ease-out）；新提交到达时宽度过渡、数字滚动、整行闪一下主色 12% 底色（600ms） | `pages/results.tsx` `TallyRow`、`openui-lib/util.tsx` `CountUp`、`index.css` `.bar-grow` / `.flash-bg` |
| 提交确认 | 提交按钮「✓ 已提交」勾描边画出 + 外圈柔光 480ms；500ms 后（结果对我可见时）自动切到结果，我选的选项条前勾描边画出并闪一次底色 | `openui-lib/forms.tsx`、`pages/view.tsx`、`pages/results.tsx` |
| 已提交锁定 | 提交成功立即进入锁定态：未选项 200ms 淡到 45% 不透明度并去饱和、选中项保持主色描边 + 10% 主色底，按钮变「✓ 已提交（第 N 版）」（勾描边画出 + 柔光），900ms 后（结果可见时）切到结果 | `openui-lib/forms.tsx` `useLocked`、`pages/view.tsx` |
| 命令栏 | 打开/关闭 200ms 缩放（95%↔100%）+ 淡入淡出，遮罩淡入 | `components/ui/command.tsx`（tw-animate） |
| 路由切换 | 内容区 `.page-enter` 淡入 + 上移 4px，250ms，一次性；改 `?tab=` 不重播 | `main.tsx`、`index.css` |
| 按钮按下回弹 | 按下 75ms 缩到 `.97` 并下沉 1px；松开 320ms `--ease-spring` | `button.tsx`、`index.css` |
| Tab 滑动指示 | animate-ui TabsList 内置，Tab 状态写进 URL（`?tab=`） | `tabs.tsx`、`ui.tsx` `useTab` |
| 骨架屏微光 | `bg-muted` 上一道浅色高光扫过，1.4s 一轮 | `skeleton.tsx`、`index.css` |
| 图表首次绘制 | 550ms，只在首次进入视口时播一次 | `openui-lib/charts-impl.tsx` |

- 弹层：Dialog / AlertDialog / Dropdown / Tooltip 由 animate-ui 驱动（对话框静止后由 `index.css` 清掉残留的 3D 变换）；Select 与命令栏用 tw-animate-css 的 `animate-in/out fade/zoom`。
- 不做：鼠标跟随微光、噪点纹理、悬停抬起/放大、报告滚动逐块揭示、庆祝彩点。
- `prefers-reduced-motion: reduce`：所有 CSS 过渡与动画时长、延迟归零，去掉位移/缩放；荧光笔刷出、骨架屏微光、闪底色、成功柔光、勾描边不播；数字直接显示终值；图表关闭进入动画；不走 View Transitions；animate-ui 用 `AnimateUIProvider tempo=0.01`，motion 用 `MotionConfig reducedMotion="user"` + 默认过渡时长 0，动态流与操作条跳过入场（`ui.tsx` `REDUCED`）。新增动效必须同时处理这两处。

## 6. 组件状态规范

| 状态 | 规范 |
|---|---|
| hover | 主按钮 `brightness(1.04)`；outline/ghost 按钮换 `accent` 底；可点击卡片 `lift`：描边加深（不位移）；动态流标题与行动作加下划线；选项卡描边变 `primary/50` |
| active（按下） | 按钮 `scale(.97)` + 下沉 1px（松开走 `--ease-spring` 回弹），主按钮阴影换 `shadow-primary-press`；选项卡 `scale(.99)`，chip `scale(.97)` |
| focus-visible | `ring-[3px] ring-ring/80`（与背景 ≥ 3:1）；选项卡用 `has-[:focus-visible]` 在整卡上显示 |
| disabled | `opacity-50`、`pointer-events-none` |
| selected | 表单选项：**主色描边 + 10% 主色底**（`border-primary bg-primary/10`），多选勾描边画出、单选圆点 `zoom-in` 弹入；动态流筛选 chip：深墨底 + 纸白字（滑动底块）；浮动操作条当前项：柠檬底 + 深墨字（滑动底块） |
| locked（已提交） | 每版每人限交一次。原题按提交数据回填：选中项「主色描边 + 10% 主色底」，未选项 `opacity-45 saturate-50`，文本框只读显示填写内容；整组 `inert` 屏蔽交互（不用 disabled 样式，选中项不变灰）；按钮「✓ 已提交（第 N 版）」。登录用户取 view 的 `my_response`，匿名访客与临时链接访问取 localStorage（`relay_resp_{page_id}_v{version}`）；HTML 页面由桥接脚本按 relay:init 的 `my_response` 回填锁定 |
| 历史版本 | 多于 1 个版本时标题下有「第 N 版」下拉（URL `?version=N` 可直达）；看历史版本时顶部柠檬浅底提示「你在看第 N 版，当前是第 M 版」+「回到最新版」，内容一律只读；交过上一版、当前版未交时提示「页面已更新到第 M 版，可以重新提交」，动态流重新出现「等你投票」 |
| loading | `<Button loading>`：显示旋转 spinner、禁用、`aria-busy`，防止重复提交；数据加载用 `Skeleton`（`bg-muted` 底 + 微光扫过） |
| success | 提交按钮短暂（1.8s）变为「✓ 已提交」（勾描边画出 + 外圈淡绿柔光）并不可再点；同时 `toast.ok()`（带绿色勾） |
| error | 校验失败：字段下方红字 + 提交按钮抖动；提交失败：按钮抖动并 `aria-invalid` 标红，按钮旁红字写明原因，`toast.err()` 带红色叹号并写明原因 |

滑块：拇指 20px 白色，拖动时放大 1.1，右上角数值变主色并略放大。

## 7. 图表配色

| 序号 | 亮色 | 暗色 |
|---|---|---|
| `--chart-1` | `#0b7a82` 深海青 | `#3fc1c9` |
| `--chart-2` | `#e2562f` 珊瑚橙 | `#ff8a6e` |
| `--chart-3` | `#715408` 赭褐 | `#f8cc52` 琥珀 |
| `--chart-4` | `#8970f6` 靛紫 | `#6387f5` 钴蓝 |
| `--chart-5` | `#b67dba` 兰紫 | `#bd5eab` 梅红 |

- 第 1、2 色取主色与珊瑚，其余三色在 OKLCH 里按 protan / deutan / tritan 三种色弱模拟（Machado 2009，严重度 1.0）搜索：任意两色在正常与三种色弱下 OKLab ΔE ≥ 8（亮色最小 9.9：protan 下深海青 vs 兰紫；暗色最小 11.5：tritan 下青 vs 钴蓝）；与卡片底对比均 ≥ 3:1（亮色最低 3.17，暗色最低 4.33）。柠檬黄不进图表（亮底上对比不足）。
- 按序号取色，序列超过 5 个循环取色——超过 5 个应拆图或合并为「其他」。
- 堆叠柱用 1px 卡片色描边分隔；网格线虚线 `border` 色；坐标轴文字 `muted-foreground`。
- 交互：悬停图例项或图形，对应系列保持不透明、其余降到 30%；tooltip 用 popover 底 + `shadow-pop`。
- 环形图中心显示占比最大的一项（如「52%」+「直销」），不显示合计。

## 8. 布局

外壳：顶栏 56px，三栏栅格（左品牌、中命令栏 `min(380px,40vw)`、右头像菜单），顶栏内容最宽 1400px；手机（< 640px）命令栏收成搜索图标按钮，品牌只留图标。内容区左右留白 16px（`px-4`）/ 24px（`sm:px-6`），底部留 112px 给浮动操作条。

| 页面 | 宽度 |
|---|---|
| 首页动态流、项目页「页面」Tab | 680px 居中 |
| 页面详情 | OpenUI 正文 720px 居中；含图表/表格/KPI/Diagram 的 OpenUI、知识库（左侧目录）与 HTML iframe 页面 1024px |
| 组织页、项目成员与权限/设置、令牌、账号、组织列表 | `Page`：1024px 居中 |

### 管理端栅格

| 场景 | 规则 |
|---|---|
| 组织 / 项目卡片 | `grid-cols-[repeat(auto-fill,minmax(260px,1fr))]`（`TILES`） |
| 列表 + 新建表单 | `.split`：`xl`（≥1280）起主列 + 右侧栏 400px，以下上下堆叠 |
| 设置类面板 | `.cols-2`：`xl` 起两列分组 |
| 表单控件 | `.form` 最宽 `max-w-2xl`；搜索框 `.search` 最宽 `max-w-md` |
| 结果（独立页 `/pages/:id/results`） | 有统计时 `xl` 起左侧统计 360px、右侧明细；详情页内嵌时统计单列在上、明细在下 |

### 页面查看（OpenUI）

- OpenUI 根内容直接放在页面底色上，不再套外层卡片；KPI、图表卡、表格自身是 `surface`。已在卡片里的表格/表单/图表不再加表面（`InSurface` 上下文，避免卡片套卡片）。
- 页面含图表 / 表格 / KPI / Diagram 块时宽 1024px；纯表单/文字页 720px 居中（页头同宽）；外壳 h1 已是页面标题，正文第一个 `large-heavy` 标题与之相同时隐藏，避免重复。
- 多列规则：
  - KPI / Snippet / Overview 卡：`auto-fit minmax(220px,1fr)`，一行排满。
  - 纵向 Stack 中**连续 ≥ 2 个图表卡**（或裸图表）自动并排：≥1280px 两列，≥1800px 三列（只有 2 个时保持两列）；表格、长文本、Markdown、表单占满整行。
  - 横向 `Stack(…, "row", …, wrap=true)` 行为不变：子项 `flex: 1 1 220px`。
  - 环形/饼图：容器宽 ≥ 420px 时图例放图右侧、整体最宽 460px 居中；不够时回落到下方。
- 表单：不在卡片里的 Form 自成一张承托卡片；单选/多选选项卡 `auto-fill minmax(280px,1fr)`（`min-w-0`，不撑破承托卡片）、最宽 `max-w-5xl`；文本输入框最宽 `max-w-3xl`；正文段落 `.md p/li` 最宽 `80ch`。
- 自动多列只改渲染，不改提交数据格式（`{action, form, values, params}`，见 `docs/api.md`）。
