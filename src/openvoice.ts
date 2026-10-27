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
const run = promisify(execFile);
const CODE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = join(CODE_ROOT, "scripts", "openvoice_say.py");
const REFERENCE = join(OWN_CHANNEL_DIR, "voice-reference.wav");
const SE_CACHE = join(OWN_CHANNEL_DIR, "openvoice-se.pth");

function setup(): { python: string; repo: string } {
  const home = resolve(CODE_ROOT, "..", "openvoice");
  const file = join(OWN_CHANNEL_DIR, "openvoice.json");
  const saved = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { python?: string; repo?: string }) : {};
  return {
    python: saved.python ?? join(home, ".venv", IS_WIN ? "Scripts" : "bin", IS_WIN ? "python.exe" : "python"),
    repo: saved.repo ?? join(home, "OpenVoice"),
  };
}

export function openVoiceReady(): { ready: boolean; missing?: string } {
  const { python, repo } = setup();
  if (!existsSync(REFERENCE)) return { ready: false, missing: `the reference recording (${REFERENCE})` };
  if (!existsSync(python)) return { ready: false, missing: `OpenVoice's Python (${python})` };
  if (!existsSync(join(repo, "checkpoints_v2", "converter", "checkpoint.pth"))) return { ready: false, missing: `OpenVoice's V2 checkpoints (${join(repo, "checkpoints_v2")})` };
  return { ready: true };
}

export async function speakWithOpenVoice(text: string, target: string): Promise<{ output: string; duration: number }> {
  const state = openVoiceReady();
  if (!state.ready) throw new Error(`Your cloned voice isn't set up on this computer yet: missing ${state.missing}.`);
  const { python, repo } = setup();
  const dir = mkdtempSync(join(tmpdir(), "flow-ov-"));
  try {
    const textFile = join(dir, "take.txt");
    writeFileSync(textFile, text, "utf8");
    // The first take also works out the speaker embedding from the whole recording, so it is given longer.
    await run(python, [SCRIPT, "--repo", repo, "--ref", REFERENCE, "--se", SE_CACHE, "--text", textFile, "--out", target], {
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
