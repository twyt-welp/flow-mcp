import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fromPcm16, normalise, writeWav } from "./audio.js";
import { HOME_DIR } from "./chrome.js";
import { OWN_CHANNEL_DIR } from "./production.js";

// ElevenLabs text-to-speech (2026-10-27, Tanya's choice over Google). The key is the user's own, saved from the panel
// into a file only they can read, like the Gemini key: it never passes through Claude.
const KEY_FILE = join(HOME_DIR, "elevenlabs-key");
const API = "https://api.elevenlabs.io/v1";
export const ELEVEN_MODEL = process.env.FLOW_MCP_ELEVEN_MODEL ?? "eleven_multilingual_v2";
// Raw 16-bit PCM, so the take is written as WAV in plain code (no FFmpeg). 24 kHz is offered on every plan.
const FORMAT = "pcm_24000";
const RATE = 24000;

export const elevenKey = (): string | undefined => {
  const key = (process.env.ELEVENLABS_API_KEY ?? (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8") : "")).trim();
  return key.length >= 20 ? key : undefined;
};

// Checked with ElevenLabs before anything is written, so a mistyped key never replaces one that works. A key limited
// to text-to-speech is refused the account page with "missing_permissions", which still proves the key is real.
export async function saveElevenKey(raw: string): Promise<{ saved: true; ending: string }> {
  const key = raw.trim();
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(key)) {
    throw new Error("That doesn't look like an ElevenLabs API key. Copy the whole key from elevenlabs.io -> Developers -> API Keys, with no spaces.");
  }
  const res = await fetch(`${API}/user`, { headers: { "xi-api-key": key } }).catch(() => null);
  if (!res) throw new Error("Couldn't reach ElevenLabs to check the key. Check your internet connection and try again.");
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).toLowerCase();
    if (!(res.status === 401 && body.includes("missing_permissions"))) {
      throw new Error("ElevenLabs didn't accept that key. Copy it again from elevenlabs.io -> Developers -> API Keys. Your previous key, if any, is unchanged.");
    }
  }
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  writeFileSync(KEY_FILE, key, { mode: 0o600 });
  chmodSync(KEY_FILE, 0o600);
  return { saved: true, ending: key.slice(-4) };
}

export interface SpokenWord {
  word: string;
  start: number;
  end: number;
}

interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

// The reply times every character of the text as sent; a word starts at its first character and ends at its last.
export function wordsFromAlignment(a: Alignment): SpokenWord[] {
  const out: SpokenWord[] = [];
  let cur: SpokenWord | undefined;
  a.characters.forEach((c, i) => {
    if (/\s/.test(c)) {
      cur = undefined;
      return;
    }
    if (!cur) out.push((cur = { word: "", start: a.character_start_times_seconds[i], end: a.character_end_times_seconds[i] }));
    cur.word += c;
    cur.end = a.character_end_times_seconds[i];
  });
  return out;
}

// Speaks a take with the user's ElevenLabs voice and returns when each word is said, so the beats are timed from the
// voice itself rather than estimated.
export async function speakWithElevenLabs(text: string, voiceId: string, target: string): Promise<{ output: string; duration: number; words: SpokenWord[] }> {
  const key = elevenKey();
  if (!key) {
    throw new Error(
      `No ElevenLabs key yet.\n\n` +
        `1. Open elevenlabs.io -> Developers -> API Keys -> Create API key (Text to Speech access is enough).\n` +
        `2. Paste it into Flow Studio: Voice step -> ElevenLabs key -> Save key. It is checked with ElevenLabs and saved\n` +
        `   only on this computer - never paste it into a chat.`,
    );
  }
  const res = await fetch(`${API}/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=${FORMAT}`, {
    method: "POST",
    headers: { "content-type": "application/json", "xi-api-key": key },
    body: JSON.stringify({ text, model_id: ELEVEN_MODEL }),
  });
  const body = (await res.json().catch(() => ({}))) as { audio_base64?: string; alignment?: Alignment; detail?: { message?: string; status?: string } | string };
  if (!res.ok) {
    const detail = typeof body.detail === "string" ? body.detail : (body.detail?.message ?? body.detail?.status ?? "no detail");
    throw new Error(`ElevenLabs refused this take (${res.status}): ${detail}`);
  }
  if (!body.audio_base64) throw new Error("ElevenLabs returned no audio for this take.");
  const pcm = normalise(fromPcm16(Buffer.from(body.audio_base64, "base64"), RATE));
  writeWav(target, pcm);
  return { output: target, duration: pcm.channels[0].length / RATE, words: body.alignment ? wordsFromAlignment(body.alignment) : [] };
}

// The channel's ElevenLabs voice, kept with the mascot in <flow-mcp>/channel (not in git): a voice id is not secret,
// but it is the user's own choice and belongs to their channel, not to the code.
const VOICE_FILE = join(OWN_CHANNEL_DIR, "elevenlabs-voice.txt");

export const elevenVoice = (): string | undefined => {
  const id = (process.env.ELEVENLABS_VOICE_ID ?? (existsSync(VOICE_FILE) ? readFileSync(VOICE_FILE, "utf8") : "")).trim();
  return id || undefined;
};

export function saveElevenVoice(raw: string): { voice_id: string } {
  const id = raw.trim();
  if (!/^[A-Za-z0-9]{10,40}$/.test(id)) throw new Error("That doesn't look like an ElevenLabs voice ID. In ElevenLabs open Voices -> My Voices, click the voice and use Copy voice ID.");
  mkdirSync(dirname(VOICE_FILE), { recursive: true });
  writeFileSync(VOICE_FILE, id);
  return { voice_id: id };
}
