import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { speakLocally } from "./assemble.js";
import { transcribe } from "./captions.js";
import { speakWithGemini } from "./gemini.js";
import { pad, type Production } from "./production.js";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FLOW_MCP_FFPROBE ?? "ffprobe";

// About three minutes of speech per take: long enough that a whole video is four or five requests (the free AI Studio
// tier allows only a handful of text-to-speech requests a minute and a day), short enough that a take never hits the
// model's output limit.
const WORDS_PER_TAKE = 450;
const GAP_S = 0.5;

export interface Timing {
  file: string;
  voice: string;
  engine: string;
  total: number;
  aligned: "words" | "estimate";
  chapters: { marker: string; start: number; end: number }[];
  beats: { n: number; chapter: string; start: number; end: number }[];
}

const wordsOf = (s: string) => s.split(/\s+/).filter(Boolean);

export async function duration(file: string): Promise<number> {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(stdout.trim());
}

interface Take {
  text: string;
  chapters: { marker: string; from: number; to: number }[]; // word ranges inside the take
}

// Whole chapters go together into takes; only a chapter longer than a take on its own is split, at a sentence end.
function takes(chapters: { marker: string; text: string }[]): Take[] {
  const out: Take[] = [];
  let cur: Take = { text: "", chapters: [] };
  const flush = () => {
    if (cur.chapters.length) out.push(cur);
    cur = { text: "", chapters: [] };
  };
  for (const ch of chapters) {
    const pieces: string[] = [];
    let piece = "";
    for (const sentence of ch.text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [ch.text]) {
      if (piece && wordsOf(piece + sentence).length > WORDS_PER_TAKE) {
        pieces.push(piece);
        piece = "";
      }
      piece += sentence;
    }
    if (piece.trim()) pieces.push(piece);
    for (const p of pieces) {
      const n = wordsOf(cur.text).length;
      if (n && n + wordsOf(p).length > WORDS_PER_TAKE) flush();
      const from = wordsOf(cur.text).length;
      cur.text = `${cur.text} ${p.trim()}`.trim();
      const last = cur.chapters.at(-1);
      if (last?.marker === ch.marker) last.to = wordsOf(cur.text).length;
      else cur.chapters.push({ marker: ch.marker, from, to: wordsOf(cur.text).length });
    }
  }
  flush();
  return out;
}

async function speak(engine: "gemini" | "mac", text: string, voice: string, target: string, style?: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return engine === "mac" ? await speakLocally(text, voice, target) : await speakWithGemini(text, voice, target, style);
    } catch (err) {
      // The free tier answers 429 when requests come too quickly: wait it out a few times rather than fail the video.
      if (attempt < 4 && /\(429\)|\(503\)|RESOURCE_EXHAUSTED|overloaded/i.test(String(err))) {
        await new Promise((r) => setTimeout(r, 35_000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

// Records the whole script as one voiceover and works out when every beat is spoken, which is what the CapCut timeline
// is built from. Takes whose text has not changed are kept, so fixing one chapter re-records only its take.
export async function recordVoiceover(
  dir: string,
  p: Production,
  o: { engine: "gemini" | "mac"; voice: string; style?: string },
  onStep: (s: string) => void = () => {},
): Promise<Timing> {
  const chapters = p.script?.chapters ?? [];
  if (!chapters.length) throw new Error("This video has no script yet. Write the script (STATE 2) first.");
  const out = join(dir, "voice");
  mkdirSync(out, { recursive: true });
  const parts = takes(chapters);
  const files: string[] = [];
  for (const [i, t] of parts.entries()) {
    const file = join(out, `take-${pad(i + 1)}.wav`);
    const meta = join(out, `take-${pad(i + 1)}.txt`);
    const stamp = `${o.engine}|${o.voice}|${o.style ?? ""}\n${t.text}`;
    if (!(existsSync(file) && existsSync(meta) && readFileSync(meta, "utf8") === stamp)) {
      onStep(`recording take ${i + 1} of ${parts.length}`);
      await speak(o.engine, t.text, o.voice, file, o.style);
      writeFileSync(meta, stamp);
    }
    files.push(file);
  }

  onStep("joining the takes");
  const narration = join(out, "narration.wav");
  const inputs = files.flatMap((f) => ["-i", f]);
  const chain = files.map((_, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,apad=pad_dur=${i < files.length - 1 ? GAP_S : 0}[a${i}]`).join(";");
  await run(FFMPEG, ["-y", ...inputs, "-filter_complex", `${chain};${files.map((_, i) => `[a${i}]`).join("")}concat=n=${files.length}:v=0:a=1[out]`, "-map", "[out]", "-c:a", "pcm_s16le", narration]);

  // Where each take's words fall. whisper.cpp gives real word times; without it, words are spread evenly over the take.
  onStep("timing every beat against the voice");
  let aligned: Timing["aligned"] = "words";
  const at: ((wordIndex: number) => number)[] = [];
  let offset = 0;
  for (const [i, file] of files.entries()) {
    const len = await duration(file);
    const n = wordsOf(parts[i].text).length;
    const base = offset;
    let heard: { start: number; end: number }[] = [];
    try {
      heard = (await transcribe(file, "en")).words;
    } catch {
      aligned = "estimate";
    }
    at.push(
      heard.length > n / 2
        ? (k) => (k <= 0 ? base : base + heard[Math.min(heard.length - 1, Math.max(0, Math.round((k * heard.length) / n) - 1))].end)
        : (k) => base + (len * Math.min(k, n)) / n,
    );
    if (heard.length <= n / 2) aligned = "estimate";
    offset += len + (i < files.length - 1 ? GAP_S : 0);
  }
  const total = await duration(narration);

  // A chapter's time runs from its first word to the next chapter's first word, so the picture never goes black.
  const spans: { marker: string; start: number }[] = [];
  parts.forEach((t, i) => t.chapters.forEach((c) => (spans.at(-1)?.marker === c.marker ? null : spans.push({ marker: c.marker, start: at[i](c.from) }))));
  spans[0].start = 0;
  const chapterTimes = spans.map((s, i) => ({ marker: s.marker, start: round(s.start), end: round(i + 1 < spans.length ? spans[i + 1].start : total) }));

  // Beats share out their chapter by their share of its words, measured on the real voice where it was heard.
  const beats: Timing["beats"] = [];
  for (const ch of chapterTimes) {
    const list = (p.beats ?? []).filter((b) => b.chapter === ch.marker).sort((a, b) => a.n - b.n);
    if (!list.length) continue;
    const words = list.map((b) => wordsOf(b.text).length || 1);
    const sum = words.reduce((a, b) => a + b, 0);
    const where = locate(parts, ch.marker);
    let cum = 0;
    for (const [k, b] of list.entries()) {
      const start = k === 0 ? ch.start : beats.at(-1)!.end;
      cum += words[k];
      const end = k === list.length - 1 ? ch.end : where ? where.time(at, cum / sum) : ch.start + ((ch.end - ch.start) * cum) / sum;
      beats.push({ n: b.n, chapter: ch.marker, start: round(start), end: round(Math.max(end, start + 0.5)) });
    }
  }
  const timing: Timing = { file: narration, voice: o.voice, engine: o.engine, total: round(total), aligned, chapters: chapterTimes, beats };
  writeFileSync(join(out, "timing.json"), JSON.stringify(timing, null, 2));
  return timing;
}

// A chapter may straddle two takes; this turns "this far through the chapter's words" into a time on the voiceover.
function locate(parts: Take[], marker: string) {
  const pieces = parts.flatMap((t, i) => t.chapters.filter((c) => c.marker === marker).map((c) => ({ take: i, from: c.from, to: c.to })));
  if (!pieces.length) return null;
  const total = pieces.reduce((a, c) => a + c.to - c.from, 0);
  return {
    time(at: ((k: number) => number)[], share: number) {
      let want = share * total;
      for (const c of pieces) {
        const len = c.to - c.from;
        if (want <= len) return at[c.take](c.from + want);
        want -= len;
      }
      const last = pieces.at(-1)!;
      return at[last.take](last.to);
    },
  };
}

const round = (s: number) => Math.round(s * 1000) / 1000;
