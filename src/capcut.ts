import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { promisify } from "node:util";
import { mediaInfo, type MediaInfo } from "./audio.js";
import { T } from "./capcut-template.js";
import { IS_MAC, IS_WIN } from "./platform.js";
import { clipFile, engineOf, stillFile, type Beat, type Production } from "./production.js";
import type { Timing } from "./voiceover.js";

const run = promisify(execFile);

// CapCut keeps every project as a folder of plain JSON here. Version 9.6 on Windows still writes draft_content.json
// unencrypted, which is what makes building a timeline from outside possible at all.
export const DRAFTS_ROOT =
  process.env.FLOW_MCP_CAPCUT_DRAFTS ??
  (IS_WIN
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "CapCut", "User Data", "Projects", "com.lveditor.draft")
    : join(homedir(), "Movies", "CapCut", "User Data", "Projects", "com.lveditor.draft"));

const BACKUP = /^draft_content\.flow-mcp-(\d{8}-\d{6})\.json$/;

export function listCapcutProjects() {
  if (!existsSync(DRAFTS_ROOT)) return { root: DRAFTS_ROOT, projects: [] };
  const projects = readdirSync(DRAFTS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && existsSync(join(DRAFTS_ROOT, d.name, "draft_content.json")))
    .map((d) => {
      const dir = join(DRAFTS_ROOT, d.name);
      const backups = readdirSync(dir).filter((f) => BACKUP.test(f)).sort();
      return { name: d.name, modified: statSync(join(dir, "draft_content.json")).mtime.toISOString(), backups: backups.length, last_backup: backups.at(-1) };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
  return { root: DRAFTS_ROOT, projects };
}

// CapCut holds the project in memory and writes it back on close, which would silently undo everything written here.
export async function capcutRunning(): Promise<boolean> {
  try {
    if (IS_WIN) return /capcut\.exe/i.test((await run("tasklist", ["/FI", "IMAGENAME eq CapCut.exe", "/NH"])).stdout);
    if (IS_MAC) return Boolean((await run("pgrep", ["-x", "CapCut"])).stdout.trim());
  } catch {
    return false;
  }
  return false;
}

/* ---------- small helpers ---------- */

const FRAME = 1e6 / 30;
const us = (s: number) => Math.max(0, Math.round(Math.round((s * 1e6) / FRAME) * FRAME));
const hex = () => randomUUID().replace(/-/g, "");
const clone = <V>(v: V): V => JSON.parse(JSON.stringify(v));
const fwd = (p: string) => p.replace(/\\/g, "/");
const tokens = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
const STOP = new Set(["the", "and", "with", "for", "low", "soft", "slow", "light", "distant", "under", "over", "into", "from", "then", "big", "small", "sfx", "music", "ambient", "ambience", "track", "loop", "version", "muffled", "reverb", "heavy"]);

// Lengths and picture sizes come straight from the file headers (audio.ts), so the build needs nothing installed.
const probed = new Map<string, MediaInfo>();
async function probe(file: string): Promise<MediaInfo> {
  const hit = probed.get(file);
  if (hit) return hit;
  const m = mediaInfo(file);
  probed.set(file, m);
  return m;
}

// A 16:9 plain white picture for the cold open's cut to white, written as a real PNG so nothing has to be shipped.
function whitePng(file: string) {
  if (existsSync(file)) return file;
  const w = 64, h = 36;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((w * 3 + 1) * h, 0xff);
  for (let y = 0; y < h; y++) rows[y * (w * 3 + 1)] = 0;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]));
  return file;
}

/* ---------- the sound library: the user's own files, then Claude's ---------- */

interface Sound {
  file: string;
  kind: "music" | "sfx" | "ambience";
  words: string[];
  own: boolean; // the user's file, preferred over Claude's when both fit a cue
}

// The formats whose length can be read without FFmpeg.
const AUDIO = /\.(mp3|wav|m4a)$/i;

function library(root: string | undefined, own: boolean): Sound[] {
  if (!root || !existsSync(root)) return [];
  const out: Sound[] = [];
  const walk = (dir: string, depth: number) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (AUDIO.test(e.name)) {
        const rel = fwd(relative(root, p)).toLowerCase();
        const kind = /(^|\/)(music|songs?|bgm)\//.test(rel) ? "music" : /(^|\/)(ambien\w*|atmos\w*|room ?tones?|beds?)\//.test(rel) ? "ambience" : "sfx";
        out.push({ file: p, kind, words: tokens(rel.replace(extname(rel), "")), own });
      }
    }
  };
  walk(root, 0);
  return out;
}

// Best file for a cue like "door bang" or "tense low synth pulse": the most shared words, then the shorter name.
function pick(lib: Sound[], cue: string, kinds: Sound["kind"][]): Sound | undefined {
  const want = tokens(cue);
  let best: Sound | undefined;
  let bestScore = 0;
  for (const s of lib) {
    if (!kinds.includes(s.kind)) continue;
    let score = 0;
    for (const w of want) {
      // The mood ("hopeful piano") matters more than the instrument: a sad piano is the wrong track for it.
      const weight = MOODS.has(w) ? 1.5 : 1;
      if (s.words.includes(w)) score += weight;
      else if (s.words.some((x) => (x.length > 3 && w.startsWith(x)) || (w.length > 3 && x.startsWith(w)))) score += 0.6 * weight;
    }
    if (score > 0 && s.own) score += 0.25;
    score -= s.words.length * 0.01;
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return bestScore >= 0.6 ? best : undefined;
}

const MOODS = new Set(["tense", "suspense", "dread", "dark", "ominous", "sad", "melancholy", "emotional", "grief", "somber", "hopeful", "uplifting", "warm", "inspiring", "action", "urgent", "intense", "chase", "eerie", "creepy", "horror", "unsettling", "mystery", "calm", "peaceful", "gentle", "reflective", "nostalgic", "dreamy", "epic", "triumphant", "victory", "heroic"]);

const cueList = (s: string | undefined) =>
  (s ?? "")
    .split(/[,;/]|\band\b/)
    .map((c) => c.replace(/\(.*?\)/g, "").trim())
    .filter((c) => c && !/^(none|n\/a|-)$/i.test(c));

/* ---------- the draft ---------- */

type Json = Record<string, any>;

interface Track {
  name: string;
  type: "video" | "audio" | "text";
  flag: number;
  segments: Json[];
}

export interface BuildOptions {
  dir: string;
  production: Production;
  project: string;
  audio_dir?: string;
  library_dir?: string; // Claude's generated sounds
  music_volume: number;
  sfx_volume: number;
  ambience_volume: number;
  titles: boolean;
  ledger: boolean;
  // Captions drawn as CapCut text: "highlight" (2-3 big words, the spoken one lit up: C3 and Shorts), "line" (one
  // plain line at the bottom), "off" (long-form C5: only the subtitle file for YouTube).
  captions?: "highlight" | "line" | "off";
  // A Short: only beats from..to of the video, its own stretch of the same voiceover, on a 9:16 canvas, with its hook
  // line at the top for the first seconds.
  window?: { from: number; to: number; hook?: string };
  vertical?: boolean;
}

// Cuts the video's timing down to a run of beats, every time measured from the first of them.
function windowed(t: Timing, from: number, to: number): { timing: Timing; offset: number } {
  const k0 = t.beats.findIndex((b) => b.n >= from);
  let k1 = t.beats.length - 1;
  while (k1 >= 0 && t.beats[k1].n > to) k1--;
  if (k0 < 0 || k1 < k0) throw new Error(`Beats ${from}-${to} aren't in this video's voiceover.`);
  const offset = t.beats[k0].start;
  const end = k1 + 1 < t.beats.length ? t.beats[k1 + 1].start : t.total;
  const shift = <X extends { start: number; end: number }>(x: X): X => ({ ...x, start: Math.max(0, x.start - offset), end: Math.min(end, x.end) - offset });
  return {
    offset,
    timing: {
      ...t,
      total: end - offset,
      beats: t.beats.slice(k0, k1 + 1).map(shift),
      chapters: t.chapters.filter((c) => c.end > offset && c.start < end).map(shift),
      words: (t.words ?? []).filter((w) => w.start >= offset - 0.05 && w.start < end).map(shift),
    },
  };
}

export async function buildCapcut(o: BuildOptions) {
  const project = join(DRAFTS_ROOT, o.project);
  const contentFile = join(project, "draft_content.json");
  if (!existsSync(contentFile)) throw new Error(`No CapCut project called "${o.project}" in ${DRAFTS_ROOT}. Create it in CapCut (import your files into it), close CapCut, then try again.`);
  if (await capcutRunning()) throw new Error("CapCut is open. Close CapCut completely first: it saves its own copy of the project when it closes, which would undo this edit.");

  const timingFile = join(o.dir, "voice", "timing.json");
  if (!existsSync(timingFile)) throw new Error("There's no timed voiceover for this video yet. Record the voiceover first: the timeline is built from it.");
  const whole = JSON.parse(readFileSync(timingFile, "utf8")) as Timing;
  if (!existsSync(whole.file)) throw new Error(`The voiceover file is missing: ${whole.file}. Record the voiceover again.`);
  const { timing, offset } = o.window ? windowed(whole, o.window.from, o.window.to) : { timing: whole, offset: 0 };
  // C3 videos are drawn 9:16 and a Short is built 9:16; everything is placed on that canvas.
  const vertical = o.vertical ?? Boolean(o.window);
  const [W, H] = vertical ? [1080, 1920] : [1920, 1080];

  const raw = readFileSync(contentFile, "utf8");
  let draft: Json;
  try {
    draft = JSON.parse(raw);
  } catch {
    throw new Error("This CapCut project's file isn't readable JSON. Newer CapCut versions can encrypt projects; this build only works with projects CapCut saves as plain files (9.6 on Windows does).");
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const backup = join(project, `draft_content.flow-mcp-${stamp}.json`);
  copyFileSync(contentFile, backup);
  const metaFile = join(project, "draft_meta_info.json");
  if (existsSync(metaFile)) copyFileSync(metaFile, join(project, `draft_meta_info.flow-mcp-${stamp}.json`));

  // Keep the ids of anything the user already imported, so CapCut's media panel and timeline point at the same item.
  const known = new Map<string, Json>();
  for (const list of [draft.materials?.videos ?? [], draft.materials?.audios ?? []]) for (const m of list) if (m.path) known.set(fwd(m.path).toLowerCase(), m);

  const materials: Json = { ...clone(T.EMPTY_MATERIALS), ...Object.fromEntries(Object.entries(draft.materials ?? {}).filter(([, v]) => !Array.isArray(v))) };
  const used = new Map<string, Json>();
  const added: { file: string; kind: "photo" | "video" | "music"; width: number; height: number; duration: number }[] = [];

  const refs = (template: Json, fade?: { in: number; out: number }) =>
    Object.entries(template)
      .filter(([type]) => type !== "audio_fades" || fade)
      .map(([type, t]) => {
        const m = clone(t);
        m.id = String(t.id).includes("-") ? randomUUID().toUpperCase() : hex();
        if (type === "audio_fades" && fade) {
          m.fade_in_duration = us(fade.in);
          m.fade_out_duration = us(fade.out);
        }
        materials[type].push(m);
        return m.id as string;
      });

  async function visual(file: string, kind: "photo" | "video"): Promise<Json> {
    const key = fwd(file).toLowerCase();
    if (used.has(key)) return used.get(key)!;
    const info = await probe(file);
    let m: Json = known.get(key) as Json;
    if (m && m.type === kind) m = clone(m);
    else {
      m = clone(kind === "photo" ? T.PHOTO : T.VIDEO);
      m.id = m.material_id = m.local_material_id = hex();
      m.unique_id = hex();
      m.path = fwd(file);
      m.material_name = basename(file);
      m.width = info.width;
      m.height = info.height;
      m.has_audio = kind === "video" && info.audio;
      m.duration = kind === "photo" ? 10_800_000_000 : us(info.duration);
      added.push({ file, kind, width: info.width, height: info.height, duration: kind === "photo" ? 5_000_000 : us(info.duration) });
    }
    materials.videos.push(m);
    used.set(key, m);
    return m;
  }

  async function sound(file: string): Promise<{ m: Json; seconds: number }> {
    const key = fwd(file).toLowerCase();
    const info = await probe(file);
    if (used.has(key)) return { m: used.get(key)!, seconds: info.duration };
    let m: Json = known.get(key) as Json;
    if (m && /music|sound|record|extract/.test(String(m.type))) m = clone(m);
    else {
      m = clone(T.AUDIO);
      m.id = m.music_id = m.local_material_id = hex();
      m.unique_id = hex();
      m.name = basename(file);
      m.path = fwd(file);
      m.duration = us(info.duration);
      added.push({ file, kind: "music", width: 0, height: 0, duration: us(info.duration) });
    }
    materials.audios.push(m);
    used.set(key, m);
    return { m, seconds: info.duration };
  }

  const tracks: Track[] = [
    { name: "Main", type: "video", flag: 0, segments: [] },
    { name: "Voiceover", type: "audio", flag: 0, segments: [] },
    { name: "Flash", type: "video", flag: 2, segments: [] },
    { name: "Music", type: "audio", flag: 0, segments: [] },
    { name: "Music B", type: "audio", flag: 0, segments: [] },
    { name: "Ambience", type: "audio", flag: 0, segments: [] },
    { name: "SFX 1", type: "audio", flag: 0, segments: [] },
    { name: "SFX 2", type: "audio", flag: 0, segments: [] },
    { name: "SFX 3", type: "audio", flag: 0, segments: [] },
    { name: "SFX 4", type: "audio", flag: 0, segments: [] },
    { name: "Titles", type: "text", flag: 0, segments: [] },
    { name: "Ledger", type: "text", flag: 0, segments: [] },
    { name: "Captions", type: "text", flag: 0, segments: [] },
  ];
  const track = (name: string) => tracks.find((t) => t.name === name)!;
  const indexOf = (t: Track) => tracks.indexOf(t);

  const kf = (property_type: string, points: [number, number][]) => ({
    id: hex(),
    material_id: "",
    property_type,
    keyframe_list: points.map(([t, v]) => ({ id: hex(), curveType: "Line", time_offset: Math.round(t), left_control: { x: 0, y: 0 }, right_control: { x: 0, y: 0 }, values: [v], string_value: "", graphID: "" })),
  });

  // CapCut fits a picture inside the canvas at scale 1; this is the scale that fills it instead (1 when the shapes match,
  // about 3.2 for a 16:9 still on a 9:16 Short).
  const fill = (m: Json) => (m.width && m.height ? Math.max(W / m.width, H / m.height) / Math.min(W / m.width, H / m.height) : 1);

  function videoSeg(t: Track, m: Json, start: number, dur: number, keyframes: Json[] = [], scale = 1, x = 0, y = 0, sourceStart = 0) {
    const s = clone(T.VIDEO_SEG);
    Object.assign(s, {
      id: hex(),
      material_id: m.id,
      source_timerange: { start: sourceStart, duration: dur },
      target_timerange: { start, duration: dur },
      extra_material_refs: refs(T.VIDEO_REFS),
      render_index: t.name === "Main" ? 0 : 1,
      track_render_index: indexOf(t),
      volume: m.type === "video" ? 0 : 1,
      common_keyframes: keyframes,
    });
    s.clip.scale = { x: scale, y: scale };
    s.clip.transform = { x, y };
    t.segments.push(s);
    return s;
  }

  function audioSeg(t: Track, m: Json, start: number, dur: number, volume: number, sourceStart = 0, fade?: { in: number; out: number }) {
    const s = clone(T.AUDIO_SEG);
    Object.assign(s, {
      id: hex(),
      material_id: m.id,
      source_timerange: { start: sourceStart, duration: dur },
      target_timerange: { start, duration: dur },
      extra_material_refs: refs(T.AUDIO_REFS, fade),
      track_render_index: indexOf(t),
      volume,
    });
    t.segments.push(s);
    return s;
  }

  const fontPath = findFont(draft);
  let textCount = 0;
  function textSeg(t: Track, text: string, start: number, dur: number, look: { size: number; color: [number, number, number]; x: number; y: number }) {
    const m = clone(T.TEXT);
    m.id = hex();
    m.font_path = fontPath;
    m.font_size = look.size;
    m.content = JSON.stringify({
      styles: [
        {
          fill: { alpha: 1.0, content: { render_type: "solid", solid: { alpha: 1.0, color: look.color } } },
          range: [0, text.length],
          size: look.size,
          bold: true,
          italic: false,
          underline: false,
          strokes: [{ content: { solid: { alpha: 1.0, color: [0.0, 0.0, 0.0] } }, width: 0.11 }],
        },
      ],
      text,
    });
    materials.texts.push(m);
    const s = clone(T.TEXT_SEG);
    Object.assign(s, {
      id: hex(),
      material_id: m.id,
      target_timerange: { start, duration: dur },
      render_index: 15000 + textCount++,
      track_render_index: indexOf(t),
      common_keyframes: [kf("KFTypeAlpha", [[0, 0], [Math.min(220_000, dur / 4), 1], [Math.max(dur - 300_000, dur / 2), 1], [dur, 0]])],
    });
    s.clip.transform = { x: look.x, y: look.y };
    t.segments.push(s);
  }

  // A caption: bold white with a dark outline, no fade (captions follow each other edge to edge), and optionally one
  // stretch of it lit up yellow, the word being spoken.
  function captionSeg(t: Track, text: string, start: number, dur: number, size: number, y: number, lit?: [number, number]) {
    const look = (range: [number, number], color: number[]) => ({
      fill: { alpha: 1.0, content: { render_type: "solid", solid: { alpha: 1.0, color } } },
      range,
      size,
      bold: true,
      italic: false,
      underline: false,
      strokes: [{ content: { solid: { alpha: 1.0, color: [0.0, 0.0, 0.0] } }, width: 0.14 }],
    });
    const white = [1, 1, 1];
    const styles = lit
      ? ([[0, lit[0]], lit, [lit[1], text.length]] as [number, number][]).filter(([a, b]) => b > a).map((r) => look(r, r === lit ? [1, 0.84, 0.18] : white))
      : [look([0, text.length], white)];
    const m = clone(T.TEXT);
    m.id = hex();
    m.font_path = fontPath;
    m.font_size = size;
    m.content = JSON.stringify({ styles, text });
    materials.texts.push(m);
    const s = clone(T.TEXT_SEG);
    Object.assign(s, { id: hex(), material_id: m.id, target_timerange: { start, duration: dur }, render_index: 15000 + textCount++, track_render_index: indexOf(t), common_keyframes: [] });
    s.clip.transform = { x: 0, y };
    t.segments.push(s);
  }

  /* ---- 1. picture: one still (or hero clip) per beat, cut to the voice ---- */
  const beats = new Map((o.production.beats ?? []).map((b) => [b.n, b]));
  const report = { stills: 0, clips: 0, held_stills: 0, missing_stills: [] as number[], music: [] as string[], ambience: [] as string[], sfx_placed: 0, sfx_skipped: [] as string[], titles: 0, ledger: 0, captions: 0, warnings: [] as string[] };
  const main = track("Main");
  const order: Beat["move"][] = ["push_in", "pan_left", "pull_out", "pan_right"];
  let lastMove: Beat["move"] | undefined;
  let prevStill: string | undefined;

  for (const [k, bt] of timing.beats.entries()) {
    const b = beats.get(bt.n);
    const start = us(bt.start);
    const end = k === timing.beats.length - 1 ? us(timing.total) : us(timing.beats[k + 1].start);
    let dur = end - start;
    if (dur < FRAME) continue;
    let at = start;
    const clip = b?.hero ? clipFile(o.dir, bt.n) : undefined;
    if (clip) {
      const m = await visual(clip, "video");
      const len = Math.min(us((await probe(clip)).duration), dur);
      const still = stillFile(o.dir, bt.n);
      if (still && dur - len >= FRAME) {
        // The beat outlasts its clip: its own still comes first, easing out to full frame, and the clip (whose first
        // frame IS that still) takes over at the end of the beat, so the hand-over can't be seen.
        const hold = dur - len;
        const sm = await visual(still, "photo");
        const f = fill(sm);
        videoSeg(main, sm, at, hold, [kf("KFTypeScaleX", [[0, 1.08 * f], [hold, 1.0 * f]])], 1.08 * f);
        report.held_stills++;
        at += hold;
      } else if (len < dur) report.warnings.push(`Beat ${bt.n}: its clip is shorter than the beat and its still is missing, so the picture goes black for ${((dur - len) / 1e6).toFixed(1)} s.`);
      videoSeg(main, m, at, len, [], fill(m));
      report.clips++;
      prevStill = still ?? prevStill;
      continue;
    }
    let still = stillFile(o.dir, bt.n);
    if (!still) {
      report.missing_stills.push(bt.n);
      still = prevStill;
      if (!still) continue;
    }
    prevStill = still;
    let move = b?.move;
    if (!move) move = order[(order.indexOf(lastMove) + 1) % order.length];
    lastMove = move;
    const m = await visual(still, "photo");
    const [frames, scale, x, y] = motion(move, dur, kf, fill(m));
    videoSeg(main, m, at, dur, frames, scale, x, y);
    report.stills++;
  }

  /* ---- 2. the voice ---- */
  const vo = await sound(timing.file);
  if (o.window) audioSeg(track("Voiceover"), vo.m, 0, Math.min(us(timing.total), us(vo.seconds) - us(offset)), 1.0, us(offset));
  else audioSeg(track("Voiceover"), vo.m, 0, us(vo.seconds), 1.0);

  /* ---- 3. cut to white at the end of the cold open ---- */
  if (timing.chapters.length > 1 && /cold/i.test(timing.chapters[0].marker)) {
    const white = await visual(whitePng(join(o.dir, "edit", "white.png")), "photo");
    const dur = us(1.333);
    videoSeg(track("Flash"), white, Math.max(0, us(timing.chapters[0].end) - us(0.4)), dur, [kf("KFTypeAlpha", [[0, 0], [200_000, 1], [410_000, 1], [dur - 20_000, 0]])]);
  }

  /* ---- 4. music, ambience and sound effects from the user's library ---- */
  const lib = [...library(o.audio_dir, true), ...library(o.library_dir, false)];
  if (!lib.length) report.warnings.push("No sound files were found, so music and sound effects were skipped.");
  // Claude's files carry long synonym names for matching; the report calls them by their first word.
  const label = (file: string) => (lib.find((x) => x.file === file)?.own === false ? `Claude's ${basename(file).split("_")[0]}` : basename(file));
  const soundOf = (marker: string) => (o.production.sound ?? []).find((s) => s.chapter === marker);
  const flashback = (marker: string) => /flashback/i.test(marker) || Boolean(o.production.script?.chapters.find((c) => c.marker === marker)?.flashback);

  if (lib.some((s) => s.kind === "music")) {
    // Chapters that ask for the same track share one long piece; a new track crossfades in on the other music lane.
    const groups: { file: string; start: number; end: number; flash: boolean }[] = [];
    let current: Sound | undefined;
    for (const ch of timing.chapters) {
      const cue = soundOf(ch.marker)?.music;
      const found = cue ? pick(lib, cue, ["music"]) : undefined;
      if (cue && !found) report.sfx_skipped.push(`music for ${ch.marker}: "${cue}"`);
      current = found ?? current ?? lib.find((s) => s.kind === "music");
      const last = groups.at(-1);
      if (last && last.file === current!.file && last.flash === flashback(ch.marker)) last.end = ch.end;
      else groups.push({ file: current!.file, start: ch.start, end: ch.end, flash: flashback(ch.marker) });
    }
    for (const [i, g] of groups.entries()) {
      const lane = track(i % 2 ? "Music B" : "Music");
      const m = await sound(g.file);
      const from = us(Math.max(0, g.start - (i ? 0.75 : 0)));
      const to = us(Math.min(timing.total, g.end + (i < groups.length - 1 ? 0.75 : 0)));
      const vol = o.music_volume * (g.flash ? 0.7 : 1);
      loop(lane, m, from, to, vol, { in: i ? 1.0 : 0.4, out: i < groups.length - 1 ? 1.2 : 2.0 });
      report.music.push(`${label(g.file)} ${fmt(from)}-${fmt(to)}`);
    }
  }

  for (const ch of timing.chapters) {
    const cue = soundOf(ch.marker)?.ambient;
    if (!cue) continue;
    const found = pick(lib, cue, ["ambience", "sfx"]);
    if (!found) {
      if (lib.length) report.sfx_skipped.push(`ambience for ${ch.marker}: "${cue}"`);
      continue;
    }
    loop(track("Ambience"), await sound(found.file), us(ch.start), us(ch.end), o.ambience_volume, { in: 0.8, out: 0.8 });
    report.ambience.push(`${label(found.file)} in ${ch.marker}`);
  }

  // Each beat's own effects land just after it starts; a chapter's listed effects go to the beat whose words fit best.
  const placements: { beat: number; cue: string }[] = [];
  for (const bt of timing.beats) for (const cue of beats.get(bt.n)?.sfx ?? []) placements.push({ beat: bt.n, cue });
  for (const ch of timing.chapters) {
    const inChapter = timing.beats.filter((b) => b.chapter === ch.marker);
    if (!inChapter.length) continue;
    for (const [i, cue] of cueList(soundOf(ch.marker)?.sfx).entries()) {
      if (placements.some((p) => tokens(p.cue).join() === tokens(cue).join() && inChapter.some((b) => b.n === p.beat))) continue;
      const want = tokens(cue);
      const scored = inChapter.map((b) => {
        const bb = beats.get(b.n);
        const words = tokens(`${bb?.text ?? ""} ${bb?.still_prompt?.match(/COMPOSITION:([^]*?)(NEGATIVE PROMPT|$)/)?.[1] ?? ""}`);
        return { n: b.n, score: want.filter((w) => words.includes(w)).length };
      });
      const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
      placements.push({ beat: best.score ? best.n : inChapter[Math.min(inChapter.length - 1, Math.floor(((i + 0.5) * inChapter.length) / Math.max(1, cueList(soundOf(ch.marker)?.sfx).length)))].n, cue });
    }
  }
  const lanes = ["SFX 1", "SFX 2", "SFX 3", "SFX 4"].map(track);
  const perBeat = new Map<number, number>();
  for (const pl of placements) {
    const found = pick(lib, pl.cue, ["sfx", "ambience"]);
    if (!found) {
      if (lib.length) report.sfx_skipped.push(`beat ${pl.beat}: "${pl.cue}"`);
      continue;
    }
    const bt = timing.beats.find((b) => b.n === pl.beat)!;
    const nth = perBeat.get(pl.beat) ?? 0;
    perBeat.set(pl.beat, nth + 1);
    const fx = await sound(found.file);
    const start = us(bt.start + 0.3 + nth * 0.5);
    const dur = Math.min(us(fx.seconds), us(6), us(timing.total) - start);
    if (dur < FRAME) continue;
    const lane = lanes.find((l) => l.segments.every((s) => s.target_timerange.start + s.target_timerange.duration <= start || s.target_timerange.start >= start + dur));
    if (!lane) {
      report.sfx_skipped.push(`beat ${pl.beat}: "${pl.cue}" (four effects already playing)`);
      continue;
    }
    audioSeg(lane, fx.m, start, dur, o.sfx_volume);
    report.sfx_placed++;
  }

  /* ---- 5. text: day markers and ledger numbers (added in editing, never drawn into the stills) ---- */
  if (o.titles) {
    for (const ch of timing.chapters) {
      const label = ch.marker.replace(/\(.*?\)/g, "").trim();
      if (!/\b(day|week|month|hour|year)s?\b/i.test(label)) continue;
      if (o.window?.hook && ch.start < 3.5) continue;
      textSeg(track("Titles"), label.toUpperCase(), us(ch.start + 0.27), Math.min(us(3.5), us(ch.end - ch.start)), { size: 15, color: [1, 1, 1], x: vertical ? 0 : -0.05, y: vertical ? 0.62 : 0.72 });
      report.titles++;
    }
  }
  // C3 videos carry one headline over the opening, plain white, centred low, for 2.5 s (the C3 engine's edit rule).
  const c3 = engineOf(o.production) === "c3";
  if (o.ledger) {
    for (const bt of timing.beats) {
      const text = beats.get(bt.n)?.overlay?.trim();
      if (!text || /^(none|-|n\/a)$/i.test(text)) continue;
      if (c3) {
        textSeg(track("Titles"), text.toUpperCase(), us(bt.start + 0.2), Math.min(us(2.5), us(bt.end - bt.start)), { size: 15, color: [1, 1, 1], x: 0, y: vertical ? 0.58 : -0.62 });
        report.titles++;
        continue;
      }
      if (/^day\s*[-+]?\d+$/i.test(text) && timing.chapters.some((c) => c.start === bt.start)) continue;
      const dur = Math.min(us(5), us(bt.end - bt.start) - us(0.4));
      if (dur < us(1)) continue;
      textSeg(track("Ledger"), text.toUpperCase(), us(bt.start + 0.3), dur, { size: 12, color: [1, 0.77, 0.24], x: vertical ? 0 : -0.6, y: vertical ? 0.42 : -0.74 });
      report.ledger++;
    }
  }

  /* ---- 6. a Short's hook line, at the top for its first seconds ---- */
  if (o.window?.hook) {
    textSeg(track("Titles"), o.window.hook.toUpperCase(), 0, Math.min(us(3.5), us(timing.total)), { size: 14, color: [1, 1, 1], x: 0, y: 0.62 });
    report.titles++;
  }

  /* ---- 7. captions from the voiceover's word times, spelled as the script has them ---- */
  const style = o.captions ?? "off";
  const words = timing.words ?? [];
  if (style !== "off" && !words.length) report.warnings.push("This voiceover has no word times yet, so no captions were added. Record the voiceover again to get them.");
  if (style !== "off" && words.length) {
    const show = (w: string) => w.replace(/^["'(\[]+|[.,;:"')\]]+$/g, "");
    const groups: (typeof words)[] = [];
    let cur: typeof words = [];
    const most = style === "highlight" ? 3 : 7;
    for (const w of words) {
      if (cur.length && (cur.length >= most || w.start - cur.at(-1)!.end > 0.6)) {
        groups.push(cur);
        cur = [];
      }
      cur.push(w);
      if (/[.!?,;:]["')\]]*$/.test(w.w) && (style === "highlight" || cur.length >= 4)) {
        groups.push(cur);
        cur = [];
      }
    }
    if (cur.length) groups.push(cur);
    const lane = track("Captions");
    const [size, y] = style === "highlight" ? [vertical ? 13 : 12, vertical ? -0.3 : -0.55] : [vertical ? 9 : 8, vertical ? -0.3 : -0.82];
    for (const [g, list] of groups.entries()) {
      const text = list.map((w) => (style === "highlight" ? show(w.w).toUpperCase() : show(w.w))).join(" ");
      const groupEnd = Math.min(list.at(-1)!.end + 0.3, groups[g + 1]?.[0].start ?? timing.total, timing.total);
      if (style === "line") {
        captionSeg(lane, text, us(list[0].start), us(groupEnd) - us(list[0].start), size, y);
        report.captions++;
        continue;
      }
      // One piece per word: the whole group stays up and the spoken word is lit, so it reads like a karaoke line.
      let from = 0;
      for (const [k, w] of list.entries()) {
        const piece = show(w.w).toUpperCase();
        const at = text.indexOf(piece, from);
        if (at >= 0) from = at + piece.length;
        const start = us(w.start);
        const end = us(k + 1 < list.length ? list[k + 1].start : groupEnd);
        if (end - start < FRAME) continue;
        captionSeg(lane, text, start, end - start, size, y, at >= 0 ? [at, at + piece.length] : undefined);
      }
      report.captions++;
    }
  }

  function loop(lane: Track, { m, seconds }: { m: Json; seconds: number }, from: number, to: number, volume: number, fade: { in: number; out: number }) {
    const len = us(seconds);
    if (len < FRAME) return;
    for (let at = from, first = true; at < to - FRAME; first = false) {
      const dur = Math.min(len, to - at);
      const last = at + dur >= to - FRAME;
      audioSeg(lane, m, at, dur, volume, 0, { in: first ? fade.in : 0.3, out: last ? fade.out : 0.3 });
      at += dur;
    }
  }

  /* ---- write ---- */
  const used_tracks = tracks.filter((t) => t.segments.length);
  const duration = Math.max(0, ...used_tracks.flatMap((t) => t.segments.map((s) => s.target_timerange.start + s.target_timerange.duration)));
  draft.materials = materials;
  draft.tracks = used_tracks.map((t, i) => {
    for (const s of t.segments) s.track_render_index = i;
    return { id: hex(), type: t.type, flag: t.flag, attribute: 0, name: t.name, is_default_name: false, segments: t.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start) };
  });
  draft.duration = duration;
  draft.canvas_config = { ...(draft.canvas_config ?? {}), ratio: "original", width: W, height: H };
  const text = JSON.stringify(draft);

  // CapCut 9.6 keeps the same timeline in several files (the main one, a copy under Timelines/<id>/, and template-2.tmp
  // working copies). Every copy that matched the main file before is updated, so CapCut opens the new edit whichever it reads.
  const mirrors = [contentFile, join(project, "template-2.tmp")];
  const tl = draft.id ? join(project, "Timelines", String(draft.id)) : "";
  if (tl && existsSync(tl)) mirrors.push(join(tl, "draft_content.json"), join(tl, "template-2.tmp"));
  const written: string[] = [];
  for (const f of mirrors) {
    if (f !== contentFile && !(existsSync(f) && readFileSync(f, "utf8") === raw)) continue;
    writeFileSync(f, text);
    written.push(relative(project, f));
  }
  if (existsSync(metaFile)) updateMeta(metaFile, duration, added);

  const narration = timing.total;
  const summary = {
    project: o.project,
    backup: basename(backup),
    runtime: fmt(duration),
    narration: fmt(us(narration)),
    ...report,
    files_written: written,
  };
  writeFileSync(join(o.dir, "capcut-report.json"), JSON.stringify(summary, null, 2));
  return summary;
}

// f is the scale that fills the canvas (see fill). On a Short a widescreen still is far wider than the frame, so a pan
// travels further across it, keeping the middle of the picture, where the subject usually is, in view.
function motion(move: Beat["move"], dur: number, kf: (p: string, pts: [number, number][]) => Json, f = 1): [Json[], number, number, number] {
  const [frames, scale, x, y] = baseMotion(move, dur, kf);
  if (f === 1) return [frames, scale, x, y];
  const pan = f > 1.5 ? 4 : 1;
  for (const k of frames) for (const p of k.keyframe_list) p.values = p.values.map((v: number) => (k.property_type === "KFTypeScaleX" ? v * f : k.property_type === "KFTypePositionX" ? v * pan : v));
  return [frames, scale * f, x * pan, y];
}

function baseMotion(move: Beat["move"], dur: number, kf: (p: string, pts: [number, number][]) => Json): [Json[], number, number, number] {
  switch (move) {
    case "pull_out":
      return [[kf("KFTypeScaleX", [[0, 1.13], [dur, 1.03]])], 1.13, 0, 0];
    case "pan_left":
      return [[kf("KFTypeScaleX", [[0, 1.12], [dur, 1.12]]), kf("KFTypePositionX", [[0, 0.08], [dur, -0.08]])], 1.12, 0.08, 0];
    case "pan_right":
      return [[kf("KFTypeScaleX", [[0, 1.12], [dur, 1.12]]), kf("KFTypePositionX", [[0, -0.08], [dur, 0.08]])], 1.12, -0.08, 0];
    case "hold":
      return [[kf("KFTypeScaleX", [[0, 1.03], [dur, 1.06]])], 1.03, 0, 0];
    case "shake": {
      // An impact: a fast push with a short decaying tremble, the way the RebornCousin edit hit its big moments.
      const shake = Math.min(dur, 1_600_000);
      const xs: [number, number][] = [];
      const ys: [number, number][] = [];
      for (let t = 0, i = 0; t <= shake; t += 80_000, i++) {
        const a = 0.012 * (1 - t / shake);
        xs.push([t, i % 2 ? -a : a]);
        ys.push([t, (i % 3) - 1 ? a * 0.8 : -a * 0.8]);
      }
      return [[kf("KFTypeScaleX", [[0, 1.1], [dur, 1.2]]), kf("KFTypePositionX", xs), kf("KFTypePositionY", ys)], 1.1, xs[0][1], ys[0][1]];
    }
    case "push_in":
    default:
      return [[kf("KFTypeScaleX", [[0, 1.03], [dur, 1.13]])], 1.03, 0, 0];
  }
}

// Text needs a font file. Use whatever the project already uses, else CapCut's own system font for the newest install.
function findFont(draft: Json): string {
  for (const t of draft.materials?.texts ?? []) if (t.font_path) return t.font_path;
  const apps = join(dirname(dirname(dirname(DRAFTS_ROOT))), "Apps");
  if (existsSync(apps)) {
    for (const v of readdirSync(apps).sort().reverse()) {
      const f = join(apps, v, "Resources", "Font", "SystemFont", "en.ttf");
      if (existsSync(f)) return fwd(f);
    }
  }
  return "";
}

// The media panel lists what draft_meta_info.json holds; new files are added there so they show up beside the user's own.
function updateMeta(file: string, duration: number, added: { file: string; kind: "photo" | "video" | "music"; width: number; height: number; duration: number }[]) {
  const meta = JSON.parse(readFileSync(file, "utf8")) as Json;
  meta.tm_duration = duration;
  meta.tm_draft_modified = Date.now() * 1000;
  let group = (meta.draft_materials ?? []).find((g: Json) => g.type === 0);
  if (!group) {
    group = { type: 0, value: [] };
    (meta.draft_materials ??= []).unshift(group);
  }
  const have = new Set(group.value.map((v: Json) => fwd(String(v.file_Path)).toLowerCase()));
  const now = Math.floor(Date.now() / 1000);
  for (const a of added) {
    if (have.has(fwd(a.file).toLowerCase())) continue;
    group.value.push({
      ai_group_type: "",
      create_time: now,
      duration: a.duration,
      enter_from: 0,
      extra_info: basename(a.file),
      file_Path: fwd(a.file),
      height: a.height,
      id: randomUUID(),
      import_time: now,
      import_time_ms: Date.now() * 1000,
      item_source: 1,
      material_color_tag: "",
      md5: "",
      metetype: a.kind,
      roughcut_time_range: { duration: a.duration, start: 0 },
      sub_time_range: { duration: -1, start: -1 },
      type: 0,
      width: a.width,
    });
  }
  writeFileSync(file, JSON.stringify(meta));
}

// Puts the project back exactly as it was before the last build (or a named backup).
export async function restoreCapcut(projectName: string, backupName?: string) {
  const project = join(DRAFTS_ROOT, projectName);
  if (!existsSync(project)) throw new Error(`No CapCut project called "${projectName}".`);
  if (await capcutRunning()) throw new Error("Close CapCut first, then restore.");
  const list = readdirSync(project).filter((f) => BACKUP.test(f)).sort();
  const name = backupName ?? list.at(-1);
  if (!name || !list.includes(name)) throw new Error("There's no flow-mcp backup in that project to restore.");
  const content = join(project, "draft_content.json");
  const current = readFileSync(content, "utf8");
  const text = readFileSync(join(project, name), "utf8");
  const draft = JSON.parse(text) as Json;
  const targets = [content, join(project, "template-2.tmp")];
  const tl = draft.id ? join(project, "Timelines", String(draft.id)) : "";
  if (tl && existsSync(tl)) targets.push(join(tl, "draft_content.json"), join(tl, "template-2.tmp"));
  for (const f of targets) if (f === content || (existsSync(f) && readFileSync(f, "utf8") === current)) writeFileSync(f, text);
  const meta = join(project, name.replace("draft_content", "draft_meta_info"));
  if (existsSync(meta)) copyFileSync(meta, join(project, "draft_meta_info.json"));
  return { restored: name, project: projectName };
}

const fmt = (u: number) => {
  const s = Math.round(u / 1e6);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// A Short gets its own CapCut project, made the way CapCut's own Duplicate does it: the main project's folder copied
// under the new name (without flow-mcp's backups), with a new draft id and its name and folder written into its
// draft_meta_info.json and into the drafts list CapCut keeps in root_meta_info.json (backed up first). The build then
// replaces the copied timeline with the Short's own. Nothing is done if the project already exists.
export async function duplicateCapcut(from: string, name: string): Promise<{ created: boolean; project: string }> {
  const src = join(DRAFTS_ROOT, from);
  const dst = join(DRAFTS_ROOT, name);
  if (existsSync(join(dst, "draft_content.json"))) return { created: false, project: name };
  if (!existsSync(join(src, "draft_content.json"))) throw new Error(`No CapCut project called "${from}" to copy the Short from.`);
  if (/[<>:"/\\|?*]/.test(name)) throw new Error(`"${name}" can't be a folder name.`);
  if (await capcutRunning()) throw new Error("CapCut is open. Close CapCut completely first, then make the Short.");
  const skip = /^(draft_content|draft_meta_info|template-2)\.(flow-mcp-|backup|before|capcut-saved|tanya).*|\.bak$/i;
  const copy = (a: string, b: string) => {
    mkdirSync(b, { recursive: true });
    for (const e of readdirSync(a, { withFileTypes: true })) {
      if (e.isDirectory()) copy(join(a, e.name), join(b, e.name));
      else if (!skip.test(e.name)) copyFileSync(join(a, e.name), join(b, e.name));
    }
  };
  copy(src, dst);
  const id = randomUUID().toUpperCase();
  const now = Date.now() * 1000;
  const metaFile = join(dst, "draft_meta_info.json");
  if (existsSync(metaFile)) {
    const meta = JSON.parse(readFileSync(metaFile, "utf8")) as Json;
    Object.assign(meta, { draft_id: id, draft_name: name, draft_fold_path: fwd(dst), tm_draft_create: now, tm_draft_modified: now });
    writeFileSync(metaFile, JSON.stringify(meta));
  }
  const rootFile = join(DRAFTS_ROOT, "root_meta_info.json");
  if (existsSync(rootFile)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    copyFileSync(rootFile, join(DRAFTS_ROOT, `root_meta_info.flow-mcp-${stamp}.json`));
    const root = JSON.parse(readFileSync(rootFile, "utf8")) as Json;
    const list: Json[] = root.all_draft_store ?? [];
    const base = list.find((d) => d.draft_name === from) ?? list[0];
    if (base) {
      const folder = fwd(dst);
      list.unshift({
        ...clone(base),
        draft_id: id,
        draft_name: name,
        draft_fold_path: folder,
        draft_json_file: `${folder}\\draft_content.json`,
        draft_cover: `${folder}\\draft_cover.jpg`,
        tm_draft_create: now,
        tm_draft_modified: now,
      });
      root.all_draft_store = list;
      if (Array.isArray(root.draft_ids)) root.draft_ids.unshift(id);
      else if (typeof root.draft_ids === "number") root.draft_ids += 1;
      writeFileSync(rootFile, JSON.stringify(root));
    }
  }
  return { created: true, project: name };
}
