// 首页（动态流）与「组织」页：我的组织 + 创建组织（api.md §4.1）
import { useState, type FormEvent } from "react";
import { Building2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { post } from "../api";
import { Link, navigate } from "../router";
import { Empty, ErrorBox, Field, Page, PageHeader, Panel, ROLE_LABEL, useAction, useSession } from "../ui";
import { Feed } from "./feed";
import type { Org } from "../types";

export const SLUG_RE = /^[a-z0-9](-?[a-z0-9]){0,39}$/;
export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
/** 名称转不出 slug（如全中文）时的兜底：prefix-4 位随机，同一个表单内保持不变 */
export const useSlugFallback = (prefix: string) => useState(() => `${prefix}-${Math.random().toString(36).slice(2, 6)}`)[0];
export const autoSlug = (name: string, fallback: string) => slugify(name) || (name.trim() ? fallback : "");

/** 组织 / 项目卡片 */
export function Tile({ to, title, desc, slug, role }: { to: string; title: string; desc?: string; slug: string; role?: string }) {
  return (
    <Link to={to}
      className="surface lift group flex min-h-[112px] flex-col gap-1.5 p-4">
      <span className="flex items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/15 text-xs font-bold text-foreground">{title.slice(0, 1).toUpperCase()}</span>
        <span className="truncate text-[15px] font-bold transition-colors group-hover:text-primary">{title}</span>
      </span>
      {desc !== undefined && <span className="line-clamp-2 text-[13px] text-muted-foreground">{desc || "暂无描述"}</span>}
      <span className="mt-auto flex items-center justify-between gap-2 pt-2 text-xs">
        <span className="truncate font-mono text-muted-foreground">{slug}</span>
        {role && <Badge variant="secondary">{role}</Badge>}
      </span>
    </Link>
  );
}

export const TILES = "grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3";

/** 首页：我能看的全部页面的动态流 */
export function Home() {
  return (
    <div className="mx-auto w-full max-w-[680px]">
      <h1 className="sr-only">动态</h1>
      <Feed />
    </div>
  );
}

export function OrgsPage() {
  const { me, refresh } = useSession();
  const fallback = useSlugFallback("org");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(async () => {
      const o = await post<Org>("/orgs", { name, slug });
      await refresh();
      navigate(`/o/${o.slug}`);
    });
  };
  return (
    <Page>
      <PageHeader title="组织" desc="组织下有项目，agent 发布的页面都归属某个项目。" />
      <div className="split">
      {me!.orgs.length === 0 ? (
        <Empty icon={<Building2 />} title="还没有加入任何组织">在下方创建一个，或打开别人发给你的邀请链接加入。</Empty>
      ) : (
        <div className={TILES}>
          {me!.orgs.map((o) => <Tile key={o.id} to={`/o/${o.slug}`} title={o.name} slug={o.slug} role={ROLE_LABEL[o.my_role]} />)}
        </div>
      )}
      <Panel title="创建组织" desc="创建后你就是该组织的所有者。">
        <form onSubmit={submit} className="form">
          <Field label="名称"><Input required maxLength={100} value={name} onChange={(e) => (setName(e.target.value), setSlug(autoSlug(e.target.value, fallback)))} /></Field>
          <Field label="标识（slug）" hint="小写字母、数字、单个连字符，用于网址">
            <Input required pattern={SLUG_RE.source} value={slug} onChange={(e) => setSlug(e.target.value)} className="font-mono" />
          </Field>
          <ErrorBox error={a.error} />
          <div><Button type="submit" loading={a.busy} disabled={a.busy}>创建组织</Button></div>
        </form>
      </Panel>
      </div>
    </Page>
  );
}
