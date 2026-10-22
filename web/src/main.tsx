import { StrictMode, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Check, ChevronsUpDown, KeyRound, LayoutGrid, LogOut, Moon, Sun, UserRound } from "lucide-react";
import "@fontsource-variable/nunito";
import "./index.css";
import { post } from "./api";
import { Link, match, navigate, useLocation } from "./router";
import { cn } from "@/lib/utils";
import { Loading, Page, SessionProvider, setCurrentOrg, useCurrentOrgId, useSession, useTheme, WRAP } from "./ui";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ForgotPassword, Login, Register, ResetPassword, VerifyEmail } from "./pages/auth";
import { AcceptInvite } from "./pages/invite";
import { Home } from "./pages/home";
import { OrgPage } from "./pages/org";
import { ProjectPage } from "./pages/project";
import { PageViewRoute, ShareViewRoute } from "./pages/view";
import { ResultsPage } from "./pages/results";
import { LinksPage } from "./pages/links";
import { AccountSettings, TokenSettings } from "./pages/settings";

type Route = [pattern: string, render: (p: Record<string, string>) => ReactNode, auth: boolean];
const routes: Route[] = [
  ["/", () => <Home />, true],
  ["/login", () => <Login />, false],
  ["/register", () => <Register />, false],
  ["/verify-email", () => <VerifyEmail />, false],
  ["/forgot-password", () => <ForgotPassword />, false],
  ["/reset-password", () => <ResetPassword />, false],
  ["/invite/:token", (p) => <AcceptInvite token={p.token} />, false],
  ["/o/:orgSlug", (p) => <OrgPage slug={p.orgSlug} />, true],
  ["/o/:orgSlug/p/:projectSlug", (p) => <ProjectPage orgSlug={p.orgSlug} projectSlug={p.projectSlug} />, true],
  ["/pages/:id", (p) => <PageViewRoute id={p.id} />, false],
  ["/pages/:id/results", (p) => <ResultsPage id={p.id} />, true],
  ["/pages/:id/links", (p) => <LinksPage id={p.id} />, true],
  ["/s/:token", (p) => <ShareViewRoute token={p.token} />, false],
  ["/settings/tokens", () => <TokenSettings />, true],
  ["/settings/account", () => <AccountSettings />, true],
];

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useSession();
  useEffect(() => {
    if (!loading && !me) navigate("/login?next=" + encodeURIComponent(location.pathname + location.search), true);
  }, [me, loading]);
  return loading || !me ? <Page><Loading /></Page> : <>{children}</>;
}

/** 标识：两个节点之间的一次转发 */
function BrandMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-6 shrink-0" aria-hidden="true">
      <rect width="24" height="24" rx="6.5" className="fill-primary" />
      <path d="M8 16 16 8" className="stroke-primary-foreground/45" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="1.8 2.6" />
      <circle cx="7.5" cy="16.5" r="2.6" className="fill-primary-foreground" />
      <circle cx="16.5" cy="7.5" r="2.6" className="fill-primary-foreground" />
    </svg>
  );
}

function OrgSwitcher({ orgSlug }: { orgSlug: string }) {
  const { me } = useSession();
  const lastId = useCurrentOrgId();
  // 路径里的组织优先；其余页面（页面查看、结果、设置）用页面所属组织或最近一次进入的组织
  const bySlug = orgSlug ? me!.orgs.find((o) => o.slug === orgSlug) : undefined;
  const cur = bySlug ?? me!.orgs.find((o) => o.id === lastId);
  useEffect(() => {
    if (bySlug) setCurrentOrg(bySlug.id);
  }, [bySlug]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="切换组织" className="max-w-[200px] gap-1.5 px-2 font-medium max-sm:max-w-[150px]">
          <span className="truncate">{cur ? cur.name : "选择组织"}</span>
          <ChevronsUpDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">组织</DropdownMenuLabel>
        {me!.orgs.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => navigate(`/o/${o.slug}`)}>
            <span className="grid size-5 place-items-center rounded-md bg-primary/15 text-[11px] font-bold text-foreground">{o.name.slice(0, 1).toUpperCase()}</span>
            <span className="flex-1 truncate">{o.name}</span>
            {o.id === cur?.id && <Check className="text-primary" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("/")}><LayoutGrid />全部组织</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Header() {
  const { me, setMe } = useSession();
  const theme = useTheme();
  const path = useLocation().split("?")[0];
  const orgSlug = path.match(/^\/o\/([^/]+)/)?.[1] ?? "";
  const logout = async () => {
    await post("/auth/logout").catch(() => {});
    setMe(null);
    navigate("/login");
  };
  const dark = theme.mode === "dark";
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/70">
      <div className={cn(WRAP, "flex h-14 items-center gap-1.5")}>
        <Link to="/" className="flex shrink-0 items-center gap-2.5 rounded-md pr-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/80" aria-label="Team Kanban 首页">
          <BrandMark />
          <span className="text-[15px] font-bold max-sm:hidden">Team Kanban</span>
        </Link>
        {me && me.orgs.length > 0 && (
          <>
            <span className="text-lg font-light text-border select-none max-sm:hidden" aria-hidden="true">/</span>
            <OrgSwitcher orgSlug={orgSlug} />
          </>
        )}
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="切换亮/暗色" onClick={() => theme.setMode(dark ? "light" : "dark")}>
              {dark ? <Sun /> : <Moon />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{dark ? "切换到亮色" : "切换到暗色"}</TooltipContent>
        </Tooltip>
        {me ? (
          <>
            <Button variant="ghost" size="sm" asChild className={path.startsWith("/settings/tokens") ? "bg-accent max-sm:hidden" : "text-muted-foreground max-sm:hidden"}>
              <Link to="/settings/tokens">令牌</Link>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-2 px-1.5" aria-label="账号菜单">
                  <Avatar className="size-6"><AvatarFallback className="text-[11px] font-semibold">{me.user.display_name.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar>
                  <span className="max-w-[120px] truncate max-md:hidden">{me.user.display_name}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="grid gap-0.5">
                  <span className="truncate">{me.user.display_name}</span>
                  <span className="truncate text-xs font-normal text-muted-foreground">{me.user.email}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => navigate("/settings/account")}><UserRound />账号设置</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => navigate("/settings/tokens")}><KeyRound />访问令牌</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={logout}><LogOut />退出登录</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : !/^\/(login|register|forgot-password|reset-password)/.test(path) && (
          <Button size="sm" variant="outline" asChild><Link to={"/login?next=" + encodeURIComponent(path)}>登录</Link></Button>
        )}
      </div>
    </header>
  );
}

function App() {
  const loc = useLocation();
  const path = loc.split("?")[0].replace(/\/+$/, "") || "/";
  const { me } = useSession();
  const { mode } = useTheme();
  let body: ReactNode = <AuthNotFound />;
  for (const [pattern, render, auth] of routes) {
    const p = match(pattern, path);
    if (p) {
      // 路由切换时内容区淡入一次（key 变化才重新挂载）
      body = <div key={loc} className="page-enter">{auth ? <RequireAuth>{render(p)}</RequireAuth> : render(p)}</div>;
      break;
    }
  }
  return (
    <>
      <Header />
      {me && !me.user.email_verified && (
        <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 border-b bg-warning/10 px-4 py-2 text-[13px]">
          <span>邮箱尚未验证，请查收验证邮件。</span>
          <Link to="/settings/account" className="font-medium underline underline-offset-4">重发验证邮件</Link>
        </div>
      )}
      <main className={cn(WRAP, "pt-8 pb-16 max-sm:pt-5")}>{body}</main>
      <Toaster theme={mode} position="bottom-center" toastOptions={{ classNames: { toast: "toast" } }} />
    </>
  );
}

function AuthNotFound() {
  return (
    <div className="mx-auto mt-12 grid max-w-sm gap-2 text-center">
      <h1 className="text-xl font-semibold tracking-tight">页面不存在</h1>
      <p className="text-sm text-muted-foreground">链接可能已失效。<Link to="/" className="link">返回首页</Link></p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><SessionProvider><App /></SessionProvider></StrictMode>,
);
