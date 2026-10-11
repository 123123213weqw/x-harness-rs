//! Bounded acknowledgement polling for the disposable native probe only.
use std::{future::Future, time::Duration};
use tokio::time::{sleep, timeout_at, Instant};

pub async fn wait<F, Fut>(budget: Duration, interval: Duration, mut poll: F) -> Result<(), String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<bool, String>>,
{
    let deadline = Instant::now() + budget;
    let mut attempts = 0;
    let mut last = "no acknowledgement attempt completed".to_owned();
    let result = timeout_at(deadline, async {
        loop {
            attempts += 1;
            match poll().await {
                Ok(true) => return,
                Ok(false) => last = "native Ready receipt was not accepted".into(),
                Err(error) => last = error,
            }
            sleep(interval).await;
        }
    })
    .await;
    result.map_err(|_| format!("native ready deadline expired after {attempts} attempts: {last}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ready_after_the_old_attempt_cap_still_succeeds() {
        let mut attempts = 0;
        wait(Duration::from_secs(2), Duration::ZERO, || {
            attempts += 1;
            std::future::ready(Ok(attempts == 101))
        })
        .await
        .unwrap();
        assert_eq!(attempts, 101);
    }

    #[tokio::test]
    async fn an_unready_page_fails_with_the_last_reason() {
        let error = wait(Duration::from_millis(30), Duration::from_millis(2), || {
            std::future::ready(Err("browser page is not ready".into()))
        })
        .await
        .unwrap_err();
        assert!(error.contains("deadline expired"));
        assert!(error.contains("browser page is not ready"));
    }

    #[tokio::test]
    async fn a_stalled_native_callback_is_also_bounded() {
        let error = wait(Duration::from_millis(30), Duration::ZERO, || {
            std::future::pending::<Result<bool, String>>()
        })
        .await
        .unwrap_err();
        assert!(error.contains("after 1 attempts"));
    }
}
