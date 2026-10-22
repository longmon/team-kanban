//! OpenUI Lang 本地校验：内嵌 QuickJS 运行打包好的 @openuidev/lang-core（design §8.3）。

use rquickjs::{Context, Runtime};
use serde::Deserialize;
use std::time::{Duration, Instant};

const LANG_CORE: &str = include_str!("../vendor/lang-core.js");

/// 校验通过时的提示（orphaned 等），失败时的错误列表（每条 `行:列 code message`）。
#[derive(Debug, Default)]
pub struct Outcome {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Deserialize)]
struct ParseOut {
    root: bool,
    meta: Meta,
}

#[derive(Deserialize)]
struct Meta {
    incomplete: bool,
    unresolved: Vec<String>,
    orphaned: Vec<String>,
    errors: Vec<ValidationError>,
}

#[derive(Deserialize)]
struct ValidationError {
    code: String,
    message: String,
    #[serde(rename = "statementId")]
    statement_id: Option<String>,
}

/// 同步执行，调用方放进 spawn_blocking。Err 表示引擎本身出错（不是 spec 有错）。
// ponytail: 每次新建 QuickJS 运行时并重新加载 lang-core（release 约几十毫秒），发布频率低够用；要提速再改成常驻线程。
pub fn validate(schema: &str, spec: &str) -> Result<Outcome, String> {
    let rt = Runtime::new().map_err(|e| e.to_string())?;
    rt.set_memory_limit(256 << 20);
    let deadline = Instant::now() + Duration::from_secs(10);
    rt.set_interrupt_handler(Some(Box::new(move || Instant::now() > deadline)));
    let ctx = Context::full(&rt).map_err(|e| e.to_string())?;
    let json = ctx.with(|ctx| -> Result<String, String> {
        let js_err = |e: rquickjs::Error| {
            let ex = ctx.catch();
            match ex.as_exception() {
                Some(ex) => format!("{e}: {}", ex.message().unwrap_or_default()),
                None => e.to_string(),
            }
        };
        ctx.eval::<(), _>(LANG_CORE).map_err(js_err)?;
        let g = ctx.globals();
        g.set("SCHEMA", schema).map_err(js_err)?;
        g.set("SPEC", spec).map_err(js_err)?;
        ctx.eval(
            r#"(() => {
                const r = LangCore.createParser(JSON.parse(SCHEMA), "Stack").parse(SPEC);
                return JSON.stringify({ root: r.root != null, meta: r.meta });
            })()"#,
        )
        .map_err(js_err)
    })?;
    let out: ParseOut = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    Ok(report(spec, out))
}

fn report(spec: &str, out: ParseOut) -> Outcome {
    let mut o = Outcome::default();
    for e in &out.meta.errors {
        let (l, c) = e
            .statement_id
            .as_deref()
            .and_then(|id| statement_pos(spec, id))
            .unwrap_or((1, 1));
        o.errors.push(format!("{l}:{c} {} {}", e.code, e.message));
    }
    for name in &out.meta.unresolved {
        let (l, c) = ident_pos(spec, name).unwrap_or((1, 1));
        o.errors
            .push(format!("{l}:{c} unresolved 引用了未定义的名称 `{name}`"));
    }
    if out.meta.incomplete {
        let lines = spec.lines().count().max(1);
        let col = spec.lines().last().map_or(0, |l| l.chars().count()) + 1;
        o.errors.push(format!(
            "{lines}:{col} incomplete 输入不完整：括号/引号未闭合或最后一条语句被截断"
        ));
    }
    if !out.root && o.errors.is_empty() {
        o.errors
            .push("1:1 no-root 没有生成根组件：需要 `root = Stack([...])`".into());
    }
    for name in &out.meta.orphaned {
        let (l, _) = statement_pos(spec, name).unwrap_or((1, 1));
        o.warnings
            .push(format!("第 {l} 行的 `{name}` 未被 root 引用，不会显示"));
    }
    o
}

/// `name = ...` 语句所在的行列（1 起）。
fn statement_pos(spec: &str, name: &str) -> Option<(usize, usize)> {
    spec.lines().enumerate().find_map(|(i, line)| {
        let t = line.trim_start();
        let rest = t.strip_prefix(name)?;
        rest.trim_start()
            .starts_with('=')
            .then(|| (i + 1, line.chars().count() - t.chars().count() + 1))
    })
}

/// 标识符第一次出现的行列（1 起，按完整单词匹配）。
fn ident_pos(spec: &str, name: &str) -> Option<(usize, usize)> {
    let is_ident = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
    spec.lines().enumerate().find_map(|(i, line)| {
        line.match_indices(name).find_map(|(at, _)| {
            let before = line[..at].chars().next_back();
            let after = line[at + name.len()..].chars().next();
            (!before.is_some_and(is_ident) && !after.is_some_and(is_ident))
                .then(|| (i + 1, line[..at].chars().count() + 1))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    const SCHEMA: &str = include_str!("../tests/fixtures/library.schema.json");

    #[test]
    fn guide_examples_pass() {
        for (title, spec) in crate::EXAMPLES {
            let o = validate(SCHEMA, spec).unwrap();
            assert!(
                o.errors.is_empty() && o.warnings.is_empty(),
                "{title}: {o:?}"
            );
        }
    }

    #[test]
    fn errors_carry_positions() {
        let spec = "root = Stack([a, b, missing])\na = CardHeader(\"x\")\n  b = Bogus(1)\nextra = CardHeader(\"y\")";
        let o = validate(SCHEMA, spec).unwrap();
        assert!(
            o.errors
                .iter()
                .any(|e| e.starts_with("3:3 unknown-component")),
            "{o:?}"
        );
        assert!(
            o.errors.iter().any(|e| e.starts_with("1:21 unresolved")),
            "{o:?}"
        );
        assert!(o.warnings.iter().any(|w| w.contains("`extra`")), "{o:?}");

        let o = validate(SCHEMA, "root = Stack([CardHeader(\"x\"").unwrap();
        assert!(o.errors.iter().any(|e| e.contains("incomplete")), "{o:?}");
    }
}
