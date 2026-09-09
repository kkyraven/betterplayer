// libc marks the mach bindings deprecated in favour of the mach2 crate; they are stable and enough here.
#![allow(deprecated)]
//! Scheduling class for the tick thread, so sleeps wake close to their deadline.

use std::time::Duration;

/// macOS: time constraint policy, the same class CoreAudio threads use.
#[cfg(target_os = "macos")]
pub fn promote(period: Duration) -> Result<(), String> {
    use libc::{
        THREAD_TIME_CONSTRAINT_POLICY, THREAD_TIME_CONSTRAINT_POLICY_COUNT, mach_thread_self,
        mach_timebase_info, thread_policy_set, thread_time_constraint_policy,
    };
    let mut tb = mach_timebase_info { numer: 0, denom: 0 };
    unsafe { mach_timebase_info(&mut tb) };
    let to_abs = |ns: u64| (ns * tb.denom as u64 / tb.numer as u64) as u32;
    let period_ns = period.as_nanos() as u64;
    let mut policy = thread_time_constraint_policy {
        period: to_abs(period_ns),
        computation: to_abs(period_ns / 20),
        constraint: to_abs(period_ns / 5),
        preemptible: 1,
    };
    let kr = unsafe {
        thread_policy_set(
            mach_thread_self(),
            THREAD_TIME_CONSTRAINT_POLICY as u32,
            &mut policy as *mut _ as *mut _,
            THREAD_TIME_CONSTRAINT_POLICY_COUNT,
        )
    };
    if kr != 0 {
        Err(format!("thread_policy_set returned {kr}"))
    } else {
        Ok(())
    }
}

/// Windows: the 1 ms timer resolution (the default is 15.6 ms, which would land a 9.5 ms sleep at
/// 15.6) and the highest priority a normal process gets, for this thread only.
///
/// The resolution request is per process on Windows 10 2004 and later and cannot be inherited from
/// Electron, which only raises it for its own threads. It is made once and kept for the life of
/// the process: tick loops start and stop with every device, and a 1 ms clock while the app runs
/// costs nothing measurable on a desktop.
#[cfg(windows)]
pub fn promote(_period: Duration) -> Result<(), String> {
    use std::sync::OnceLock;

    use windows::Win32::Media::{TIMERR_NOERROR, timeBeginPeriod};
    use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL};

    static RESOLUTION: OnceLock<Result<(), String>> = OnceLock::new();
    RESOLUTION
        .get_or_init(|| {
            let r = unsafe { timeBeginPeriod(1) };
            if r == TIMERR_NOERROR { Ok(()) } else { Err(format!("timeBeginPeriod(1) returned {r}")) }
        })
        .clone()?;
    unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL) }.map_err(|e| format!("SetThreadPriority: {e}"))
}

/// Linux: disable timer coalescing for this thread, then request the lowest FIFO
/// priority. Without an RLIMIT_RTPRIO grant it keeps normal scheduling, with precise timers.
#[cfg(target_os = "linux")]
pub fn promote(_period: Duration) -> Result<(), String> {
    unsafe {
        libc::prctl(libc::PR_SET_TIMERSLACK, 1 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong);
        let priority = libc::sched_get_priority_min(libc::SCHED_FIFO);
        if priority < 0 { return Err(std::io::Error::last_os_error().to_string()); }
        let param = libc::sched_param { sched_priority: priority };
        let error = libc::pthread_setschedparam(libc::pthread_self(), libc::SCHED_FIFO, &param);
        if error != 0 {
            return Err(format!("SCHED_FIFO: {}", std::io::Error::from_raw_os_error(error)));
        }
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub fn promote(_period: Duration) -> Result<(), String> {
    Err("no realtime policy on this platform yet".into())
}
