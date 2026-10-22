// fetch 封装：JSON、CSRF（design §6.2）、统一错误（api.md §2）
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: { fields?: Record<string, string> } | null = null,
  ) {
    super(message);
  }
}

let csrf: string | null = null;
export const setCsrf = (t: string | null) => (csrf = t);

type Opts = { headers?: Record<string, string>; signal?: AbortSignal };

export async function api<T = unknown>(method: string, path: string, body?: unknown, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { ...opts.headers };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (csrf && method !== "GET" && method !== "HEAD") headers["X-CSRF-Token"] = csrf;
  let res: globalThis.Response;
  try {
    res = await fetch("/api" + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "network", "网络错误，请检查连接后重试");
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json?.error;
    if (res.status === 429) {
      const after = res.headers.get("Retry-After");
      throw new ApiError(429, "rate_limited", `操作太频繁${after ? `，请 ${after} 秒后重试` : ""}`);
    }
    throw new ApiError(res.status, err?.code ?? "internal", err?.message ?? `请求失败（${res.status}）`, err?.details ?? null);
  }
  return json as T;
}

export const get = <T>(path: string, opts?: Opts) => api<T>("GET", path, undefined, opts);
export const post = <T>(path: string, body: unknown = {}, opts?: Opts) => api<T>("POST", path, body, opts);
export const patch = <T>(path: string, body: unknown) => api<T>("PATCH", path, body);
export const put = <T>(path: string, body: unknown) => api<T>("PUT", path, body);
export const del = (path: string, body?: unknown) => api<void>("DELETE", path, body);

export const qs = (o: Record<string, string | number | boolean | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? "?" + s : "";
};

export function errMsg(e: unknown): string {
  if (e instanceof ApiError) {
    const f = e.details?.fields;
    return f ? `${e.message}：${Object.entries(f).map(([k, v]) => `${k} ${v}`).join("；")}` : e.message;
  }
  return String((e as Error)?.message ?? e);
}

// 临时链接密码 grant（design §6.6：存 sessionStorage）
const grantKey = (token: string) => "relay_grant_" + token;
export const shareGrant = {
  get: (token: string) => {
    try { return sessionStorage.getItem(grantKey(token)); } catch { return null; }
  },
  set: (token: string, g: string | null) => {
    try { g ? sessionStorage.setItem(grantKey(token), g) : sessionStorage.removeItem(grantKey(token)); } catch { /* 隐私模式 */ }
  },
};

// 匿名昵称（api.md §9：localStorage relay_nickname）
export const nicknameStore = {
  get: () => { try { return localStorage.getItem("relay_nickname") ?? ""; } catch { return ""; } },
  set: (v: string) => { try { localStorage.setItem("relay_nickname", v); } catch { /* ignore */ } },
};
