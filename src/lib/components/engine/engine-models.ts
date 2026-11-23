// Model IDs per engine, each with the provider page it was checked against.
// IDs come from the catalog (src-tauri/src/tts/catalog.rs) and the installers.
// Engines with no model choice (edge, xai, mistral) have no entry and show no row.

// Model IDs per engine, each with the provider page it was checked against.
// `label` is the short chip text; the full `id` stays in the chip tooltip and
// its accessible name. IDs come from the catalog (src-tauri/src/tts/catalog.rs)
// and the installers.
// Engines with no model choice (edge, xai, mistral) have no entry and show no row.

export interface EngineModel {
  id: string;
  /** Short display label for the chip. A projection of `id`, never a rename. */
  label: string;
  sourceUrl: string;
}

const ELEVENLABS_MODELS = "https://elevenlabs.io/docs/overview/models";
const FISH_CAPABILITIES = "https://docs.fish.audio/overview/capabilities";
const CARTESIA_LATEST = "https://docs.cartesia.ai/build-with-cartesia/tts-models/latest";
const CARTESIA_OLDER = "https://docs.cartesia.ai/build-with-cartesia/tts-models/older-models";
const GEMINI_FLASH = "https://aistudio.google.com/docs/models/gemini-3.8-flash-tts";
const GEMINI_FLASH_LITE = "https://aistudio.google.com/docs/models/gemini-3.8-flash-lite-tts";
const MAI_LEARN = "https://learn.microsoft.com/vi-vn/Azure/ai-services/speech-service/mai-voices";
const MAI_MODEL = "https://microsoft.ai/models/mai-voice-2/";
const PIPER_VOICES = "https://huggingface.co/rhasspy/piper-voices";

function hf(repo: string): string {
  return `https://huggingface.co/${repo}`;
}

export const ENGINE_MODELS = {
  kitten: [
    {
      id: "KittenML/kitten-tts-nano-0.8",
      label: "nano-0.8",
      sourceUrl: hf("KittenML/kitten-tts-nano-0.8")
    },
    {
      id: "KittenML/kitten-tts-micro-0.8",
      label: "micro-0.8",
      sourceUrl: hf("KittenML/kitten-tts-micro-0.8")
    },
    {
      id: "KittenML/kitten-tts-mini-0.8",
      label: "mini-0.8",
      sourceUrl: hf("KittenML/kitten-tts-mini-0.8")
    },
    {
      id: "KittenML/kitten-tts-nano-0.8-int8",
      label: "nano-0.8-int8",
      sourceUrl: hf("KittenML/kitten-tts-nano-0.8-int8")
    }
  ],
  qwen: [
    {
      id: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
      label: "0.6B",
      sourceUrl: hf("Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
    },
    {
      id: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
      label: "1.7B",
      sourceUrl: hf("Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice")
    }
  ],
  piper: [
    { id: "en_US-amy-medium", label: "amy", sourceUrl: PIPER_VOICES },
    { id: "en_US-lessac-medium", label: "lessac", sourceUrl: PIPER_VOICES },
    { id: "en_US-ryan-medium", label: "ryan", sourceUrl: PIPER_VOICES },
    { id: "en_US-joe-medium", label: "joe", sourceUrl: PIPER_VOICES },
    { id: "en_US-libritts-medium", label: "libritts", sourceUrl: PIPER_VOICES }
  ],
  kokoro: [{ id: "kokoro-v1.0-duration.onnx", label: "v1.0", sourceUrl: hf("hexgrad/Kokoro-82M") }],
  pocket: [{ id: "kyutai/pocket-tts", label: "pocket-tts", sourceUrl: hf("kyutai/pocket-tts") }],
  "tiny-voca": [{ id: "n4ze3m/tiny-voca", label: "tiny-voca", sourceUrl: hf("n4ze3m/tiny-voca") }],
  kale: [
    {
      id: "KaleComputer/kale-tts-1-nano",
      label: "tts-1-nano",
      sourceUrl: hf("KaleComputer/kale-tts-1-nano")
    }
  ],
  openai: [
    {
      id: "gpt-4o-mini-tts",
      label: "gpt-4o-mini-tts",
      sourceUrl: "https://developers.openai.com/api/docs/models/gpt-4o-mini-tts"
    },
    {
      id: "tts-1",
      label: "tts-1",
      sourceUrl: "https://developers.openai.com/api/docs/models/tts-1"
    },
    {
      id: "tts-1-hd",
      label: "tts-1-hd",
      sourceUrl: "https://developers.openai.com/api/docs/models/tts-1-hd"
    }
  ],
  elevenlabs: [
    { id: "eleven_v4", label: "v4", sourceUrl: ELEVENLABS_MODELS },
    { id: "eleven_v4_turbo", label: "v4 turbo", sourceUrl: ELEVENLABS_MODELS },
    { id: "eleven_v3", label: "v3", sourceUrl: ELEVENLABS_MODELS },
    { id: "eleven_v3_conversational", label: "v3 conversational", sourceUrl: ELEVENLABS_MODELS },
    { id: "eleven_multilingual_v2", label: "multilingual v2", sourceUrl: ELEVENLABS_MODELS },
    { id: "eleven_flash_v2_5", label: "flash v2.5", sourceUrl: ELEVENLABS_MODELS },
    { id: "eleven_flash_v2", label: "flash v2", sourceUrl: ELEVENLABS_MODELS }
  ],
  fish: [
    { id: "s2.1-pro", label: "s2.1-pro", sourceUrl: FISH_CAPABILITIES },
    { id: "s2.1-pro-free", label: "s2.1-pro-free", sourceUrl: FISH_CAPABILITIES },
    { id: "s2-pro", label: "s2-pro", sourceUrl: FISH_CAPABILITIES },
    {
      id: "drama-3",
      label: "drama-3",
      sourceUrl: "https://docs.fish.audio/features/text-to-speech/drama-3"
    }
  ],
  cartesia: [
    { id: "sonic-3.6", label: "sonic-3.6", sourceUrl: CARTESIA_LATEST },
    { id: "sonic-3.5", label: "sonic-3.5", sourceUrl: CARTESIA_OLDER }
  ],
  google: [
    { id: "gemini-3.8-flash-tts", label: "3.8 flash", sourceUrl: GEMINI_FLASH },
    { id: "gemini-3.8-flash-lite-tts", label: "3.8 flash lite", sourceUrl: GEMINI_FLASH_LITE }
  ],
  microsoft: [
    { id: "mai-voice-2", label: "voice 2", sourceUrl: MAI_LEARN },
    { id: "mai-voice-2-flash", label: "voice 2 flash", sourceUrl: MAI_LEARN },
    { id: "mai-voice-2.1", label: "voice 2.1", sourceUrl: MAI_MODEL },
    { id: "mai-voice-2.1-flash", label: "voice 2.1 flash", sourceUrl: MAI_MODEL }
  ]
} satisfies Record<string, EngineModel[]>;

// Named lookup for the panel: engines without a model choice (edge, xai,
// mistral) have no key, so a lookup by engine id tolerates a miss.
export function engineModels(engineId: string): EngineModel[] {
  if (!Object.hasOwn(ENGINE_MODELS, engineId)) return [];
  // SAFETY: Object.hasOwn just proved `engineId` is a key of ENGINE_MODELS.
  return ENGINE_MODELS[engineId as keyof typeof ENGINE_MODELS];
}
