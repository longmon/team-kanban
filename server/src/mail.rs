//! SMTP 发信；未配置时打日志。发信失败只记 WARN，不影响主流程
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor, message::Mailbox};

pub struct Mailer {
    smtp: Option<(AsyncSmtpTransport<Tokio1Executor>, Mailbox)>,
}

impl Mailer {
    pub fn new(url: Option<&str>, from: Option<&str>) -> Result<Self, String> {
        let smtp = match (url, from) {
            (Some(u), Some(f)) => Some((
                AsyncSmtpTransport::<Tokio1Executor>::from_url(u).map_err(|e| format!("SMTP_URL: {e}"))?.build(),
                f.parse().map_err(|e| format!("SMTP_FROM: {e}"))?,
            )),
            (None, _) => None,
            (Some(_), None) => return Err("配置了 SMTP_URL 但缺少 SMTP_FROM".into()),
        };
        Ok(Self { smtp })
    }

    pub fn send(&self, to: &str, subject: &str, body: String) {
        let Some((transport, from)) = &self.smtp else {
            tracing::info!(target: "mail.dev", to, subject, body);
            return;
        };
        let msg = to.parse::<Mailbox>().map_err(|e| e.to_string()).and_then(|to| {
            Message::builder().from(from.clone()).to(to).subject(subject).body(body).map_err(|e| e.to_string())
        });
        let transport = transport.clone();
        let to = to.to_string();
        tokio::spawn(async move {
            let r = match msg {
                Ok(m) => transport.send(m).await.map(|_| ()).map_err(|e| e.to_string()),
                Err(e) => Err(e),
            };
            if let Err(e) = r {
                tracing::warn!(to, "发信失败: {e}");
            }
        });
    }
}
