#![allow(deprecated)]


use std::time::Duration;


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


#[cfg(not(any(target_os = "macos", windows)))]
pub fn promote(_period: Duration) -> Result<(), String> {
    Err("no realtime policy on this platform yet".into())
}
