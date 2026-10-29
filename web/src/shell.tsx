// 外壳（方向 A 长春花工作台）：登录后左侧固定导航（品牌、组织切换、工作台 / 等我处理 / 我发布的、项目列表、底部当前用户与设置）；
// < 1024 收成顶部条 + 抽屉。搜索框（⌘K 命令栏）由各页面放在自己的标题行（SearchButton）。未登录时只有一条简单顶栏
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Building2, Check, ChevronDown, FileText, FolderKanban, Home, Inbox, KeyRound, LayoutGrid, LogOut, Menu, Monitor, Moon, Search, Send, Settings, Sun, UserPlus, UserRound, X } from "lucide-react";
import { get, post, qs } from "./api";
import { cn } from "@/lib/utils";
import { Link, navigate, useLocation, useQuery } from "./router";
import { ROLE_LABEL, resetMyProjects, setCurrentOrg, useActiveProject, useCurrentOrgId, useMyProjects, useSession, useTheme } from "./ui";
import { useHomeStats } from "./pages/feed";
import { ClassicGuest, ClassicShell } from "./classic";
import { Button } from "@/components/ui/button";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Page, Paged } from "./types";

/** 标识：长春花蓝圆角方块里的四格 */
function BrandMark() {
  return (
    <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-primary text-primary-foreground">
      <LayoutGrid className="size-4" />
    </span>
  );
}

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** 命令栏、头像菜单共用的动作（经典外壳也用） */
export function useShellActions() {
  const { me, setMe } = useSession();
  const theme = useTheme();
  const lastOrg = useCurrentOrgId();
  const path = useLocation().split("?")[0];
  const orgs = me?.orgs ?? [];
  // 当前组织：路径里的 → 最近进入的 → 唯一的一个
  const slug = path.match(/^\/o\/([^/]+)/)?.[1];
  const org = orgs.find((o) => o.slug === slug) ?? orgs.find((o) => o.id === lastOrg) ?? orgs[0];
  const project = path.match(/^\/o\/[^/]+\/p\/([^/]+)/)?.[1];
  return {
    org,
    toggleTheme: () => theme.setMode(theme.mode === "dark" ? "light" : "dark"),
    dark: theme.mode === "dark",
    classic: theme.skin === "classic",
    toggleSkin: () => theme.setSkin(theme.skin === "classic" ? "default" : "classic"),
    // 在项目页时邀请进项目（成员与权限 Tab），否则邀请进当前组织
    invite: () => navigate(project && org ? `/o/${org.slug}/p/${project}?tab=members` : org ? `/o/${org.slug}?tab=invites` : "/orgs"),
    orgSettings: () => navigate(org ? `/o/${org.slug}?tab=settings` : "/orgs"),
    logout: async () => {
      await post("/auth/logout").catch(() => {});
      resetMyProjects();
      setMe(null);
      navigate("/login");
    },
  };
}

export function CommandBar({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
  const act = useShellActions();
  const projects = useMyProjects();
  const [q, setQ] = useState("");
  const [pages, setPages] = useState<Page[]>([]);
  const seq = useRef(0);
  // 页面：后端按标题模糊搜索（q ≤ 100 字），空输入时给最近 8 个；200ms 防抖，只认最后一次请求
  useEffect(() => {
    if (!open) return;
    const n = ++seq.current;
    const t = setTimeout(() => {
      get<Paged<Page>>(`/pages${qs({ q: q.trim().slice(0, 100), limit: 8 })}`).then((r) => n === seq.current && setPages(r.items), () => {});
    }, q ? 200 : 0);
    return () => clearTimeout(t);
  }, [q, open]);
  useEffect(() => void (!open && setQ("")), [open]);
  const run = (fn: () => void) => () => (setOpen(false), fn());
  const projName = (id: string) => projects.data?.find((p) => p.id === id);
  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="搜索项目、页面，或输入操作" value={q} onValueChange={setQ} />
      <CommandList>
        <CommandEmpty>没有匹配的结果</CommandEmpty>
        {pages.length > 0 && (
          <CommandGroup heading="页面">
            {pages.map((p) => {
              const pr = projName(p.project_id);
              return (
                <CommandItem key={p.id} value={`page:${p.id}`} keywords={[p.title]} onSelect={run(() => navigate(`/pages/${p.id}`))}>
                  <FileText />
                  <span className="truncate">{p.title}</span>
                  {pr && <CommandShortcut className="truncate">{pr.name}</CommandShortcut>}
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
        {!!projects.data?.length && (
          <CommandGroup heading="项目">
            {projects.data.map((p) => (
              <CommandItem key={p.id} value={`project:${p.id}`} keywords={[p.name, p.slug, p.org.name]} onSelect={run(() => navigate(`/o/${p.org.slug}/p/${p.slug}`))}>
                <FolderKanban />
                <span className="truncate">{p.name}</span>
                <CommandShortcut className="truncate">{p.org.name}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="操作">
          <CommandItem keywords={["令牌", "token", "agent", "mcp"]} onSelect={run(() => navigate("/settings/tokens"))}><KeyRound />新建令牌</CommandItem>
          <CommandItem keywords={["邀请", "成员", "invite"]} onSelect={run(act.invite)}><UserPlus />邀请成员</CommandItem>
          <CommandItem keywords={["组织", "设置"]} onSelect={run(act.orgSettings)}><Settings />进入组织设置</CommandItem>
          <CommandItem keywords={["组织", "创建", "org"]} onSelect={run(() => navigate("/orgs"))}><Building2 />组织</CommandItem>
          <CommandItem keywords={["账号", "密码", "设置"]} onSelect={run(() => navigate("/settings/account"))}><UserRound />账号设置</CommandItem>
          {!act.classic && <CommandItem keywords={["主题", "暗色", "亮色", "theme"]} onSelect={run(act.toggleTheme)}>{act.dark ? <Sun /> : <Moon />}切换主题</CommandItem>}
          <CommandItem keywords={["主题", "经典", "默认", "win98", "theme", "skin"]} onSelect={run(act.toggleSkin)}><Monitor />{act.classic ? "切换到默认主题" : "切换到经典主题"}</CommandItem>
          <CommandItem keywords={["退出", "登出", "logout"]} onSelect={run(act.logout)}><LogOut />退出登录</CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

/** 项目小方点颜色：按顺序取类型色 */
const DOT_VARS = ["--t-vote", "--t-book", "--t-flow", "--t-form", "--t-report", "--t-arch"];
const DOT = (i: number) => `var(${DOT_VARS[i % DOT_VARS.length]})`;

/** 页面标题行里的搜索框：点击或 ⌘K / Ctrl K 打开命令栏 */
export function SearchButton({ label = "搜索页面、项目或操作", className }: { label?: string; className?: string }) {
  return (
    <button type="button" onClick={() => window.dispatchEvent(new Event("tk:search"))} aria-label="搜索页面" aria-keyshortcuts={IS_MAC ? "Meta+K" : "Control+K"}
      className={cn("flex h-[38px] w-[300px] max-w-full items-center gap-2 rounded-[11px] border bg-card px-3 text-[14px] text-faint outline-none transition-colors hover:border-input hover:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/80 max-lg:hidden", className)}>
      <Search className="size-[18px] shrink-0" />
      <span className="flex-1 truncate text-left">{label}</span>
      <kbd className="rounded-md border px-1.5 font-sans text-[12px] text-faint">{IS_MAC ? "⌘K" : "Ctrl K"}</kbd>
    </button>
  );
}

function OrgSwitcher() {
  const { me } = useSession();
  const act = useShellActions();
  const orgs = me?.orgs ?? [];
  if (!orgs.length) return null;
  const o = act.org;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="切换组织"
          className="mb-3 flex w-full items-center gap-2.5 rounded-[12px] border px-2.5 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/80">
          <span aria-hidden="true" className="grid size-[30px] shrink-0 place-items-center rounded-[9px] bg-[#1e2a5a] font-semibold text-white">{(o?.name ?? "?").slice(0, 1).toUpperCase()}</span>
          <span className="min-w-0 flex-1">
            <b className="block truncate font-semibold">{o?.name ?? "选择组织"}</b>
            {o && <small className="block truncate text-[12px] text-faint">{ROLE_LABEL[o.my_role]}</small>}
          </span>
          <ChevronDown className="size-[18px] shrink-0 text-faint" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">组织</DropdownMenuLabel>
        {orgs.map((x) => (
          <DropdownMenuItem key={x.id} onSelect={() => (setCurrentOrg(x.id), navigate("/"))}>
            <Building2 /><span className="flex-1 truncate">{x.name}</span>{x.id === o?.id && <Check className="text-primary" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {o && <DropdownMenuItem onSelect={() => navigate(`/o/${o.slug}`)}><Settings />管理组织</DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => navigate("/orgs")}><FolderKanban />全部组织 / 新建</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const NAV = "relative flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/80 aria-[current=page]:bg-primary-soft aria-[current=page]:text-primary [&_svg]:size-[18px] [&_svg]:shrink-0";

function NavLink({ to, on, icon, children, badge, count }: { to: string; on: boolean; icon: ReactNode; children: ReactNode; badge?: ReactNode; count?: number | null }) {
  return (
    <Link to={to} aria-current={on ? "page" : undefined} className={NAV}>
      {icon}<span className="min-w-0 flex-1 truncate">{children}</span>
      {badge}
      {count != null && <span className="text-[12px] text-faint tabular-nums">{count}</span>}
    </Link>
  );
}

/** 左侧导航内容（宽屏固定栏与窄屏抽屉共用） */
function SideNav() {
  const { me } = useSession();
  const act = useShellActions();
  const projects = useMyProjects();
  const stats = useHomeStats(act.org?.id);
  const path = useLocation().split("?")[0];
  const view = useQuery("view");
  const activeId = useActiveProject();
  const list = (projects.data ?? []).filter((p) => p.org.id === act.org?.id);
  const slug = path.match(/^\/o\/[^/]+\/p\/([^/]+)/)?.[1];
  const cur = list.find((p) => p.slug === slug || p.id === activeId);
  const home = path === "/";
  return (
    <>
      <Link to="/" className="mb-3.5 flex items-center gap-2.5 rounded-md px-2 text-[16px] font-bold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/80" aria-label="Team Kanban 首页">
        <BrandMark />Team Kanban
      </Link>
      <OrgSwitcher />
      <nav aria-label="导航" className="flex flex-col gap-1">
        <NavLink to="/" on={home && !view} icon={<Home />}>工作台</NavLink>
        <NavLink to="/?view=todo" on={home && view === "todo"} icon={<Inbox />}
          badge={stats.todo !== null && stats.todo > 0 && <span data-testid="todo-count" className="rounded-full bg-coral px-[7px] text-[12px] leading-[18px] font-semibold text-white tabular-nums">{stats.todo}</span>}>
          等我处理
        </NavLink>
        <NavLink to="/?view=mine" on={home && view === "mine"} icon={<Send />} count={stats.mine}>我发布的</NavLink>
      </nav>
      {list.length > 0 && (
        <nav aria-label="项目" className="flex min-h-0 flex-col gap-1 overflow-y-auto">
          <p className="px-2.5 pt-4 pb-1.5 text-[12px] text-faint">项目</p>
          {list.map((p, i) => (
            <NavLink key={p.id} to={`/o/${p.org.slug}/p/${p.slug}`} on={cur?.id === p.id} count={stats.by[p.id] ?? (stats.full ? 0 : null)}
              icon={<i aria-hidden="true" className="size-2.5 shrink-0 rounded-[3px]" style={{ background: DOT(i) }} />}>
              {p.name}
            </NavLink>
          ))}
        </nav>
      )}
      {me && <UserMenu />}
    </>
  );
}

function UserMenu() {
  const { me } = useSession();
  const act = useShellActions();
  if (!me) return null;
  return (
    <div className="mt-auto flex items-center gap-2.5 border-t px-2.5 pt-3">
      <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-[14px] font-semibold text-primary-foreground">{me.user.display_name.slice(0, 1).toUpperCase()}</span>
      <span className="min-w-0 flex-1">
        <b className="block truncate font-semibold">{me.user.display_name}</b>
        <small className="block truncate text-[12px] text-faint">{act.org ? `${act.org.name} ${ROLE_LABEL[act.org.my_role]}` : me.user.email}</small>
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="账号菜单" className="grid size-8 shrink-0 place-items-center rounded-[10px] text-faint outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/80">
            <Settings className="size-[18px]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="w-56">
          <DropdownMenuLabel className="grid gap-0.5">
            <span className="truncate">{me.user.display_name}</span>
            <span className="truncate text-xs font-normal text-muted-foreground">{me.user.email}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => navigate("/orgs")}><Building2 />组织</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate("/settings/tokens")}><KeyRound />访问令牌</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate("/settings/account")}><UserRound />账号设置</DropdownMenuItem>
          <DropdownMenuItem onSelect={act.toggleTheme}>{act.dark ? <Sun /> : <Moon />}{act.dark ? "切换到亮色" : "切换到暗色"}</DropdownMenuItem>
          <DropdownMenuItem onSelect={act.toggleSkin}><Monitor />切换到经典主题</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={act.logout}><LogOut />退出登录</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** 未登录时的顶栏：品牌 + 主题切换 + 登录 */
function GuestHeader() {
  const act = useShellActions();
  const path = useLocation().split("?")[0];
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex h-[60px] w-full max-w-[1600px] items-center gap-3 px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2.5 rounded-md text-[16px] font-bold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/80" aria-label="Team Kanban 首页">
          <BrandMark /><span className="max-sm:hidden">Team Kanban</span>
        </Link>
        <span className="ml-auto" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="切换亮/暗色" onClick={act.toggleTheme}>{act.dark ? <Sun /> : <Moon />}</Button>
          </TooltipTrigger>
          <TooltipContent>{act.dark ? "切换到亮色" : "切换到暗色"}</TooltipContent>
        </Tooltip>
        {!/^\/(login|register|forgot-password|reset-password)/.test(path) && (
          <Button size="sm" variant="outline" asChild><Link to={"/login?next=" + encodeURIComponent(path)}>登录</Link></Button>
        )}
      </div>
    </header>
  );
}

/** 整页外壳：登录后 = 左侧导航 + 内容；未登录 = 顶栏 + 内容。banner 是顶部提示条（邮箱未验证等） */
export function Shell({ banner, children }: { banner?: ReactNode; children: ReactNode }) {
  const { me } = useSession();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => setDrawer(false), [loc]);
  useEffect(() => {
    if (!me) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setDrawer(false);
    };
    const onSearch = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("tk:search", onSearch);
    return () => (window.removeEventListener("keydown", onKey), window.removeEventListener("tk:search", onSearch));
  }, [me]);
  const { skin } = useTheme();
  // 经典主题：资源管理器窗口外壳（未登录时是青色桌面）
  if (skin === "classic")
    return me ? <ClassicShell banner={banner} onSearch={() => setOpen(true)}>{children}<CommandBar open={open} setOpen={setOpen} /></ClassicShell> : <ClassicGuest>{banner}{children}</ClassicGuest>;
  const main = <main className="mx-auto w-full max-w-[1920px] min-w-0 px-4 pt-5 pb-16 sm:px-6 lg:px-8 lg:pt-7">{children}</main>;
  if (!me) return <>{<GuestHeader />}{banner}{main}</>;
  const side = "flex flex-col gap-1 bg-card px-4 py-5";
  return (
    <div className="flex min-h-dvh">
      <aside aria-label="侧栏" className={cn(side, "sticky top-0 h-dvh w-[220px] shrink-0 border-r max-lg:hidden min-[1500px]:w-[248px]")}><SideNav /></aside>
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button type="button" aria-label="关闭导航" className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
          <aside aria-label="侧栏" className={cn(side, "page-enter absolute inset-y-0 left-0 w-[min(280px,86vw)] shadow-pop")}>
            <button type="button" aria-label="关闭导航" onClick={() => setDrawer(false)} className="absolute top-4 right-3 grid size-8 place-items-center rounded-[10px] text-faint hover:bg-accent"><X className="size-[18px]" /></button>
            <SideNav />
          </aside>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b bg-card/95 px-3 backdrop-blur-sm lg:hidden">
          <Button variant="ghost" size="icon-sm" aria-label="打开导航" onClick={() => setDrawer(true)}><Menu /></Button>
          <Link to="/" className="flex items-center gap-2 rounded-md text-[15px] font-bold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/80" aria-label="Team Kanban 首页"><BrandMark />Team Kanban</Link>
          <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="搜索页面" onClick={() => setOpen(true)}><Search /></Button>
        </header>
        {banner}
        {main}
      </div>
      <CommandBar open={open} setOpen={setOpen} />
    </div>
  );
}
