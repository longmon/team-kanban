# 设计规范（陶土 Clay）

改 UI 以本文为依据。token 唯一定义处是 `web/src/theme.css`（`:root` 亮色、`.dark` 暗色），`web/src/index.css` 的 `@theme inline` 把它们注册成 Tailwind 工具类（`bg-primary`、`shadow-card`、`ease-standard` 等）。组件是 shadcn/ui（`web/src/components/ui`），OpenUI 渲染组件 kanbanLibrary 在 `web/src/openui-lib`，两者共用同一套 token。

方向：暖白底 + 哑光橙主色，主按钮用深棕字；只有**卡片和主按钮**带很轻的暖色阴影，输入框、徽标、表格、次级按钮保持平面细描边。不用渐变背景、毛玻璃、不规则圆角、手写体。

## 1. 颜色 token

| token | 亮色 | 暗色 | 用途 |
|---|---|---|---|
| `--background` | `#fbf6f1` | `#241c17` | 页面底色 |
| `--foreground` | `#4a382d` | `#ede0d3` | 正文、标题（暖深棕/暖米白，不用纯黑纯白） |
| `--card` / `--popover` | `#fffdfa` | `#30261f` | 卡片、弹层 |
| `--primary` | `#e58a4e` | `#f29a5e` | 主按钮、选中描边、进度条、强调 |
| `--primary-foreground` | `#2e1405` | `#2e1405` | 主色上的文字（深棕，不是白字） |
| `--secondary` / `--muted` | `#f4ebe2` | `#3a2e26` | 次级底、表头、骨架屏、滑块轨道 |
| `--muted-foreground` | `#7a6254` | `#bfa893` | 次要文字（说明、时间、表头） |
| `--accent` | `#f6ede4` | `#3d3028` | 悬停底（ghost/outline 按钮、菜单项） |
| `--border` | `#eee1d4` | `rgb(255 240 225 / .10)` | 分隔线、卡片内描边 |
| `--input` | `#e6d6c7` | `rgb(255 240 225 / .15)` | 输入框描边 |
| `--ring` | `#b85a1f` | `#f29a5e` | 焦点环（统一 `ring-[3px] ring-ring/80`） |
| `--destructive` | `#be3a2e` | `#f2826f` | 错误、删除 |
| `--success` | `#36732e` | `#8dd080` | 成功、上涨 |
| `--warning` | `#96501b` | `#f0a465` | 警告 |
| `--info` | `#33679f` | `#82b6ea` | 提示 |

状态色作为文字使用时配 10–15% 同色浅底（如 `bg-success/12 text-success`）。

### 对比度核对（WCAG AA：正文 ≥ 4.5:1，大字/图形 ≥ 3:1）

改任何颜色后重算这张表。半透明底按卡片色混合后计算。

| 模式 | 组合 | 前景 | 背景 | 对比度 | 要求 | 结果 |
|---|---|---|---|---|---|---|
| 亮 | 正文 foreground / 背景 | `#4a382d` | `#fbf6f1` | 10.32 | ≥4.5 | 通过 |
| 亮 | 正文 foreground / 卡片 | `#4a382d` | `#fffdfa` | 10.92 | ≥4.5 | 通过 |
| 亮 | 正文 foreground / muted 底 | `#4a382d` | `#f4ebe2` | 9.41 | ≥4.5 | 通过 |
| 亮 | 次要文字 muted-fg / 背景 | `#7a6254` | `#fbf6f1` | 5.28 | ≥4.5 | 通过 |
| 亮 | 次要文字 muted-fg / 卡片 | `#7a6254` | `#fffdfa` | 5.59 | ≥4.5 | 通过 |
| 亮 | 次要文字 muted-fg / muted 底 | `#7a6254` | `#f4ebe2` | 4.82 | ≥4.5 | 通过 |
| 亮 | 主按钮文字 / 主色 | `#2e1405` | `#e58a4e` | 6.63 | ≥4.5 | 通过 |
| 亮 | 选中项文字 / 10% 主色底 | `#4a382d` | `#fcf2e9` | 10.04 | ≥4.5 | 通过 |
| 亮 | success 文字 / 12% 浅底（徽标） | `#36732e` | `#e7ece2` | 4.79 | ≥4.5 | 通过 |
| 亮 | warning 文字 / 15% 浅底（徽标） | `#96501b` | `#efe3d9` | 4.81 | ≥4.5 | 通过 |
| 亮 | info 文字 / 12% 浅底（徽标） | `#33679f` | `#e7ebef` | 4.89 | ≥4.5 | 通过 |
| 亮 | destructive 文字 / 10% 浅底 | `#be3a2e` | `#f9eae6` | 4.68 | ≥4.5 | 通过 |
| 亮 | destructive 文字 / 卡片（错误提示） | `#be3a2e` | `#fffdfa` | 5.39 | ≥4.5 | 通过 |
| 亮 | 危险按钮文字 / destructive | `#ffffff` | `#be3a2e` | 5.48 | ≥4.5 | 通过 |
| 亮 | 焦点环 ring/80 / 卡片（非文字） | `#c67b4b` | `#fffdfa` | 3.26 | ≥3 | 通过 |
| 亮 | 焦点环 ring/80 / 背景（非文字） | `#c57949` | `#fbf6f1` | 3.15 | ≥3 | 通过 |
| 暗 | 正文 foreground / 背景 | `#ede0d3` | `#241c17` | 12.93 | ≥4.5 | 通过 |
| 暗 | 正文 foreground / 卡片 | `#ede0d3` | `#30261f` | 11.39 | ≥4.5 | 通过 |
| 暗 | 正文 foreground / muted 底 | `#ede0d3` | `#3a2e26` | 10.14 | ≥4.5 | 通过 |
| 暗 | 次要文字 muted-fg / 背景 | `#bfa893` | `#241c17` | 7.37 | ≥4.5 | 通过 |
| 暗 | 次要文字 muted-fg / 卡片 | `#bfa893` | `#30261f` | 6.49 | ≥4.5 | 通过 |
| 暗 | 次要文字 muted-fg / muted 底 | `#bfa893` | `#3a2e26` | 5.78 | ≥4.5 | 通过 |
| 暗 | 主按钮文字 / 主色 | `#2e1405` | `#f29a5e` | 7.85 | ≥4.5 | 通过 |
| 暗 | 选中项文字 / 10% 主色底 | `#ede0d3` | `#433225` | 9.41 | ≥4.5 | 通过 |
| 暗 | success 文字 / 12% 浅底（徽标） | `#8dd080` | `#3b3a2b` | 6.28 | ≥4.5 | 通过 |
| 暗 | warning 文字 / 15% 浅底（徽标） | `#f0a465` | `#4d392a` | 5.28 | ≥4.5 | 通过 |
| 暗 | info 文字 / 12% 浅底（徽标） | `#82b6ea` | `#3a3737` | 5.52 | ≥4.5 | 通过 |
| 暗 | destructive 文字 / 10% 浅底 | `#f2826f` | `#432f27` | 4.90 | ≥4.5 | 通过 |
| 暗 | destructive 文字 / 卡片（错误提示） | `#f2826f` | `#30261f` | 5.76 | ≥4.5 | 通过 |
| 暗 | 危险按钮文字 / destructive | `#2e1405` | `#f2826f` | 6.73 | ≥4.5 | 通过 |
| 暗 | 焦点环 ring/80 / 卡片（非文字） | `#cb8351` | `#30261f` | 4.85 | ≥3 | 通过 |
| 暗 | 焦点环 ring/80 / 背景（非文字） | `#c98150` | `#241c17` | 5.38 | ≥3 | 通过 |

## 2. 字体

- 拉丁字母与数字：**Nunito**（可变字重，自托管 `@fontsource-variable/nunito`，由 `web/src/main.tsx` 引入，Vite 打包进 `dist/assets`；CSP 为 `font-src 'self' data:`，不能用 Google Fonts CDN）。
- 中文：系统字体回退（PingFang SC / Hiragino Sans GB / Microsoft YaHei / Noto Sans SC）。
- 标题与正文同一族，**标题字重 600–700**，层级靠字号和颜色：

| 层级 | 字号 / 字重 | 用法 |
|---|---|---|
| 页面标题 | 26px（手机 22px）/ 700 | `PageHeader` |
| 卡片/区块标题 | 16px / 700 | `Panel`、`CardHeader`、OpenUI `large-heavy` 为 22px |
| 正文 | 14px / 400，行高 1.55 | |
| 标签、按钮 | 13–14px / 600 | 表单 label、按钮、选项标题 |
| 次要文字 | 12–13px / 400，`muted-foreground` | 说明、时间、表头 |
| KPI 数值 | 22px / 700，`tabular-nums` | 数字一律等宽数字 |

## 3. 圆角

`--radius: 16px`：`rounded-xl` = 20px（卡片）、`rounded-lg` = 16px（KPI 小卡、对话框内块）、`rounded-md` = 14px（按钮、输入框、选项卡）、`rounded-sm` = 12px；徽标、chip、状态胶囊 `rounded-full`。

## 4. 阴影

| 工具类 | 用途 |
|---|---|
| `shadow-card` | 卡片表面（`surface` 工具类 = `rounded-xl bg-card shadow-card`）：1px 极淡暖色描边 + 软投影 + 内高光，不再加 border |
| `shadow-card-hover` | 可点击卡片悬停（`lift` 工具类）、toast、图表 tooltip |
| `shadow-primary` | 主按钮（Button `default` 变体） |
| `shadow-primary-press` | 主按钮按下 |

亮色阴影用暖棕色 `rgb(150 90 40 / …)`，暗色用黑色并带 1px 暖白细边。其余组件（Input、Badge、Table、outline 按钮）保持平面细描边。

## 5. 动效

原则：静止时外观与无动效时完全一致（配色、字体、圆角、布局不变），只在交互或数据变化时出现；每个动效都要能回答「它告诉用户什么」。只用浏览器原生能力（CSS、WAAPI、View Transitions、IntersectionObserver），不引入动画库，符合 CSP `script-src 'self'`。

| 变量 | 值 | 用途 |
|---|---|---|
| `--dur-fast` | 150ms | 勾选图标弹入、颜色切换 |
| `--dur-base` | 200ms | 默认过渡（`transition-*` 不写时长时即此值）、tw-animate 进出 |
| `--dur-slow` | 250ms | 路由切换淡入、Tab / 筛选 chips 指示块滑动 |
| `--ease-standard` | `cubic-bezier(.2,.8,.2,1)` | 统一缓动（默认过渡缓动、tw-animate 默认缓动） |
| `--ease-pop` | `cubic-bezier(.3,1.5,.5,1)` | 只用于 ≤ 24px 的小元素弹入（勾、圆点） |
| `--ease-spring` | `linear(0, .22 6%, .56 14%, .86 24%, 1.03 34%, 1.055 42%, 1.04 52%, 1.012 64%, .996 78%, 1)` | 新增。轻弹簧，过冲约 5%，**只用于按钮松开回弹** |

时长以 150–400ms 为主；图表首次绘制 550ms、结果行闪底色 600ms、骨架屏一轮 1.4s 是例外。

| 动效 | 规范 | 实现位置 |
|---|---|---|
| 按钮按下回弹 | 按下 75ms 缩到 `.97` 并下沉 1px；松开时位移/缩放走 320ms `--ease-spring`，颜色/阴影仍 200ms `--ease-standard` | `button.tsx`（按下）、`index.css` `[data-slot=button]:not(:active)`（松开，顺序须与 button.tsx 的 `transition-[…]` 一致） |
| 卡片悬停抬起 | 可点击卡片/列表行上移 2px + `shadow-card-hover`；用 `translate` 属性，不与入场动画的 `transform` 冲突 | `index.css` `lift` 工具类 |
| 列表依次入场 | `.list` 的子项淡入上移 6px，300ms，每项错开 30ms，第 9 项起同时出现；首次加载、换筛选、重新加载后重播（容器 `key={list.gen}`） | `index.css` `.list > *`、`ui.tsx` `usePaged().gen` |
| Tab / 筛选 chips 滑动指示 | 选中底色/下划线是一个绝对定位的指示块，按选中项的位置尺寸 250ms 滑过去；首帧直接到位不滑；选中项本身不再画选中底 | `tabs.tsx` `useSlidingIndicator` / `SlidingIndicator`（TabsList 内置；页内下划线 tabs 传 `PAGE_TABS_INDICATOR`）；项目页筛选 chips |
| 数字滚动计数 | 文本中第一个数字从 0（首次）或旧值补间到新值，450ms ease-out，保留前后缀/小数位/千分位，`tabular-nums` 防抖动；播完显示原文 | `openui-lib/util.tsx` `CountUp`：KPI（`MetricIndicatorInline`、`Text/BoldText` 的 number 变体）、结果页计数 |
| 骨架屏微光 | `bg-muted` 上一道浅色高光扫过，1.4s 一轮，替代 `animate-pulse` | `skeleton.tsx` + `index.css` `.skeleton-shimmer` |
| toast 滑入 | 沿用 sonner 自带的滑入/滑出，不另做 | `components/ui/sonner.tsx` |
| 勾选形变 | 多选：勾的描边 180ms 画出（`.check-draw`）；单选：圆点 150ms `--ease-pop` 弹入 | `checkbox.tsx`、`radio-group.tsx` |
| 提交 loading → 成功 / 失败 | 点击即锁定按钮宽度；内容随状态交叉淡入；成功「✓ 已提交」勾描边画出；失败抖动 300ms + `aria-invalid` 标红 + 按钮旁红字写明原因（同时 `toast.err`） | `openui-lib/forms.tsx` Button、`pages/openui-view.tsx` |
| 提交成功柔光 | 成功时按钮外一圈淡绿柔光 480ms（`::after` box-shadow 扩散到 10px 后消失），替代彩带 | `index.css` `.submit-glow` |
| 列表 → 页面共享元素 | 点列表标题进入页面：标题作为共享元素（`page-title`）300ms 移到页头 h1，其余内容交叉淡入 250ms；最多等新页标题 300ms，过渡期间点击 iframe 无效；浏览器不支持 View Transitions 时直接切换 | `router.tsx` `navigate(to, replace, from)`、`<Link viewTransition>`、`index.css` `::view-transition-*` |
| 图表首次绘制 | 折线描边、柱从 0 生长、饼/环扫过，550ms ease-out（Recharts 自带动画）；每个图表只在首次进入视口时播一次，视口外先静态完整渲染（打印、截图不缺图） | `openui-lib/charts-impl.tsx` `useDraw` |
| 结果条实时增长 + 新行闪底色 | 计数条首次出现从 0 生长（`scaleX` 360ms），新数据到达时宽度 360ms 过渡、数字滚动、该行闪一下主色 12% 底色（600ms）；表格里新到达的提交行同样闪一下（连接后 800ms 内补发的历史提交不闪） | `pages/results.tsx` `TallyRow`、`index.css` `.bar-grow` / `.flash-bg` |

- 路由切换：内容区 `.page-enter` 淡入 + 上移 4px，一次性，不做逐块飞入（报告不做滚动逐块揭示）。
- 弹层：Dialog / Dropdown / Select / Tooltip / Tabs 内容用 tw-animate-css 的 `animate-in/out fade/zoom/slide`；Accordion 用 `accordion-down/up`。
- 不做：鼠标跟随微光、噪点纹理、焦点渐变描边、报告滚动逐块揭示、⌘K、庆祝彩点。
- `prefers-reduced-motion: reduce`：所有过渡与动画时长、延迟归零，并去掉位移/缩放（按下、悬停抬起、淡入位移、列表入场、结果条生长、抖动）；骨架屏微光、闪底色、成功柔光、勾描边不播；数字直接显示终值；图表关闭进入动画；不走 View Transitions。新增动效必须同时加进 `index.css` 的这条规则。

## 6. 组件状态规范

| 状态 | 规范 |
|---|---|
| hover | 主按钮 `brightness(1.04)`；outline/ghost 按钮换 `accent` 底；可点击卡片/列表行 `lift`：上移 2px + `shadow-card-hover`；选项卡描边变 `primary/50` |
| active（按下） | 按钮 `scale(.97)` + 下沉 1px（松开走 `--ease-spring` 回弹），主按钮阴影换 `shadow-primary-press`；选项卡 `scale(.99)`，chip `scale(.97)` |
| focus-visible | `ring-[3px] ring-ring/80`（与背景 ≥ 3:1）；选项卡用 `has-[:focus-visible]` 在整卡上显示 |
| disabled | `opacity-50`、`pointer-events-none` |
| selected | **主色描边 + 10% 主色底**（`border-primary bg-primary/10`）：单选/多选选项卡、chip；多选勾描边画出、单选圆点 `zoom-in` 弹入；chip 选中时前面弹出 ✓；项目页筛选 chips 与 Tab 的选中底由滑动指示块绘制 |
| loading | `<Button loading>`：显示旋转 spinner、禁用、`aria-busy`，防止重复提交；数据加载用 `Skeleton`（`bg-muted` 底 + 微光扫过） |
| success | 提交按钮短暂（1.8s）变为「✓ 已提交」（勾描边画出 + 外圈淡绿柔光）并不可再点；同时 `toast.ok()`（带绿色勾） |
| error | 校验失败：字段下方红字 + 提交按钮抖动；提交失败：按钮抖动并 `aria-invalid` 标红，按钮旁红字写明原因，`toast.err()` 带红色叹号并写明原因 |

滑块：拇指 20px 白色，拖动时放大 1.1，右上角数值变主色并略放大。

## 7. 图表配色

| 序号 | 亮色 | 暗色 |
|---|---|---|
| `--chart-1` | `#e07a3a` 橙 | `#f08a4a` |
| `--chart-2` | `#79ba8a` 绿 | `#49c287` |
| `--chart-3` | `#d64a77` 玫红 | `#ca6a88` |
| `--chart-4` | `#549cc0` 蓝 | `#5a91c2` |
| `--chart-5` | `#7e63bc` 紫 | `#c2a1e8` |

- 色相沿用设计稿，明度按 protan / deutan / tritan 三种色弱模拟（Machado 2009）调过：任意两色在正常与三种色弱下 OKLab ΔE ≥ 8（亮色最小 8.1，暗色最小 8.1）；没有两个相近的黄/橙。
- 按序号取色，序列超过 5 个循环取色——超过 5 个应拆图或合并为「其他」。
- 堆叠柱用 1px 卡片色描边分隔；网格线虚线 `border` 色；坐标轴文字 `muted-foreground`。
- 交互：悬停图例项或图形，对应系列保持不透明、其余降到 30%；tooltip 用 popover 底 + `shadow-card-hover`。
- 环形图中心显示占比最大的一项（如「52%」+「直销」），不显示合计。

## 8. 布局

**宽屏优先**：目标是 1280–2560px 的桌面浏览器，内容随窗口宽度铺开。**手机不是设计目标**，不为手机单独做布局；窄屏下各栅格自动退成单列、能看即可，不再要求 375px 无横向滚动。

### 断点与版心

| 断点（Tailwind） | 视口 | 左右留白 |
|---|---|---|
| 默认 | < 640px | 16px（`px-4`） |
| `sm` | ≥ 640px | 24px（`px-6`） |
| `lg` | ≥ 1024px | 40px（`px-10`） |
| `2xl` | ≥ 1536px | 64px（`px-16`） |

- 版心 `WRAP`（`web/src/ui.tsx`）：`mx-auto w-full max-w-[1808px]` + 上表留白，内容区最宽 **1680px**；顶栏与内容区共用，左右对齐。2560 屏两侧留白，不无限拉长。
- `Page` 不再自带最大宽度，跟随版心。

### 管理端栅格

| 场景 | 规则 |
|---|---|
| 组织 / 项目卡片 | `grid-cols-[repeat(auto-fill,minmax(260px,1fr))]`（`TILES`） |
| 列表 + 新建表单 | `.split`：`xl`（≥1280）起主列 `minmax(0,1fr)` + 右侧栏 400px（新建组织/项目/群组、邀请、令牌、临时链接、添加成员），以下上下堆叠 |
| 设置类面板 | `.cols-2`：`xl` 起两列分组（如基本信息 \| 退出/删除） |
| 表单控件 | `.form` 最宽 `max-w-2xl`；列表上方搜索框 `.search` 最宽 `max-w-md`；工具条输入框最宽 `max-w-sm` |
| 结果页 | 有统计时 `xl` 起左侧统计 360px、右侧明细表格；以下统计在上（`auto-fill minmax(280px)`） |
| 列表、表格 | 铺满主列 |

### 页面查看（OpenUI）

- OpenUI 根内容直接放在页面底色上，不再套外层卡片；KPI、图表卡、表格自身是 `surface`。已在卡片里的表格/表单/图表不再加表面（`InSurface` 上下文，避免卡片套卡片）。
- 页面含图表 / 表格 / KPI 块时铺满版心；纯表单/文字页收窄到 `max-w-5xl` 居中（页头同宽）。
- 多列规则：
  - KPI / Snippet / Overview 卡：`auto-fit minmax(220px,1fr)`，一行排满。
  - 纵向 Stack 中**连续 ≥ 2 个图表卡**（或裸图表）自动并排：≥1280px 两列，≥1800px 三列（只有 2 个时保持两列）；表格、长文本、Markdown、表单占满整行。
  - 横向 `Stack(…, "row", …, wrap=true)` 行为不变：子项 `flex: 1 1 220px`。
  - 环形/饼图：容器宽 ≥ 420px 时图例放图右侧、整体最宽 460px 居中；不够时回落到下方。
- 表单：不在卡片里的 Form 自成一张承托卡片；单选/多选选项卡 `auto-fill minmax(280px,1fr)`、最宽 `max-w-5xl`（宽屏 2–3 列）；文本输入框最宽 `max-w-3xl`；正文段落 `.md p/li` 最宽 `80ch`。
- 自动多列只改渲染，不改提交数据格式（`{action, form, values, params}`，见 `docs/api.md`）。
