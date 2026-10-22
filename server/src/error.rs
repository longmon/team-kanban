use axum::{
    Json,
    extract::{FromRequest, Request, rejection::JsonRejection},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub details: Option<Value>,
    pub retry_after: Option<u64>,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into(), details: None, retry_after: None }
    }
    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", "资源不存在")
    }
    pub fn forbidden() -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", "无权执行此操作")
    }
    pub fn unauthenticated() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthenticated", "需要登录")
    }
    pub fn csrf() -> Self {
        Self::new(StatusCode::FORBIDDEN, "csrf_failed", "CSRF 校验失败")
    }
    pub fn conflict(code: &'static str, message: &str) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }
    pub fn gone(code: &'static str, message: &str) -> Self {
        Self::new(StatusCode::GONE, code, message)
    }
    pub fn rate_limited(retry_after: u64) -> Self {
        let mut e = Self::new(StatusCode::TOO_MANY_REQUESTS, "rate_limited", "请求过于频繁，请稍后再试");
        e.retry_after = Some(retry_after.max(1));
        e
    }
    /// 单字段校验失败
    pub fn field(name: &str, reason: &str) -> Self {
        let mut e = Self::new(StatusCode::BAD_REQUEST, "validation_failed", format!("{name}: {reason}"));
        e.details = Some(json!({ "fields": { name: reason } }));
        e
    }
    pub fn internal(err: impl std::fmt::Display) -> Self {
        tracing::error!("internal error: {err}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", "服务器内部错误")
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        Self::internal(e)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = json!({ "error": { "code": self.code, "message": self.message, "details": self.details } });
        let mut res = (self.status, Json(body)).into_response();
        if let Some(s) = self.retry_after {
            res.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from(s));
        }
        res
    }
}

/// 唯一约束冲突时返回约束名，便于映射成 409
pub fn unique_violation(e: &sqlx::Error) -> Option<&str> {
    match e {
        sqlx::Error::Database(d) if d.code().as_deref() == Some("23505") => d.constraint(),
        _ => None,
    }
}

/// 外键冲突时返回约束名
pub fn fk_violation(e: &sqlx::Error) -> Option<&str> {
    match e {
        sqlx::Error::Database(d) if d.code().as_deref() == Some("23503") => d.constraint(),
        _ => None,
    }
}

/// 替代 axum::Json：把拒绝原因映射成契约里的错误码
pub struct JsonBody<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for JsonBody<T> {
    type Rejection = AppError;
    async fn from_request(req: Request, state: &S) -> Result<Self, AppError> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(v)) => Ok(Self(v)),
            Err(r) => Err(match r {
                JsonRejection::MissingJsonContentType(_) => {
                    AppError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type", "请求体必须是 application/json")
                }
                JsonRejection::JsonSyntaxError(_) => AppError::new(StatusCode::BAD_REQUEST, "invalid_json", "请求体不是合法 JSON"),
                JsonRejection::JsonDataError(e) => {
                    let mut err = AppError::new(StatusCode::BAD_REQUEST, "validation_failed", e.body_text());
                    err.details = Some(json!({ "fields": { "body": e.body_text() } }));
                    err
                }
                r if r.status() == StatusCode::PAYLOAD_TOO_LARGE => {
                    AppError::new(StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large", "请求体过大")
                }
                r => AppError::new(StatusCode::BAD_REQUEST, "invalid_json", r.body_text()),
            }),
        }
    }
}

/// 替代 axum::extract::Path：非法 UUID 等路径错误一律 404
pub struct P<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned + Send> axum::extract::FromRequestParts<S> for P<T> {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut axum::http::request::Parts, state: &S) -> Result<Self, AppError> {
        axum::extract::Path::<T>::from_request_parts(parts, state)
            .await
            .map(|p| Self(p.0))
            .map_err(|_| AppError::not_found())
    }
}

/// 替代 axum::extract::Query：解析失败 → 400 validation_failed
pub struct Q<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> axum::extract::FromRequestParts<S> for Q<T> {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut axum::http::request::Parts, state: &S) -> Result<Self, AppError> {
        axum::extract::Query::<T>::from_request_parts(parts, state)
            .await
            .map(|q| Self(q.0))
            .map_err(|e| AppError::field("query", &e.body_text()))
    }
}
