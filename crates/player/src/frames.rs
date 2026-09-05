use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};


pub type External = [(usize, usize); 3];

pub struct FrameSlot {
    ptr: *mut u8,
    len: usize,
    owned: bool,
}
unsafe impl Send for FrameSlot {}
unsafe impl Sync for FrameSlot {}

impl FrameSlot {
    fn owned(len: usize) -> FrameSlot {
        let v: Vec<u8> = vec![0; len];
        let ptr = Box::leak(v.into_boxed_slice()).as_mut_ptr();
        FrameSlot { ptr, len, owned: true }
    }

    fn external(ptr: usize, len: usize) -> FrameSlot {
        FrameSlot { ptr: ptr as *mut u8, len, owned: false }
    }
    pub fn as_ptr(&self) -> *mut u8 {
        self.ptr
    }



    pub unsafe fn as_slice(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.ptr, self.len) }
    }
}

impl Drop for FrameSlot {
    fn drop(&mut self) {
        if self.owned {
            unsafe { drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(self.ptr, self.len))) };
        }
    }
}

struct State {
    slots: [Arc<FrameSlot>; 3],
    width: u32,
    height: u32,
    writing: usize,

    ready: Option<(usize, Instant, Option<f64>)>,
    reading: usize,

    hold: bool,
}



const HOLD: Duration = Duration::from_millis(250);


#[derive(Clone, Copy, Debug)]
pub struct Acquired {
    pub index: usize,

    pub waited: Duration,

    pub pts: Option<f64>,
}

pub struct Frames {
    state: Mutex<State>,
    published: Condvar,
    taken: Condvar,
}

impl Frames {


    pub fn new(width: u32, height: u32, hold: bool) -> Frames {
        Frames { state: Mutex::new(State::new(width, height, None, hold)), published: Condvar::new(), taken: Condvar::new() }
    }



    pub fn reset(&self, width: u32, height: u32, external: Option<External>) {
        let mut s = self.state.lock().unwrap();
        *s = State::new(width, height, external, s.hold);
    }

    pub fn size(&self) -> (u32, u32) {
        let s = self.state.lock().unwrap();
        (s.width, s.height)
    }


    pub fn writing(&self) -> Arc<FrameSlot> {
        let s = self.state.lock().unwrap();
        s.slots[s.writing].clone()
    }

    pub fn slot(&self, index: usize) -> Arc<FrameSlot> {
        self.state.lock().unwrap().slots[index].clone()
    }


    pub fn publish(&self, pts: Option<f64>) -> bool {
        let mut s = self.state.lock().unwrap();
        if s.hold && s.ready.is_some() {
            s = self.taken.wait_timeout_while(s, HOLD, |s| s.ready.is_some()).unwrap().0;
        }
        let old_writing = s.writing;
        let dropped = match s.ready.take() {
            Some((stale, ..)) => {
                s.writing = stale;
                true
            }
            None => {
                s.writing = (0..3).find(|i| *i != old_writing && *i != s.reading).unwrap();
                false
            }
        };
        s.ready = Some((old_writing, Instant::now(), pts));
        drop(s);
        self.published.notify_one();
        dropped
    }


    pub fn acquire(&self) -> Option<Acquired> {
        let mut s = self.state.lock().unwrap();
        self.take(&mut s)
    }


    pub fn acquire_wait(&self, timeout: Duration) -> Option<Acquired> {
        let s = self.state.lock().unwrap();
        let (mut s, _) = self.published.wait_timeout_while(s, timeout, |s| s.ready.is_none()).unwrap();
        self.take(&mut s)
    }

    fn take(&self, s: &mut State) -> Option<Acquired> {
        let (index, published, pts) = s.ready.take()?;
        s.reading = index;
        if s.hold {
            self.taken.notify_one();
        }
        Some(Acquired { index, waited: published.elapsed(), pts })
    }
}

impl State {
    fn new(width: u32, height: u32, external: Option<External>, hold: bool) -> State {
        let len = width as usize * height as usize * 4;
        let slot = |i: usize| match external {
            Some(ext) => FrameSlot::external(ext[i].0, ext[i].1.min(len)),
            None => FrameSlot::owned(len),
        };
        State {
            slots: [Arc::new(slot(0)), Arc::new(slot(1)), Arc::new(slot(2))],
            width,
            height,
            writing: 0,
            ready: None,
            reading: 2,
            hold,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_never_hands_out_the_reading_slot() {
        let f = Frames::new(2, 2, false);
        assert!(f.acquire().is_none());
        assert!(!f.publish(None));
        let a = f.acquire().unwrap().index;
        assert!(!f.publish(Some(1.5)));
        assert!(f.publish(None), "second publish before acquire replaces the unread frame");
        let b = f.acquire().unwrap().index;
        assert_ne!(a, b);
        let w = f.state.lock().unwrap().writing;
        assert_ne!(w, b);
    }

    #[test]
    fn held_publish_waits_for_the_reader() {
        let f = Arc::new(Frames::new(2, 2, true));
        assert!(!f.publish(Some(0.0)));
        let reader = {
            let f = f.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(30));
                f.acquire().unwrap().pts
            })
        };
        let t0 = Instant::now();
        assert!(!f.publish(Some(1.0)), "waited for the first frame to be taken rather than replacing it");
        assert!(t0.elapsed() >= Duration::from_millis(20));
        assert_eq!(reader.join().unwrap(), Some(0.0));
        assert_eq!(f.acquire().unwrap().pts, Some(1.0));
        assert!(!f.publish(None));
        let t0 = Instant::now();
        assert!(f.publish(None), "no reader: replaced after the hold ran out");
        assert!(t0.elapsed() >= HOLD);
    }
}
