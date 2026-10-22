// 注册、登录、找回密码、重置密码、邮箱验证（api.md §3）
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError, post } from "../api";
import { Link, navigate, useQuery } from "../router";
import { AuthCard, ErrorBox, Field, Notice, useAction, useSession } from "../ui";
import type { Me } from "../types";

/** 只允许站内相对路径，防开放跳转 */
export const safeNext = (n: string | null) => (n && n.startsWith("/") && !n.startsWith("//") ? n : "/");

const Foot = ({ children }: { children: React.ReactNode }) => <p className="text-center text-[13px] text-muted-foreground">{children}</p>;

export function Login() {
  const next = safeNext(useQuery("next"));
  const { setMe, refresh } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      const r = await post<Pick<Me, "user" | "csrf_token">>("/auth/login", { email, password });
      setMe({ ...r, orgs: [] });
      await refresh();
      navigate(next, true);
    });
  };
  return (
    <AuthCard title="登录 Team Kanban" desc="查看 agent 发给你的页面，管理组织与令牌。">
      <form onSubmit={submit} className="grid gap-4">
        <Field label="邮箱"><Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="密码"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <ErrorBox error={a.error} />
        <Button type="submit" loading={a.busy} disabled={a.busy} className="mt-1 w-full">登录</Button>
      </form>
      <Foot>
        <Link className="link" to={"/register" + (next !== "/" ? "?next=" + encodeURIComponent(next) : "")}>注册账号</Link>
        <span className="mx-2 text-border">|</span>
        <Link className="link" to="/forgot-password">忘记密码</Link>
      </Foot>
    </AuthCard>
  );
}

export function Register() {
  const next = safeNext(useQuery("next"));
  // 从 /invite/:token 跳来时带上邀请 token（ALLOW_SIGNUP=0 时注册必需）
  const inviteToken = next.match(/^\/invite\/([^/?]+)/)?.[1];
  const { setMe, refresh } = useSession();
  const [f, setF] = useState({ email: "", password: "", display_name: "" });
  const a = useAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      const r = await post<Pick<Me, "user" | "csrf_token">>("/auth/register", { ...f, invite_token: inviteToken });
      setMe({ ...r, orgs: [] });
      await refresh();
      navigate(next, true);
    });
  };
  const signupDisabled = a.error instanceof ApiError && a.error.code === "signup_disabled";
  return (
    <AuthCard title="注册账号" desc="注册后可以创建组织，或接受别人的邀请。">
      <form onSubmit={submit} className="grid gap-4">
        <Field label="邮箱"><Input type="email" autoComplete="email" required value={f.email} onChange={set("email")} /></Field>
        <Field label="显示名"><Input required maxLength={50} value={f.display_name} onChange={set("display_name")} /></Field>
        <Field label="密码" hint="10–128 个字符">
          <Input type="password" autoComplete="new-password" required minLength={10} maxLength={128} value={f.password} onChange={set("password")} />
        </Field>
        {signupDisabled ? <Notice tone="warning">本站暂未开放注册，请通过邀请链接注册。</Notice> : <ErrorBox error={a.error} />}
        <Button type="submit" loading={a.busy} disabled={a.busy} className="mt-1 w-full">注册</Button>
      </form>
      <Foot>已有账号？<Link className="link" to={"/login" + (next !== "/" ? "?next=" + encodeURIComponent(next) : "")}>登录</Link></Foot>
    </AuthCard>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      await post("/auth/password/forgot", { email });
      setSent(true);
    });
  };
  return (
    <AuthCard title="找回密码" desc={sent ? undefined : "输入注册邮箱，我们会发送重置链接。"}>
      {sent ? (
        <Notice tone="success">如果该邮箱已注册，你会收到一封重置密码的邮件（1 小时内有效）。</Notice>
      ) : (
        <form onSubmit={submit} className="grid gap-4">
          <Field label="注册邮箱"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <ErrorBox error={a.error} />
          <Button type="submit" loading={a.busy} disabled={a.busy} className="w-full">发送重置邮件</Button>
        </form>
      )}
      <Foot><Link className="link" to="/login">返回登录</Link></Foot>
    </AuthCard>
  );
}

export function ResetPassword() {
  const token = useQuery("token") ?? "";
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      await post("/auth/password/reset", { token, password });
      setDone(true);
    });
  };
  const invalid = a.error instanceof ApiError && a.error.code === "token_invalid";
  return (
    <AuthCard title="重置密码">
      {done ? (
        <Notice tone="success">密码已重置，请用新密码登录。</Notice>
      ) : invalid || !token ? (
        <Notice tone="error">链接无效、已过期或已使用，请重新申请。</Notice>
      ) : (
        <form onSubmit={submit} className="grid gap-4">
          <Field label="新密码" hint="10–128 个字符">
            <Input type="password" autoComplete="new-password" required minLength={10} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <ErrorBox error={a.error} />
          <Button type="submit" loading={a.busy} disabled={a.busy} className="w-full">重置密码</Button>
        </form>
      )}
      <Foot><Link className="link" to={invalid || !token ? "/forgot-password" : "/login"}>{invalid || !token ? "重新申请" : "去登录"}</Link></Foot>
    </AuthCard>
  );
}

export function VerifyEmail() {
  const token = useQuery("token") ?? "";
  const { refresh } = useSession();
  const [state, setState] = useState<"pending" | "ok" | "bad">("pending");
  const sent = useRef(false); // StrictMode 下 effect 会跑两次，token 一次性
  // GET 无副作用：页面加载后再 POST（design §6.2）
  useEffect(() => {
    if (!token) return setState("bad");
    if (sent.current) return;
    sent.current = true;
    post("/auth/verify-email", { token }).then(
      () => (setState("ok"), void refresh()),
      () => setState("bad"),
    );
  }, [token, refresh]);
  return (
    <AuthCard title="邮箱验证">
      {state === "pending" && <p className="text-sm text-muted-foreground">验证中…</p>}
      {state === "ok" && <Notice tone="success">邮箱已验证。</Notice>}
      {state === "bad" && <Notice tone="error">验证链接无效、已过期或已使用。登录后可在账号设置里重发。</Notice>}
      <Foot><Link className="link" to="/">返回首页</Link></Foot>
    </AuthCard>
  );
}
