//! One movement feature row from what the engine already computes, in `ml/models/movement.py`'s
//! `FeatureLayout` order with `ml/data/dataset.py`'s normalisation constant for constant. This
//! is the whole per-frame contract: change it and the Python changes with it.

use bp_tracking::FlowPoint;

/// Displacements are pixels of a 384 px wide frame; this brings a normal stroke to about 1.
pub const FLOW_SCALE: f32 = 8.0;
pub const FLOW_CLIP: f32 = 4.0;
/// Per column of `signals`, in engine component order (stroke, sway, surge, roll, pitch, twist).
pub const SIGNAL_SCALE: [f32; 6] = [8.0, 4.0, 128.0, 128.0, 128.0, 128.0];
/// Staleness caps in seconds; absent means the cap.
pub const BOX_STALE_MAX: f32 = 10.0;
pub const SEMANTIC_STALE_MAX: f32 = 2.0;
/// A frame interval in ms is divided by this.
pub const INTERVAL_SCALE: f64 = 33.3;
/// The interval a window's first row always carries: one nominal frame (`feature_row` prepends
/// `time_ms[0] - 1000 / 30`).
pub const FIRST_INTERVAL: f32 = (1000.0 / 30.0 / INTERVAL_SCALE) as f32;
/// Grid points per flow field and channels per point (dx, dy, err, textured).
pub const GRID_POINTS: usize = 192;
const GRID_CHANNELS: usize = 4;
const FIELD: usize = GRID_POINTS * GRID_CHANNELS;
/// Detector kinds the one-hot covers, in `bp_detect::Kind::ALL` order.
pub const BOX_KINDS: usize = 6;
/// Coverage columns kept: the first four kinds (genitals, breasts, buttocks, faces).
pub const BOX_COVERAGE: usize = 4;

/// The row's spans, in order. `Meta` checks an export against this at load.
pub const MOVEMENT_LAYOUT: &[(&str, usize)] = &[
    ("frame_field", FIELD),
    ("region_field", FIELD),
    ("region", 4),
    ("chain", 6),
    ("signals", 6),
    ("cut", 1),
    ("interval", 1),
    ("box", 4),
    ("box_kind", BOX_KINDS),
    ("box_conf", 1),
    ("box_coverage", BOX_COVERAGE),
    ("box_stale", 1),
    ("pace", 6),
    ("future_mask", 1),
    ("semantic_stale", 1),
    ("semantic_present", 1),
];

const fn offset(index: usize) -> usize {
    let mut at = 0;
    let mut i = 0;
    while i < index {
        at += MOVEMENT_LAYOUT[i].1;
        i += 1;
    }
    at
}

pub const FRAME_FIELD: usize = offset(0);
pub const REGION_FIELD: usize = offset(1);
pub const REGION: usize = offset(2);
pub const CHAIN: usize = offset(3);
pub const SIGNALS: usize = offset(4);
pub const CUT: usize = offset(5);
pub const INTERVAL: usize = offset(6);
pub const BOX: usize = offset(7);
pub const BOX_KIND: usize = offset(8);
pub const BOX_CONF: usize = offset(9);
pub const BOX_COVERAGE_AT: usize = offset(10);
pub const BOX_STALE: usize = offset(11);
pub const PACE: usize = offset(12);
pub const FUTURE_MASK: usize = offset(13);
pub const SEMANTIC_STALE: usize = offset(14);
pub const SEMANTIC_PRESENT: usize = offset(15);
/// Width of one row.
pub const MOVEMENT_WIDTH: usize = offset(16);

/// The detector's latest run, as the row reads it: when it ran (on the caller's clock), what it
/// chose, and how much of the picture each kind covered on that run alone. A run that found
/// nothing still counts: its coverage and its time are what the model sees.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BoxRun {
    pub time_ms: f64,
    /// The chosen box in 0..1 of the frame, `None` when the run found nothing worth following.
    pub rect: Option<[f32; 4]>,
    /// Index into `bp_detect::Kind::ALL` of the box's kind; `None` for a covered class.
    pub kind: Option<usize>,
    pub confidence: f32,
    pub coverage: [f32; BOX_KINDS],
}

/// One frame's inputs. `chain` is the region tracker's last `Sample.motion`, held across frames
/// that produced none (the first frame, the frame after a cut); `now_ms` is on the same clock
/// as `detection.time_ms`, which is not necessarily the frame's media time.
pub struct FrameInput<'a> {
    pub frame_field: &'a [FlowPoint],
    pub region_field: &'a [FlowPoint],
    /// The region tracker's region, or the default centre box.
    pub region: [f32; 4],
    pub chain: [f64; 6],
    pub signals: [f64; 6],
    pub cut: bool,
    pub interval_ms: f64,
    pub detection: Option<&'a BoxRun>,
    pub now_ms: f64,
    pub pace: f32,
}

/// The 0.2, 0.2, 0.6, 0.6 box the region tracker uses when none is set.
pub const DEFAULT_REGION: [f32; 4] = [0.2, 0.2, 0.6, 0.6];

/// One flow grid: untextured points zeroed, displacements scaled to O(1) and clipped, the error
/// through a log. `field` may be shorter than the grid (before the first frame); the rest is 0.
fn field_block(field: &[FlowPoint], out: &mut [f32]) {
    out.fill(0.0);
    for (p, point) in field.iter().take(GRID_POINTS).enumerate() {
        let textured = point.textured;
        let at = p * GRID_CHANNELS;
        out[at] = (point.dx / FLOW_SCALE).clamp(-FLOW_CLIP, FLOW_CLIP) * textured;
        out[at + 1] = (point.dy / FLOW_SCALE).clamp(-FLOW_CLIP, FLOW_CLIP) * textured;
        out[at + 2] = point.err.abs().ln_1p() / 3.0 * textured;
        out[at + 3] = textured;
    }
}

/// Fills `out` (`MOVEMENT_WIDTH` wide) with the frame's row. The future mask is left at 0; the
/// ring sets it per window, as `feature_row` does.
pub fn movement_row(input: &FrameInput, out: &mut [f32]) {
    assert_eq!(out.len(), MOVEMENT_WIDTH);
    field_block(input.frame_field, &mut out[FRAME_FIELD..FRAME_FIELD + FIELD]);
    field_block(input.region_field, &mut out[REGION_FIELD..REGION_FIELD + FIELD]);
    out[REGION..REGION + 4].copy_from_slice(&input.region);
    for i in 0..6 {
        out[CHAIN + i] = input.chain[i] as f32;
        out[SIGNALS + i] = (input.signals[i] as f32 / SIGNAL_SCALE[i]).clamp(-FLOW_CLIP, FLOW_CLIP);
    }
    out[CUT] = input.cut as u8 as f32;
    out[INTERVAL] = (input.interval_ms / INTERVAL_SCALE) as f32;
    out[BOX..BOX_STALE + 1].fill(0.0);
    out[BOX_STALE] = BOX_STALE_MAX;
    if let Some(run) = input.detection {
        if let Some(rect) = run.rect {
            out[BOX..BOX + 4].copy_from_slice(&rect);
        }
        if let Some(kind) = run.kind.filter(|k| *k < BOX_KINDS) {
            out[BOX_KIND + kind] = 1.0;
        }
        out[BOX_CONF] = if run.rect.is_some() { run.confidence } else { 0.0 };
        out[BOX_COVERAGE_AT..BOX_COVERAGE_AT + BOX_COVERAGE].copy_from_slice(&run.coverage[..BOX_COVERAGE]);
        out[BOX_STALE] = (((input.now_ms - run.time_ms) / 1000.0) as f32).clamp(0.0, BOX_STALE_MAX);
    }
    out[PACE..PACE + 6].fill(input.pace);
    out[FUTURE_MASK] = 0.0;
    // The shipped model trained with the semantic backbone absent: stale at the cap, not present.
    out[SEMANTIC_STALE] = SEMANTIC_STALE_MAX;
    out[SEMANTIC_PRESENT] = 0.0;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offsets_match_the_export() {
        assert_eq!(MOVEMENT_WIDTH, 1579);
        assert_eq!((REGION, CHAIN, SIGNALS, CUT, INTERVAL), (1536, 1540, 1546, 1552, 1553));
        assert_eq!((BOX, BOX_KIND, BOX_CONF, BOX_COVERAGE_AT, BOX_STALE), (1554, 1558, 1564, 1565, 1569));
        assert_eq!((PACE, FUTURE_MASK, SEMANTIC_STALE, SEMANTIC_PRESENT), (1570, 1576, 1577, 1578));
    }

    #[test]
    fn a_row_scales_and_holds_the_box() {
        let mut field = vec![FlowPoint::default(); GRID_POINTS];
        field[0] = FlowPoint { u: 0.0, v: 0.0, dx: 40.0, dy: -4.0, err: 20.0, textured: 1.0 };
        field[1] = FlowPoint { u: 0.0, v: 0.0, dx: 40.0, dy: -4.0, err: 20.0, textured: 0.0 };
        let run = BoxRun { time_ms: 1000.0, rect: Some([0.1, 0.2, 0.3, 0.4]), kind: Some(3), confidence: 0.9, coverage: [0.5, 0.0, 0.1, 0.2, 0.3, 0.4] };
        let input = FrameInput { frame_field: &field, region_field: &[], region: DEFAULT_REGION, chain: [0.5; 6], signals: [16.0, -80.0, 12800.0, 0.0, 0.0, 0.0], cut: true, interval_ms: 66.6, detection: Some(&run), now_ms: 3500.0, pace: 0.7 };
        let mut out = vec![0.0; MOVEMENT_WIDTH];
        movement_row(&input, &mut out);
        assert_eq!(&out[0..4], &[4.0, -0.5, (21.0f32).ln() / 3.0, 1.0]);
        assert_eq!(&out[4..8], &[0.0; 4], "an untextured point is zeroed");
        assert!(out[REGION_FIELD..REGION_FIELD + FIELD].iter().all(|v| *v == 0.0), "an empty field is at rest");
        assert_eq!(&out[SIGNALS..SIGNALS + 3], &[2.0, -4.0, 4.0]);
        assert_eq!((out[CUT], out[INTERVAL]), (1.0, (66.6 / INTERVAL_SCALE) as f32));
        assert_eq!(&out[BOX..BOX + 4], &[0.1, 0.2, 0.3, 0.4]);
        assert_eq!(out[BOX_KIND + 3], 1.0);
        assert_eq!(out[BOX_CONF], 0.9);
        assert_eq!(&out[BOX_COVERAGE_AT..BOX_COVERAGE_AT + 4], &[0.5, 0.0, 0.1, 0.2]);
        assert_eq!(out[BOX_STALE], 2.5);
        assert_eq!(&out[PACE..PACE + 6], &[0.7; 6]);
        assert_eq!((out[FUTURE_MASK], out[SEMANTIC_STALE], out[SEMANTIC_PRESENT]), (0.0, 2.0, 0.0));
        // No detector: the box block is zeros and the staleness is at its cap.
        movement_row(&FrameInput { detection: None, ..input }, &mut out);
        assert!(out[BOX..BOX_STALE].iter().all(|v| *v == 0.0));
        assert_eq!(out[BOX_STALE], BOX_STALE_MAX);
        // A run that found nothing keeps its coverage and time.
        let miss = BoxRun { rect: None, kind: None, confidence: f32::NAN, ..run };
        movement_row(&FrameInput { detection: Some(&miss), ..input }, &mut out);
        assert!(out[BOX..BOX_COVERAGE_AT].iter().all(|v| *v == 0.0));
        assert_eq!(out[BOX_COVERAGE_AT], 0.5);
        assert_eq!(out[BOX_STALE], 2.5);
    }
}
