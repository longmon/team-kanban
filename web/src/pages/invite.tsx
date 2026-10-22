// 接受邀请（api.md §5）
import { Button } from "@/components/ui/button";
import { ApiError, get, post } from "../api";
import { Link, navigate } from "../router";
import { AuthCard, ErrorBox, fmtTime, Loading, Notice, Page, ROLE_LABEL, useAction, useLoad, useSession } from "../ui";
import type { Group, InvitePreview, Org, Project } from "../types";

const GONE: Record<string, string> = {
  invite_expired: "邀请已过期", invite_revoked: "邀请已被撤销", invite_used_up: "邀请名额已用完", not_found: "邀请不存在",
};
const TARGET: Record<string, string> = { org: "组织", project: "项目", group: "群组" };

export function AcceptInvite({ token }: { token: string }) {
  const { me, refresh } = useSession();
  const pv = useLoad(() => get<InvitePreview>(`/invites/by-token/${encodeURIComponent(token)}`), [token]);
  const a = useAction();
  const next = encodeURIComponent(`/invite/${token}`);

  if (pv.loading) return <Page><Loading /></Page>;
  if (pv.error) {
    const code = pv.error instanceof ApiError ? pv.error.code : "";
    return <AuthCard title="无法加入"><Notice tone="error">{GONE[code] ?? "无法加载邀请"}</Notice></AuthCard>;
  }
  const p = pv.data!;
  const accept = () =>
    a.run(async () => {
      const r = await post<{ org: Org; project: Project | null; group: Group | null }>(
        `/invites/by-token/${encodeURIComponent(token)}/accept`, {},
      );
      await refresh();
      navigate(r.project ? `/o/${r.org.slug}/p/${r.project.slug}` : `/o/${r.org.slug}`, true);
    });
  const code = a.error instanceof ApiError ? a.error.code : "";

  return (
    <AuthCard title={`加入${TARGET[p.target_type]}「${p.target_name}」`}>
      <p className="text-sm leading-relaxed">
        <b className="font-medium">{p.invited_by}</b> 邀请你以 <b className="font-medium">{ROLE_LABEL[p.role] ?? p.role}</b> 身份加入{TARGET[p.target_type]}
        「<b className="font-medium">{p.target_name}</b>」（组织 {p.org.name}）。
      </p>
      <p className="text-[13px] text-muted-foreground">有效期至 {fmtTime(p.expires_at)}{p.email_bound && "；此邀请仅限指定邮箱接受"}</p>
      {!me ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Button onClick={() => navigate(`/login?next=${next}`)}>登录后接受</Button>
          <Button variant="outline" onClick={() => navigate(`/register?next=${next}`)}>注册新账号</Button>
        </div>
      ) : (
        <>
          {code === "email_unverified" ? (
            <Notice tone="warning">请先验证邮箱再接受邀请（<Link className="link" to="/settings/account">重发验证邮件</Link>）。</Notice>
          ) : code === "email_mismatch" ? (
            <Notice tone="warning">此邀请绑定了其它邮箱，当前账号 {me.user.email} 无法接受。</Notice>
          ) : (
            <ErrorBox error={a.error && (GONE[code] ? new Error(GONE[code]) : a.error)} />
          )}
          <Button disabled={a.busy} onClick={accept} className="w-full">以 {me.user.display_name} 身份接受</Button>
        </>
      )}
    </AuthCard>
  );
}
