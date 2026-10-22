//! 进程内通知中心：page_id → broadcast，供长轮询与 SSE。ponytail: 单实例；多实例换 PG LISTEN/NOTIFY
use std::{collections::HashMap, sync::Mutex};
use tokio::sync::broadcast;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Event {
    /// 新提交，带 seq
    Response(i64),
    /// 页面 version / accept_responses 变化
    Page,
    /// 页面被删除
    Deleted,
}

#[derive(Default)]
pub struct Notify {
    map: Mutex<HashMap<Uuid, broadcast::Sender<Event>>>,
}

impl Notify {
    pub fn subscribe(&self, page_id: Uuid) -> broadcast::Receiver<Event> {
        self.map.lock().unwrap().entry(page_id).or_insert_with(|| broadcast::channel(64).0).subscribe()
    }

    pub fn send(&self, page_id: Uuid, ev: Event) {
        let mut m = self.map.lock().unwrap();
        if let Some(tx) = m.get(&page_id) {
            if tx.receiver_count() == 0 {
                m.remove(&page_id);
            } else {
                let _ = tx.send(ev);
            }
        }
    }

    /// 清理已无订阅者的条目（后台每分钟一次）
    pub fn sweep(&self) {
        self.map.lock().unwrap().retain(|_, tx| tx.receiver_count() > 0);
    }
}
