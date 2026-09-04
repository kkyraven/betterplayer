// libc marks the mach bindings deprecated in favour of the mach2 crate; they are stable and enough here.
#![allow(deprecated)]
//! Scheduling class for the tick thread, so sleeps wake close to their deadline.

use std::time::Duration;

/// macOS: time constraint policy, the same class CoreAudio threads use.
#[cfg(target_os = "macos")]
pub fn promote(period: Duration) -> Result<(), String> {
    use libc::{
        THREAD_TIME_CONSTRAINT_POLICY, THREAD_TIME_CONSTRAINT_POLICY_COUNT, mach_thread_self, mach_timebase_info,
        thread_policy_set, thread_time_constraint_policy,
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
    if kr != 0 { Err(format!("thread_policy_set returned {kr}")) } else { Ok(()) }
}

/// Windows (SetThreadPriority plus timeBeginPeriod) and Linux (SCHED_FIFO where allowed) are
/// still to do; the loop runs at normal priority there.
#[cfg(not(target_os = "macos"))]
pub fn promote(_period: Duration) -> Result<(), String> {
    Err("no realtime policy on this platform yet".into())
}
