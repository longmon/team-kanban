// 经典主题（Windows 98）外壳与通用小部件：「Team Kanban - 资源管理器」窗口（标题栏 / 菜单栏 / 工具栏 / 地址栏 / 左侧文件夹树 / 状态栏）
// + 任务栏（开始菜单、托盘、时钟）+ 右侧停靠小窗（等我处理、实时动态）。只做视觉隐喻，不做窗口拖拽、层叠、最小化。
// 只在 <html data-skin="classic"> 时由 shell.tsx 渲染；样式全部在 classic.css（限定在 [data-skin=classic] 下）。
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Link, navigate, useLocation, useQuery } from "./router";
import { copyText, ROLE_LABEL, setCurrentOrg, toast, toneOf, useActiveProject, useMyProjects, useNow, useSession } from "./ui";
import { pagesOf, useHomeStats } from "./pages/feed";
import { useShellActions } from "./shell";
import { PixelIcon, TONE_PIXEL, type PixelName } from "./pixel-icons";

// ---------- 停靠栏：页面把小窗渲染到主窗右侧（手机上排在主窗下方） ----------
const DockCtx = createContext<HTMLElement | null>(null);
export function Dock({ children }: { children: ReactNode }) {
  const el = useContext(DockCtx);
  return el ? createPortal(children, el) : null;
}

/** 窗口标题栏右侧的最小化/最大化/关闭：只是装饰（不做窗口管理）；onClose 时关闭按钮可用 */
function Controls({ onClose }: { onClose?: () => void }) {
  return (
    <span className="cl-ctl">
      {!onClose && <><span aria-hidden="true"><PixelIcon name="min" /></span><span aria-hidden="true"><PixelIcon name="res" /></span></>}
      {onClose ? <button type="button" aria-label="关闭" onClick={onClose}><PixelIcon name="x" /></button> : <span aria-hidden="true" className="x"><PixelIcon name="x" /></span>}
    </span>
  );
}

/** 停靠小窗 */
export function MiniWindow({ title, icon, label, children }: { title: ReactNode; icon: PixelName; label: string; children: ReactNode }) {
  return (
    <section className="cl-win cl-mini" aria-label={label}>
      <div className="cl-titlebar"><PixelIcon name={icon} /><span className="cl-t">{title}</span><Controls /></div>
      <div className="cl-mini-body">{children}</div>
    </section>
  );
}

/** 属性对话框（页面详情）：标题栏「标题 - 属性」+ 选项卡 + 内容 + 底部 确定 / 取消 / 应用 */
export function ClassicSheet({ title, icon, tabs, onClose, children }: {
  title: string; icon: PixelName; tabs: { label: string; on?: boolean; onClick?: () => void }[]; onClose: () => void; children: ReactNode;
}) {
  return (
    <section className="cl-win cl-sheet" aria-label={`${title} - 属性`}>
      <div className="cl-titlebar"><PixelIcon name={icon} /><span className="cl-t">{title} - 属性</span><Controls onClose={onClose} /></div>
      <div className="cl-sheet-body">
        <div className="cl-tabs">
          {tabs.map((t) => <button key={t.label} type="button" aria-pressed={!!t.on} onClick={t.onClick}>{t.label}</button>)}
        </div>
        <div className="cl-tabpanel">{children}</div>
        <div className="cl-sheet-foot">
          <Button onClick={onClose}>确定</Button>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button variant="outline" disabled>应用(A)</Button>
        </div>
      </div>
    </section>
  );
}

// ---------- 当前文档标题（地址栏、标题栏用；页面详情挂载时设置） ----------
let docTitle: string | null = null;
const titleListeners = new Set<() => void>();
const emitTitle = () => titleListeners.forEach((l) => l());
export function useClassicTitle(t: string | undefined) {
  useEffect(() => {
    if (t === undefined) return;
    docTitle = t;
    emitTitle();
    return () => void ((docTitle = null), emitTitle());
  }, [t]);
}
const useDocTitle = () => useSyncExternalStore((l) => (titleListeners.add(l), () => void titleListeners.delete(l)), () => docTitle);

/** 当前位置：组织、项目、地址分段与上一级 */
function usePlace() {
  const act = useShellActions();
  const projects = useMyProjects();
  const path = useLocation().split("?")[0];
  const view = useQuery("view");
  const activeId = useActiveProject();
  const doc = useDocTitle();
  const org = act.org;
  const list = (projects.data ?? []).filter((p) => p.org.id === org?.id);
  const slug = path.match(/^\/o\/[^/]+\/p\/([^/]+)/)?.[1];
  const cur = list.find((p) => p.slug === slug || p.id === activeId);
  const on = org?.name ?? "Team Kanban";
  const projUrl = cur ? `/o/${cur.org.slug}/p/${cur.slug}` : null;
  let segs: (string | null | undefined)[], up: string | null = "/";
  if (path === "/") (segs = [on, view === "todo" ? "等我处理" : view === "mine" ? "我发布的" : "工作台"]), (up = view ? "/" : null);
  else if (slug) (segs = [on, "项目", cur?.name ?? slug]), (up = org ? `/o/${org.slug}` : "/");
  else if (path.startsWith("/o/")) segs = [on, "组织设置"];
  else if (path.startsWith("/pages/")) {
    const sub = path.endsWith("/results") ? "全部结果" : path.endsWith("/links") ? "临时链接" : null;
    segs = [on, cur && "项目", cur?.name, doc, sub];
    up = sub ? path.replace(/\/(results|links)$/, "") : projUrl ?? "/";
  } else if (path === "/settings/tokens") segs = ["设置", "访问令牌"];
  else if (path === "/settings/account") segs = ["设置", "账号与外观"];
  else if (path === "/orgs") segs = ["组织"];
  else segs = [on];
  const s = segs.filter(Boolean) as string[];
  return { org, list, cur, path, view, segs: s, up };
}

// ---------- 左侧文件夹树 ----------
function Row({ to, onClick, icon, children, sel, cnt, badge }: {
  to?: string; onClick?: () => void; icon: PixelName; children: ReactNode; sel?: boolean; cnt?: ReactNode; badge?: ReactNode;
}) {
  const body = <><PixelIcon name={icon} /><span className="lbl">{children}</span>{badge}{cnt != null && <span className="cnt">{cnt}</span>}</>;
  return to
    ? <Link to={to} className="cl-row" aria-current={sel ? "page" : undefined}>{body}</Link>
    : <button type="button" className="cl-row" onClick={onClick}>{body}</button>;
}

/** 可展开节点：+/- 方块切换 */
function Node({ id, closed, toggle, row, children }: { id: string; closed: Set<string>; toggle: (id: string) => void; row: ReactNode; children?: ReactNode }) {
  const shut = closed.has(id);
  return (
    <li className={shut ? "closed" : undefined}>
      {children && <button type="button" className={shut ? "pm plus" : "pm"} aria-label={shut ? "展开" : "折叠"} aria-expanded={!shut} onClick={() => toggle(id)} />}
      {row}
      {children && !shut && <ul>{children}</ul>}
    </li>
  );
}

function Tree() {
  const { me } = useSession();
  const pl = usePlace();
  const stats = useHomeStats(pl.org?.id);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setClosed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const home = pl.path === "/";
  return (
    <nav aria-label="文件夹" className="cl-tree">
      <ul>
        <Node id="desk" closed={closed} toggle={toggle} row={<Row icon="desk" to="/">桌面</Row>}>
          {(me?.orgs ?? []).map((o) => o.id === pl.org?.id ? (
            <Node key={o.id} id={o.id} closed={closed} toggle={toggle} row={<Row icon="org" to={`/o/${o.slug}`} cnt={`（${ROLE_LABEL[o.my_role]}）`}>{o.name}</Row>}>
              <li><Row icon="logo" to="/" sel={home && !pl.view}>工作台</Row></li>
              <li><Row icon="inbox" to="/?view=todo" sel={home && pl.view === "todo"} badge={!!stats.todo && <span className="badge" data-testid="todo-count">{stats.todo}</span>}>等我处理</Row></li>
              <li><Row icon="send" to="/?view=mine" sel={home && pl.view === "mine"} cnt={stats.mine != null ? `(${stats.mine})` : null}>我发布的</Row></li>
              {pl.list.length > 0 && (
                <Node id="projects" closed={closed} toggle={toggle} row={<Row icon="folder-open" to={`/o/${o.slug}`}>项目</Row>}>
                  {pl.list.map((p) => {
                    const n = stats.by[p.id] ?? (stats.full ? 0 : null);
                    const isCur = pl.cur?.id === p.id;
                    const pages = isCur ? pagesOf(p.id) : [];
                    const row = <Row icon={isCur ? "folder-open" : "folder"} to={`/o/${p.org.slug}/p/${p.slug}`} sel={isCur && !pl.path.startsWith("/pages/")} cnt={n != null ? `(${n})` : null}>{p.name}</Row>;
                    return pages.length ? (
                      <Node key={p.id} id={p.id} closed={closed} toggle={toggle} row={row}>
                        {pages.map((x) => (
                          <li key={x.id}><Row icon={TONE_PIXEL[toneOf(x.page_type, x.category)]} to={`/pages/${x.id}`} sel={pl.path.startsWith(`/pages/${x.id}`)}>{x.title}</Row></li>
                        ))}
                      </Node>
                    ) : <li key={p.id}>{row}</li>;
                  })}
                </Node>
              )}
            </Node>
          ) : (
            <li key={o.id}><Row icon="org" onClick={() => (setCurrentOrg(o.id), navigate("/"))} cnt={`（${ROLE_LABEL[o.my_role]}）`}>{o.name}</Row></li>
          ))}
        </Node>
      </ul>
    </nav>
  );
}

// ---------- 菜单栏 ----------
function Menu({ label, k, children }: { label: string; k: string; children: ReactNode }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild><button type="button" className="cl-menu-btn">{label}(<u>{k}</u>)</button></DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={0} className="w-48">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuBar({ onSearch }: { onSearch: () => void }) {
  const act = useShellActions();
  const { me } = useSession();
  return (
    <nav aria-label="菜单栏" className="cl-menubar">
      <Menu label="文件" k="F">
        <DropdownMenuItem onSelect={() => navigate("/settings/tokens")}>新建令牌…</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate("/orgs")}>组织…</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate("/settings/account")}>账号设置</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={act.logout}>注销 {me?.user.display_name}…</DropdownMenuItem>
      </Menu>
      <Menu label="编辑" k="E">
        <DropdownMenuItem onSelect={() => copyText(location.href, "已复制链接")}>复制链接</DropdownMenuItem>
        <DropdownMenuItem onSelect={onSearch}>查找…</DropdownMenuItem>
      </Menu>
      <Menu label="查看" k="V">
        <DropdownMenuItem onSelect={() => navigate("/")}>工作台</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate("/?view=todo")}>等我处理</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate("/?view=mine")}>我发布的</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => location.reload()}>刷新</DropdownMenuItem>
        <DropdownMenuItem onSelect={act.toggleSkin}>切换到默认主题</DropdownMenuItem>
      </Menu>
      <Menu label="帮助" k="H">
        <DropdownMenuItem onSelect={() => toast("Team Kanban 经典主题：在「设置 › 外观」切回默认主题")}>关于 Team Kanban</DropdownMenuItem>
      </Menu>
    </nav>
  );
}

function Tb({ icon, label, onClick, disabled }: { icon: PixelName; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="cl-tb" title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      <PixelIcon name={icon} /><span className="cl-tl">{label}</span>
    </button>
  );
}

// ---------- 开始菜单 ----------
function Item({ icon, children, onClick, sm }: { icon: PixelName; children: ReactNode; onClick: () => void; sm?: boolean }) {
  return <li><button type="button" className={sm ? "sm" : undefined} onClick={onClick}><PixelIcon name={icon} size={sm ? 16 : 24} /><span>{children}</span></button></li>;
}

function StartMenu({ close, onSearch }: { close: () => void; onSearch: () => void }) {
  const { me } = useSession();
  const act = useShellActions();
  const pl = usePlace();
  const go = (to: string) => () => (close(), navigate(to));
  const orgs = me?.orgs ?? [];
  return (
    <div className="cl-start-menu" role="dialog" aria-label="开始菜单">
      <div className="brand" aria-hidden="true"><b>Team</b>Kanban 98</div>
      <ul>
        <Item icon="logo" onClick={go("/")}>工作台</Item>
        <Item icon="inbox" onClick={go("/?view=todo")}>等我处理</Item>
        <Item icon="send" onClick={go("/?view=mine")}>我发布的</Item>
        {pl.list.length > 0 && <li className="hd">项目</li>}
        {pl.list.map((p) => <Item key={p.id} sm icon="folder" onClick={go(`/o/${p.org.slug}/p/${p.slug}`)}>{p.name}</Item>)}
        {orgs.length > 1 && <li className="hd">切换组织</li>}
        {orgs.length > 1 && orgs.map((o) => <Item key={o.id} sm icon="org" onClick={() => (close(), setCurrentOrg(o.id), navigate("/"))}>{o.name}{o.id === pl.org?.id ? "（当前）" : ""}</Item>)}
        <li className="hr" />
        <Item icon="run" onClick={() => (close(), onSearch())}>运行…</Item>
        <Item icon="gear" onClick={go("/settings/account")}>设置</Item>
        <Item icon="key" onClick={go("/settings/tokens")}>访问令牌</Item>
        <Item icon="org" onClick={go("/orgs")}>组织</Item>
        <Item icon="props" onClick={() => (close(), act.toggleSkin())}>切换到默认主题</Item>
        <li className="hr" />
        <Item icon="shut" onClick={() => (close(), act.logout())}>注销 {me?.user.display_name}…</Item>
      </ul>
    </div>
  );
}

const hhmm = (t: number) => new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

/** 登录后的整页外壳 */
export function ClassicShell({ banner, onSearch, children }: { banner?: ReactNode; onSearch: () => void; children: ReactNode }) {
  const { me } = useSession();
  const loc = useLocation();
  const pl = usePlace();
  const stats = useHomeStats(pl.org?.id);
  const now = useNow();
  const [dock, setDock] = useState<HTMLElement | null>(null);
  const [start, setStart] = useState(false);
  const content = useRef<HTMLElement>(null);
  const startRef = useRef<HTMLDivElement>(null);
  // 换页：内容区回到顶部（窗口内滚动，不是整页滚动）、收起开始菜单
  useEffect(() => {
    content.current?.scrollTo(0, 0);
    setStart(false);
  }, [loc]);
  useEffect(() => {
    if (!start) return;
    const off = (e: MouseEvent) => !startRef.current?.contains(e.target as Node) && setStart(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setStart(false);
    document.addEventListener("mousedown", off);
    document.addEventListener("keydown", esc);
    return () => (document.removeEventListener("mousedown", off), document.removeEventListener("keydown", esc));
  }, [start]);
  const title = `Team Kanban - 资源管理器 - ${pl.segs.join("\\")}`;
  return (
    <DockCtx.Provider value={dock}>
      <div className="cl-desk">
        <section className="cl-win cl-main" aria-label="Team Kanban - 资源管理器">
          <div className="cl-titlebar"><PixelIcon name="logo" /><span className="cl-t">{title}</span><Controls /></div>
          <MenuBar onSearch={onSearch} />
          <div className="cl-toolbar" role="toolbar" aria-label="工具栏">
            <span className="grip" aria-hidden="true" />
            <Tb icon="back" label="后退" onClick={() => history.back()} />
            <Tb icon="fwd" label="前进" onClick={() => history.forward()} />
            <Tb icon="up" label="向上" disabled={!pl.up} onClick={() => pl.up && navigate(pl.up)} />
            <span className="vsep" aria-hidden="true" />
            <Tb icon="refresh" label="刷新" onClick={() => location.reload()} />
            <Tb icon="find" label="查找" onClick={onSearch} />
            <span className="vsep" aria-hidden="true" />
            <Tb icon="props" label="属性" onClick={() => navigate("/settings/account")} />
          </div>
          <div className="cl-addr">
            <label htmlFor="cl-addr"><span className="d">地址(<u>D</u>)</span><span className="m">位置:</span></label>
            <div className="cl-combo"><PixelIcon name="logo" /><input id="cl-addr" readOnly value={`tkanban://${pl.segs.join("/")}`} /></div>
            <Button variant="outline" size="sm" className="cl-go" onClick={() => navigate(loc, true)}>转到</Button>
          </div>
          <div className="cl-body">
            <aside className="cl-side" aria-label="侧栏">
              <div className="cl-pane-head">文件夹</div>
              <Tree />
            </aside>
            <main ref={content} className="cl-content">{banner}{children}</main>
          </div>
          <div className="cl-status">
            <div className="grow">{me?.orgs.length ? "就绪" : "还没有加入组织"}</div>
            <div><PixelIcon name="inbox" />等我处理 {stats.todo ?? 0}</div>
            <div><i className="cl-led" aria-hidden="true" />已连接</div>
            <div><PixelIcon name="user" />{me?.user.display_name}{pl.org ? ` - ${pl.org.name}` : ""}</div>
          </div>
        </section>
        <div ref={setDock} className="cl-dock" />
      </div>
      <div ref={startRef}>
        {start && <StartMenu close={() => setStart(false)} onSearch={onSearch} />}
        <div className="cl-taskbar">
          <button type="button" className="cl-start" aria-expanded={start} aria-pressed={start} onClick={() => setStart((s) => !s)}><PixelIcon name="logo" />开始</button>
          <span className="sep" aria-hidden="true" />
          <button type="button" className="cl-task" aria-pressed="true"><PixelIcon name="logo" /><span>Team Kanban - 资源管理器</span></button>
          <div className="cl-tray">
            <Link to="/?view=todo" className="badge-ico" aria-label={`等我处理 ${stats.todo ?? 0}`}><PixelIcon name="inbox" />{!!stats.todo && <b>{stats.todo}</b>}</Link>
            <PixelIcon name="net" />
            <time>{hhmm(now)}</time>
          </div>
        </div>
      </div>
    </DockCtx.Provider>
  );
}

/** 未登录：青色桌面。登录/注册等是对话框本身（AuthCard），其它页面（分享链接等）放进一个窗口 */
export function ClassicGuest({ children }: { children: ReactNode }) {
  const path = useLocation().split("?")[0];
  if (/^\/(login|register|forgot-password|reset-password|verify-email)/.test(path)) return <main className="cl-guest">{children}</main>;
  return (
    <div className="cl-guest">
      <section className="cl-win cl-guest-win" aria-label="Team Kanban">
        <div className="cl-titlebar"><PixelIcon name="logo" /><span className="cl-t">Team Kanban</span><Controls /></div>
        <div className="cl-toolbar">
          <span className="grip" aria-hidden="true" />
          <Link className="cl-tb" to={"/login?next=" + encodeURIComponent(path)}><PixelIcon name="user" /><span className="cl-tl">登录</span></Link>
        </div>
        <main className="cl-content">{children}</main>
      </section>
    </div>
  );
}
