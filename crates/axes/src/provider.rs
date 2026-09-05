#[derive(Clone, Debug, PartialEq)]
pub enum Provider {
    None,

    Random { speed: f64 },

    Sine { period_ms: f64 },
}

#[derive(Default)]
pub struct State {
    phase_ms: f64,
    from: f64,
    to: f64,
    seed: u64,
}

impl Provider {
    pub fn value(&self, st: &mut State, dt_ms: f64) -> Option<f64> {
        match self {
            Provider::None => None,
            Provider::Sine { period_ms } => {
                st.phase_ms = (st.phase_ms + dt_ms) % period_ms.max(1.0);
                Some(0.5 + 0.5 * (st.phase_ms / period_ms.max(1.0) * std::f64::consts::TAU).sin())
            }
            Provider::Random { speed } => {
                let leg_ms = 1000.0 / speed.max(0.01);
                st.phase_ms += dt_ms;
                while st.phase_ms >= leg_ms {
                    st.phase_ms -= leg_ms;
                    st.from = st.to;
                    st.to = next_random(&mut st.seed);
                }
                let u = st.phase_ms / leg_ms;
                let u = u * u * (3.0 - 2.0 * u);
                Some(st.from + (st.to - st.from) * u)
            }
        }
    }
}


pub(crate) fn next_random(seed: &mut u64) -> f64 {
    if *seed == 0 {
        *seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1) | 1;
    }
    let mut x = *seed;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *seed = x;
    (x >> 11) as f64 / (1u64 << 53) as f64
}
