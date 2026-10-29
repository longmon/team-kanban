use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    /// 不带结尾斜杠，例 `https://relay.example.com`
    pub public_url: String,
    /// html 页面独立源；None = 退化为同源 /h/*
    pub pages_origin: Option<String>,
    pub secret_key: Vec<u8>,
    pub bind: String,
    pub trust_proxy: bool,
    pub cookie_secure: bool,
    pub allow_signup: bool,
    pub smtp_url: Option<String>,
    pub smtp_from: Option<String>,
}

fn var(name: &str) -> Option<String> {
    env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn flag(name: &str, default: bool) -> bool {
    var(name).map_or(default, |v| !matches!(v.as_str(), "0" | "false" | "no" | "off"))
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let need = |n: &str| var(n).ok_or_else(|| format!("缺少环境变量 {n}"));
        let secret_key = need("SECRET_KEY")?.into_bytes();
        if secret_key.len() < 32 {
            return Err("SECRET_KEY 至少 32 字节".into());
        }
        Ok(Self {
            database_url: need("DATABASE_URL")?,
            public_url: need("PUBLIC_URL")?.trim_end_matches('/').to_string(),
            pages_origin: var("PAGES_ORIGIN").map(|s| s.trim_end_matches('/').to_string()),
            secret_key,
            bind: var("BIND").unwrap_or_else(|| "0.0.0.0:8080".into()),
            trust_proxy: flag("TRUST_PROXY", false),
            cookie_secure: flag("COOKIE_SECURE", true),
            allow_signup: flag("ALLOW_SIGNUP", true),
            smtp_url: var("SMTP_URL"),
            smtp_from: var("SMTP_FROM"),
        })
    }

    pub fn session_cookie_name(&self) -> &'static str {
        if self.cookie_secure { "__Host-relay_session" } else { "relay_session" }
    }

    /// html 页面所在源（frame_url 前缀）
    pub fn frame_origin(&self) -> &str {
        self.pages_origin.as_deref().unwrap_or(&self.public_url)
    }

    /// `PAGES_ORIGIN` 的 host[:port]，用于按 Host 头分流
    pub fn pages_host(&self) -> Option<String> {
        self.pages_origin.as_deref().map(host_of)
    }
}

pub fn host_of(origin: &str) -> String {
    let s = origin.split_once("://").map_or(origin, |(_, r)| r);
    s.split('/').next().unwrap_or("").to_ascii_lowercase()
}

/// `SUPERADMIN_EMAILS=a@x.com,b@y.com`：逗号/空白分隔，trim + 小写，去重
pub fn superadmin_emails() -> Vec<String> {
    parse_emails(&var("SUPERADMIN_EMAILS").unwrap_or_default())
}

pub fn parse_emails(s: &str) -> Vec<String> {
    let mut v: Vec<String> = s.split([',', ' ', '\n', '\t']).map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty()).collect();
    v.sort();
    v.dedup();
    v
}
