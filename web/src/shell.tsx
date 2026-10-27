// 外壳（方向 B 糖纸格）：品牌 + 组织切换 + 项目胶囊（全部 / 各项目，选中为深色胶囊，多了收进「更多」）+ 搜索框（⌘K 命令栏）+ 头像菜单。无侧栏
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Building2, Check, ChevronDown, FileText, FolderKanban, KeyRound, LayoutGrid, LogOut, Moon, Search, Settings, Sun, UserPlus, UserRound } from "lucide-react";
import { get, post, qs } from "./api";
import { cn } from "@/lib/utils";
import { Link, navigate, useLocation } from "./router";
import { resetMyProjects, setCurrentOrg, useActiveProject, useCurrentOrgId, useMyProjects, useSession, useTheme } from "./ui";
import { useProjectCounts } from "./pages/feed";
import { Button } from "@/components/ui/button";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Page, Paged } from "./types";

/** 标识：葡萄紫圆角方块里的四格 */
function BrandMark() {
  return (
    <span aria-hidden="true" className="grid size-[30px] shrink-0 place-items-center rounded-[10px] bg-primary text-primary-foreground">
      <LayoutGrid className="size-4" />
    </span>
  );
}

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** 命令栏、头像菜单共用的动作 */
function useShellActions() {
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

function CommandBar({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
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
          <CommandItem keywords={["主题", "暗色", "亮色", "theme"]} onSelect={run(act.toggleTheme)}>{act.dark ? <Sun /> : <Moon />}切换主题</CommandItem>
          <CommandItem keywords={["退出", "登出", "logout"]} onSelect={run(act.logout)}><LogOut />退出登录</CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

/** 项目胶囊的小圆点颜色：按顺序取图表色 */
const DOT = (i: number) => `var(--chart-${(i % 5) + 1})`;
/** 宽屏最多直接显示的项目胶囊数，其余收进「更多」 */
const MAX_PILLS = 5;

function OrgSwitcher() {
  const { me } = useSession();
  const act = useShellActions();
  const orgs = me?.orgs ?? [];
  if (!orgs.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="切换组织"
          className="flex h-9 max-w-44 items-center gap-1.5 rounded-[10px] bg-muted px-2.5 text-[14px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/80">
          <span className="truncate">{act.org?.name ?? "选择组织"}</span><ChevronDown className="size-4 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">组织</DropdownMenuLabel>
        {orgs.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => (setCurrentOrg(o.id), navigate("/"))}>
            <Building2 /><span className="flex-1 truncate">{o.name}</span>{o.id === act.org?.id && <Check className="text-primary" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {act.org && <DropdownMenuItem onSelect={() => navigate(`/o/${act.org!.slug}`)}><Settings />管理组织</DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => navigate("/orgs")}><FolderKanban />全部组织 / 新建</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 项目胶囊：全部 + 当前组织的项目（带页面数；数目只在首页列表已全部加载时显示） */
function ProjectPills() {
  const act = useShellActions();
  const projects = useMyProjects();
  const counts = useProjectCounts(act.org?.id);
  const path = useLocation().split("?")[0];
  const activeId = useActiveProject();
  const list = (projects.data ?? []).filter((p) => p.org.id === act.org?.id);
  const slug = path.match(/^\/o\/[^/]+\/p\/([^/]+)/)?.[1];
  const cur = list.find((p) => p.slug === slug || p.id === activeId);
  const shown = list.slice(0, MAX_PILLS);
  // 选中的项目排在「更多」里时，换到最后一个可见位
  if (cur && !shown.includes(cur)) shown[shown.length - 1] = cur;
  const rest = list.filter((p) => !shown.includes(p));
  const pill = "relative inline-flex h-9 shrink-0 items-center gap-2 rounded-full px-3.5 text-[14px] font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/80";
  const on = (active: boolean) => (active ? "text-background" : "text-muted-foreground hover:text-foreground");
  const bg = <motion.span layoutId="pill-on" className="absolute inset-0 -z-0 rounded-full bg-foreground" transition={{ type: "spring", bounce: 0.15, duration: 0.3 }} />;
  const allOn = path === "/";
  return (
    <nav aria-label="项目" className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
      <Link to="/" aria-current={allOn ? "page" : undefined} className={cn(pill, on(allOn))}>
        {allOn && bg}<span className="relative">全部</span>
        {counts.all !== null && <em className="relative text-xs not-italic opacity-60 tabular-nums">{counts.all}</em>}
      </Link>
      {shown.map((p) => {
        const active = cur?.id === p.id;
        return (
          <Link key={p.id} to={`/o/${p.org.slug}/p/${p.slug}`} aria-current={active ? "page" : undefined} className={cn(pill, on(active))}>
            {active && bg}
            <i aria-hidden="true" className="relative size-2 rounded-full" style={{ background: active ? "var(--background)" : DOT(list.indexOf(p)) }} />
            <span className="relative max-w-40 truncate">{p.name}</span>
            {counts.by[p.id] !== undefined && <em className="relative text-xs not-italic opacity-60 tabular-nums">{counts.by[p.id]}</em>}
          </Link>
        );
      })}
      {rest.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={cn(pill, on(false))}>更多<ChevronDown className="size-4" /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {rest.map((p) => (
              <DropdownMenuItem key={p.id} onSelect={() => navigate(`/o/${p.org.slug}/p/${p.slug}`)}>
                <i aria-hidden="true" className="size-2 rounded-full" style={{ background: DOT(list.indexOf(p)) }} />
                <span className="flex-1 truncate">{p.name}</span>
                {counts.by[p.id] !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{counts.by[p.id]}</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </nav>
  );
}

export function Header() {
  const { me } = useSession();
  const act = useShellActions();
  const path = useLocation().split("?")[0];
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!me) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [me]);
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur-sm">
      <div className="mx-auto flex w-full max-w-[2200px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6 lg:h-[68px] lg:flex-nowrap lg:py-0 xl:px-10">
        <Link to="/" className="flex shrink-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/80" aria-label="Team Kanban 首页">
          <BrandMark />
          <span className="text-[17px] font-semibold max-sm:hidden">Team Kanban</span>
        </Link>
        {me && <OrgSwitcher />}
        {/* 项目胶囊：宽屏在顶栏一行内，窄屏换到第二行横向滑动 */}
        {me && <div className="order-last w-full min-w-0 lg:order-none lg:ml-2 lg:w-auto lg:flex-1"><ProjectPills /></div>}
        <div className="ml-auto flex items-center gap-2 lg:ml-0">
          {me && (
            <button type="button" onClick={() => setOpen(true)} aria-label="搜索页面" aria-keyshortcuts={IS_MAC ? "Meta+K" : "Control+K"}
              className="flex h-[38px] w-[min(260px,32vw)] items-center gap-2 rounded-full bg-muted px-3.5 text-[14px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/80 max-sm:w-[38px] max-sm:justify-center max-sm:px-0">
              <Search className="size-4 shrink-0" />
              <span className="flex-1 truncate text-left max-sm:hidden">搜索页面</span>
              <kbd className="rounded-md border bg-card px-1.5 font-sans text-[11px] max-md:hidden">{IS_MAC ? "⌘K" : "Ctrl K"}</kbd>
            </button>
          )}
          {me ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label="账号菜单" className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-[14px] font-semibold text-primary-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/80">
                  {me.user.display_name.slice(0, 1).toUpperCase()}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="grid gap-0.5">
                  <span className="truncate">{me.user.display_name}</span>
                  <span className="truncate text-xs font-normal text-muted-foreground">{me.user.email}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => navigate("/orgs")}><Building2 />组织</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => navigate("/settings/tokens")}><KeyRound />访问令牌</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => navigate("/settings/account")}><UserRound />账号设置</DropdownMenuItem>
                <DropdownMenuItem onSelect={act.toggleTheme}>{act.dark ? <Sun /> : <Moon />}{act.dark ? "切换到亮色" : "切换到暗色"}</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={act.logout}><LogOut />退出登录</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="切换亮/暗色" onClick={act.toggleTheme}>{act.dark ? <Sun /> : <Moon />}</Button>
                </TooltipTrigger>
                <TooltipContent>{act.dark ? "切换到亮色" : "切换到暗色"}</TooltipContent>
              </Tooltip>
              {!/^\/(login|register|forgot-password|reset-password)/.test(path) && (
                <Button size="sm" variant="outline" asChild><Link to={"/login?next=" + encodeURIComponent(path)}>登录</Link></Button>
              )}
            </>
          )}
        </div>
      </div>
      {me && <CommandBar open={open} setOpen={setOpen} />}
    </header>
  );
}
