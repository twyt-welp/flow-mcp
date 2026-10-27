import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// One video of the C5 Reborn engine lives in one folder, and production.json in it is the single record of where that
// video stands: Claude writes the engine's text into it (ideas, script, locks, beat map, prompts, branding), and every
// Flow, voice and CapCut step reads its prompts from it. Files follow fixed names, so what exists on disk IS the
// progress and nothing has to be written back when a job lands:
//   sheets/<id>.png   stills/scene-NN.png   clips/scene-NN.mp4   voice/narration.wav + timing.json   thumbs/thumb-N.png

export const MOVES = ["push_in", "pull_out", "pan_left", "pan_right", "hold", "shake"] as const;

const beat = z.object({
  n: z.number().int().min(1).describe("Beat number; still N is beat N."),
  chapter: z.string().describe("Chapter marker exactly as in the script, e.g. 'COLD OPEN' or 'DAY -30'."),
  text: z.string().describe("The beat's exact spoken words from the script (20-30 words). Used to time the beat against the voiceover."),
  shot: z.string().optional(),
  base: z.string().optional().describe("Base version: past life, 1, 2, 3 or away."),
  flashback: z.boolean().optional(),
  who: z.string().optional(),
  hero: z.boolean().optional().describe("A star beat: it also gets a 6-second animated clip."),
  still_prompt: z.string().optional().describe("The full, self-contained still prompt (locks pasted word for word, ends with its NEGATIVE PROMPT)."),
  clip_prompt: z.string().optional().describe("Hero beats only: the full clip prompt."),
  move: z.enum(MOVES).optional().describe("Edit move for the still in CapCut."),
  overlay: z.string().optional().describe("On-screen overlay text from the edit note (a ledger number or countdown), or empty for none."),
  sfx: z.array(z.string()).optional().describe("Sound effects that land on this beat, in plain words ('door bang', 'cans clinking')."),
});

const sheet = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/).describe("File name without extension: 'mascot', 'sister', 'threat', 'base'."),
  kind: z.enum(["mascot", "character", "threat", "base"]),
  handle: z.string().optional().describe("@YOU, @SISTER ..."),
  lock: z.string().optional().describe("The lock text (MASCOT LOCK, CHARACTER LOCK, THREAT LOCK or the four BASE LOCK paragraphs)."),
  prompt: z.string().describe("The full sheet image prompt."),
});

export const productionShape = z.object({
  title: z.string().optional(),
  state: z.string().optional().describe("Where the engine is: ideas, script, cast, beats, stills, clips, voice, capcut, thumbnails, branding, done."),
  my_topics: z.array(z.string()).optional().describe("The user's own topic list, typed in Flow Studio: STATE 1 builds its ideas from these first."),
  topics: z.array(z.object({ n: z.number().int(), title: z.string(), hook: z.string().optional() })).optional(),
  picked: z.union([z.number().int(), z.string()]).optional().describe("The idea number picked in STATE 1, or the user's own scenario."),
  script: z
    .object({
      chapters: z.array(z.object({ marker: z.string(), flashback: z.boolean().optional(), text: z.string() })),
      ledger: z.string().optional(),
      contrasts: z.string().optional(),
    })
    .optional(),
  sheets: z.array(sheet).optional(),
  beats: z.array(beat).optional(),
  sound: z.array(z.object({ chapter: z.string(), music: z.string().optional(), sfx: z.string().optional(), ambient: z.string().optional() })).optional(),
  thumbnails: z.array(z.object({ n: z.number().int().min(1).max(9), template: z.string(), prompt: z.string() })).optional(),
  overlay_text: z.array(z.string()).optional(),
  branding: z
    .object({ titles: z.array(z.string()).optional(), description: z.string().optional(), hashtags: z.array(z.string()).optional(), next: z.string().optional() })
    .optional(),
  settings: z
    .object({
      max_credits: z.number().int().min(0).optional(),
      voice: z.string().optional(),
      style: z.string().optional(),
      capcut_project: z.string().optional(),
    })
    .optional(),
});

export type Production = z.infer<typeof productionShape> & { video: string; updated?: string };
export type Beat = z.infer<typeof beat>;

export const FILE = "production.json";
export const pad = (n: number) => String(n).padStart(2, "0");
export const sub = (dir: string, ...parts: string[]) => join(dir, ...parts);
export const stillFile = (dir: string, n: number) => firstExisting(join(dir, "stills"), `scene-${pad(n)}`, /\.(png|jpe?g|webp)$/i);
export const clipFile = (dir: string, n: number) => firstExisting(join(dir, "clips"), `scene-${pad(n)}`, /\.(mp4|mov|webm)$/i);
export const sheetFile = (dir: string, id: string) => firstExisting(join(dir, "sheets"), id, /\.(png|jpe?g|webp)$/i);
// The channel's own mascot sheet, kept with the code in <flow-mcp>/channel/sheets/mascot.(png|jpg|webp) (the user's
// picture, 2026-10-27; not in git). Every video's folder sits in the output root, beside _channel, so a video finds the
// mascot here first (it beats any mascot drawn earlier); it is copied into _channel/sheets so the panel (which only
// serves the output folder) can show it. Without it, the video's own sheet, then the channel's, as before.
export const OWN_CHANNEL_DIR = fileURLToPath(new URL("../channel/", import.meta.url));

export function mascotSheet(dir: string): string | undefined {
  const channel = join(dirname(dir), "_channel");
  const own = sheetFile(OWN_CHANNEL_DIR, "mascot");
  // The user's own picture beats any mascot drawn earlier into a video or the channel folder.
  if (!own) return sheetFile(dir, "mascot") ?? sheetFile(channel, "mascot");
  try {
    const copy = join(channel, "sheets", `mascot${extname(own)}`);
    const old = sheetFile(channel, "mascot");
    if (old && old !== copy) renameSync(old, old.replace(/(\.\w+)$/, `-old$1`));
    if (!existsSync(copy) || statSync(copy).size !== statSync(own).size) {
      mkdirSync(join(channel, "sheets"), { recursive: true });
      copyFileSync(own, copy);
    }
    return copy;
  } catch {
    return own;
  }
}

export const thumbFile = (dir: string, n: number) => firstExisting(join(dir, "thumbs"), `thumb-${n}`, /\.(png|jpe?g|webp)$/i);

// Flow names a second take "-v2"; the first take is the one used.
function firstExisting(dir: string, stem: string, ext: RegExp): string | undefined {
  if (!existsSync(dir)) return undefined;
  const hits = readdirSync(dir).filter((f) => ext.test(f) && (f.startsWith(`${stem}.`) || f.startsWith(`${stem}-v1.`)));
  return hits.length ? join(dir, hits.sort()[0]) : undefined;
}

export function readProduction(dir: string, video: string): Production {
  const file = join(dir, FILE);
  if (!existsSync(file)) return { video };
  return { ...(JSON.parse(readFileSync(file, "utf8")) as Production), video };
}

// Top-level fields are replaced whole, except `settings` and `branding`, which merge, and `beats`, which merge by beat
// number so a chapter's prompts can be added one turn at a time without resending the whole map.
export function writeProduction(dir: string, video: string, patch: z.infer<typeof productionShape>, replaceBeats = false): Production {
  mkdirSync(dir, { recursive: true });
  const cur = readProduction(dir, video);
  const next: Production = { ...cur, ...patch, video };
  if (patch.settings) next.settings = { ...cur.settings, ...patch.settings };
  if (patch.branding) next.branding = { ...cur.branding, ...patch.branding };
  if (patch.beats && cur.beats && !replaceBeats) {
    const byN = new Map(cur.beats.map((b) => [b.n, b]));
    for (const b of patch.beats) byN.set(b.n, { ...byN.get(b.n), ...b });
    next.beats = [...byN.values()].sort((a, b) => a.n - b.n);
  }
  next.updated = new Date().toISOString();
  const file = join(dir, FILE);
  // Written beside and swapped in, so a crash mid-write never leaves half a production record.
  writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2));
  renameSync(`${file}.tmp`, file);
  return next;
}

// What exists on disk for this video, for the panel's progress strip and for Claude to see what is still missing.
export function progress(dir: string, p: Production) {
  const beats = p.beats ?? [];
  const heroes = beats.filter((b) => b.hero);
  const sheets = p.sheets ?? [];
  const timing = join(dir, "voice", "timing.json");
  return {
    sheets: { total: sheets.length, done: sheets.filter((s) => (s.kind === "mascot" ? mascotSheet(dir) : sheetFile(dir, s.id))).map((s) => s.id) },
    stills: { total: beats.length, missing: beats.filter((b) => !stillFile(dir, b.n)).map((b) => b.n) },
    clips: { total: heroes.length, missing: heroes.filter((b) => !clipFile(dir, b.n)).map((b) => b.n) },
    voice: existsSync(timing) ? (JSON.parse(readFileSync(timing, "utf8")) as { total: number; file: string; voice?: string }) : null,
    thumbnails: { total: (p.thumbnails ?? []).length, done: (p.thumbnails ?? []).filter((t) => thumbFile(dir, t.n)).map((t) => t.n) },
  };
}

export function listProductions(root: string) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, FILE)))
    .map((d) => {
      const p = readProduction(join(root, d.name), d.name);
      return { video: d.name, title: p.title, state: p.state, updated: p.updated ?? new Date(statSync(join(root, d.name, FILE)).mtimeMs).toISOString() };
    })
    .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
}
