mod bpe;
pub mod mel;
mod vad;
mod whisper;

use std::path::Path;

use ort::environment::{ThreadManager, ThreadWorker};
use ort::session::{Session, builder::GraphOptimizationLevel};

pub use vad::{FRAME, Vad};
pub use whisper::Whisper;

#[cfg(windows)]
use windows::Win32::System::Threading::{
    GetCurrentThread, GetThreadPriority, SetThreadPriority, THREAD_PRIORITY, THREAD_PRIORITY_BELOW_NORMAL,
};

struct Lowered {
    #[cfg(windows)]
    before: Option<i32>,
}

impl Lowered {
    fn new() -> Lowered {
        #[cfg(windows)]
        {
            let before = unsafe { GetThreadPriority(GetCurrentThread()) };
            let lower = before > THREAD_PRIORITY_BELOW_NORMAL.0 && before <= 15;
            let lowered = lower && unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL) }.is_ok();
            Lowered { before: lowered.then_some(before) }
        }
        #[cfg(not(windows))]
        Lowered {}
    }
}

impl Drop for Lowered {
    fn drop(&mut self) {
        #[cfg(windows)]
        if let Some(before) = self.before {
            let _ = unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY(before)) };
        }
    }
}

struct BelowNormal;

impl ThreadManager for BelowNormal {
    type Thread = std::thread::JoinHandle<()>;

    fn create(&mut self, worker: ThreadWorker) -> ort::Result<Self::Thread> {
        std::thread::Builder::new()
            .name("bp-speech".into())
            .spawn(move || {
                let _low = Lowered::new();
                worker.work();
            })
            .map_err(|e| ort::Error::new(e.to_string()))
    }

    fn join(thread: Self::Thread) -> ort::Result<()> {
        thread.join().map_err(|_| ort::Error::new("speech thread panicked"))
    }
}

fn session(path: &Path, threads: usize) -> Result<Session, String> {
    Session::builder()
        .and_then(|b| b.with_optimization_level(GraphOptimizationLevel::Level3))
        .and_then(|b| b.with_intra_threads(threads))
        .and_then(|b| b.with_intra_op_spinning(false))
        .and_then(|b| b.with_thread_manager(BelowNormal))
        .and_then(|b| b.commit_from_file(path))
        .map_err(|e| format!("{}: {e}", path.display()))
}
