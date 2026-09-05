pub const TAU_MAX_MS: f64 = 120.0;



pub fn tau_for_pace(pace: f64) -> f64 {
    TAU_MAX_MS * (1.0 - pace).max(0.0)
}


pub fn quantile_to_rate(quantile: f64, cdf: &[f64]) -> f64 {
    match cdf {
        [] => 0.0,
        [one] => *one,
        _ => {
            let q = quantile.clamp(0.0, 1.0);
            let x = q * (cdf.len() - 1) as f64;
            let i = (x.floor() as usize).min(cdf.len() - 2);
            cdf[i] + (cdf[i + 1] - cdf[i]) * (x - i as f64)
        }
    }
}



pub fn rate_to_quantile(rate: f64, cdf: &[f64]) -> f64 {
    if cdf.len() < 2 {
        return 0.5;
    }
    if rate <= cdf[0] {
        return 0.0;
    }
    let last = cdf.len() - 1;
    if rate >= cdf[last] {
        return 1.0;
    }
    let i = cdf.partition_point(|&v| v <= rate).max(1) - 1;
    let (a, b) = (cdf[i], cdf[i + 1]);
    let u = if b > a { (rate - a) / (b - a) } else { 0.0 };
    (i as f64 + u) / last as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tau_is_linear_in_pace() {
        assert_eq!(tau_for_pace(0.0), TAU_MAX_MS);
        assert_eq!(tau_for_pace(0.5), TAU_MAX_MS / 2.0);
        assert_eq!(tau_for_pace(1.0), 0.0);
        assert_eq!(tau_for_pace(1.5), 0.0);
    }

    #[test]
    fn quantile_and_rate_round_trip() {
        let cdf = [0.1, 0.5, 1.0, 2.0, 4.0];
        for q in [0.0, 0.1, 0.5, 0.8, 1.0] {
            let r = quantile_to_rate(q, &cdf);
            assert!((rate_to_quantile(r, &cdf) - q).abs() < 1e-9, "{q} -> {r}");
        }
        assert_eq!(rate_to_quantile(0.0, &cdf), 0.0);
        assert_eq!(rate_to_quantile(9.0, &cdf), 1.0);
        assert_eq!(quantile_to_rate(0.5, &[]), 0.0);
    }
}
