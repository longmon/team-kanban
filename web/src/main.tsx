import { StrictMode, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/bricolage-grotesque";
import { AnimateUIProvider } from "@animate-ui/react/provider";
import { MotionConfig } from "motion/react";
import "./index.css";
import { Link, match, navigate, useLocation } from "./router";
import { Header } from "./shell";
import { Loading, Page, REDUCED, SessionProvider, useSession, useTheme } from "./ui";
import { Toaster } from "@/components/ui/sonner";
import { ForgotPassword, Login, Register, ResetPassword, VerifyEmail } from "./pages/auth";
import { AcceptInvite } from "./pages/invite";
import { Home, OrgsPage } from "./pages/home";
import { OrgPage } from "./pages/org";
import { ProjectPage } from "./pages/project";
import { PageViewRoute, ShareViewRoute } from "./pages/view";
import { ResultsPage } from "./pages/results";
import { LinksPage } from "./pages/links";
import { AccountSettings, TokenSettings } from "./pages/settings";

type Route = [pattern: string, render: (p: Record<string, string>) => ReactNode, auth: boolean];
const routes: Route[] = [
  ["/", () => <Home />, true],
  ["/orgs", () => <OrgsPage />, true],
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
      body = <div key={path} className="page-enter">{auth ? <RequireAuth>{render(p)}</RequireAuth> : render(p)}</div>;
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
      <main className="w-full px-4 pt-8 pb-28 sm:px-6 max-sm:pt-5">{body}</main>
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

// 减少动态：animate-ui 默认只去位移、仍保留淡入淡出；按设计规范 §5 时长归零，这里把它的动效节奏压到 1%（近乎瞬时，弹簧同比加速）。
// ponytail: 只在加载时读一次系统设置，运行中切换需刷新页面
// motion 自己的组件（动态流、操作条、结果条）同样处理：减少动态时默认过渡时长归零，各组件另外跳过入场（ui.tsx REDUCED）
const tempo = REDUCED ? 0.01 : 1;
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AnimateUIProvider tempo={tempo} reducedMotion="user">
      <MotionConfig reducedMotion="user" transition={REDUCED ? { duration: 0 } : undefined}>
        <SessionProvider><App /></SessionProvider>
      </MotionConfig>
    </AnimateUIProvider>
  </StrictMode>,
);
