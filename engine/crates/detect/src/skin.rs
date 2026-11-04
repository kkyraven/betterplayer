use std::path::Path;

use ort::value::TensorRef;

use crate::{Fit, Shape, Variant, letterbox, nearest_variant, open_shapes};

pub const CENSOR_CELLS: usize = 320;
const ENTER: f32 = 0.6;
const HOLD: f32 = 0.2;
const BAND: f32 = 0.15;

#[derive(Clone, Debug, PartialEq)]
pub struct SkinMask {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

pub struct Skin {
    shapes: Vec<Shape>,
    variants: Vec<Variant>,
    provider: &'static str,
    input: Vec<f32>,
    prev: Vec<f32>,
    max_cells: usize,
}

impl Skin {
    pub fn load(variants: Vec<Variant>, cache_dir: Option<&Path>, max_cells: usize) -> Result<Skin, String> {
        let (shapes, provider) = open_shapes(&variants, cache_dir)?;
        Ok(Skin { shapes, variants, provider, input: Vec::new(), prev: Vec::new(), max_cells: max_cells.max(1) })
    }

    pub fn provider(&self) -> &'static str {
        self.provider
    }

    pub fn segment(&mut self, rgb: &[u8], width: usize, height: usize) -> Result<SkinMask, String> {
        self.run(rgb, width, height, true)
    }

    pub fn segment_with(&mut self, rgb: &[u8], width: usize, height: usize, prev: &mut Vec<f32>) -> Result<SkinMask, String> {
        std::mem::swap(&mut self.prev, prev);
        let mask = self.run(rgb, width, height, true);
        std::mem::swap(&mut self.prev, prev);
        mask
    }

    pub fn segment_soft(&mut self, rgb: &[u8], width: usize, height: usize) -> Result<SkinMask, String> {
        self.run(rgb, width, height, false)
    }

    fn run(&mut self, rgb: &[u8], width: usize, height: usize, solid: bool) -> Result<SkinMask, String> {
        if width == 0 || height == 0 || rgb.len() < width * height * 3 {
            return Err(format!("frame is {} bytes, expected {}x{}x3", rgb.len(), width, height));
        }
        let shape = &mut self.shapes[nearest_variant(&self.variants, width, height)];
        let (sw, sh) = (shape.width, shape.height);
        let fit = letterbox(rgb, width, height, sw, sh, &mut self.input);
        let tensor = TensorRef::from_array_view(([1usize, 3, sh, sw], self.input.as_slice())).map_err(|e| e.to_string())?;
        let outputs = shape.session.run(ort::inputs![shape.input_name.as_str() => tensor]).map_err(|e| e.to_string())?;
        let (_, prob) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        if prob.len() != sw * sh {
            return Err(format!("skin map is {} values, expected {sw}x{sh}", prob.len()));
        }
        Ok(grid(prob, sw, &fit, &mut self.prev, self.max_cells, solid))
    }
}

fn smoothstep(lo: f32, hi: f32, x: f32) -> f32 {
    let t = ((x - lo) / (hi - lo)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn grid(prob: &[f32], stride: usize, fit: &Fit, prev: &mut Vec<f32>, max_cells: usize, solid: bool) -> SkinMask {
    let k = fit.fit_w.div_ceil(max_cells).max(1);
    let (gw, gh) = (fit.fit_w.div_ceil(k), fit.fit_h.div_ceil(k));
    let (x0, y0) = (fit.pad_x as usize, fit.pad_y as usize);
    if prev.len() != gw * gh {
        prev.clear();
        prev.resize(gw * gh, 0.0);
    }
    let mut data = vec![0u8; gw * gh];
    for gy in 0..gh {
        let ys = gy * k..((gy + 1) * k).min(fit.fit_h);
        for gx in 0..gw {
            let xs = gx * k..((gx + 1) * k).min(fit.fit_w);
            let mut sum = 0.0;
            for y in ys.clone() {
                let row = (y0 + y) * stride + x0;
                sum += prob[row + xs.start..row + xs.end].iter().sum::<f32>();
            }
            let p = sum / (ys.len() * xs.len()) as f32;
            let i = gy * gw + gx;
            let at = if prev[i] > 0.5 { HOLD.min(ENTER) } else { ENTER };
            let v = smoothstep(at - BAND, at + BAND, p);
            prev[i] = v;
            data[i] = ((if solid { smoothstep(0.25, 0.45, v) } else { v }) * 255.0).round() as u8;
        }
    }
    SkinMask { width: gw, height: gh, data }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fit(w: usize, h: usize) -> Fit {
        Fit { scale: 1.0, pad_x: 0.0, pad_y: 0.0, fit_w: w, fit_h: h }
    }

    #[test]
    fn a_cell_needs_a_clear_answer_to_start_and_holds_on_a_weak_one() {
        let mut prev = Vec::new();
        let at = |p: f32, prev: &mut Vec<f32>| grid(&[p; 4], 2, &fit(2, 2), prev, CENSOR_CELLS, true).data[0];
        assert_eq!(at(0.4, &mut prev), 0, "not sure enough to start");
        assert_eq!(at(0.9, &mut prev), 255);
        assert_eq!(at(0.4, &mut prev), 255, "held");
        assert_eq!(at(0.02, &mut prev), 0, "let go");
        assert_eq!(at(0.4, &mut prev), 0);
    }

    #[test]
    fn the_padding_is_cropped_and_wide_pictures_are_pooled() {
        let mut prob = vec![1.0f32; 16];
        for y in 1..3 {
            prob[y * 4] = 0.0;
            prob[y * 4 + 1] = 0.0;
        }
        let f = Fit { scale: 1.0, pad_x: 0.0, pad_y: 1.0, fit_w: 4, fit_h: 2 };
        let m = grid(&prob, 4, &f, &mut Vec::new(), CENSOR_CELLS, true);
        assert_eq!((m.width, m.height), (4, 2));
        assert_eq!(m.data, vec![0, 0, 255, 255, 0, 0, 255, 255]);
        let wide = Fit { scale: 1.0, pad_x: 0.0, pad_y: 0.0, fit_w: 1920, fit_h: 2 };
        let m = grid(&vec![0.9; 1920 * 2], 1920, &wide, &mut Vec::new(), CENSOR_CELLS, true);
        assert_eq!((m.width, m.height), (320, 1), "six pixels a cell");
        let m = grid(&vec![0.9; 1920 * 2], 1920, &wide, &mut Vec::new(), 256, true);
        assert_eq!((m.width, m.height), (240, 1), "eight pixels a cell under a cap of 256");
    }

    #[test]
    fn the_soft_answer_keeps_the_value_before_the_solid_step() {
        let soft = grid(&[0.62; 4], 2, &fit(2, 2), &mut Vec::new(), CENSOR_CELLS, false).data[0];
        let solid = grid(&[0.62; 4], 2, &fit(2, 2), &mut Vec::new(), CENSOR_CELLS, true).data[0];
        assert!((128..200).contains(&soft), "soft {soft}");
        assert_eq!(solid, 255);
    }

    #[test]
    fn real_model_finds_skin() {
        let Ok(model) = std::env::var("BP_SKIN") else { return };
        let Ok(frame) = std::env::var("BP_TEST_FRAME") else { return };
        let (w, h, rgb) = crate::tests::read_frame(&frame);
        let (vw, vh) = crate::tests::shape_of(&model);
        let t0 = std::time::Instant::now();
        let mut s = Skin::load(vec![Variant { width: vw, height: vh, path: model.into() }], None, CENSOR_CELLS).unwrap();
        let load = t0.elapsed();
        let t1 = std::time::Instant::now();
        let m = s.segment(&rgb, w, h).unwrap();
        let first = t1.elapsed();
        let t2 = std::time::Instant::now();
        let _ = s.segment(&rgb, w, h).unwrap();
        let covered = m.data.iter().filter(|v| **v > 127).count() as f64 / m.data.len() as f64;
        println!("skin {vw}x{vh} on {}: load {load:?}, first {first:?}, second {:?}, {}x{} cells, {:.0}% skin", s.provider(), t2.elapsed(), m.width, m.height, covered * 100.0);
    }
}
