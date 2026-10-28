//! 接口文档（page_type=api_doc，kind=api）的内部结构与校验。契约见 docs/api.md §7.5。
//! 服务端入库前校验 + MCP 本地预检共用此文件（mcp 用 `#[path]` 引入），因此只依赖 serde / serde_json。
//! 入库的是规范化后的紧凑 JSON（去首尾空白、method 大写、未知字段拒绝），前端只渲染这一种结构。
//! 示例值（example）用 RawValue 原样保留，不改变作者写的对象键顺序。

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, value::RawValue};

/// 原样保留的 JSON 示例
pub type Example = Box<RawValue>;

/// Value → 原样示例（MCP 转换 OpenAPI 时用）
pub fn example(v: &Value) -> Option<Example> {
    serde_json::value::to_raw_value(v).ok()
}

/// 规范化 JSON 的大小上限（与 openui 相同）
pub const MAX_BYTES: usize = 512 * 1024;
const MAX_ERRORS: usize = 50;
const MAX_ENDPOINTS: usize = 300;
const MAX_FIELDS: usize = 500;
const MAX_DEPTH: usize = 6;
const METHODS: [&str; 7] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApiDoc {
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub version: String,
    pub servers: Vec<ServerEnv>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<Auth>,
    pub groups: Vec<Group>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerEnv {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthType {
    Header,
    Query,
    Bearer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Auth {
    #[serde(rename = "type")]
    pub kind: AuthType,
    /// header / query 的参数名；bearer 忽略（固定 Authorization）
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    /// 示例值，用占位符，如 {{API_KEY}}
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub value: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Group {
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    pub endpoints: Vec<Endpoint>,
}

fn yes() -> bool {
    true
}
fn is_true(b: &bool) -> bool {
    *b
}
fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Endpoint {
    pub method: String,
    pub path: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// false = 不需要全局鉴权
    #[serde(default = "yes", skip_serializing_if = "is_true")]
    pub auth: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub deprecated: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub params: Vec<Param>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<Body>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub responses: Vec<Resp>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<ErrCode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParamIn {
    Path,
    Query,
    Header,
}

fn string_ty() -> String {
    "string".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Param {
    pub name: String,
    #[serde(rename = "in")]
    pub location: ParamIn,
    #[serde(rename = "type", default = "string_ty")]
    pub ty: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub required: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub example: Option<Example>,
    #[serde(rename = "enum", default, skip_serializing_if = "Vec::is_empty")]
    pub enums: Vec<Value>,
}

fn json_ct() -> String {
    "application/json".into()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Body {
    #[serde(default = "json_ct")]
    pub content_type: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<Field>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub example: Option<Example>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Field {
    pub name: String,
    #[serde(rename = "type", default = "string_ty")]
    pub ty: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub required: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub example: Option<Example>,
    #[serde(rename = "enum", default, skip_serializing_if = "Vec::is_empty")]
    pub enums: Vec<Value>,
    /// 子字段（object，或元素为 object 的 array）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<Field>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Resp {
    #[serde(deserialize_with = "str_or_num")]
    pub status: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<Field>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub example: Option<Example>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ErrCode {
    #[serde(deserialize_with = "str_or_num")]
    pub code: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
}

/// 状态码 / 错误码写成数字也接受（200、1001），统一存字符串
fn str_or_num<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    match Value::deserialize(d)? {
        Value::String(s) => Ok(s),
        Value::Number(n) => Ok(n.to_string()),
        _ => Err(serde::de::Error::custom("必须是字符串或数字")),
    }
}

impl ApiDoc {
    pub fn endpoint_count(&self) -> usize {
        self.groups.iter().map(|g| g.endpoints.len()).sum()
    }
}

/// 校验通过的结果：规范化 JSON 与接口数
#[derive(Debug)]
pub struct Checked {
    pub json: String,
    pub endpoints: usize,
}

/// 解析 + 校验 + 规范化。错误为逐条 `位置: 原因`（最多 50 条）。
pub fn validate(src: &str) -> Result<Checked, Vec<String>> {
    if src.len() > MAX_BYTES * 2 {
        return Err(vec![format!("内容超过 {} KiB", MAX_BYTES * 2 / 1024)]);
    }
    let mut doc: ApiDoc = serde_json::from_str(src).map_err(|e| vec![format!("结构错误（第 {} 行第 {} 列）: {e}", e.line(), e.column())])?;
    finish(&mut doc)
}

/// 校验并规范化已构造的结构（MCP 的 OpenAPI 转换结果也走这里）
pub fn finish(doc: &mut ApiDoc) -> Result<Checked, Vec<String>> {
    let mut c = Ck::default();
    c.check_doc(doc);
    if !c.errs.is_empty() {
        return Err(c.errs);
    }
    let json = serde_json::to_string(doc).map_err(|e| vec![e.to_string()])?;
    if json.len() > MAX_BYTES {
        return Err(vec![format!("规范化后 {} 字节，超过上限 {} KiB；请拆成多个文档", json.len(), MAX_BYTES / 1024)]);
    }
    Ok(Checked { json, endpoints: doc.endpoint_count() })
}

#[derive(Default)]
struct Ck {
    errs: Vec<String>,
    fields: usize,
}

impl Ck {
    fn err(&mut self, at: &str, msg: impl AsRef<str>) {
        if self.errs.len() < MAX_ERRORS {
            self.errs.push(format!("{at}: {}", msg.as_ref()));
        }
    }

    /// trim 后长度 min..=max；single_line 时不许任何控制字符，否则只许 \n \t
    fn text(&mut self, at: &str, v: &mut String, min: usize, max: usize, single_line: bool) {
        let t = v.trim();
        if t.len() != v.len() {
            *v = t.to_string();
        }
        let n = v.chars().count();
        if n < min || n > max {
            self.err(at, if min > 0 { format!("长度需在 {min}..{max} 字符") } else { format!("不能超过 {max} 字符") });
        } else if v.chars().any(|c| c.is_control() && (single_line || !matches!(c, '\n' | '\t' | '\r'))) {
            self.err(at, "不能含控制字符");
        }
    }

    /// 不含空白的标识（参数名、header 名、URL、路径）
    fn token(&mut self, at: &str, v: &mut String, max: usize) {
        self.text(at, v, 1, max, true);
        if v.chars().any(char::is_whitespace) {
            self.err(at, "不能含空白");
        }
    }

    fn scalar(&mut self, at: &str, v: &Value, max: usize) {
        if v.is_object() || v.is_array() || v.is_null() {
            self.err(at, "必须是字符串、数字或布尔值");
        } else if v.to_string().len() > max {
            self.err(at, format!("不能超过 {max} 字节"));
        }
    }

    fn scalar_raw(&mut self, at: &str, v: &mut Example, max: usize) {
        match serde_json::from_str::<Value>(v.get()) {
            Ok(x) => {
                self.scalar(at, &x, max);
                *v = example(&x).unwrap_or_else(|| v.clone());
            }
            Err(e) => self.err(at, e.to_string()),
        }
    }

    fn json_size(&mut self, at: &str, v: &Example, max: usize) {
        if v.get().len() > max {
            self.err(at, format!("示例不能超过 {} KiB", max / 1024));
        }
    }

    fn enums(&mut self, at: &str, vs: &[Value]) {
        if vs.len() > 100 {
            self.err(at, "最多 100 项");
        }
        for (i, v) in vs.iter().enumerate().take(100) {
            self.scalar(&format!("{at}[{i}]"), v, 200);
        }
    }

    fn check_doc(&mut self, d: &mut ApiDoc) {
        self.text("title", &mut d.title, 1, 200, true);
        self.text("description", &mut d.description, 0, 20000, false);
        self.text("version", &mut d.version, 0, 50, true);
        if d.servers.is_empty() || d.servers.len() > 10 {
            self.err("servers", "需要 1..10 个环境（如 测试 / 生产）");
        }
        let mut names = vec![];
        for (i, s) in d.servers.iter_mut().enumerate() {
            let at = format!("servers[{i}]");
            self.text(&format!("{at}.name"), &mut s.name, 1, 50, true);
            self.token(&format!("{at}.url"), &mut s.url, 500);
            if !(s.url.starts_with("http://") || s.url.starts_with("https://")) {
                self.err(&format!("{at}.url"), "必须以 http:// 或 https:// 开头");
            }
            if s.url.contains(['?', '#']) {
                self.err(&format!("{at}.url"), "不能带 ? 或 #（查询参数写到接口 params 里）");
            }
            s.url.truncate(s.url.trim_end_matches('/').len());
            if names.contains(&s.name) {
                self.err(&format!("{at}.name"), "环境名重复");
            }
            names.push(s.name.clone());
        }
        if let Some(a) = &mut d.auth {
            if a.kind == AuthType::Bearer {
                a.name.clear();
            } else {
                self.token("auth.name", &mut a.name, 100);
            }
            self.text("auth.value", &mut a.value, 0, 500, true);
            self.text("auth.description", &mut a.description, 0, 2000, false);
        }
        if d.groups.is_empty() || d.groups.len() > 50 {
            self.err("groups", "需要 1..50 个分组");
        }
        let total = d.endpoint_count();
        if total == 0 || total > MAX_ENDPOINTS {
            self.err("groups", format!("接口总数需在 1..{MAX_ENDPOINTS}，当前 {total}"));
            if total > MAX_ENDPOINTS {
                return;
            }
        }
        for (gi, g) in d.groups.iter_mut().enumerate().take(50) {
            let at = format!("groups[{gi}]");
            self.text(&format!("{at}.name"), &mut g.name, 1, 100, true);
            self.text(&format!("{at}.description"), &mut g.description, 0, 5000, false);
            for (ei, e) in g.endpoints.iter_mut().enumerate() {
                self.check_endpoint(&format!("{at}.endpoints[{ei}]"), e);
            }
        }
    }

    fn check_endpoint(&mut self, at: &str, e: &mut Endpoint) {
        e.method = e.method.trim().to_ascii_uppercase();
        if !METHODS.contains(&e.method.as_str()) {
            self.err(&format!("{at}.method"), format!("取值必须是 {}", METHODS.join("/")));
        }
        self.token(&format!("{at}.path"), &mut e.path, 500);
        if !e.path.starts_with('/') || e.path.contains(['?', '#']) {
            self.err(&format!("{at}.path"), "必须以 / 开头且不带 ? 或 #（查询参数写到 params 里）");
        }
        self.text(&format!("{at}.title"), &mut e.title, 1, 200, true);
        self.text(&format!("{at}.description"), &mut e.description, 0, 10000, false);
        if e.params.len() > 50 {
            self.err(&format!("{at}.params"), "最多 50 个");
        }
        let mut seen: Vec<(ParamIn, String)> = vec![];
        for (i, p) in e.params.iter_mut().enumerate().take(50) {
            let pa = format!("{at}.params[{i}]");
            self.token(&format!("{pa}.name"), &mut p.name, 100);
            self.text(&format!("{pa}.type"), &mut p.ty, 1, 50, true);
            self.text(&format!("{pa}.description"), &mut p.description, 0, 2000, false);
            if let Some(x) = &mut p.example {
                self.scalar_raw(&format!("{pa}.example"), x, 2000);
            }
            self.enums(&format!("{pa}.enum"), &p.enums);
            if p.location == ParamIn::Path {
                p.required = true;
            }
            let key = (p.location, if p.location == ParamIn::Header { p.name.to_ascii_lowercase() } else { p.name.clone() });
            if seen.contains(&key) {
                self.err(&format!("{pa}.name"), "同一位置的参数名重复");
            }
            seen.push(key);
        }
        // path 里的 {name} 与 in=path 参数一一对应
        let mut placeholders = vec![];
        let mut rest = e.path.as_str();
        while let Some(s) = rest.find('{') {
            let Some(len) = rest[s..].find('}') else { break };
            placeholders.push(rest[s + 1..s + len].to_string());
            rest = &rest[s + len + 1..];
        }
        for ph in &placeholders {
            if !e.params.iter().any(|p| p.location == ParamIn::Path && &p.name == ph) {
                self.err(&format!("{at}.path"), format!("{{{ph}}} 没有对应的 in=path 参数"));
            }
        }
        for p in e.params.iter().filter(|p| p.location == ParamIn::Path) {
            if !placeholders.contains(&p.name) {
                self.err(&format!("{at}.params"), format!("path 参数 {} 没有出现在 path 里", p.name));
            }
        }
        if let Some(b) = &mut e.body {
            if matches!(e.method.as_str(), "GET" | "HEAD") {
                self.err(&format!("{at}.body"), "GET/HEAD 不能有请求体");
            }
            self.token(&format!("{at}.body.content_type"), &mut b.content_type, 100);
            self.fields = 0;
            self.check_fields(&format!("{at}.body.fields"), &mut b.fields, 1);
            if let Some(x) = &b.example {
                self.json_size(&format!("{at}.body.example"), x, 64 * 1024);
            }
        }
        if e.responses.len() > 20 {
            self.err(&format!("{at}.responses"), "最多 20 个");
        }
        for (i, r) in e.responses.iter_mut().enumerate().take(20) {
            let ra = format!("{at}.responses[{i}]");
            r.status = r.status.trim().to_ascii_uppercase();
            let ok = r.status == "DEFAULT"
                || (r.status.len() == 3
                    && matches!(r.status.as_bytes()[0], b'1'..=b'5')
                    && (r.status[1..].bytes().all(|b| b.is_ascii_digit()) || &r.status[1..] == "XX"));
            if !ok {
                self.err(&format!("{ra}.status"), "必须是 100..599、1XX..5XX 或 default");
            }
            if r.status == "DEFAULT" {
                r.status = "default".into();
            }
            self.text(&format!("{ra}.description"), &mut r.description, 0, 2000, false);
            self.fields = 0;
            self.check_fields(&format!("{ra}.fields"), &mut r.fields, 1);
            if let Some(x) = &r.example {
                self.json_size(&format!("{ra}.example"), x, 64 * 1024);
            }
        }
        if e.errors.len() > 200 {
            self.err(&format!("{at}.errors"), "最多 200 个");
        }
        for (i, x) in e.errors.iter_mut().enumerate().take(200) {
            let xa = format!("{at}.errors[{i}]");
            self.text(&format!("{xa}.code"), &mut x.code, 1, 100, true);
            self.text(&format!("{xa}.description"), &mut x.description, 0, 2000, false);
            if x.http_status.is_some_and(|s| !(100..=599).contains(&s)) {
                self.err(&format!("{xa}.http_status"), "范围 100..599");
            }
        }
    }

    fn check_fields(&mut self, at: &str, fs: &mut [Field], depth: usize) {
        if depth > MAX_DEPTH {
            self.err(at, format!("嵌套不能超过 {MAX_DEPTH} 层"));
            return;
        }
        self.fields += fs.len();
        if self.fields > MAX_FIELDS {
            self.err(at, format!("一个请求体/响应最多 {MAX_FIELDS} 个字段"));
            return;
        }
        let mut names: Vec<String> = vec![];
        for (i, f) in fs.iter_mut().enumerate() {
            let fa = format!("{at}[{i}]");
            self.text(&format!("{fa}.name"), &mut f.name, 1, 100, true);
            self.text(&format!("{fa}.type"), &mut f.ty, 1, 50, true);
            self.text(&format!("{fa}.description"), &mut f.description, 0, 2000, false);
            if let Some(x) = &f.example {
                self.json_size(&format!("{fa}.example"), x, 8 * 1024);
            }
            self.enums(&format!("{fa}.enum"), &f.enums);
            if names.contains(&f.name) {
                self.err(&format!("{fa}.name"), "同级字段名重复");
            }
            names.push(f.name.clone());
            self.check_fields(&format!("{fa}.fields"), &mut f.fields, depth + 1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal() -> Value {
        serde_json::json!({
            "title": " 支付 API ",
            "servers": [{ "name": "测试", "url": "https://sandbox.example.com/v1/" }],
            "groups": [{ "name": "订单", "endpoints": [{
                "method": "get", "path": "/orders/{id}", "title": "查单",
                "params": [{ "name": "id", "in": "path", "example": "o_1" }],
                "responses": [{ "status": 200, "example": { "ok": true } }],
                "errors": [{ "code": 1001, "description": "不存在" }]
            }] }]
        })
    }

    #[test]
    fn normalizes_minimal_doc() {
        let c = validate(&minimal().to_string()).unwrap();
        assert_eq!(c.endpoints, 1);
        let v: Value = serde_json::from_str(&c.json).unwrap();
        assert_eq!(v["title"], "支付 API");
        assert_eq!(v["servers"][0]["url"], "https://sandbox.example.com/v1");
        let e = &v["groups"][0]["endpoints"][0];
        assert_eq!(e["method"], "GET");
        assert_eq!(e["params"][0]["required"], true);
        assert_eq!(e["params"][0]["type"], "string");
        assert_eq!(e["responses"][0]["status"], "200");
        assert_eq!(e["errors"][0]["code"], "1001");
        assert!(e.get("auth").is_none(), "默认值不序列化");
    }

    #[test]
    fn example_key_order_kept() {
        let src = r#"{"title":"t","servers":[{"name":"a","url":"https://a.com"}],"groups":[{"name":"g","endpoints":[
            {"method":"POST","path":"/p","title":"p","body":{"example":{"zeta":1,"alpha":{"y":2,"b":3}}}}]}]}"#;
        let c = validate(src).unwrap();
        assert!(c.json.contains(r#""example":{"zeta":1,"alpha":{"y":2,"b":3}}"#), "{}", c.json);
    }

    #[test]
    fn reports_each_problem() {
        let mut v = minimal();
        v["servers"][0]["url"] = "ftp://x".into();
        let e = &mut v["groups"][0]["endpoints"][0];
        e["method"] = "FETCH".into();
        e["path"] = "/orders/{id}/{line}".into();
        e["body"] = serde_json::json!({ "fields": [{ "name": "a" }, { "name": "a" }] });
        let errs = validate(&v.to_string()).unwrap_err();
        let joined = errs.join("\n");
        for want in ["servers[0].url", ".method", "{line} 没有对应", "同级字段名重复"] {
            assert!(joined.contains(want), "缺少 {want}: {joined}");
        }
        let mut v = minimal();
        v["groups"][0]["endpoints"][0]["body"] = serde_json::json!({ "example": {} });
        assert!(validate(&v.to_string()).unwrap_err()[0].contains("GET/HEAD 不能有请求体"));
    }

    #[test]
    fn unknown_field_and_limits() {
        let mut v = minimal();
        v["typo"] = 1.into();
        assert!(validate(&v.to_string()).unwrap_err()[0].contains("unknown field"));
        let mut v = minimal();
        let ep = v["groups"][0]["endpoints"][0].clone();
        v["groups"][0]["endpoints"] = Value::Array(vec![ep; MAX_ENDPOINTS + 1]);
        assert!(validate(&v.to_string()).unwrap_err()[0].contains("接口总数"));
        let mut v = minimal();
        let mut f = serde_json::json!({ "name": "x" });
        for _ in 0..MAX_DEPTH {
            f = serde_json::json!({ "name": "x", "type": "object", "fields": [f] });
        }
        v["groups"][0]["endpoints"][0]["method"] = "POST".into();
        v["groups"][0]["endpoints"][0]["body"] = serde_json::json!({ "fields": [f] });
        assert!(validate(&v.to_string()).unwrap_err().join("").contains("嵌套不能超过"));
        let mut v = minimal();
        v["title"] = "x".repeat(201).into();
        assert!(validate(&v.to_string()).unwrap_err()[0].starts_with("title:"));
    }
}
