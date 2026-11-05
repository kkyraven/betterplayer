use std::path::Path;

use ort::memory::Allocator;
use ort::session::{Session, SessionInputValue};
use ort::value::{DynValue, Tensor, TensorRef};

use crate::bpe::Bpe;
use crate::mel::{FRAMES, MELS, Mel};

const PROMPT: usize = 224;
const MAX_TOKENS: usize = 96;
const BASE_TOKENS: usize = 8;
const TOKENS_PER_SECOND: usize = 6;
const NO_SPEECH: f32 = 0.6;
const LOW_LOGPROB: f32 = -1.0;
const SURELY_NO_SPEECH: f32 = 0.9;
const SUPPRESS: &[u32] = &[
    1, 2, 7, 8, 9, 10, 14, 25, 26, 27, 28, 29, 31, 58, 59, 60, 61, 62, 63, 90, 91, 92, 93, 357, 366, 438, 532, 685, 705,
    796, 930, 1058, 1220, 1267, 1279, 1303, 1343, 1377, 1391, 1635, 1782, 1875, 2162, 2361, 2488, 3467, 4008, 4211, 4600,
    4808, 5299, 5855, 6329, 7203, 9609, 9959, 10563, 10786, 11420, 11709, 11907, 13163, 13697, 13700, 14808, 15306,
    16410, 16791, 17992, 19203, 19510, 20724, 22305, 22935, 27007, 30109, 30420, 33409, 34949, 40283, 40493, 40549,
    47282, 49146,
];
const BLANK: u32 = 220;

pub struct Whisper {
    mel: Mel,
    bpe: Bpe,
    encoder: Session,
    decoder: Session,
    layers: usize,
    heads: usize,
    head_dim: usize,
    banned: Vec<bool>,
}

fn e(err: impl std::fmt::Display) -> String {
    err.to_string()
}

fn looping(text: &[u32]) -> Option<usize> {
    (1..=3).find(|&n| {
        let len = text.len();
        len >= 3 * n && text[len - n..] == text[len - 2 * n..len - n] && text[len - n..] == text[len - 3 * n..len - 2 * n]
    })
}

fn log_prob(logits: &[f32], i: usize) -> f32 {
    let max = logits.iter().fold(f32::NEG_INFINITY, |m, &v| m.max(v));
    let sum: f32 = logits.iter().map(|&v| (v - max).exp()).sum();
    logits[i] - max - sum.ln()
}

fn pick(logits: &[f32], banned: &[bool], extra: &[u32]) -> (u32, f32) {
    let best = (0..logits.len())
        .filter(|&i| !banned[i] && !extra.contains(&(i as u32)))
        .max_by(|&a, &b| logits[a].total_cmp(&logits[b]))
        .unwrap_or(0);
    (best as u32, log_prob(logits, best))
}

impl Whisper {
    pub fn load(encoder: &Path, decoder: &Path, tokenizer: &Path) -> Result<Whisper, String> {
        let bpe = Bpe::load(tokenizer)?;
        let encoder = crate::session(encoder, 4)?;
        let decoder = crate::session(decoder, 4)?;
        let layers = decoder.inputs.iter().filter(|i| i.name.ends_with(".decoder.key")).count();
        let cache: Vec<i64> = decoder
            .inputs
            .iter()
            .find(|i| i.name == "past_key_values.0.decoder.key")
            .and_then(|i| i.input_type.tensor_shape())
            .map(|s| s.iter().copied().collect())
            .unwrap_or_default();
        let [_, heads, _, head_dim] = cache[..] else { return Err(format!("unexpected decoder cache {cache:?}")) };
        let vocab = decoder
            .outputs
            .iter()
            .find(|o| o.name == "logits")
            .and_then(|o| o.output_type.tensor_shape().and_then(|s| s.last().copied()))
            .ok_or("decoder has no logits")?;
        if layers == 0 || heads <= 0 || head_dim <= 0 || vocab <= bpe.specials.eot as i64 {
            return Err(format!("unexpected decoder: {layers} layers, {vocab} logits"));
        }
        let mut banned: Vec<bool> = (0..vocab).map(|i| i > bpe.specials.eot as i64).collect();
        for &t in SUPPRESS {
            banned[t as usize] = true;
        }
        Ok(Whisper { mel: Mel::new(), bpe, encoder, decoder, layers, heads: heads as usize, head_dim: head_dim as usize, banned })
    }

    fn opening(&self, prompt: &str) -> Vec<u32> {
        let s = self.bpe.specials;
        let mut ids = Vec::new();
        let prompt = prompt.trim();
        if !prompt.is_empty() {
            let words = self.bpe.encode(&format!(" {prompt}"));
            ids.push(s.prev);
            ids.extend_from_slice(&words[words.len().saturating_sub(PROMPT - 1)..]);
        }
        ids.extend([s.sot, s.no_timestamps]);
        ids
    }

    pub fn transcribe(&mut self, pcm: &[i16], prompt: &str) -> Result<String, String> {
        if pcm.is_empty() {
            return Ok(String::new());
        }
        let _low = crate::Lowered::new();
        let audio: Vec<f32> = pcm.iter().map(|&s| s as f32 / 32768.0).collect();
        let features = self.mel.features(&audio);
        let features = TensorRef::from_array_view(([1usize, MELS, FRAMES], features.as_slice())).map_err(e)?;
        let hidden: DynValue = self
            .encoder
            .run(ort::inputs!["input_features" => features])
            .map_err(e)?
            .remove("last_hidden_state")
            .ok_or("encoder gave no last_hidden_state")?;

        let s = self.bpe.specials;
        let opening = self.opening(prompt);
        let sot_at = opening.len() - 2;
        let empty = || Tensor::<f32>::new(&Allocator::default(), [1usize, self.heads, 0, self.head_dim]).map(DynValue::from).map_err(e);
        let mut past_dec: Vec<DynValue> = (0..self.layers * 2).map(|_| empty()).collect::<Result<_, _>>()?;
        let mut past_enc: Vec<DynValue> = (0..self.layers * 2).map(|_| empty()).collect::<Result<_, _>>()?;
        let mut text: Vec<u32> = Vec::new();
        let (mut no_speech, mut logprob) = (0.0f32, 0.0f32);
        let mut input: Vec<i64> = opening.iter().map(|&t| t as i64).collect();
        let limit = (BASE_TOKENS + pcm.len() * TOKENS_PER_SECOND / crate::mel::RATE).min(MAX_TOKENS);
        for step in 0..limit {
            let first = step == 0;
            let ids = Tensor::from_array(([1usize, input.len()], input.clone())).map_err(e)?;
            let cache = Tensor::from_array(([1usize], vec![!first])).map_err(e)?;
            let mut inputs: Vec<(String, SessionInputValue)> =
                vec![("input_ids".into(), ids.into()), ("encoder_hidden_states".into(), (&hidden).into())];
            for l in 0..self.layers {
                for (i, kv) in ["key", "value"].iter().enumerate() {
                    inputs.push((format!("past_key_values.{l}.decoder.{kv}"), (&past_dec[l * 2 + i]).into()));
                    inputs.push((format!("past_key_values.{l}.encoder.{kv}"), (&past_enc[l * 2 + i]).into()));
                }
            }
            inputs.push(("use_cache_branch".into(), cache.into()));
            let mut out = self.decoder.run(inputs).map_err(e)?;
            let (shape, logits) = out["logits"].try_extract_tensor::<f32>().map_err(e)?;
            let vocab = shape[2] as usize;
            let row = |i: usize| &logits[i * vocab..(i + 1) * vocab];
            let last = row(shape[1] as usize - 1);
            let (token, lp) = if first {
                no_speech = log_prob(row(sot_at), s.no_speech as usize).exp();
                if no_speech > SURELY_NO_SPEECH {
                    return Ok(String::new());
                }
                pick(last, &self.banned, &[BLANK, s.eot])
            } else {
                pick(last, &self.banned, &[])
            };
            for l in 0..self.layers {
                for (i, kv) in ["key", "value"].iter().enumerate() {
                    past_dec[l * 2 + i] = out.remove(format!("present.{l}.decoder.{kv}")).ok_or("decoder gave no cache")?;
                    if first {
                        past_enc[l * 2 + i] = out.remove(format!("present.{l}.encoder.{kv}")).ok_or("decoder gave no cache")?;
                    }
                }
            }
            logprob += lp;
            if token == s.eot {
                break;
            }
            text.push(token);
            if let Some(n) = looping(&text) {
                text.truncate(text.len() - 2 * n);
                break;
            }
            input = vec![token as i64];
        }
        let avg = logprob / (text.len() + 1) as f32;
        if text.is_empty() || (no_speech > NO_SPEECH && avg < LOW_LOGPROB) {
            return Ok(String::new());
        }
        Ok(self.bpe.decode(&text).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::looping;

    #[test]
    fn spots_loops() {
        assert_eq!(looping(&[5, 9, 9, 9]), Some(1));
        assert_eq!(looping(&[1, 2, 1, 2, 1, 2]), Some(2));
        assert_eq!(looping(&[1, 2, 3, 1, 2, 3, 1, 2, 3]), Some(3));
        assert_eq!(looping(&[1, 2, 1, 2, 3]), None);
        assert_eq!(looping(&[7, 7]), None);
    }
}
