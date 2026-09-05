use std::sync::{Arc, Mutex};

use crate::features::MOVEMENT_WIDTH;
use crate::meta::Meta;
use crate::ring::Ring;
use crate::session::{Head, Session};

pub const PAST: usize = 128;
pub const FUTURE: usize = 16;
pub const WINDOW: usize = PAST + FUTURE;

pub const SCORE_START: usize = 64;


#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Heads {
    pub time_ms: f64,
    pub pos: [f64; 6],
    pub active: [f64; 6],
    pub trough: [f64; 6],
    pub peak: [f64; 6],
}

pub struct Movement {
    session: Arc<Mutex<Session>>,
    pub meta: Arc<Meta>,
    pub ring: Ring,
    window: Vec<f32>,
}

impl Movement {
    pub fn new(session: Arc<Mutex<Session>>, meta: Arc<Meta>) -> Movement {
        Movement { session, meta, ring: Ring::new(), window: vec![0.0; WINDOW * MOVEMENT_WIDTH] }
    }




    pub fn run(&mut self, future: usize, from: usize, to: usize) -> Result<Vec<Heads>, String> {
        if self.ring.is_empty() {
            return Ok(Vec::new());
        }
        self.ring.window(future, &mut self.window);
        let heads = self.session.lock().unwrap().run(&self.window)?;
        let find = |name: &str| heads.iter().find(|h| h.name == name).ok_or_else(|| format!("the graph has no {name} head"));
        let (pos, active, trough, peak) = (find("pos")?, find("active")?, find("trough")?, find("peak")?);
        let mut out = Vec::with_capacity(to.saturating_sub(from));
        for i in from..to.min(WINDOW) {
            let Some(time_ms) = self.ring.time_at(i, future) else { continue };
            let row = |h: &Head| std::array::from_fn(|a| h.at(i, a) as f64);
            out.push(Heads { time_ms, pos: row(pos), active: row(active), trough: row(trough), peak: row(peak) });
        }
        Ok(out)
    }


    pub fn run_ms(&self) -> f64 {
        self.session.lock().unwrap().run_ms
    }
}
