// 外壳（方向 C）：左上品牌、顶部居中命令栏（⌘K / Ctrl+K）、右侧头像菜单
import { useEffect, useRef, useState } from "react";
import { Building2, FileText, FolderKanban, KeyRound, LogOut, Moon, Search, Settings, Sun, UserPlus, UserRound } from "lucide-react";
import { get, post, qs } from "./api";
import { Link, navigate, useLocation } from "./router";
import { resetMyProjects, useCurrentOrgId, useMyProjects, useSession, useTheme } from "./ui";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Page, Paged } from "./types";

/** 标识：两个节点之间的一次转发 */
function BrandMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-6 shrink-0" aria-hidden="true">
      <rect width="24" height="24" rx="6.5" className="fill-foreground" />
      <path d="M8 16 16 8" className="stroke-background/50" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="1.8 2.6" />
      <circle cx="7.5" cy="16.5" r="2.6" className="fill-highlight" />
      <circle cx="16.5" cy="7.5" r="2.6" className="fill-background" />
    </svg>
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
  const org = orgs.find((o) => o.slug === slug) ?? orgs.find((o) => o.id === lastOrg) ?? (orgs.length === 1 ? orgs[0] : undefined);
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
    <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur-sm">
      <div className="mx-auto grid h-14 w-full max-w-[1400px] grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 sm:px-6">
        <Link to="/" className="flex w-fit items-center gap-2.5 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/80" aria-label="Team Kanban 首页">
          <BrandMark />
          <span className="font-heading text-[15px] font-bold max-sm:hidden">Team Kanban</span>
        </Link>
        {me ? (
          <>
            {/* 宽屏：居中命令栏；手机：收成图标按钮 */}
            <button type="button" onClick={() => setOpen(true)} aria-label="打开命令栏" aria-keyshortcuts={IS_MAC ? "Meta+K" : "Control+K"}
              className="flex h-9 w-[min(380px,40vw)] items-center gap-2 rounded-full border bg-card px-3.5 text-[13px] text-muted-foreground transition-colors outline-none hover:border-input hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/80 max-sm:hidden">
              <Search className="size-4" />
              <span className="flex-1 truncate text-left">跳转到项目、页面或操作</span>
              <kbd className="rounded border px-1.5 font-sans text-[11px]">{IS_MAC ? "⌘K" : "Ctrl K"}</kbd>
            </button>
            <span className="sm:hidden" />
          </>
        ) : <span />}
        <div className="flex items-center justify-end gap-1">
          {me && (
            <Button variant="ghost" size="icon-sm" aria-label="搜索" className="sm:hidden" onClick={() => setOpen(true)}><Search /></Button>
          )}
          {me ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-2 px-1.5" aria-label="账号菜单">
                  <Avatar className="size-7"><AvatarFallback className="bg-foreground text-[12px] font-semibold text-background">{me.user.display_name.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar>
                  <span className="max-w-[120px] truncate max-md:hidden">{me.user.display_name}</span>
                </Button>
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
