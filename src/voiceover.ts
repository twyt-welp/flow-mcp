import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { joinTakes, pauses, readWav, writeWav } from "./audio.js";
import { speakLocally } from "./assemble.js";
import { alignText, transcribe } from "./captions.js";
import { speakWithElevenLabs, type SpokenWord } from "./elevenlabs.js";
import { speakWithGemini } from "./gemini.js";
import { hearWords, openVoiceStamp, speakWithOpenVoice } from "./openvoice.js";
import { pad, type Production } from "./production.js";

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
  aligned: "voice" | "words" | "pauses" | "estimate";
  chapters: { marker: string; start: number; end: number }[];
  beats: { n: number; chapter: string; start: number; end: number }[];
  // Every script word as written, with when it is spoken: the captions and the subtitle file are made from these.
  words?: { w: string; start: number; end: number }[];
}

const wordsOf = (s: string) => s.split(/\s+/).filter(Boolean);

// How long a word takes to say, by its letters, plus a little for the breath a comma or full stop brings.
const weight = (w: string) => w.replace(/[^\p{L}\p{N}]/gu, "").length + 2 + (/[.!?]["')\]]*$/.test(w) ? 4 : /[,;:\u2014-]$/.test(w) ? 2 : 0);

// Without a transcriber, a word's time is found from the voice itself: the speaking time (pauses left out) is shared
// out by each word's length, and a boundary that lands near a real pause moves onto it, so a cut falls in a breath and
// never mid-word.
function fromPauses(file: string, words: string[]): (k: number) => number {
  const pcm = readWav(file);
  const { speech, pauses: gaps } = pauses(pcm);
  const len = pcm.channels[0].length / pcm.rate;
  if (speech[1] <= speech[0]) return (k) => (len * k) / Math.max(1, words.length);
  const inner = gaps.filter((g) => g.start > speech[0] && g.end < speech[1]);
  const talk = speech[1] - speech[0] - inner.reduce((a, g) => a + g.end - g.start, 0);
  const cum = [0];
  for (const w of words) cum.push(cum.at(-1)! + weight(w));
  // Speaking time -> clock time, stepping over each pause.
  const clock = (t: number) => {
    let at = speech[0];
    for (const g of inner) {
      if (at + t <= g.start) break;
      t -= g.start - at;
      at = g.end;
    }
    return at + t;
  };
  return (k) => {
    if (k <= 0) return 0;
    if (k >= words.length) return len;
    const guess = clock((talk * cum[k]) / cum.at(-1)!);
    let best: number | undefined, dist = 1.3;
    for (const g of gaps) {
      const mid = (g.start + g.end) / 2;
      if (Math.abs(mid - guess) < dist) [best, dist] = [mid, Math.abs(mid - guess)];
    }
    return best ?? guess;
  };
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

export type VoiceEngine = "elevenlabs" | "openvoice" | "gemini" | "mac";

async function speak(engine: VoiceEngine, text: string, voice: string, target: string, style?: string, profile?: string): Promise<{ duration: number; words?: SpokenWord[] }> {
  for (let attempt = 0; ; attempt++) {
    try {
      if (engine === "elevenlabs") return await speakWithElevenLabs(text, voice, target);
      if (engine === "openvoice") return await speakWithOpenVoice(text, target, profile);
      return engine === "mac" ? await speakLocally(text, voice, target) : await speakWithGemini(text, voice, target, style);
    } catch (err) {
      // The free tier answers 429 when requests come too quickly: wait it out a few times rather than fail the video.
      if (attempt < 4 && /\(429\)|\(503\)|RESOURCE_EXHAUSTED|overloaded|too_many_concurrent/i.test(String(err))) {
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
  o: { engine: VoiceEngine; voice: string; style?: string; profile?: string },
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
    const said = join(out, `take-${pad(i + 1)}.words.json`);
    // Changed OpenVoice speed or pauses re-record too; at the defaults the stamp is the old one.
    const stamp = `${o.engine}|${o.voice}|${o.style ?? ""}${o.engine === "openvoice" ? openVoiceStamp(o.profile) : ""}\n${t.text}`;
    if (!(existsSync(file) && existsSync(meta) && readFileSync(meta, "utf8") === stamp)) {
      onStep(`recording take ${i + 1} of ${parts.length}`);
      const spoken = await speak(o.engine, t.text, o.voice, file, o.style, o.profile);
      // ElevenLabs says when each word is spoken: kept beside the take, it times the beats exactly.
      if (spoken?.words?.length) writeFileSync(said, JSON.stringify(spoken.words));
      else rmSync(said, { force: true });
      writeFileSync(meta, stamp);
    }
    files.push(file);
  }

  onStep("joining the takes");
  const narration = join(out, "narration.wav");
  const joined = joinTakes(files.map((f) => readWav(f)), GAP_S);
  writeWav(narration, joined);
  const total = joined.channels[0].length / joined.rate;

  // Where each take's words fall: ElevenLabs reports them itself; otherwise they are heard (faster-whisper from
  // OpenVoice's Python, then whisper.cpp) and lined up with the script's words; otherwise read from the voice's own
  // pauses. Every script word gets a start and an end: the beats are cut on them and the captions are drawn from them.
  onStep("timing every beat against the voice");
  let aligned: Timing["aligned"] = "voice";
  const at: ((wordIndex: number) => number)[] = [];
  const spokenWords: NonNullable<Timing["words"]> = [];
  let offset = 0;
  for (const [i, file] of files.entries()) {
    const take = readWav(file);
    const len = take.channels[0].length / take.rate;
    const words = wordsOf(parts[i].text);
    const n = words.length;
    const base = offset;
    const said = join(out, `take-${pad(i + 1)}.words.json`);
    const heardFile = join(out, `take-${pad(i + 1)}.heard.json`);
    const exact: SpokenWord[] = existsSync(said) ? JSON.parse(readFileSync(said, "utf8")) : [];
    let times: { start: number; end: number }[] = [];
    if (exact.length === n) times = exact;
    else {
      // What was heard is kept beside the take, keyed by the take's stamp, so a rebuild doesn't listen again.
      const stamp = readFileSync(join(out, `take-${pad(i + 1)}.txt`), "utf8");
      let heard: { text: string; start: number; end: number }[] = [];
      const kept = existsSync(heardFile) ? (JSON.parse(readFileSync(heardFile, "utf8")) as { stamp: string; words: typeof heard }) : undefined;
      if (kept?.stamp === stamp) heard = kept.words;
      else {
        onStep(`listening to take ${i + 1} for word times`);
        heard = (await hearWords(file)) ?? [];
        if (!heard.length) {
          try {
            heard = (await transcribe(file, "en")).words;
          } catch {
            heard = [];
          }
        }
        if (heard.length) writeFileSync(heardFile, JSON.stringify({ stamp, words: heard }));
      }
      if (heard.length > n / 2) {
        if (aligned === "voice") aligned = "words";
        times = alignText(heard, parts[i].text, "en");
      }
    }
    if (times.length === n) {
      // A boundary falls in the gap between the last word said and the next.
      at.push((k) => (k <= 0 ? base : k >= n ? base + times[n - 1].end : base + (times[k - 1].end + times[k].start) / 2));
    } else {
      const time = fromPauses(file, words);
      at.push((k) => base + time(k));
      times = words.map((_, k) => ({ start: time(k), end: Math.max(time(k) + 0.05, time(k + 1) - 0.05) }));
      aligned = "pauses";
    }
    words.forEach((w, k) => spokenWords.push({ w, start: round(base + times[k].start), end: round(base + times[k].end) }));
    offset += len + (i < files.length - 1 ? GAP_S : 0);
  }

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
  const timing: Timing = { file: narration, voice: o.voice, engine: o.engine, total: round(total), aligned, chapters: chapterTimes, beats, words: spokenWords };
  writeFileSync(join(out, "timing.json"), JSON.stringify(timing, null, 2));
  writeFileSync(join(out, "subtitles.srt"), toSrt(spokenWords));
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

// The voiceover as a subtitle file for YouTube's CC button: lines of up to about 42 letters, broken after a sentence or
// a comma where one is near, each shown until the next begins.
export function toSrt(words: NonNullable<Timing["words"]>): string {
  const lines: (typeof words)[] = [];
  let cur: typeof words = [];
  for (const w of words) {
    const len = cur.map((x) => x.w).join(" ").length;
    if (cur.length && (len + 1 + w.w.length > 42 || w.start - cur.at(-1)!.end > 0.8)) {
      lines.push(cur);
      cur = [];
    }
    cur.push(w);
    if (/[.!?]["')\]]*$/.test(w.w) || (/[,;:]$/.test(w.w) && len > 24)) {
      lines.push(cur);
      cur = [];
    }
  }
  if (cur.length) lines.push(cur);
  const stamp = (t: number) => {
    const ms = Math.max(0, Math.round(t * 1000));
    const p = (v: number, n = 2) => String(v).padStart(n, "0");
    return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  return lines
    .map((l, i) => {
      const next = lines[i + 1]?.[0].start;
      const end = next !== undefined ? Math.min(l.at(-1)!.end + 0.4, next) : l.at(-1)!.end + 0.4;
      return `${i + 1}\n${stamp(l[0].start)} --> ${stamp(end)}\n${l.map((x) => x.w).join(" ")}\n`;
    })
    .join("\n");
}
