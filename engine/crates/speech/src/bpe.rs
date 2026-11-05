use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;

#[derive(Deserialize)]
struct File {
    model: Model,
    added_tokens: Vec<Added>,
}

#[derive(Deserialize)]
struct Model {
    vocab: HashMap<String, u32>,
    merges: Vec<String>,
}

#[derive(Deserialize)]
struct Added {
    id: u32,
    content: String,
}

#[derive(Clone, Copy, Debug)]
pub struct Specials {
    pub eot: u32,
    pub sot: u32,
    pub prev: u32,
    pub no_timestamps: u32,
    pub no_speech: u32,
}

pub struct Bpe {
    vocab: HashMap<String, u32>,
    tokens: Vec<String>,
    ranks: HashMap<(String, String), usize>,
    byte_char: [char; 256],
    char_byte: HashMap<char, u8>,
    pub specials: Specials,
}

fn byte_chars() -> [char; 256] {
    let mut out = ['\0'; 256];
    let mut next = 256u32;
    for b in 0..=255u8 {
        let printable = matches!(b, b'!'..=b'~' | 0xA1..=0xAC | 0xAE..=0xFF);
        out[b as usize] = if printable {
            b as char
        } else {
            next += 1;
            char::from_u32(next - 1).unwrap_or('\0')
        };
    }
    out
}

#[derive(PartialEq, Clone, Copy)]
enum Class {
    Letter,
    Number,
    Space,
    Other,
}

fn class(c: char) -> Class {
    if c.is_alphabetic() {
        Class::Letter
    } else if c.is_numeric() {
        Class::Number
    } else if c.is_whitespace() {
        Class::Space
    } else {
        Class::Other
    }
}

fn pieces(text: &str) -> Vec<String> {
    let c: Vec<char> = text.chars().collect();
    let n = c.len();
    let mut out = Vec::new();
    let mut i = 0;
    while i < n {
        if c[i] == '\'' {
            let rest: String = c[i + 1..n.min(i + 3)].iter().collect();
            if let Some(s) = ["re", "ve", "ll", "s", "t", "m", "d"].iter().find(|s| rest.starts_with(**s)) {
                out.push(format!("'{s}"));
                i += 1 + s.len();
                continue;
            }
        }
        let j = if c[i] == ' ' && i + 1 < n && class(c[i + 1]) != Class::Space { i + 1 } else { i };
        let kind = class(c[j]);
        if kind != Class::Space {
            let mut k = j + 1;
            while k < n && class(c[k]) == kind {
                k += 1;
            }
            out.push(c[i..k].iter().collect());
            i = k;
            continue;
        }
        let mut k = i + 1;
        while k < n && class(c[k]) == Class::Space {
            k += 1;
        }
        let end = if k < n && k - i > 1 { k - 1 } else { k };
        out.push(c[i..end].iter().collect());
        i = end;
    }
    out
}

impl Bpe {
    pub fn load(path: &Path) -> Result<Bpe, String> {
        let raw = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let file: File = serde_json::from_slice(&raw).map_err(|e| format!("{}: {e}", path.display()))?;
        let special = |name: &str| {
            file.added_tokens.iter().find(|t| t.content == name).map(|t| t.id).ok_or(format!("tokenizer has no {name}"))
        };
        let specials = Specials {
            eot: special("<|endoftext|>")?,
            sot: special("<|startoftranscript|>")?,
            prev: special("<|startofprev|>")?,
            no_timestamps: special("<|notimestamps|>")?,
            no_speech: special("<|nocaptions|>")?,
        };
        let mut tokens = vec![String::new(); specials.eot as usize];
        for (t, &id) in &file.model.vocab {
            if id < specials.eot {
                tokens[id as usize] = t.clone();
            }
        }
        let ranks = file
            .model
            .merges
            .iter()
            .enumerate()
            .filter_map(|(r, m)| m.split_once(' ').map(|(a, b)| ((a.to_string(), b.to_string()), r)))
            .collect();
        let byte_char = byte_chars();
        let char_byte = byte_char.iter().enumerate().map(|(b, &c)| (c, b as u8)).collect();
        Ok(Bpe { vocab: file.model.vocab, tokens, ranks, byte_char, char_byte, specials })
    }

    pub fn encode(&self, text: &str) -> Vec<u32> {
        let mut ids = Vec::new();
        for piece in pieces(text) {
            let mut parts: Vec<String> = piece.bytes().map(|b| self.byte_char[b as usize].to_string()).collect();
            loop {
                let best = parts
                    .windows(2)
                    .enumerate()
                    .filter_map(|(i, w)| self.ranks.get(&(w[0].clone(), w[1].clone())).map(|&r| (r, i)))
                    .min();
                let Some((_, i)) = best else { break };
                let right = parts.remove(i + 1);
                parts[i].push_str(&right);
            }
            ids.extend(parts.iter().filter_map(|p| self.vocab.get(p)));
        }
        ids
    }

    pub fn decode(&self, ids: &[u32]) -> String {
        let bytes: Vec<u8> = ids
            .iter()
            .filter_map(|&id| self.tokens.get(id as usize))
            .flat_map(|t| t.chars().filter_map(|c| self.char_byte.get(&c).copied()))
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::{Bpe, pieces};

    #[test]
    fn splits_like_gpt2() {
        assert_eq!(pieces(" Myra Bale, 2D's  VR\n"), [" Myra", " Bale", ",", " 2", "D", "'s", " ", " VR", "\n"]);
        assert_eq!(pieces("a  b"), ["a", " ", " b"]);
    }

    #[test]
    #[ignore]
    fn encodes_like_tokenizers() {
        let dir = std::env::var("BP_SPEECH_MODELS").expect("BP_SPEECH_MODELS");
        let bpe = Bpe::load(&std::path::Path::new(&dir).join("whisper-base-en-tokenizer.json")).unwrap();
        let cases: [(&str, &[u32]); 3] = [
            (
                " Myra Bale, beach, blonde, VR, 2D, favourites, fastest",
                &[2011, 430, 43248, 11, 10481, 11, 21541, 11, 6453, 11, 362, 35, 11, 39489, 11, 14162],
            ),
            (
                " Ren\u{e9}e Zo\u{eb}'s  caf\u{e9}\tPOV 4K60fps!!",
                &[7152, 22161, 31645, 26689, 338, 220, 40304, 197, 47, 8874, 604, 42, 1899, 29647, 3228],
            ),
            (" it's 20 minutes... ok?", &[340, 338, 1160, 2431, 986, 12876, 30]),
        ];
        for (text, ids) in cases {
            assert_eq!(bpe.encode(text), ids, "{text:?}");
            assert_eq!(bpe.decode(ids), text);
        }
        assert_eq!(bpe.specials.eot, 50256);
    }
}
