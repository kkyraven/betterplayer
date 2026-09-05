use crate::Action;


pub fn rdp_indices(time_ms: &[f64], pos: &[f64], eps: f64) -> Vec<usize> {
    let n = pos.len();
    if n < 3 {
        return (0..n).collect();
    }
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    let mut stack = vec![(0usize, n - 1)];
    while let Some((a, b)) = stack.pop() {
        if b <= a + 1 {
            continue;
        }
        let span = time_ms[b] - time_ms[a];
        let mut worst = (0.0f64, a);
        for i in a + 1..b {
            let u = if span > 0.0 { (time_ms[i] - time_ms[a]) / span } else { 0.0 };
            let on_line = pos[a] + (pos[b] - pos[a]) * u;
            let d = (pos[i] - on_line).abs();
            if d > worst.0 {
                worst = (d, i);
            }
        }
        if worst.0 > eps {
            keep[worst.1] = true;
            stack.push((a, worst.1));
            stack.push((worst.1, b));
        }
    }
    (0..n).filter(|&i| keep[i]).collect()
}


pub fn simplify(actions: &[Action], eps: f64) -> Vec<Action> {
    let time: Vec<f64> = actions.iter().map(|a| a.at).collect();
    let pos: Vec<f64> = actions.iter().map(|a| a.pos).collect();
    rdp_indices(&time, &pos, eps).into_iter().map(|i| actions[i]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(at: f64, pos: f64) -> Action {
        Action { at, pos }
    }

    #[test]
    fn simplify_keeps_the_turns_and_drops_the_straights() {
        let ramp: Vec<Action> = (0..=10).map(|i| a(i as f64 * 100.0, i as f64 / 10.0)).collect();
        assert_eq!(simplify(&ramp, 0.01), vec![a(0.0, 0.0), a(1000.0, 1.0)]);
        let tri = vec![a(0.0, 0.0), a(100.0, 0.5), a(200.0, 1.0), a(300.0, 0.5), a(400.0, 0.0)];
        assert_eq!(simplify(&tri, 0.01), vec![a(0.0, 0.0), a(200.0, 1.0), a(400.0, 0.0)]);
        let wobble = vec![a(0.0, 0.0), a(100.0, 0.505), a(200.0, 1.0)];
        assert_eq!(simplify(&wobble, 0.01).len(), 2, "a wobble under the tolerance is noise");
        assert_eq!(rdp_indices(&[0.0, 1.0], &[0.0, 1.0], 0.01), vec![0, 1]);
    }
}
