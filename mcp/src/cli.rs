//! `tkanban` 子命令：管理本机 profile（多服务器）并启动 stdio MCP。

use std::{
    io::{BufRead, IsTerminal, Write},
    process::ExitCode,
};

use rmcp::ServiceExt;
use serde_json::Value;

use crate::{
    Kanban, Srv,
    config::{self, Config, ENV_PROFILE, Profile},
    pick_server,
};

const HELP: &str = "\
tkanban —— Team Kanban 本机命令行 + MCP 服务器（发布页面、拉取提交）

用法：
  tkanban add <名称> --url <URL> [--token <PAT>] [--org <slug>] [--project <slug>] [--group <群组名>]... [--default]
      添加一个服务器（profile）。会联网校验 token，并列出它能发布的组织、项目、群组；校验失败不保存。
      不写 --token（或写 --token -）时：终端里交互输入（不回显），管道里从 stdin 读第一行，避免 token 进 shell 历史。
      --org / --project / --group 是这个服务器上的默认发布目标，发布时视为「用户已指定」。
      --default 把它设为默认服务器。
  tkanban list                 列出全部服务器和默认项（token 打码）
  tkanban remove <名称>        删除服务器
  tkanban default <名称>       设为默认服务器；tkanban default --clear 取消默认
  tkanban targets [名称]       实时列出可发布的组织、项目、群组（缺省列全部服务器）
  tkanban test [名称]          测试连通性和 token（缺省测全部服务器）
  tkanban mcp                  启动 stdio MCP 服务器（给 Claude Code / Codex 注册用）；不带子命令时同样启动 MCP
  tkanban --help               显示本帮助
  tkanban --version            显示版本

选择规则（MCP 工具照此执行）：
  - 用户在对话里指明了服务器 / 组织 / 项目 / 群组，就用指明的。
  - 没指明时，某一级只有一个候选就直接用；有多个候选，agent 会先问你发到哪个服务器、哪个项目或群组。
  - 默认服务器只在你显式执行过 `tkanban add --default` 或 `tkanban default <名称>` 时才生效；
    没设默认且配置了多个服务器时，每次都会询问。

配置文件：$XDG_CONFIG_HOME/team-kanban/config.toml（缺省 ~/.config/team-kanban/config.toml），权限 0600。
  旧路径 agent-relay/config.toml 存在而新路径不存在时，自动迁移到新路径。
兼容：设置了环境变量 TEAM_KANBAN_URL（及 TEAM_KANBAN_TOKEN）时，视为一个名为 env 的服务器。
注意：服务端 Docker 镜像里的二进制叫 relay（历史名称，为兼容保留），那个跑在服务器上；本命令 tkanban 跑在你的电脑上，两者无关。

示例：
  tkanban add depx --url https://relay-mcp.depx.net --default        # 随后提示输入 PAT
  printf '%s\\n' \"$PAT\" | tkanban add another --url https://relay.example.com --org acme --group 设计组
  claude mcp add team-kanban -s user -- /usr/local/bin/tkanban mcp
";

fn fail(msg: impl std::fmt::Display) -> ExitCode {
    eprintln!("错误：{msg}");
    ExitCode::FAILURE
}

pub async fn run(args: Vec<String>) -> ExitCode {
    let cmd = args.first().map(String::as_str);
    let rest = args.get(1..).unwrap_or_default();
    let r = match cmd {
        // 不带子命令：兼容旧注册方式直接跑 MCP；人在终端里敲则给帮助
        None if std::io::stdin().is_terminal() => {
            print!("{HELP}");
            return ExitCode::SUCCESS;
        }
        None | Some("mcp") => return serve().await,
        Some("-h" | "--help" | "help") => {
            print!("{HELP}");
            return ExitCode::SUCCESS;
        }
        Some("-V" | "--version") => {
            println!("tkanban {}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        Some("add") => add(rest).await,
        Some("list") => list(),
        Some("remove") => one_name(rest).and_then(remove),
        Some("default") => set_default(rest),
        Some("targets") => targets(rest.first().map(String::as_str)).await,
        Some("test") => test(rest.first().map(String::as_str)).await,
        Some(other) => Err(format!("未知子命令 {other}，见 tkanban --help")),
    };
    match r {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => fail(e),
    }
}

async fn serve() -> ExitCode {
    let service = match Kanban::new().serve(rmcp::transport::stdio()).await {
        Ok(s) => s,
        Err(e) => return fail(e),
    };
    match service.waiting().await {
        Ok(_) => ExitCode::SUCCESS,
        Err(e) => fail(e),
    }
}

fn one_name(rest: &[String]) -> Result<&str, String> {
    match rest {
        [n] => Ok(n),
        _ => Err("需要且只需要一个 <名称>".into()),
    }
}

fn check_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 32
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !ok {
        return Err(format!("名称「{name}」不合法：1..32 个字母、数字、- 或 _"));
    }
    if name == ENV_PROFILE {
        return Err("env 是保留名（代表 TEAM_KANBAN_URL/TEAM_KANBAN_TOKEN 环境变量）".into());
    }
    Ok(())
}

/// 终端里关回显交互输入；否则从 stdin 读第一行。
fn read_token() -> Result<String, String> {
    let stdin = std::io::stdin();
    let tty = stdin.is_terminal();
    let stty = |arg: &str| {
        let _ = std::process::Command::new("stty").arg(arg).status();
    };
    if tty {
        eprint!("请输入 PAT（arp_…，输入不回显）：");
        let _ = std::io::stderr().flush();
        stty("-echo");
    }
    let mut line = String::new();
    let r = stdin.lock().read_line(&mut line);
    if tty {
        stty("echo");
        eprintln!();
    }
    r.map_err(|e| format!("读取 token 失败：{e}"))?;
    Ok(line.trim().to_string())
}

async fn add(rest: &[String]) -> Result<(), String> {
    let mut name = None;
    let (mut url, mut token, mut org, mut project) = (None, None, None, None);
    let mut groups = vec![];
    let mut make_default = false;
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        let (flag, inline) = match a.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f, Some(v.to_string())),
            _ => (a.as_str(), None),
        };
        let mut val = || {
            inline
                .clone()
                .or_else(|| it.next().cloned())
                .ok_or_else(|| format!("{flag} 需要一个值"))
        };
        match flag {
            "--url" => url = Some(val()?),
            "--token" => token = Some(val()?),
            "--org" => org = Some(val()?),
            "--project" => project = Some(val()?),
            "--group" => groups.push(val()?),
            "--default" => make_default = true,
            f if f.starts_with('-') => return Err(format!("未知参数 {f}，见 tkanban --help")),
            _ if name.is_none() => name = Some(a.clone()),
            _ => return Err(format!("多余的参数 {a}")),
        }
    }
    let name = name.ok_or("缺少 <名称>，见 tkanban --help")?;
    check_name(&name)?;
    let url = url.ok_or("缺少 --url")?;
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("--url 必须以 https:// 或 http:// 开头".into());
    }
    let mut c = Config::load_file()?;
    if c.profiles.contains_key(&name) {
        return Err(format!("服务器 {name} 已存在；先 tkanban remove {name}"));
    }
    let token = match token.as_deref() {
        None | Some("-") => read_token()?,
        Some(t) => t.to_string(),
    };
    if token.is_empty() {
        return Err("token 为空".into());
    }
    let p = Profile {
        url,
        token,
        org,
        project,
        groups,
    };
    let s = Srv::new(&name, p.clone());
    let kanban = Kanban::new();
    let t = kanban
        .targets(&s)
        .await
        .map_err(|e| format!("校验失败，未保存：{e}"))?;
    if p.org.is_some() || p.project.is_some() || !p.groups.is_empty() {
        match kanban
            .resolve_target(&s, p.org.as_deref(), p.project.as_deref(), &p.groups, true)
            .await
        {
            Ok((proj, _)) => println!(
                "默认发布目标：{}/{}",
                proj["org"]["slug"].as_str().unwrap_or_default(),
                proj["slug"].as_str().unwrap_or_default()
            ),
            // 默认值没唯一确定项目：允许，发布时再问
            Err(e) if e.starts_with('{') => {
                println!("提示：默认 org/project/group 没有唯一确定一个项目，发布时仍会询问。")
            }
            Err(e) => return Err(format!("默认目标无效，未保存：{e}")),
        }
    }
    c.profiles.insert(name.clone(), p);
    if make_default {
        c.default = Some(name.clone());
    }
    let path = c.save()?;
    println!(
        "已添加 {name}{}，配置：{}",
        if make_default { "（默认）" } else { "" },
        path.display()
    );
    print_targets(&t);
    Ok(())
}

fn list() -> Result<(), String> {
    let c = Config::load()?;
    println!("配置文件：{}", config::path().display());
    if c.profiles.is_empty() {
        println!("（还没有服务器，用 tkanban add 添加）");
        return Ok(());
    }
    for (n, p) in &c.profiles {
        let mark = if c.default.as_deref() == Some(n) {
            "*"
        } else {
            " "
        };
        let src = if n == ENV_PROFILE {
            "  (来自环境变量)"
        } else {
            ""
        };
        println!(
            "{mark} {n:<12} {}  token={}{src}",
            p.url,
            config::mask(&p.token)
        );
        let mut d = vec![];
        if let Some(o) = &p.org {
            d.push(format!("org={o}"));
        }
        if let Some(pr) = &p.project {
            d.push(format!("project={pr}"));
        }
        if !p.groups.is_empty() {
            d.push(format!("groups={}", p.groups.join(",")));
        }
        if !d.is_empty() {
            println!("    默认目标：{}", d.join("  "));
        }
    }
    match &c.default {
        Some(d) => println!("默认服务器：{d}（* 标记）"),
        None if c.profiles.len() > 1 => println!("未设默认服务器：没指明时 agent 会询问发到哪个"),
        None => {}
    }
    Ok(())
}

fn remove(name: &str) -> Result<(), String> {
    if name == ENV_PROFILE {
        return Err("env 来自环境变量 TEAM_KANBAN_URL/TEAM_KANBAN_TOKEN，取消设置环境变量即可".into());
    }
    let mut c = Config::load_file()?;
    c.profiles
        .remove(name)
        .ok_or_else(|| format!("没有名为 {name} 的服务器"))?;
    if c.default.as_deref() == Some(name) {
        c.default = None;
    }
    c.save()?;
    println!("已删除 {name}");
    Ok(())
}

fn set_default(rest: &[String]) -> Result<(), String> {
    let mut c = Config::load_file()?;
    if rest == ["--clear"] {
        c.default = None;
        c.save()?;
        println!("已取消默认服务器");
        return Ok(());
    }
    let name = one_name(rest)?;
    if !Config::load()?.profiles.contains_key(name) {
        return Err(format!("没有名为 {name} 的服务器（tkanban list 查看）"));
    }
    c.default = Some(name.into());
    c.save()?;
    println!("默认服务器：{name}");
    Ok(())
}

/// 指定名称就一个，否则全部。
fn servers(name: Option<&str>) -> Result<Vec<Srv>, String> {
    if let Some(n) = name {
        return pick_server(Some(n)).map(|s| vec![s]);
    }
    let c = Config::load()?;
    if c.profiles.is_empty() {
        return Err("还没有服务器，用 tkanban add 添加".into());
    }
    Ok(c.profiles
        .into_iter()
        .map(|(n, p)| Srv::new(&n, p))
        .collect())
}

fn print_targets(t: &Value) {
    let orgs = t["orgs"].as_array().cloned().unwrap_or_default();
    if orgs.is_empty() {
        println!("  （没有可发布的项目：需要项目 editor/admin 角色和 publish scope）");
    }
    let s = |v: &Value| v.as_str().unwrap_or_default().to_string();
    for o in orgs {
        println!(
            "  组织 {} ({})  {}",
            s(&o["name"]),
            s(&o["slug"]),
            s(&o["id"])
        );
        for p in o["projects"].as_array().into_iter().flatten() {
            println!(
                "    项目 {} ({}/{})  {}  [{}]",
                s(&p["name"]),
                s(&o["slug"]),
                s(&p["slug"]),
                s(&p["id"]),
                s(&p["role"])
            );
        }
        for g in o["groups"].as_array().into_iter().flatten() {
            println!("    群组 {}  {}", s(&g["name"]), s(&g["id"]));
        }
        if let Some(e) = o["groups_error"].as_str() {
            println!("    群组：无法列出（{e}）");
        }
    }
}

async fn targets(name: Option<&str>) -> Result<(), String> {
    let kanban = Kanban::new();
    let mut failed = false;
    for s in servers(name)? {
        println!("服务器 {}  {}", s.name, s.base);
        match kanban.targets(&s).await {
            Ok(t) => print_targets(&t),
            Err(e) => {
                failed = true;
                println!("  失败：{e}");
            }
        }
    }
    if failed {
        Err("部分服务器查询失败".into())
    } else {
        Ok(())
    }
}

async fn test(name: Option<&str>) -> Result<(), String> {
    let kanban = Kanban::new();
    let mut failed = false;
    for s in servers(name)? {
        match kanban.targets(&s).await {
            Ok(t) => {
                let orgs = t["orgs"].as_array().cloned().unwrap_or_default();
                let n: usize = orgs
                    .iter()
                    .map(|o| o["projects"].as_array().map_or(0, Vec::len))
                    .sum();
                println!(
                    "✓ {}  {}  token 有效，{} 个组织、{n} 个可发布项目",
                    s.name,
                    s.base,
                    orgs.len()
                );
            }
            Err(e) => {
                failed = true;
                println!("✗ {}  {}  {e}", s.name, s.base);
            }
        }
    }
    if failed {
        Err("测试未通过".into())
    } else {
        Ok(())
    }
}
