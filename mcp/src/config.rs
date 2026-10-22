//! 本机 profile 配置：`$XDG_CONFIG_HOME/team-kanban/config.toml`（缺省 `~/.config/team-kanban/config.toml`），
//! 文件 0600、目录 0700。新路径不存在而旧路径 `agent-relay/config.toml` 存在时，读取旧文件写到新路径。
//! 设置了 TEAM_KANBAN_URL 时追加一个名为 env 的隐式 profile（兼容旧的环境变量注册方式）。

use std::{collections::BTreeMap, path::PathBuf};

use serde::{Deserialize, Serialize};

pub const ENV_PROFILE: &str = "env";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Profile {
    pub url: String,
    pub token: String,
    /// 默认组织（slug / UUID / 名称），视为用户已指定
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org: Option<String>,
    /// 默认项目（UUID / "org/slug" / slug / 名称），视为用户已指定
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// 默认群组（名称或 UUID），视为用户已指定
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Config {
    /// 只由 `tkanban add --default` / `tkanban default` 写入
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default)]
    pub profiles: BTreeMap<String, Profile>,
}

fn base() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config")
        })
}

pub fn path() -> PathBuf {
    base().join("team-kanban").join("config.toml")
}

/// 改名前的配置路径（agent-relay，历史名称，为兼容保留）
fn legacy_path() -> PathBuf {
    base().join("agent-relay").join("config.toml")
}

impl Config {
    /// 只读文件（不含 env profile）；文件不存在视为空配置。
    pub fn load_file() -> Result<Self, String> {
        let p = path();
        match std::fs::read_to_string(&p) {
            Ok(s) => toml::from_str(&s)
                .map_err(|e| format!("config_error: 解析 {} 失败：{e}", p.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let old = legacy_path();
                let Ok(s) = std::fs::read_to_string(&old) else {
                    return Ok(Self::default());
                };
                let c = toml::from_str(&s)
                    .map_err(|e| format!("config_error: 解析 {} 失败：{e}", old.display()))?;
                write_atomic(&s)?;
                eprintln!("已把旧配置 {} 迁移到 {}", old.display(), p.display());
                Ok(c)
            }
            Err(e) => Err(format!("config_error: 读取 {} 失败：{e}", p.display())),
        }
    }

    /// 文件 + env 隐式 profile；MCP 每次调用工具时都重新读取，`tkanban add` 后无需重启。
    pub fn load() -> Result<Self, String> {
        let mut c = Self::load_file()?;
        let url = std::env::var("TEAM_KANBAN_URL").unwrap_or_default();
        if !url.is_empty() {
            let token = std::env::var("TEAM_KANBAN_TOKEN").unwrap_or_default();
            c.profiles.insert(
                ENV_PROFILE.into(),
                Profile {
                    url,
                    token,
                    ..Default::default()
                },
            );
        }
        if c.default
            .as_ref()
            .is_some_and(|d| !c.profiles.contains_key(d))
        {
            c.default = None;
        }
        Ok(c)
    }

    /// 原子写入：先写同目录临时文件（0600）再 rename。
    pub fn save(&self) -> Result<PathBuf, String> {
        let text = toml::to_string(self).map_err(|e| format!("config_error: {e}"))?;
        write_atomic(&text)
    }
}

/// 原子写入配置文件：目录 0700，先写同目录临时文件（0600）再 rename。
fn write_atomic(text: &str) -> Result<PathBuf, String> {
    let p = path();
    let dir = p.parent().unwrap_or(std::path::Path::new("."));
    let err = |e: std::io::Error| format!("config_error: 写入 {} 失败：{e}", p.display());
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        b.mode(0o700);
        b.create(dir).map_err(err)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(err)?;
    }
    #[cfg(not(unix))]
    b.create(dir).map_err(err)?;
    let tmp = p.with_extension("toml.tmp");
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    use std::io::Write;
    let mut f = o.open(&tmp).map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(err)?;
    }
    f.write_all(text.as_bytes()).map_err(err)?;
    f.sync_all().map_err(err)?;
    std::fs::rename(&tmp, &p).map_err(err)?;
    Ok(p)
}

/// token 打码：保留前 8 个字符（arp_ + 4 位前缀）。
pub fn mask(token: &str) -> String {
    if token.is_empty() {
        return "(未设置)".into();
    }
    let head: String = token.chars().take(8).collect();
    format!("{head}…")
}
