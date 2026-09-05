pub mod decoder;
#[cfg(test)]
mod fixture_tests;
pub mod features;
pub mod mel;
pub mod meta;
pub mod movement;
pub mod music;
pub mod pace;
pub mod ring;
pub mod session;
pub mod spec;

pub use decoder::{ActiveGate, DecodeConfig, Smoother, trim_step, decode_axis};
pub use features::{BoxRun, FrameInput, MOVEMENT_LAYOUT, MOVEMENT_WIDTH, movement_row};
pub use meta::{Field, Meta, ModelKind};
pub use movement::{Heads, Movement, PAST, FUTURE, WINDOW, SCORE_START};
pub use music::{Music, MusicResult, VideoRow, MUSIC_WIDTH, RATE_HZ as MUSIC_RATE_HZ};
pub use pace::{quantile_to_rate, rate_to_quantile, tau_for_pace};
pub use ring::Ring;
pub use session::{Loaded, Session, TOO_SLOW_MS};
pub use spec::{MODELS, ModelSpec, model};


pub const AXES: [&str; 6] = ["L0", "L1", "L2", "R0", "R1", "R2"];
