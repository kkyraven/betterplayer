use crate::features::{FIRST_INTERVAL, FUTURE_MASK, INTERVAL, MOVEMENT_WIDTH, SEMANTIC_STALE, SEMANTIC_STALE_MAX};
use crate::movement::{FUTURE, PAST, WINDOW};

pub struct Ring {
    rows: Vec<Vec<f32>>,
    times: Vec<f64>,

    head: usize,
    len: usize,

    pushed: u64,
}

impl Default for Ring {
    fn default() -> Ring {
        Ring::new()
    }
}

impl Ring {
    pub fn new() -> Ring {
        Ring { rows: vec![vec![0.0; MOVEMENT_WIDTH]; WINDOW], times: vec![0.0; WINDOW], head: 0, len: 0, pushed: 0 }
    }

    pub fn clear(&mut self) {
        self.len = 0;
        self.head = 0;
        self.pushed = 0;
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn pushed(&self) -> u64 {
        self.pushed
    }


    pub fn push(&mut self, row: &[f32], time_ms: f64) {
        let at = (self.head + self.len) % WINDOW;
        self.rows[at].copy_from_slice(row);
        self.times[at] = time_ms;
        if self.len < WINDOW {
            self.len += 1;
        } else {
            self.head = (self.head + 1) % WINDOW;
        }
        self.pushed += 1;
    }



    pub fn push_repeat(&mut self, time_ms: f64) {
        if self.len == 0 {
            return;
        }
        let newest = (self.head + self.len - 1) % WINDOW;
        let mut row = self.rows[newest].clone();
        row[INTERVAL] = 0.0;
        self.push(&row, time_ms);
    }


    fn back(&self, i: usize) -> usize {
        (self.head + self.len - 1 - i.min(self.len - 1)) % WINDOW
    }



    pub fn time_at(&self, i: usize, future: usize) -> Option<f64> {
        let real = PAST + future.min(FUTURE);
        if i >= real || self.len == 0 {
            return None;
        }
        let from_newest = real - 1 - i;
        (from_newest < self.len).then(|| self.times[self.back(from_newest)])
    }



    pub fn window(&self, future: usize, out: &mut [f32]) {
        assert!(self.len > 0, "the ring is empty");
        assert_eq!(out.len(), WINDOW * MOVEMENT_WIDTH);
        let future = future.min(FUTURE);
        let real = PAST + future;
        for i in 0..WINDOW {
            let row = &mut out[i * MOVEMENT_WIDTH..(i + 1) * MOVEMENT_WIDTH];
            if i >= real {
                row.fill(0.0);
                row[SEMANTIC_STALE] = SEMANTIC_STALE_MAX;
                continue;
            }
            let from_newest = real - 1 - i;
            if from_newest < self.len {
                row.copy_from_slice(&self.rows[self.back(from_newest)]);
            } else {

                row.copy_from_slice(&self.rows[self.head]);
                row[INTERVAL] = 0.0;
            }
        }
        if real > self.len {
            out[(real - self.len) * MOVEMENT_WIDTH + INTERVAL] = 0.0;
        }
        out[INTERVAL] = FIRST_INTERVAL;
        let mask = if future > 0 { 1.0 } else { 0.0 };
        for i in 0..WINDOW {
            out[i * MOVEMENT_WIDTH + FUTURE_MASK] = mask;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::PACE;

    fn row(v: f32) -> Vec<f32> {
        let mut r = vec![v; MOVEMENT_WIDTH];
        r[INTERVAL] = 1.0;
        r
    }

    #[test]
    fn a_short_ring_pads_the_front_and_blanks_the_future() {
        let mut ring = Ring::new();
        for i in 0..10 {
            ring.push(&row(i as f32 + 1.0), i as f64 * 33.3);
        }
        let mut out = vec![0.0; WINDOW * MOVEMENT_WIDTH];
        ring.window(0, &mut out);
        let at = |i: usize, c: usize| out[i * MOVEMENT_WIDTH + c];


        assert_eq!(at(127, PACE), 10.0);
        assert_eq!(at(118, PACE), 1.0);
        assert_eq!(at(117, PACE), 1.0);
        assert_eq!(at(117, INTERVAL), 0.0);
        assert_eq!(at(0, INTERVAL), FIRST_INTERVAL);
        assert_eq!(at(118, INTERVAL), 0.0, "the oldest real row follows a copy of itself");
        assert_eq!(at(119, INTERVAL), 1.0);
        for i in PAST..WINDOW {
            assert_eq!(at(i, PACE), 0.0, "the future is blank");
            assert_eq!(at(i, SEMANTIC_STALE), SEMANTIC_STALE_MAX);
        }
        assert!((0..WINDOW).all(|i| at(i, FUTURE_MASK) == 0.0));
        assert_eq!(ring.time_at(127, 0), Some(9.0 * 33.3));
        assert_eq!(ring.time_at(118, 0), Some(0.0));
        assert_eq!(ring.time_at(117, 0), None);
        assert_eq!(ring.time_at(128, 0), None);
    }

    #[test]
    fn a_full_window_with_future_ends_on_the_newest_row() {
        let mut ring = Ring::new();
        for i in 0..200 {
            ring.push(&row(i as f32), i as f64);
        }
        let mut out = vec![0.0; WINDOW * MOVEMENT_WIDTH];
        ring.window(FUTURE, &mut out);
        let at = |i: usize, c: usize| out[i * MOVEMENT_WIDTH + c];
        assert_eq!(at(WINDOW - 1, PACE), 199.0);
        assert_eq!(at(PAST - 1, PACE), 183.0, "the present is 16 rows behind the newest");
        assert_eq!(at(0, PACE), 56.0);
        assert_eq!(at(0, INTERVAL), FIRST_INTERVAL);
        assert!((0..WINDOW).all(|i| at(i, FUTURE_MASK) == 1.0));
        assert_eq!(ring.time_at(PAST - 1, FUTURE), Some(183.0));
        ring.push_repeat(200.0);
        let mut again = vec![0.0; WINDOW * MOVEMENT_WIDTH];
        ring.window(FUTURE, &mut again);
        assert_eq!(again[(WINDOW - 1) * MOVEMENT_WIDTH + PACE], 199.0);
        assert_eq!(again[(WINDOW - 1) * MOVEMENT_WIDTH + INTERVAL], 0.0);
        assert_eq!(ring.time_at(WINDOW - 1, FUTURE), Some(200.0));
    }
}
