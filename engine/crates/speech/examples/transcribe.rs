use std::path::Path;
use std::time::Instant;

fn wav(path: &str) -> Vec<i16> {
    let raw = std::fs::read(path).expect("read wav");
    let at = raw.windows(4).position(|w| w == b"data").expect("data chunk") + 8;
    raw[at..].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = Path::new(&args[0]);
    let (prompt, wavs) = match args.get(1) {
        Some(p) if !p.ends_with(".wav") => (p.clone(), &args[2..]),
        _ => (String::new(), &args[1..]),
    };
    let encoder = std::env::var("BP_SPEECH_ENCODER").unwrap_or("whisper-base-en-encoder.onnx".into());
    let t = Instant::now();
    let mut whisper = bp_speech::Whisper::load(
        &dir.join(&encoder),
        &dir.join("whisper-base-en-decoder.onnx"),
        &dir.join("whisper-base-en-tokenizer.json"),
    )
    .expect("load whisper");
    let mut vad = bp_speech::Vad::load(&dir.join("silero-vad.onnx")).expect("load vad");
    println!("load {:.0} ms ({encoder}), prompt {prompt:?}", t.elapsed().as_secs_f64() * 1e3);

    let mut seed = 1u32;
    let mut noise = || {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        ((seed >> 16) as i16) / 40
    };
    let mut clips: Vec<(String, Vec<i16>)> = wavs.iter().map(|w| (w.clone(), wav(w))).collect();
    clips.push(("silence 3 s".into(), vec![0; 48_000]));
    clips.push(("noise 3 s".into(), (0..48_000).map(|_| noise()).collect()));
    for (name, pcm) in &clips {
        let mut padded = pcm.clone();
        padded.resize(padded.len().max(48_000), 0);
        vad.reset();
        let t = Instant::now();
        let probs: Vec<f32> = padded.chunks(1600).flat_map(|c| vad.push(c).expect("vad")).collect();
        let vad_ms = t.elapsed().as_secs_f64() * 1e3;
        let speech = probs.iter().filter(|&&p| p > 0.5).count();
        let t = Instant::now();
        let text = whisper.transcribe(&padded, &prompt).expect("transcribe");
        let ms = t.elapsed().as_secs_f64() * 1e3;
        let secs = padded.len() as f64 / 16_000.0;
        println!(
            "{name}: {text:?}  transcribe {ms:.0} ms, vad {:.1} ms/s ({speech}/{} frames speech)",
            vad_ms / secs,
            probs.len()
        );
    }
}
