//! 小工具：随机 token、摘要、HMAC、时间格式、密码、分页、字段校验
use argon2::{
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
    password_hash::SaltString,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use chrono::{DateTime, SecondsFormat, Utc};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

pub fn new_id() -> Uuid {
    Uuid::now_v7()
}

/// 32 字节随机，base64url 无填充（43 字符）
pub fn random_token() -> String {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("OS RNG");
    B64.encode(b)
}

pub fn sha256(s: &str) -> Vec<u8> {
    Sha256::digest(s.as_bytes()).to_vec()
}

pub fn sha256_hex(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

pub fn b64(b: &[u8]) -> String {
    B64.encode(b)
}

pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    B64.decode(s).ok()
}

pub fn hmac_sign(key: &[u8], msg: &str) -> String {
    let mut m = Hmac::<Sha256>::new_from_slice(key).expect("hmac key");
    m.update(msg.as_bytes());
    B64.encode(m.finalize().into_bytes())
}

/// 常数时间校验
pub fn hmac_verify(key: &[u8], msg: &str, sig_b64: &str) -> bool {
    let Some(sig) = b64_decode(sig_b64) else { return false };
    let mut m = Hmac::<Sha256>::new_from_slice(key).expect("hmac key");
    m.update(msg.as_bytes());
    m.verify_slice(&sig).is_ok()
}

pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn ts(t: &DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn ts_opt(t: &Option<DateTime<Utc>>) -> Option<String> {
    t.as_ref().map(ts)
}

// ---------------------------------------------------------------- 密码

pub async fn hash_password(pw: String) -> AppResult<String> {
    tokio::task::spawn_blocking(move || {
        let mut salt = [0u8; 16];
        getrandom::fill(&mut salt).expect("OS RNG");
        let salt = SaltString::encode_b64(&salt).map_err(AppError::internal)?;
        Argon2::default().hash_password(pw.as_bytes(), &salt).map(|h| h.to_string()).map_err(AppError::internal)
    })
    .await
    .map_err(AppError::internal)?
}

/// hash 为 None 时校验一个假哈希抹平时延，恒返回 false
pub async fn verify_password(pw: String, hash: Option<String>) -> bool {
    static DUMMY: OnceLock<String> = OnceLock::new();
    let real = hash.is_some();
    let hash = hash.unwrap_or_else(|| {
        DUMMY
            .get_or_init(|| {
                let salt = SaltString::encode_b64(b"relay-dummy-salt").unwrap();
                Argon2::default().hash_password(b"dummy-password", &salt).unwrap().to_string()
            })
            .clone()
    });
    tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash).is_ok_and(|h| Argon2::default().verify_password(pw.as_bytes(), &h).is_ok())
    })
    .await
    .unwrap_or(false)
        && real
}

// ---------------------------------------------------------------- 校验

pub fn chars(s: &str) -> usize {
    s.chars().count()
}

/// trim 后长度在 [min, max] 字符内
pub fn text_field(name: &str, v: &str, min: usize, max: usize) -> AppResult<String> {
    let t = v.trim();
    let n = chars(t);
    if n < min || n > max {
        return Err(AppError::field(name, &format!("长度需在 {min}..{max} 字符")));
    }
    Ok(t.to_string())
}

pub fn slug_field(v: &str) -> AppResult<String> {
    let ok = !v.is_empty()
        && v.len() <= 40
        && v.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !v.starts_with('-')
        && !v.ends_with('-')
        && !v.contains("--");
    if ok { Ok(v.to_string()) } else { Err(AppError::field("slug", "只能是小写字母、数字和单个连字符，1..40 字符")) }
}

pub fn email_field(v: &str) -> AppResult<String> {
    let e = v.trim().to_lowercase();
    let n = chars(&e);
    let ok = (3..=254).contains(&n) && e.split_once('@').is_some_and(|(a, b)| !a.is_empty() && !b.is_empty()) && !e.contains(char::is_whitespace);
    if ok { Ok(e) } else { Err(AppError::field("email", "邮箱格式不正确")) }
}

pub fn password_field(name: &str, v: &str) -> AppResult<()> {
    let n = chars(v);
    if (10..=128).contains(&n) { Ok(()) } else { Err(AppError::field(name, "密码长度需在 10..128 字符")) }
}

/// 匿名昵称：去控制字符、trim、1..50
pub fn nickname(v: Option<&str>) -> Option<String> {
    let s: String = v?.chars().filter(|c| !c.is_control()).collect();
    let s = s.trim();
    (1..=50).contains(&chars(s)).then(|| s.to_string())
}

/// 路径中非法 UUID → 404
pub fn parse_uuid(s: &str) -> AppResult<Uuid> {
    Uuid::parse_str(s).map_err(|_| AppError::not_found())
}

// ---------------------------------------------------------------- 分页

#[derive(Deserialize, Default)]
pub struct PageQuery {
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

impl PageQuery {
    pub fn limit(&self) -> i64 {
        self.limit.unwrap_or(50).clamp(1, 200)
    }
    /// id 游标
    pub fn cursor_id(&self) -> AppResult<Option<Uuid>> {
        self.cursor
            .as_deref()
            .filter(|c| !c.is_empty())
            .map(|c| Uuid::parse_str(c).map_err(|_| AppError::field("cursor", "无效游标")))
            .transpose()
    }
    /// (加入时间, user_id) 游标，编码为 `{微秒}_{uuid}`
    pub fn cursor_time(&self) -> AppResult<Option<(DateTime<Utc>, Uuid)>> {
        let Some(c) = self.cursor.as_deref().filter(|c| !c.is_empty()) else { return Ok(None) };
        let bad = || AppError::field("cursor", "无效游标");
        let (t, id) = c.split_once('_').ok_or_else(bad)?;
        let t = DateTime::from_timestamp_micros(t.parse().map_err(|_| bad())?).ok_or_else(bad)?;
        Ok(Some((t, Uuid::parse_str(id).map_err(|_| bad())?)))
    }
}

pub fn time_cursor(t: &DateTime<Utc>, id: &Uuid) -> String {
    format!("{}_{}", t.timestamp_micros(), id)
}

/// 多取一条判断是否还有下一页：rows 截到 limit 并返回 next_cursor
pub fn paginate<T>(mut rows: Vec<T>, limit: i64, cursor_of: impl Fn(&T) -> String) -> (Vec<T>, Option<String>) {
    if rows.len() as i64 > limit {
        rows.truncate(limit as usize);
        let next = rows.last().map(cursor_of);
        (rows, next)
    } else {
        (rows, None)
    }
}

/// LIKE 前缀匹配转义
pub fn like_prefix(q: &str) -> String {
    let mut s = String::with_capacity(q.len() + 1);
    for c in q.chars() {
        if matches!(c, '%' | '_' | '\\') {
            s.push('\\');
        }
        s.push(c);
    }
    s.push('%');
    s
}
