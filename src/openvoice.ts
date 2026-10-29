import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { normalise, readWav, writeWav } from "./audio.js";
import { IS_WIN } from "./platform.js";
import { OWN_CHANNEL_DIR } from "./production.js";

// The user's own cloned voice through OpenVoice V2 (2026-10-27, Tanya's choice: free, runs on their RTX 4070 Ti).
// OpenVoice is Python, so it lives in its own folder beside flow-mcp (<studio>/openvoice: a .venv and the OpenVoice
// checkout with checkpoints_v2) and scripts/openvoice_say.py speaks one take per call. channel/openvoice.json can point
// elsewhere: { "python": "...", "repo": "..." }. The reference recording is channel/voice-reference.wav; its speaker
// embedding is cached beside it on first use.
// A profile is a second voice in its own folder (2026-10-29: C3 videos use channel/c3/voice-reference.wav, the user's
// own C3 recording): its own reference, embedding cache and openvoice.json (speed and pauses), which openvoice_say.py
// reads beside the reference. Python and the OpenVoice checkout always come from channel/openvoice.json.
const run = promisify(execFile);
const CODE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = join(CODE_ROOT, "scripts", "openvoice_say.py");
const home = (profile?: string) => (profile ? join(OWN_CHANNEL_DIR, profile) : OWN_CHANNEL_DIR);
const reference = (profile?: string) => join(home(profile), "voice-reference.wav");
const seCache = (profile?: string) => join(home(profile), "openvoice-se.pth");
const readJson = (file: string): Record<string, unknown> => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});

// "speed" (MeloTTS, 1 = its own pace; 2026-10-29 the user found 1.0 too fast at ~200 words a minute) is read here and,
// for a process started before this existed, by openvoice_say.py itself.
function setup(profile?: string): { python: string; repo: string; speed: number } {
  const install = resolve(CODE_ROOT, "..", "openvoice");
  const saved = readJson(join(OWN_CHANNEL_DIR, "openvoice.json")) as { python?: string; repo?: string; speed?: number };
  const own = profile ? (readJson(join(home(profile), "openvoice.json")) as { speed?: number }) : {};
  return {
    python: saved.python ?? join(install, ".venv", IS_WIN ? "Scripts" : "bin", IS_WIN ? "python.exe" : "python"),
    repo: saved.repo ?? join(install, "OpenVoice"),
    speed: own.speed ?? saved.speed ?? 1,
  };
}

// What a take's stamp records about these settings, so changing the speed or the pauses (sentence_pause,
// line_pause: read by openvoice_say.py only) re-records. Empty at the defaults, so older takes stay valid.
export function openVoiceStamp(profile?: string): string {
  const saved = readJson(join(home(profile), "openvoice.json"));
  const { speed = setup(profile).speed, sentence_pause, line_pause, sdp_ratio, noise_scale } = saved;
  const parts = [
    profile ? `voice ${profile}` : "",
    speed !== 1 ? `speed ${speed}` : "",
    sentence_pause !== undefined ? `pause ${sentence_pause}/${line_pause ?? ""}` : "",
    sdp_ratio !== undefined || noise_scale !== undefined ? `expr ${sdp_ratio ?? ""}/${noise_scale ?? ""}` : "",
  ];
  return parts.filter(Boolean).map((p) => `|${p}`).join("");
}

export function openVoiceReady(profile?: string): { ready: boolean; missing?: string } {
  const { python, repo } = setup(profile);
  if (!existsSync(reference(profile))) return { ready: false, missing: `the reference recording (${reference(profile)})` };
  if (!existsSync(python)) return { ready: false, missing: `OpenVoice's Python (${python})` };
  if (!existsSync(join(repo, "checkpoints_v2", "converter", "checkpoint.pth"))) return { ready: false, missing: `OpenVoice's V2 checkpoints (${join(repo, "checkpoints_v2")})` };
  return { ready: true };
}

export async function speakWithOpenVoice(text: string, target: string, profile?: string): Promise<{ output: string; duration: number }> {
  const state = openVoiceReady(profile);
  if (!state.ready) throw new Error(`Your cloned voice isn't set up on this computer yet: missing ${state.missing}.`);
  const { python, repo, speed } = setup(profile);
  const dir = mkdtempSync(join(tmpdir(), "flow-ov-"));
  try {
    const textFile = join(dir, "take.txt");
    writeFileSync(textFile, text, "utf8");
    // The first take also works out the speaker embedding from the whole recording, so it is given longer.
    await run(python, [SCRIPT, "--repo", repo, "--ref", reference(profile), "--se", seCache(profile), "--text", textFile, "--out", target, "--speed", String(speed)], {
      timeout: 15 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    }).catch((err: { stderr?: string; message: string }) => {
      const tail = (err.stderr ?? "").trim().split("\n").slice(-6).join("\n");
      throw new Error(`OpenVoice couldn't speak this take: ${tail || err.message}`);
    });
    const pcm = normalise(readWav(target));
    writeWav(target, pcm);
    return { output: target, duration: pcm.channels[0].length / pcm.rate };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// When each word of a take is said, heard by faster-whisper (which OpenVoice installs) from the same Python. Used to
// time the beats and the captions for any voice that doesn't report its own word times. Undefined when OpenVoice
// isn't set up here, or hearing fails: the caller falls back to the voice's pauses.
export async function hearWords(file: string): Promise<{ text: string; start: number; end: number }[] | undefined> {
  const { python } = setup();
  if (!existsSync(python)) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "flow-words-"));
  try {
    const out = join(dir, "words.json");
    await run(python, [join(CODE_ROOT, "scripts", "words.py"), "--wav", file, "--out", out], {
      timeout: 10 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    return JSON.parse(readFileSync(out, "utf8"));
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
