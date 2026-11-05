use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::err;

#[napi]
pub struct SpeechModel {
    whisper: bp_speech::Whisper,
}

#[napi]
impl SpeechModel {
    #[napi(constructor)]
    pub fn new(encoder: String, decoder: String, tokenizer: String) -> Result<SpeechModel> {
        let whisper = bp_speech::Whisper::load(encoder.as_ref(), decoder.as_ref(), tokenizer.as_ref()).map_err(err)?;
        Ok(SpeechModel { whisper })
    }

    #[napi]
    pub fn transcribe(&mut self, pcm: Int16Array, prompt: String) -> Result<String> {
        self.whisper.transcribe(&pcm, &prompt).map_err(err)
    }
}

#[napi]
pub struct SpeechVad {
    vad: bp_speech::Vad,
}

#[napi]
impl SpeechVad {
    #[napi(constructor)]
    pub fn new(vad: String) -> Result<SpeechVad> {
        Ok(SpeechVad { vad: bp_speech::Vad::load(vad.as_ref()).map_err(err)? })
    }

    #[napi]
    pub fn vad(&mut self, pcm: Int16Array) -> Result<Float32Array> {
        self.vad.push(&pcm).map(Float32Array::new).map_err(err)
    }

    #[napi]
    pub fn reset(&mut self) {
        self.vad.reset();
    }
}
