use bp_script::{Action, Script};

use crate::{BeatTrack, GenerateOptions, Style};

pub const MIN_SPEED: f64 = 300.0;
pub const MAX_SPEED: f64 = 600.0;

/// Keep the keyframe already being approached, then join a reachable future keyframe.
/// Old history is retained only as far back as the new rolling analysis needs it.
pub fn continue_script(
    previous: &Script,
    next: Script,
    committed_ms: f64,
    max_speed: f64,
) -> Script {
    let end = previous.actions.partition_point(|a| a.at <= committed_ms);
    let Some(mut anchor) = previous
        .actions
        .get(end)
        .or_else(|| previous.actions.last())
        .copied()
    else {
        return next;
    };
    let mut keep = (end + 1).min(previous.actions.len());
    // Finish a bounce's paired return, including slower bounces, before correcting its timing.
    if end > 0 && end < previous.actions.len() {
        let from = previous.actions[end - 1];
        if let Some(&back) = previous.actions.get(keep).filter(|back| {
            back.pos == from.pos && anchor.pos != from.pos
                && (back.at - anchor.at - (anchor.at - from.at)).abs() < 1e-7
        }) {
            anchor = back;
            keep += 1;
        }
        if (anchor.pos - from.pos).abs() * 100_000.0 > (anchor.at - from.at) * max_speed + 1e-7 {
            while let Some(&next) = previous.actions.get(keep) {
                if (next.pos - anchor.pos).abs() * 100_000.0 <= (next.at - anchor.at) * max_speed + 1e-7 {
                    break;
                }
                anchor = next;
                keep += 1;
            }
        }
    }
    let holding = keep == end + 1 && end > 0 && previous.actions[end - 1].pos == anchor.pos;
    if holding || anchor.at < committed_ms {
        anchor.at = committed_ms.ceil();
    }
    let start_ms = next
        .actions
        .first()
        .map_or(committed_ms - 24_000.0, |a| a.at)
        .min(committed_ms - 10_000.0);
    let start = previous
        .actions
        .partition_point(|a| a.at < start_ms)
        .saturating_sub(1);
    let keep = if holding { end } else { keep };
    let mut actions = previous.actions[start..keep].to_vec();
    if actions.last().is_none_or(|a| a.at < anchor.at) {
        actions.push(anchor);
    }
    let same_anchor = next.actions.iter().position(|a| a.at == anchor.at && a.pos == anchor.pos);
    let join = same_anchor.map(|i| i + 1).or_else(|| next.actions.iter().position(|a| {
        a.at > anchor.at
            && (a.pos - anchor.pos).abs() * 100_000.0 <= (a.at - anchor.at) * max_speed + 1e-7
    }));
    if let Some(join) = join {
        actions.extend_from_slice(&next.actions[join..]);
    } else {
        actions.push(Action {
            at: (anchor.at + 2000.0).max(next.duration_ms()),
            pos: anchor.pos,
        });
    }
    Script { actions, ..next }
}

fn positive(value: f64, fallback: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        fallback
    }
}

/// Repair detections before selecting tempo. Collisions keep the stronger observation.
fn beats_at(track: &BeatTrack, factor: f64) -> Vec<(f64, f64)> {
    let factor = positive(factor, 1.0).clamp(0.25, 4.0);
    let mut beats: Vec<_> = track
        .beats
        .iter()
        .enumerate()
        .filter(|(_, at)| at.is_finite() && **at >= 0.0 && **at <= 9e12)
        .map(|(i, at)| (at.round(), track.loudness.get(i).copied().unwrap_or(1.0)))
        .map(|(at, loud)| {
            (
                at,
                if loud.is_finite() {
                    loud.clamp(0.0, 1.0)
                } else {
                    0.0
                },
            )
        })
        .collect();
    beats.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut clean: Vec<(f64, f64)> = Vec::with_capacity(beats.len());
    for beat in beats {
        if let Some(last) = clean.last_mut().filter(|last| beat.0 - last.0 < 3.0) {
            if beat.1 > last.1 {
                *last = beat;
            }
        } else {
            clean.push(beat);
        }
    }
    if factor <= 0.75 {
        return clean.into_iter().step_by(if factor <= 0.375 { 4 } else { 2 }).collect();
    }
    if factor >= 1.5 {
        let divisions = if factor >= 3.0 { 4 } else { 2 };
        let mut subdivided = Vec::with_capacity(clean.len() * divisions);
        for (i, &beat) in clean.iter().enumerate() {
            subdivided.push(beat);
            if let Some(&next) = clean.get(i + 1).filter(|next| next.0 - beat.0 >= 3.0 * divisions as f64) {
                // Subdivisions are timing predictions, not additional loud accents.
                for j in 1..divisions {
                    subdivided.push(((beat.0 + (next.0 - beat.0) * j as f64 / divisions as f64).round(), beat.1.min(next.1)));
                }
            }
        }
        return subdivided;
    }
    clean
}

/// Integer milliseconds and positions make the constraints survive funscript export.
/// Speed is measured in final axis position units per second of playback.
pub fn generate(track: &BeatTrack, opts: GenerateOptions) -> Script {
    let beats = beats_at(track, opts.tempo_factor);
    if beats.len() < 2 || (opts.style == Style::Strokes && beats.iter().all(|b| b.1 <= 0.05)) {
        return Script::default();
    }
    let range_min = if opts.min.is_finite() {
        (opts.min.clamp(0.0, 1.0) * 100.0).round()
    } else {
        0.0
    };
    let range_max = if opts.max.is_finite() {
        (opts.max.clamp(0.0, 1.0) * 100.0).round().max(range_min)
    } else {
        100.0
    };
    let span = range_max - range_min;
    let rate = positive(opts.playback_rate, 1.0);
    let max_speed = positive(opts.max_speed, MAX_SPEED) / rate;
    let defaults = GenerateOptions::default();
    let bounce_depth = if opts.bounce_depth.is_finite() { opts.bounce_depth.clamp(0.01, 1.0) } else { defaults.bounce_depth };
    let bounce_factor = if opts.bounce_speed.is_finite() { opts.bounce_speed.clamp(0.5, 6.0) } else { defaults.bounce_speed };
    let bounce_speed = max_speed * bounce_factor;
    let min_speed = positive(opts.min_speed, MIN_SPEED).min(max_speed * rate) / rate;
    let frame = 1000.0 / positive(opts.fps, 60.0).clamp(1.0, 1000.0);
    let intensity = if opts.intensity.is_finite() {
        opts.intensity.clamp(0.0, 2.0)
    } else {
        1.0
    };
    let mut audible: Vec<_> = beats.iter().map(|b| b.1).filter(|l| *l > 0.05).collect();
    audible.sort_by(f64::total_cmp);
    let reference = audible
        .get(audible.len() / 2)
        .copied()
        .unwrap_or(1.0)
        .max(0.1);
    let bottom = |i: usize| {
        if opts.alternate && i % 2 == 1 {
            span
        } else {
            0.0
        }
    };
    let mut actions = Vec::with_capacity(beats.len() * 5);
    let mut push = |at: f64, pos: f64| {
        if actions.last().is_none_or(|a: &Action| at > a.at) {
            let pos = if opts.invert {
                range_max - pos
            } else {
                range_min + pos
            };
            actions.push(Action {
                at,
                pos: pos / 100.0,
            });
        }
    };
    if opts.style == Style::Raw {
        for &(at, _) in &beats {
            push(at, 0.0);
        }
        return Script {
            actions,
            ..Script::default()
        };
    }
    let mut previous_height = 0.0;
    let mut previous_base = 0.0;
    for (i, &(at, loud)) in beats.iter().enumerate() {
        let base = if loud <= 0.05 {
            previous_base
        } else {
            bottom(i)
        };
        let previous = i.checked_sub(1).map(|j| beats[j].0);
        let boundary = previous.map_or(0.0, |prev| ((prev + at) / 2.0).ceil());
        let depth = if loud <= 0.05 {
            0.0
        } else if opts.volume_depth {
            (loud / (reference * 0.85)).clamp(0.0, 1.0)
        } else {
            1.0
        };
        let height = (span * depth * intensity).min(span).floor();
        let required = height * 1000.0 / max_speed;
        let peak_at = (at - (required / frame).ceil().max(1.0) * frame)
            .floor()
            .max(boundary);
        let height = height.min(((at - peak_at) * max_speed / 1000.0 + 1e-9).floor());
        let peak = if base == 0.0 { height } else { span - height };
        if let Some(prev_at) = previous {
            let prev_base = previous_base;
            let distance = (peak - prev_base).abs();
            let available = peak_at - prev_at;
            let return_ms = (distance * 1000.0 / min_speed).ceil().max(1.0);
            let mut return_at = (prev_at + return_ms).min(peak_at);
            let accent = opts.flourishes && !opts.alternate && beats[i - 1].1 >= reference * 1.35;
            // Fit the bounce around the next peak without changing that peak's height or time.
            let bounce = (previous_height * bounce_depth).round();
            let bounce_ms = (bounce * 1000.0 / bounce_speed).ceil().max(1.0);
            let quick_ms = (distance * 1000.0 / max_speed).ceil().max(1.0);
            if accent && bounce >= 1.0 && bounce_ms * 2.0 + quick_ms <= available {
                push(prev_at + bounce_ms, prev_base + bounce);
                push(prev_at + bounce_ms * 2.0, prev_base);
                return_at = prev_at + bounce_ms * 2.0 + quick_ms;
            }
            if return_at < peak_at && distance > 0.0 {
                push(return_at, peak);
            }
        }
        if peak_at < at {
            push(peak_at, peak);
        }
        push(at, base);
        previous_height = height;
        previous_base = base;
    }
    if let Some(&(at, loud)) = beats.last() {
        let bounce = (previous_height * bounce_depth).round();
        let bounce_ms = (bounce * 1000.0 / bounce_speed).ceil().max(1.0);
        let return_ms = (previous_height * 1000.0 / max_speed).ceil().max(1.0);
        if opts.flourishes
            && !opts.alternate
            && loud >= reference * 1.35
            && bounce >= 1.0
            && at + 2.0 * bounce_ms + return_ms <= track.duration_ms.floor()
        {
            push(at + bounce_ms, bounce);
            push(at + 2.0 * bounce_ms, 0.0);
            push(at + 2.0 * bounce_ms + return_ms, previous_height);
        }
    }
    // Alternating axes can have an unreachable opposite endpoint at very high tempos.
    // Keep the endpoint attainable rather than emitting an excessive slope.
    if opts.alternate {
        for i in 1..actions.len() {
            let previous = actions[i - 1];
            let action = &mut actions[i];
            let step = ((action.at - previous.at) * max_speed / 1000.0 + 1e-9).floor() / 100.0;
            action.pos = action.pos.clamp(previous.pos - step, previous.pos + step);
            action.pos = (action.pos * 100.0).round() / 100.0;
        }
    }
    Script {
        actions,
        ..Script::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const BOUNCE_SPEED_FACTOR: f64 = 3.0;

    fn track(beats: &[f64]) -> BeatTrack {
        BeatTrack {
            beats: beats.to_vec(),
            loudness: vec![0.5; beats.len()],
            ..Default::default()
        }
    }

    fn valid(script: &Script, max_speed: f64) {
        assert!(script.actions.iter().all(|a| a.at.is_finite()
            && a.at >= 0.0
            && a.at.fract() == 0.0
            && (0.0..=1.0).contains(&a.pos)));
        for w in script.actions.windows(2) {
            assert!(w[1].at > w[0].at);
            let speed = (w[1].pos - w[0].pos).abs() * 100_000.0 / (w[1].at - w[0].at);
            assert!(speed <= max_speed + 1e-8, "{speed}: {w:?}");
        }
    }

    #[test]
    fn strokes_return_hold_and_reach_bottom_on_the_beat() {
        let script = generate(&track(&[0.0, 1000.0, 2000.0]), GenerateOptions::default());
        assert_eq!(
            script
                .actions
                .iter()
                .map(|a| (a.at, a.pos))
                .collect::<Vec<_>>(),
            vec![
                (0.0, 0.0),
                (334.0, 1.0),
                (833.0, 1.0),
                (1000.0, 0.0),
                (1334.0, 1.0),
                (1833.0, 1.0),
                (2000.0, 0.0)
            ]
        );
        valid(&script, MAX_SPEED);
    }

    #[test]
    fn loud_beat_has_one_sixth_bounce_and_quick_return() {
        let mut t = track(&[0.0, 500.0, 1000.0, 1500.0, 2000.0]);
        t.loudness[2] = 1.0;
        let script = generate(&t, GenerateOptions::default());
        let accent: Vec<_> = script
            .actions
            .iter()
            .filter(|a| a.at >= 1000.0 && a.at < 1500.0)
            .map(|a| (a.at, a.pos))
            .collect();
        assert_eq!(
            accent,
            vec![
                (1000.0, 0.0),
                (1010.0, 0.17),
                (1020.0, 0.0),
                (1187.0, 1.0),
                (1333.0, 1.0)
            ]
        );
        let plain = generate(
            &t,
            GenerateOptions {
                flourishes: false,
                ..Default::default()
            },
        );
        assert_eq!(script.actions.len(), plain.actions.len() + 3);
        valid(&script, MAX_SPEED * BOUNCE_SPEED_FACTOR);
    }

    #[test]
    fn fast_bounces_keep_their_depth_and_wall_clock_duration_at_different_playback_rates() {
        let mut t = track(&[0.0, 1000.0, 2000.0, 3000.0, 4000.0]);
        t.loudness[2] = 1.0;
        for rate in [0.5, 1.0, 2.0] {
            let script = generate(&t, GenerateOptions {
                min: 0.1, max: 0.9, invert: true, playback_rate: rate,
                ..Default::default()
            });
            let start = script.actions.iter().position(|a| a.at == 2000.0).unwrap();
            let bounce = &script.actions[start..start + 4];
            assert_eq!(bounce.iter().map(|a| a.pos).collect::<Vec<_>>(), [0.9, 0.77, 0.9, 0.1]);
            assert!((14.0..=16.0).contains(&((bounce[2].at - bounce[0].at) / rate)));
            for (i, w) in script.actions.windows(2).enumerate() {
                let limit = if i == start || i == start + 1 { MAX_SPEED * BOUNCE_SPEED_FACTOR } else { MAX_SPEED };
                let speed = (w[1].pos - w[0].pos).abs() * 100_000.0 / (w[1].at - w[0].at) * rate;
                assert!(speed <= limit + 1e-8, "{rate}: {w:?}");
            }
            valid(&script, MAX_SPEED * BOUNCE_SPEED_FACTOR / rate);
        }
    }

    #[test]
    fn rolling_corrections_finish_a_fast_bounce() {
        let mut t = track(&[0.0, 500.0, 1000.0, 1500.0, 2000.0]);
        t.loudness[2] = 1.0;
        let old = generate(&t, GenerateOptions::default());
        for committed in [999.0, 1000.0, 1005.0, 1010.0, 1015.0, 1020.0] {
            assert_eq!(continue_script(&old, old.clone(), committed, MAX_SPEED).actions, old.actions);
        }
        t.beats[2] = 990.0;
        t.beats[3] = 1490.0;
        let corrected = generate(&t, GenerateOptions::default());
        for committed in [1005.0, 1010.0, 1015.0] {
            let script = continue_script(&old, corrected.clone(), committed, MAX_SPEED);
            assert_eq!(
                script.actions.iter().filter(|a| a.at <= 1020.0).copied().collect::<Vec<_>>(),
                old.actions.iter().filter(|a| a.at <= 1020.0).copied().collect::<Vec<_>>()
            );
            assert!(script.actions.iter().any(|a| a.at > 1020.0 && a.at < 1490.0 && a.pos == 1.0));
            valid(&script, MAX_SPEED * BOUNCE_SPEED_FACTOR);
        }
    }

    #[test]
    fn adjustable_bounces_preserve_the_next_peak_and_repair_invalid_options() {
        let mut t = track(&[0.0, 2000.0, 4000.0, 6000.0, 8000.0]);
        t.loudness[2] = 1.0;
        t.loudness[3] = 0.1;
        for depth in [0.01, 0.1, 1.0 / 6.0, 0.5, 1.0] {
            for speed in [0.5, 1.0, 3.0, 6.0] {
                let opts = GenerateOptions { bounce_depth: depth, bounce_speed: speed, volume_depth: true, ..Default::default() };
                let plain = generate(&t, GenerateOptions { flourishes: false, ..opts });
                let next_peak = plain.actions.iter().rev().find(|a| a.at < 6000.0).unwrap();
                let script = generate(&t, opts);
                let start = script.actions.iter().position(|a| a.at == 4000.0).unwrap();
                assert_eq!(script.actions[start + 1].pos, (100.0 * depth).round() / 100.0);
                assert_eq!(script.actions[start + 2].pos, 0.0);
                assert!(script.actions.contains(next_peak), "depth {depth}, speed {speed}");
                for (i, w) in script.actions.windows(2).enumerate() {
                    let limit = if i == start || i == start + 1 { MAX_SPEED * speed } else { MAX_SPEED };
                    assert!((w[1].pos - w[0].pos).abs() * 100_000.0 <= (w[1].at - w[0].at) * limit + 1e-7);
                }
                valid(&script, MAX_SPEED * speed.max(1.0));
            }
        }
        let defaults = generate(&t, GenerateOptions::default());
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let script = generate(&t, GenerateOptions { bounce_depth: value, bounce_speed: value, ..Default::default() });
            assert_eq!(script.actions, defaults.actions);
        }
        for (value, depth, speed) in [(-10.0, 0.01, 0.5), (100.0, 1.0, 6.0)] {
            let repaired = generate(&t, GenerateOptions { bounce_depth: value, bounce_speed: value, ..Default::default() });
            let clamped = generate(&t, GenerateOptions { bounce_depth: depth, bounce_speed: speed, ..Default::default() });
            assert_eq!(repaired.actions, clamped.actions);
        }
        let tight = track(&[0.0, 500.0, 1000.0, 1500.0, 2000.0]);
        let tight = BeatTrack { loudness: vec![0.5, 0.5, 1.0, 0.5, 0.5], ..tight };
        let opts = GenerateOptions { bounce_depth: 1.0, bounce_speed: 0.5, ..Default::default() };
        assert_eq!(generate(&tight, opts).actions, generate(&tight, GenerateOptions { flourishes: false, ..opts }).actions);
    }

    #[test]
    fn rolling_corrections_finish_slow_bounces_in_both_directions() {
        for invert in [false, true] {
            let mut t = track(&[0.0, 500.0, 1000.0, 1500.0, 2000.0]);
            t.loudness[2] = 1.0;
            let opts = GenerateOptions { bounce_speed: 0.5, invert, ..Default::default() };
            let old = generate(&t, opts);
            t.beats[2] = 940.0;
            t.beats[3] = 1440.0;
            let corrected = generate(&t, opts);
            for committed in [1005.0, 1057.0, 1100.0] {
                let script = continue_script(&old, corrected.clone(), committed, MAX_SPEED);
                assert_eq!(
                    script.actions.iter().filter(|a| a.at <= 1114.0).copied().collect::<Vec<_>>(),
                    old.actions.iter().filter(|a| a.at <= 1114.0).copied().collect::<Vec<_>>()
                );
                valid(&script, MAX_SPEED);
            }
        }
    }

    #[test]
    fn accents_preserve_the_next_stroke_peak_across_timing_and_depth_changes() {
        for gap in [160.0, 250.0, 333.0, 400.0, 500.0, 1000.0] {
            for fps in [5.0, 24.0, 60.0, 144.0] {
                for volume_depth in [false, true] {
                    let mut t = track(&(0..20).map(|i| i as f64 * gap).collect::<Vec<_>>());
                    t.loudness[8] = 1.0;
                    t.loudness[9] = 0.3;
                    let opts = GenerateOptions { fps, volume_depth, ..Default::default() };
                    let plain = generate(&t, GenerateOptions { flourishes: false, ..opts });
                    let accented = generate(&t, opts);
                    for (i, beats) in t.beats.windows(2).enumerate() {
                        let peak = |s: &Script| s.actions.iter().filter(|a| a.at > beats[0] && a.at < beats[1])
                            .map(|a| a.pos).fold(0.0_f64, f64::max);
                        let expected = peak(&plain);
                        let actual = peak(&accented);
                        assert_eq!(actual, expected, "gap {gap}, fps {fps}, interval {i}");
                        assert!(accented.actions.iter().any(|a| a.at == beats[1] && a.pos == 0.0));
                    }
                    valid(&accented, MAX_SPEED * BOUNCE_SPEED_FACTOR);
                }
            }
        }
    }

    #[test]
    fn short_fast_and_invalid_detections_never_fail() {
        assert!(
            generate(&track(&[]), GenerateOptions::default())
                .actions
                .is_empty()
        );
        assert!(
            generate(&track(&[1.0]), GenerateOptions::default())
                .actions
                .is_empty()
        );
        let t = track(&[f64::NAN, -1.0, 3.0, 0.0, 1.0, 6.0, 9.0, f64::INFINITY]);
        let script = generate(&t, GenerateOptions::default());
        valid(&script, MAX_SPEED);
        assert!(script.actions.iter().all(|a| a.pos <= 0.01));
        let raw = generate(
            &t,
            GenerateOptions {
                style: Style::Raw,
                ..Default::default()
            },
        );
        assert_eq!(
            raw.actions.iter().map(|a| a.at).collect::<Vec<_>>(),
            vec![0.0, 3.0, 6.0, 9.0]
        );
        assert!(raw.actions.iter().all(|a| a.pos == 0.0));
        for at in [0.0, 0.4, 1.0, 2.0, 19.0] {
            valid(
                &generate(&track(&[at, 500.0]), GenerateOptions::default()),
                MAX_SPEED,
            );
        }
    }

    #[test]
    fn bounds_fps_playback_rate_and_alternation_preserve_speed() {
        let mut seed = 7u32;
        for alternate in [false, true] {
            for fps in [0.0, 24.0, 29.97, 60.0, 144.0, f64::NAN] {
                let mut at = 0.0;
                let beats: Vec<_> = (0..500)
                    .map(|_| {
                        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                        at += (seed % 1200) as f64 + 0.2;
                        at
                    })
                    .collect();
                let script = generate(
                    &track(&beats),
                    GenerateOptions {
                        fps,
                        alternate,
                        min: 0.13,
                        max: 0.78,
                        invert: true,
                        playback_rate: 2.0,
                        ..Default::default()
                    },
                );
                valid(&script, MAX_SPEED / 2.0);
                assert!(
                    script
                        .actions
                        .iter()
                        .all(|a| a.pos >= 0.13 && a.pos <= 0.78)
                );
            }
        }
    }

    #[test]
    fn quiet_depth_keeps_beats_at_zero_and_missing_loudness_keeps_beats() {
        let mut t = track(&[0.0, 500.0, 1000.0, 1500.0]);
        t.loudness[2] = 0.1;
        let script = generate(
            &t,
            GenerateOptions {
                volume_depth: true,
                ..Default::default()
            },
        );
        assert!(
            t.beats
                .iter()
                .all(|at| script.actions.iter().any(|a| a.at == *at && a.pos == 0.0))
        );
        assert!(
            script
                .actions
                .iter()
                .any(|a| a.at > 500.0 && a.at < 1000.0 && a.pos > 0.0 && a.pos < 0.3)
        );
        t.loudness.clear();
        assert!(!generate(&t, GenerateOptions::default()).actions.is_empty());
    }

    #[test]
    fn corrections_preserve_the_active_move_and_silence_expires_predictions() {
        let old = generate(
            &track(&[0.0, 500.0, 1000.0, 1500.0, 2000.0]),
            GenerateOptions::default(),
        );
        let new = generate(
            &track(&[0.0, 470.0, 920.0, 1370.0, 1820.0]),
            GenerateOptions::default(),
        );
        let next = continue_script(&old, new, 800.0, MAX_SPEED);
        let anchor = old.actions.iter().find(|a| a.at > 800.0).unwrap();
        assert_eq!(
            old.actions
                .iter()
                .filter(|a| a.at <= anchor.at)
                .collect::<Vec<_>>(),
            next.actions
                .iter()
                .filter(|a| a.at <= anchor.at)
                .collect::<Vec<_>>()
        );
        valid(&next, MAX_SPEED);
        let silent = continue_script(&old, Script::default(), 800.0, MAX_SPEED);
        assert_eq!(silent.actions.last().unwrap().pos, anchor.pos);
        assert_eq!(
            silent.actions.iter().filter(|a| a.at > anchor.at).count(),
            1
        );
    }

    #[test]
    fn silence_keeps_raw_timing_but_does_not_generate_strokes() {
        let mut t = track(&[0.0, 500.0, 1000.0, 1500.0]);
        t.loudness.fill(0.0);
        for alternate in [false, true] {
            assert!(
                generate(
                    &t,
                    GenerateOptions {
                        alternate,
                        ..Default::default()
                    }
                )
                .actions
                .is_empty()
            );
        }
        assert_eq!(
            generate(
                &t,
                GenerateOptions {
                    style: Style::Raw,
                    ..Default::default()
                }
            )
            .actions
            .len(),
            4
        );
    }

    #[test]
    fn final_accent_uses_the_audio_tail_without_writing_past_it() {
        let mut t = track(&[0.0, 500.0, 1000.0, 1500.0]);
        t.loudness[3] = 1.0;
        t.duration_ms = 2000.0;
        let script = generate(&t, GenerateOptions::default());
        assert_eq!(
            script
                .actions
                .iter()
                .filter(|a| a.at > 1500.0)
                .map(|a| (a.at, a.pos))
                .collect::<Vec<_>>(),
            vec![(1510.0, 0.17), (1520.0, 0.0), (1687.0, 1.0)]
        );
        t.duration_ms = 1600.0;
        assert_eq!(
            generate(&t, GenerateOptions::default())
                .actions
                .last()
                .unwrap()
                .at,
            1500.0
        );
        valid(&script, MAX_SPEED * BOUNCE_SPEED_FACTOR);
    }
}
