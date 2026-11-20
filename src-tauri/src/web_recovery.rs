//! Brings the window back when its page's web process dies. On Linux, WebKitGTK draws the page in a process of its
//! own, and when that process crashes the window turns gray and stays that way, even though Task Proxy itself is
//! still running. Loading the page again starts a new one, and the page picks up its state from the backend, running
//! scripts included. A page that keeps crashing is left alone rather than reloaded forever.
use std::time::{Duration, Instant};

/// How many crashes in a row, each within `CRASH_WINDOW` of the last, are reloaded before giving up.
const MAX_RELOADS: usize = 3;
const CRASH_WINDOW: Duration = Duration::from_secs(60);

/// The recent crashes, to tell a crash now and then from a page that crashes as soon as it loads.
#[derive(Default)]
pub(crate) struct CrashHistory {
    recent: Vec<Instant>,
}

impl CrashHistory {
    /// Records a crash at `now`, and says whether the page should be loaded again.
    pub(crate) fn reload_after_crash(&mut self, now: Instant) -> bool {
        self.recent
            .retain(|at| now.duration_since(*at) < CRASH_WINDOW);
        self.recent.push(now);
        self.recent.len() <= MAX_RELOADS
    }
}

/// Reloads the main window's page whenever its web process crashes or runs out of memory.
#[cfg(target_os = "linux")]
pub(crate) fn watch(window: &tauri::WebviewWindow) {
    use std::cell::RefCell;
    use webkit2gtk::{WebProcessTerminationReason, WebViewExt};
    let result = window.with_webview(|webview| {
        let history = RefCell::new(CrashHistory::default());
        webview
            .inner()
            .connect_web_process_terminated(move |view, reason| {
                // Ending it on purpose, as when the window closes, is not a crash.
                if reason == WebProcessTerminationReason::TerminatedByApi {
                    return;
                }
                if history.borrow_mut().reload_after_crash(Instant::now()) {
                    eprintln!(
                        "The window's web process ended ({:?}), so the page is loaded again.",
                        reason
                    );
                    view.reload();
                } else {
                    eprintln!(
                        "The window's web process keeps ending ({:?}), so it is not loaded again.",
                        reason
                    );
                }
            });
    });
    if let Err(err) = result {
        eprintln!("The window can't be watched for crashes: {}", err);
    }
}

/// Other platforms keep the page in the app's own process, or bring it back themselves.
#[cfg(not(target_os = "linux"))]
pub(crate) fn watch(_window: &tauri::WebviewWindow) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_crash_now_and_then_is_always_reloaded() {
        let mut history = CrashHistory::default();
        let start = Instant::now();
        for hour in 0..10 {
            assert!(history.reload_after_crash(start + Duration::from_secs(3600 * hour)));
        }
    }

    #[test]
    fn a_page_that_keeps_crashing_is_reloaded_three_times_then_left_alone() {
        let mut history = CrashHistory::default();
        let start = Instant::now();
        let reloads: Vec<bool> = (0..5)
            .map(|second| history.reload_after_crash(start + Duration::from_secs(second * 5)))
            .collect();
        assert_eq!(reloads, [true, true, true, false, false]);
        // A minute after the last crash, it is reloaded again.
        assert!(history.reload_after_crash(start + Duration::from_secs(20 + 61)));
    }
}
