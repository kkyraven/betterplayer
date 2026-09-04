//! Script model: the axis table, tolerant funscript parsing, every container in the wild,
//! keyframe interpolation and the speed heatmap. Pure logic, no clock, no devices.

pub mod axis;
pub mod container;
pub mod expand;
pub mod funscript;
pub mod heatmap;
pub mod interp;

pub use axis::{Axis, Kind, Namespace};
pub use container::{Container, LoadedScript, classify_suffix, find_scripts, select_default};
pub use funscript::{Action, Bookmark, Chapter, Script};
pub use heatmap::{Heatmap, SpeedStats};
pub use interp::Interpolation;
