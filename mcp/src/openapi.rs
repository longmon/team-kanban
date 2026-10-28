//! OpenAPI 3.x / Swagger 2.0（JSON）→ 接口文档内部结构（docs/api.md §7.5）。
//! 只取文档展示需要的子集；转换不了的地方（cookie 参数、外部 $ref、相对 server 地址等）记入 warnings。

use serde_json::Value;

use crate::apidoc::{ApiDoc, Auth, AuthType, Body, Endpoint, ErrCode, Example, Field, Group, Param, ParamIn, Resp, ServerEnv, example as to_example};

const PLACEHOLDER_HOST: &str = "https://api.example.com";
const METHODS: [&str; 7] = ["get", "post", "put", "patch", "delete", "head", "options"];
const MAX_DEPTH: usize = 6;

/// 带 openapi / swagger 顶层字段的 JSON 视为 OpenAPI
pub fn is_openapi(v: &Value) -> bool {
    v.get("openapi").is_some() || v.get("swagger").is_some()
}

/// 文本 → JSON；YAML 明确拒绝（不引入 YAML 依赖）
pub fn parse_text(text: &str) -> Result<Value, String> {
    let t = text.trim_start_matches('\u{feff}').trim_start();
    if !t.starts_with('{') {
        return Err("openapi_unsupported: 只支持 JSON 格式；YAML 请先转成 JSON（如 `yq -o=json api.yaml > api.json`）再传入".into());
    }
    serde_json::from_str(t).map_err(|e| format!("invalid_json: 第 {} 行第 {} 列：{e}", e.line(), e.column()))
}

struct Conv<'a> {
    root: &'a Value,
    v2: bool,
    warnings: Vec<String>,
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

fn cut(t: &str, max: usize) -> String {
    t.chars().take(max).collect()
}

pub fn convert(v: &Value) -> Result<(ApiDoc, Vec<String>), String> {
    let v2 = v.get("swagger").and_then(Value::as_str).is_some_and(|x| x.starts_with("2."));
    if !v2 && !v.get("openapi").and_then(Value::as_str).is_some_and(|x| x.starts_with("3.")) {
        return Err("openapi_unsupported: 只支持 OpenAPI 3.x 与 Swagger 2.0".into());
    }
    let mut c = Conv { root: v, v2, warnings: vec![] };
    let info = v.get("info").cloned().unwrap_or_default();
    let mut doc = ApiDoc {
        title: Some(s(&info, "title")).filter(|t| !t.is_empty()).unwrap_or_else(|| "接口文档".into()),
        description: s(&info, "description"),
        version: cut(&s(&info, "version"), 50),
        servers: c.servers(),
        auth: c.auth(),
        groups: vec![],
    };
    // 分组：先按顶层 tags 的顺序，再按出现顺序；没有 tag 的归「其他」
    for t in v.get("tags").and_then(Value::as_array).into_iter().flatten() {
        doc.groups.push(Group { name: s(t, "name"), description: s(t, "description"), endpoints: vec![] });
    }
    let global_auth = v.get("security").and_then(Value::as_array).is_none_or(|a| !a.is_empty());
    for (path, item) in v.get("paths").and_then(Value::as_object).into_iter().flatten() {
        let item = c.resolve(item);
        for m in METHODS {
            let Some(op) = item.get(m) else { continue };
            let ep = c.endpoint(m, path, item, op, global_auth);
            let tag = op.get("tags").and_then(|t| t.get(0)).and_then(Value::as_str).unwrap_or("其他").trim().to_string();
            match doc.groups.iter_mut().find(|g| g.name == tag) {
                Some(g) => g.endpoints.push(ep),
                None => doc.groups.push(Group { name: tag, description: String::new(), endpoints: vec![ep] }),
            }
        }
    }
    doc.groups.retain(|g| !g.endpoints.is_empty());
    Ok((doc, c.warnings))
}

impl<'a> Conv<'a> {
    /// 跟随本文档内的 $ref（#/...），外部引用原样返回并告警
    fn resolve(&mut self, mut v: &'a Value) -> &'a Value {
        for _ in 0..20 {
            let Some(r) = v.get("$ref").and_then(Value::as_str) else { return v };
            match r.strip_prefix('#').and_then(|p| self.root.pointer(p)) {
                Some(t) => v = t,
                None => {
                    self.warn(format!("无法解析的 $ref：{r}（只支持本文档内的 #/ 引用）"));
                    return v;
                }
            }
        }
        v
    }

    fn warn(&mut self, w: String) {
        if !self.warnings.contains(&w) && self.warnings.len() < 30 {
            self.warnings.push(w);
        }
    }

    fn servers(&mut self) -> Vec<ServerEnv> {
        let mut out = vec![];
        if self.v2 {
            let host = s(self.root, "host");
            let base = s(self.root, "basePath");
            let schemes: Vec<&str> = self.root.get("schemes").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
            let scheme = if schemes.is_empty() || schemes.contains(&"https") { "https" } else { schemes[0] };
            if host.is_empty() {
                self.warn(format!("Swagger 没有 host，环境地址用占位 {PLACEHOLDER_HOST}，请改成真实地址"));
                out.push(ServerEnv { name: "默认".into(), url: format!("{PLACEHOLDER_HOST}{base}") });
            } else {
                out.push(ServerEnv { name: "默认".into(), url: format!("{scheme}://{host}{base}") });
            }
            return out;
        }
        for (i, sv) in self.root.get("servers").and_then(Value::as_array).into_iter().flatten().enumerate().take(10) {
            let mut url = s(sv, "url");
            // 变量取默认值
            for (k, var) in sv.get("variables").and_then(Value::as_object).into_iter().flatten() {
                url = url.replace(&format!("{{{k}}}"), &s(var, "default"));
            }
            if url.starts_with('/') || url.is_empty() {
                self.warn(format!("server 地址「{url}」是相对路径，已补成 {PLACEHOLDER_HOST}{url}，请改成真实地址"));
                url = format!("{PLACEHOLDER_HOST}{url}");
            }
            let mut name = cut(&s(sv, "description"), 50);
            if name.is_empty() || out.iter().any(|o: &ServerEnv| o.name == name) {
                name = format!("环境 {}", i + 1);
            }
            out.push(ServerEnv { name, url });
        }
        if out.is_empty() {
            self.warn(format!("没有 servers，环境地址用占位 {PLACEHOLDER_HOST}，请改成真实地址"));
            out.push(ServerEnv { name: "默认".into(), url: PLACEHOLDER_HOST.into() });
        }
        out
    }

    fn auth(&mut self) -> Option<Auth> {
        let schemes = if self.v2 { self.root.get("securityDefinitions") } else { self.root.pointer("/components/securitySchemes") }?.as_object()?;
        // 优先全局 security 里用到的第一个
        let used = self.root.pointer("/security/0").and_then(Value::as_object).and_then(|o| o.keys().next().cloned());
        let (key, sc) = match used.as_ref().and_then(|k| schemes.get_key_value(k)) {
            Some(x) => x,
            None => schemes.iter().next()?,
        };
        let sc = self.resolve(sc);
        let desc = s(sc, "description");
        let ty = s(sc, "type");
        let scheme = s(sc, "scheme").to_ascii_lowercase();
        let a = |kind, name: &str, value: &str| Some(Auth { kind, name: name.into(), value: value.into(), description: desc.clone() });
        if schemes.len() > 1 {
            self.warn(format!("定义了多种鉴权方式，只展示「{key}」"));
        }
        match (ty.as_str(), s(sc, "in").as_str()) {
            ("apiKey", "header") => a(AuthType::Header, &s(sc, "name"), "{{API_KEY}}"),
            ("apiKey", "query") => a(AuthType::Query, &s(sc, "name"), "{{API_KEY}}"),
            ("apiKey", "cookie") => a(AuthType::Header, "Cookie", &format!("{}={{{{API_KEY}}}}", s(sc, "name"))),
            ("http", _) if scheme == "basic" => a(AuthType::Header, "Authorization", "Basic {{BASE64_USER_PASS}}"),
            ("basic", _) => a(AuthType::Header, "Authorization", "Basic {{BASE64_USER_PASS}}"),
            ("http", _) if scheme == "bearer" => a(AuthType::Bearer, "", "{{TOKEN}}"),
            ("oauth2" | "openIdConnect", _) => a(AuthType::Bearer, "", "{{ACCESS_TOKEN}}"),
            _ => {
                self.warn(format!("不支持的鉴权方式「{key}」（type={ty}），已忽略"));
                None
            }
        }
    }

    fn endpoint(&mut self, method: &str, path: &str, item: &'a Value, op: &'a Value, global_auth: bool) -> Endpoint {
        let summary = s(op, "summary");
        let title = if !summary.is_empty() { summary } else if !s(op, "operationId").is_empty() { s(op, "operationId") } else { format!("{} {path}", method.to_uppercase()) };
        let mut ep = Endpoint {
            method: method.to_uppercase(),
            path: path.to_string(),
            title: cut(&title, 200),
            description: s(op, "description"),
            auth: op.get("security").and_then(Value::as_array).map_or(global_auth, |a| !a.is_empty()),
            deprecated: op.get("deprecated") == Some(&Value::Bool(true)),
            ..Default::default()
        };
        // 参数：path 级 + operation 级（同名同位置以 operation 为准）
        let mut raw: Vec<&Value> = vec![];
        for list in [item.get("parameters"), op.get("parameters")] {
            for p in list.and_then(Value::as_array).into_iter().flatten() {
                let p = self.resolve(p);
                raw.retain(|q| !(s(q, "name") == s(p, "name") && s(q, "in") == s(p, "in")));
                raw.push(p);
            }
        }
        let mut form = vec![];
        let mut has_file = false;
        for p in raw {
            let loc = match s(p, "in").as_str() {
                "path" => ParamIn::Path,
                "query" => ParamIn::Query,
                "header" => ParamIn::Header,
                "body" => {
                    let schema = p.get("schema").unwrap_or(&Value::Null);
                    let ct = self.v2_type(op, "consumes");
                    ep.body = Some(Body { content_type: ct, fields: self.fields(schema, 1, &mut vec![]), example: self.example(schema).as_ref().and_then(to_example) });
                    continue;
                }
                "formData" => {
                    has_file |= s(p, "type") == "file";
                    form.push(self.field(&s(p, "name"), p, p.get("required") == Some(&Value::Bool(true)), 1, &mut vec![]));
                    continue;
                }
                other => {
                    self.warn(format!("{} {path}：不支持 in={other} 参数「{}」，已忽略", method.to_uppercase(), s(p, "name")));
                    continue;
                }
            };
            let schema = if self.v2 { p } else { self.resolve(p.get("schema").unwrap_or(&Value::Null)) };
            ep.params.push(Param {
                name: s(p, "name"),
                location: loc,
                ty: self.type_of(schema),
                required: loc == ParamIn::Path || p.get("required") == Some(&Value::Bool(true)),
                description: s(p, "description"),
                example: self.param_example(p, schema).as_ref().and_then(to_example),
                enums: schema.get("enum").and_then(Value::as_array).cloned().unwrap_or_default(),
            });
        }
        if !form.is_empty() {
            let ct = if has_file { "multipart/form-data" } else { "application/x-www-form-urlencoded" };
            ep.body = Some(Body { content_type: ct.into(), fields: form, example: None });
        }
        // path 里出现但没声明的参数补上（内部结构要求一一对应）
        let mut rest = path;
        while let Some(i) = rest.find('{') {
            let Some(j) = rest[i..].find('}') else { break };
            let name = &rest[i + 1..i + j];
            if !ep.params.iter().any(|p| p.location == ParamIn::Path && p.name == name) {
                ep.params.push(Param { name: name.into(), location: ParamIn::Path, ty: "string".into(), required: true, description: String::new(), example: None, enums: vec![] });
            }
            rest = &rest[i + j + 1..];
        }
        ep.params.retain(|p| p.location != ParamIn::Path || path.contains(&format!("{{{}}}", p.name)));
        if !self.v2 && let Some(rb) = op.get("requestBody") {
            let rb = self.resolve(rb);
            if let Some((ct, media)) = pick_media(rb) {
                let schema = media.get("schema").unwrap_or(&Value::Null);
                let example = self.media_example(media).or_else(|| self.example(schema));
                ep.body = Some(Body { content_type: ct, fields: self.fields(schema, 1, &mut vec![]), example: example.as_ref().and_then(to_example) });
            }
        }
        for (status, r) in op.get("responses").and_then(Value::as_object).into_iter().flatten() {
            let r = self.resolve(r);
            let (fields, example) = if self.v2 {
                let schema = r.get("schema").unwrap_or(&Value::Null);
                let ex = r.pointer("/examples/application~1json").cloned().or_else(|| self.example(schema));
                (self.fields(schema, 1, &mut vec![]), ex)
            } else {
                match pick_media(r) {
                    Some((_, media)) => {
                        let schema = media.get("schema").unwrap_or(&Value::Null);
                        let ex = self.media_example(media).or_else(|| self.example(schema));
                        (self.fields(schema, 1, &mut vec![]), ex)
                    }
                    None => (vec![], None),
                }
            };
            let example: Option<Example> = example.as_ref().and_then(to_example);
            ep.responses.push(Resp { status: status.clone(), description: s(r, "description"), fields, example });
        }
        // 扩展：x-error-codes: [{code, description|message, http_status|status}]
        for e in op.get("x-error-codes").and_then(Value::as_array).into_iter().flatten() {
            let code = match e.get("code") {
                Some(Value::String(x)) => x.clone(),
                Some(Value::Number(n)) => n.to_string(),
                _ => continue,
            };
            let desc = Some(s(e, "description")).filter(|d| !d.is_empty()).unwrap_or_else(|| s(e, "message"));
            let http = e.get("http_status").or_else(|| e.get("status")).and_then(Value::as_u64).and_then(|n| u16::try_from(n).ok());
            ep.errors.push(ErrCode { code, description: desc, http_status: http });
        }
        ep
    }

    /// Swagger 2.0 的 consumes：operation 优先，其次全局，缺省 JSON
    fn v2_type(&self, op: &Value, key: &str) -> String {
        op.pointer(&format!("/{key}/0"))
            .or_else(|| self.root.pointer(&format!("/{key}/0")))
            .and_then(Value::as_str)
            .unwrap_or("application/json")
            .to_string()
    }

    fn param_example(&mut self, p: &'a Value, schema: &'a Value) -> Option<Value> {
        let scalar = |v: &Value| (!v.is_object() && !v.is_array() && !v.is_null()).then(|| v.clone());
        p.get("example")
            .or_else(|| p.get("x-example"))
            .and_then(scalar)
            .or_else(|| p.get("examples").and_then(Value::as_object).and_then(|m| m.values().next()).and_then(|e| e.get("value")).and_then(scalar))
            .or_else(|| self.example(schema).as_ref().and_then(scalar))
    }

    fn media_example(&mut self, media: &'a Value) -> Option<Value> {
        media.get("example").cloned().or_else(|| {
            let first = media.get("examples")?.as_object()?.values().next()?;
            self.resolve(first).get("value").cloned()
        })
    }

    /// schema 自带的示例：example → default → examples[0] → enum[0]
    fn example(&mut self, schema: &'a Value) -> Option<Value> {
        let sc = self.resolve(schema);
        sc.get("example")
            .or_else(|| sc.get("default"))
            .or_else(|| sc.pointer("/examples/0"))
            .or_else(|| sc.pointer("/enum/0"))
            .cloned()
    }

    /// 字段类型：string / integer(int64) / array<string> / object …
    fn type_of(&mut self, schema: &'a Value) -> String {
        let sc = self.resolve(schema);
        let mut t = match sc.get("type") {
            Some(Value::String(t)) => t.clone(),
            // 3.1：["string", "null"]
            Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).find(|t| *t != "null").unwrap_or("string").to_string(),
            _ if sc.get("properties").is_some() || sc.get("allOf").is_some() => "object".into(),
            _ if sc.get("oneOf").is_some() || sc.get("anyOf").is_some() => "object".into(),
            _ => "string".into(),
        };
        if t == "array" {
            let items = sc.get("items").unwrap_or(&Value::Null);
            t = format!("array<{}>", self.type_of(items));
        } else if let Some(f) = sc.get("format").and_then(Value::as_str) {
            t = format!("{t}({f})");
        }
        cut(&t, 50)
    }

    /// object 的 properties（含 allOf 合并）→ 字段表；array 取 items；oneOf/anyOf 取第一种
    fn fields(&mut self, schema: &'a Value, depth: usize, seen: &mut Vec<String>) -> Vec<Field> {
        if depth > MAX_DEPTH {
            return vec![];
        }
        let r = schema.get("$ref").and_then(Value::as_str).map(str::to_string);
        if let Some(r) = &r {
            if seen.contains(r) {
                return vec![];
            }
            seen.push(r.clone());
        }
        let sc = self.resolve(schema);
        let out = if let Some(items) = sc.get("items").filter(|_| sc.get("properties").is_none()) {
            self.fields(items, depth, seen)
        } else if let Some(first) = sc.get("oneOf").or_else(|| sc.get("anyOf")).and_then(|a| a.get(0)) {
            self.fields(first, depth, seen)
        } else {
            let mut props: Vec<(&'a String, &'a Value)> = vec![];
            let mut required: Vec<&'a str> = vec![];
            let mut parts = vec![sc];
            for p in sc.get("allOf").and_then(Value::as_array).into_iter().flatten() {
                parts.push(self.resolve(p));
            }
            for part in parts {
                required.extend(part.get("required").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str));
                for (k, v) in part.get("properties").and_then(Value::as_object).into_iter().flatten() {
                    props.retain(|(n, _)| *n != k);
                    props.push((k, v));
                }
            }
            props.into_iter().map(|(k, v)| self.field(k, v, required.contains(&k.as_str()), depth, seen)).collect()
        };
        if r.is_some() {
            seen.pop();
        }
        out
    }

    fn field(&mut self, name: &str, prop: &'a Value, required: bool, depth: usize, seen: &mut Vec<String>) -> Field {
        let sc = self.resolve(prop);
        let ty = self.type_of(prop);
        let nested = ty == "object" || ty.starts_with("array<object");
        let mut description = s(sc, "description");
        if sc.get("oneOf").is_some() || sc.get("anyOf").is_some() {
            description = format!("{description}（多种结构之一，下列为第一种）").trim_start().to_string();
        }
        Field {
            name: cut(name, 100),
            ty,
            required,
            description,
            example: self.example(prop).filter(|e| !e.is_object() && !e.is_array() || !nested).as_ref().and_then(to_example),
            enums: sc.get("enum").and_then(Value::as_array).cloned().unwrap_or_default(),
            fields: if nested { self.fields(prop, depth + 1, seen) } else { vec![] },
        }
    }
}

/// content 里优先取 JSON，其次第一个
fn pick_media(v: &Value) -> Option<(String, &Value)> {
    let content = v.get("content")?.as_object()?;
    content.iter().find(|(k, _)| k.contains("json")).or_else(|| content.iter().next()).map(|(k, m)| (k.clone(), m))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn openapi3_to_api_doc() {
        let spec = json!({
            "openapi": "3.0.3",
            "info": { "title": "支付", "version": "1.2" },
            "servers": [{ "url": "https://{env}.pay.example.com/v1", "description": "测试", "variables": { "env": { "default": "sandbox" } } }, { "url": "/v1" }],
            "security": [{ "key": [] }],
            "components": {
                "securitySchemes": { "key": { "type": "apiKey", "in": "header", "name": "X-Api-Key" } },
                "schemas": {
                    "Money": { "type": "object", "required": ["amount"], "properties": { "amount": { "type": "integer", "format": "int64", "example": 100 }, "currency": { "type": "string", "enum": ["CNY", "USD"] } } },
                    "Order": { "allOf": [{ "$ref": "#/components/schemas/Money" }, { "properties": { "id": { "type": "string" }, "children": { "type": "array", "items": { "$ref": "#/components/schemas/Order" } } } }] }
                },
                "parameters": { "Trace": { "name": "X-Trace", "in": "header", "schema": { "type": "string" }, "example": "t-1" } }
            },
            "tags": [{ "name": "订单", "description": "下单与查单" }],
            "paths": {
                "/orders/{id}": {
                    "parameters": [{ "$ref": "#/components/parameters/Trace" }],
                    "get": { "tags": ["订单"], "summary": "查单", "parameters": [{ "name": "id", "in": "path", "schema": { "type": "string" } }, { "name": "sid", "in": "cookie" }],
                             "responses": { "200": { "description": "ok", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Order" } } } } },
                             "x-error-codes": [{ "code": 40401, "message": "订单不存在", "status": 404 }] }
                },
                "/health": { "get": { "security": [], "responses": { "204": { "description": "ok" } } } }
            }
        });
        let (mut doc, warnings) = convert(&spec).unwrap();
        assert_eq!(doc.servers[0].url, "https://sandbox.pay.example.com/v1");
        assert_eq!(doc.servers[1].url, "https://api.example.com/v1");
        assert_eq!(doc.auth.as_ref().unwrap().name, "X-Api-Key");
        assert_eq!(doc.groups.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(), ["订单", "其他"]);
        let ep = &doc.groups[0].endpoints[0];
        assert_eq!((ep.method.as_str(), ep.title.as_str(), ep.params.len()), ("GET", "查单", 2));
        let r = &ep.responses[0];
        assert_eq!(r.fields.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["amount", "currency", "id", "children"]);
        assert_eq!((r.fields[0].ty.as_str(), r.fields[0].required), ("integer(int64)", true));
        assert_eq!(r.fields[3].ty, "array<object>");
        assert!(r.fields[3].fields.is_empty(), "循环引用截断");
        assert_eq!((ep.errors[0].code.as_str(), ep.errors[0].http_status), ("40401", Some(404)));
        assert!(!doc.groups[1].endpoints[0].auth);
        assert!(warnings.iter().any(|w| w.contains("cookie")) && warnings.iter().any(|w| w.contains("相对路径")));
        crate::apidoc::finish(&mut doc).unwrap();
    }

    #[test]
    fn swagger2_body_and_form() {
        let spec = json!({
            "swagger": "2.0", "info": { "title": "旧接口" }, "host": "api.old.com", "basePath": "/api", "schemes": ["http"],
            "securityDefinitions": { "t": { "type": "oauth2" } },
            "paths": {
                "/pay": { "post": { "parameters": [{ "in": "body", "name": "b", "schema": { "type": "object", "properties": { "n": { "type": "string" } } } }], "responses": {} } },
                "/upload/{id}": { "post": { "consumes": ["multipart/form-data"], "parameters": [{ "in": "formData", "name": "f", "type": "file", "required": true }], "responses": {} } }
            }
        });
        let (mut doc, _) = convert(&spec).unwrap();
        assert_eq!(doc.servers[0].url, "http://api.old.com/api");
        assert_eq!(doc.auth.as_ref().unwrap().kind, AuthType::Bearer);
        let eps = &doc.groups[0].endpoints;
        assert_eq!(eps[0].body.as_ref().unwrap().fields[0].name, "n");
        assert_eq!(eps[1].body.as_ref().unwrap().content_type, "multipart/form-data");
        assert_eq!(eps[1].params[0].name, "id", "path 里未声明的参数自动补上");
        crate::apidoc::finish(&mut doc).unwrap();
    }

    #[test]
    fn yaml_and_unknown_versions_rejected() {
        assert!(parse_text("openapi: 3.0.0\n").unwrap_err().starts_with("openapi_unsupported"));
        assert!(convert(&json!({ "swagger": "1.2" })).unwrap_err().starts_with("openapi_unsupported"));
        assert!(parse_text("{ bad").unwrap_err().starts_with("invalid_json"));
    }
}
