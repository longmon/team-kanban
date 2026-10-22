//! 进程内固定窗口计数。ponytail: 单实例；多实例时换 PG/Redis（design §9）
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use crate::error::{AppError, AppResult};

#[derive(Default)]
pub struct RateLimiter {
    map: Mutex<HashMap<String, (Instant, Duration, u32)>>,
}

impl RateLimiter {
    /// 计一次；超过 limit 返回 429（带 Retry-After）
    pub fn hit(&self, key: &str, limit: u32, window: Duration) -> AppResult<()> {
        self.try_hit(key, limit, window).map_err(AppError::rate_limited)
    }

    /// 计一次；超限返回剩余秒数
    pub fn try_hit(&self, key: &str, limit: u32, window: Duration) -> Result<(), u64> {
        let now = Instant::now();
        let mut m = self.map.lock().unwrap();
        let e = m.entry(key.to_string()).or_insert((now, window, 0));
        if now.duration_since(e.0) >= e.1 {
            *e = (now, window, 0);
        }
        if e.2 >= limit {
            return Err(remaining(e.0, e.1, now));
        }
        e.2 += 1;
        Ok(())
    }

    /// 不计数，只检查是否已达上限
    pub fn check(&self, key: &str, limit: u32) -> Result<(), u64> {
        let now = Instant::now();
        let m = self.map.lock().unwrap();
        match m.get(key) {
            Some(&(start, win, n)) if now.duration_since(start) < win && n >= limit => Err(remaining(start, win, now)),
            _ => Ok(()),
        }
    }

    /// 计一次失败；达到 limit 时把窗口起点重置为现在（即从最后一次失败起锁 window）
    pub fn fail(&self, key: &str, limit: u32, window: Duration) {
        let now = Instant::now();
        let mut m = self.map.lock().unwrap();
        let e = m.entry(key.to_string()).or_insert((now, window, 0));
        if now.duration_since(e.0) >= e.1 {
            *e = (now, window, 0);
        }
        e.2 += 1;
        if e.2 >= limit {
            e.0 = now;
        }
    }

    pub fn clear(&self, key: &str) {
        self.map.lock().unwrap().remove(key);
    }

    /// 清理过期条目（后台每分钟一次）
    pub fn sweep(&self) {
        let now = Instant::now();
        self.map.lock().unwrap().retain(|_, (start, win, _)| now.duration_since(*start) < *win);
    }
}

fn remaining(start: Instant, win: Duration, now: Instant) -> u64 {
    (win.saturating_sub(now.duration_since(start))).as_secs() + 1
}

pub const MIN: Duration = Duration::from_secs(60);
pub const MIN15: Duration = Duration::from_secs(15 * 60);
pub const HOUR: Duration = Duration::from_secs(3600);
