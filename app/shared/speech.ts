import type { Chip } from './portals'
import type { ModelInfo } from './tracking'

const WHISPER = 'https://huggingface.co/onnx-community/whisper-base.en'
const WHISPER_REV = '51eefc0af78b103839eda9e7e4f4186acc6517fe'
const VAD = 'https://huggingface.co/onnx-community/silero-vad'
const VAD_REV = 'e71cae966052b992a7eca6b17738916ce0eca4ec'

export const SPEECH_MODEL: ModelInfo = {
  id: 'whisper-base-en',
  label: 'Whisper base.en',
  kind: 'speech',
  version: 'q8',
  files: [
    { file: 'whisper-base-en-encoder.onnx', url: `${WHISPER}/resolve/${WHISPER_REV}/onnx/encoder_model_quantized.onnx`, sha256: '6e8001198c490bbae018c0044f630c2915efb826bad957006ce36152d0ab2a10' },
    { file: 'whisper-base-en-decoder.onnx', url: `${WHISPER}/resolve/${WHISPER_REV}/onnx/decoder_model_merged_int8.onnx`, sha256: 'dd4761a3f7add26afda3512abff4706920404c2517e85a9f2ff090b0c0987909' },
    { file: 'whisper-base-en-tokenizer.json', url: `${WHISPER}/resolve/${WHISPER_REV}/tokenizer.json`, sha256: '5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0' },
  ],
  bundled: false,
  sizeMb: 77,
  licence: 'Apache-2.0',
  licenceUrl: 'https://www.apache.org/licenses/LICENSE-2.0.txt',
  sourceUrl: 'https://huggingface.co/openai/whisper-base.en',
  consent: true,
}

export const VAD_MODEL: ModelInfo = {
  id: 'silero-vad',
  label: 'Silero VAD',
  kind: 'vad',
  version: 'v5',
  files: [
    { file: 'silero-vad.onnx', url: `${VAD}/resolve/${VAD_REV}/onnx/model.onnx`, sha256: 'a4a068cd6cf1ea8355b84327595838ca748ec29a25bc91fc82e6c299ccdc5808' },
  ],
  bundled: false,
  sizeMb: 2,
  licence: 'MIT',
  licenceUrl: 'https://raw.githubusercontent.com/snakers4/silero-vad/master/LICENSE',
  sourceUrl: 'https://github.com/snakers4/silero-vad',
  consent: true,
}

export const VOICE_MODELS = [SPEECH_MODEL, VAD_MODEL] as const
export const VOICE_SIZE_MB = VOICE_MODELS.reduce((mb, m) => mb + m.sizeMb, 0)

export const SPEECH_RATE = 16_000

export type SpeechModelState =
  | { kind: 'missing'; sizeMb: number }
  | { kind: 'downloading'; done: number; total: number }
  | { kind: 'failed'; error: string }
  | { kind: 'ready' }

export interface SpeechWord { text: string; filter: boolean }

export interface SpeechReply { words: SpeechWord[]; end: 'none' | 'speech' | 'silent' }

export interface SpeechFinal { words: SpeechWord[]; chips: Chip[] }
