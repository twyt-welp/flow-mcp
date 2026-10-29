import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { clipFile, engineOf, mascotSheet, OWN_CHANNEL_DIR, pad, sheetFile, stillFile, thumbFile, type Beat, type Production } from "./production.js";
import type { SceneParams } from "./queue.js";

// Turns a video's production record into Flow jobs. Every prompt is used exactly as the engine wrote it (the locks are
// already pasted in word for word); this only decides which reference sheets ride along and where each file lands.

type Sheet = NonNullable<Production["sheets"]>[number];

// The mascot sheet is the channel's own picture (see mascotSheet) and is reused by every video, as the engine says.
export const channelDir = (root: string) => join(root, "_channel");

export function sheetPath(root: string, dir: string, s: Pick<Sheet, "id" | "kind">): string | undefined {
  return s.kind === "mascot" ? mascotSheet(dir) : sheetFile(dir, s.id);
}

// C3 videos are vertical Shorts (2026-10-29): stills, clips and thumbnails are drawn 9:16. Sheets stay 16:9 (their
// rows of turnaround views need the width).
const frame = (p: Production) => (engineOf(p) === "c3" ? ("9:16" as const) : ("16:9" as const));

// The mascot rides along with every still and thumbnail even when this video's record lists no mascot sheet: the
// channel's own sheet is the reference, and the writing pass no longer re-declares it.
// C3 videos have no mascot: each one draws its own one or two characters.
function withMascot(p: Production): Sheet[] {
  const sheets = p.sheets ?? [];
  if (engineOf(p) === "c3") return sheets.filter((s) => s.kind !== "mascot");
  return sheets.some((s) => s.kind === "mascot") ? sheets : [{ id: "mascot", kind: "mascot", handle: "@YOU", lock: "", prompt: "" } as Sheet, ...sheets];
}

// Out of the way, not deleted: a redo keeps the old file beside the new one under another name.
function setAside(file: string | undefined) {
  if (!file || !existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  renameSync(file, file.replace(/(\.\w+)$/, `-old-${stamp}$1`));
}

export function planSheets(root: string, dir: string, p: Production, ids: string[] | undefined, redo: boolean): SceneParams[] {
  const sheets = (p.sheets ?? []).filter((s) => !ids || ids.includes(s.id));
  if (!sheets.length) throw new Error(ids ? `No sheet called ${ids.join(", ")} in this video.` : "This video has no character, threat or base sheets yet (STATE 3).");
  const jobs: SceneParams[] = [];
  for (const s of sheets) {
    const out = join(s.kind === "mascot" ? channelDir(root) : dir, "sheets");
    // The user's own mascot picture is final: it is never redrawn, even on a redo.
    if (s.kind === "mascot" && sheetFile(OWN_CHANNEL_DIR, s.id)) continue;
    const have = sheetPath(root, dir, s);
    if (have && !redo) continue;
    if (redo) setAside(sheetFile(s.kind === "mascot" ? channelDir(root) : dir, s.id));
    mkdirSync(out, { recursive: true });
    jobs.push({ prompt: s.prompt, type: "image", aspect_ratio: "16:9", max_credits: 0, output_dir: out, file_stem: s.id });
  }
  return jobs;
}

// Which sheets a beat needs: always the mascot, any supporting character named in it, the threat when its lock is in
// the prompt, and the base unless the beat is away from it.
function refsFor(b: Beat, sheets: Sheet[]): Sheet[] {
  const text = `${b.who ?? ""} ${b.still_prompt ?? ""}`.toUpperCase();
  return sheets.filter((s) => {
    if (s.kind === "mascot") return true;
    if (s.kind === "character") return Boolean(s.handle && text.includes(s.handle.toUpperCase()));
    if (s.kind === "threat") return text.includes("THREAT LOCK");
    return !/away/i.test(b.base ?? "") && /BASE/.test(text);
  });
}

const refName = (s: Sheet) => (s.kind === "base" ? "the base" : s.kind === "threat" ? "the threat" : (s.handle ?? s.id).replace(/^@/, ""));

export function planStills(root: string, dir: string, p: Production, only: number[] | undefined, redo: boolean, mode: "agent" | "one_by_one"): SceneParams[] {
  const beats = (p.beats ?? []).filter((b) => (only ? only.includes(b.n) : true) && (redo || !stillFile(dir, b.n)));
  if (!beats.length) throw new Error(only ? "Those stills already exist. Pass redo: true to draw them again." : "Every beat already has its still.");
  const missing = beats.filter((b) => !b.still_prompt).map((b) => b.n);
  if (missing.length) throw new Error(`Beat(s) ${missing.join(", ")} have no still prompt yet (STATE 5).`);
  const sheets = withMascot(p).map((s) => ({ s, file: sheetPath(root, dir, s) })).filter((x) => x.file);
  const out = join(dir, "stills");
  mkdirSync(out, { recursive: true });
  if (redo) for (const b of beats) setAside(stillFile(dir, b.n));

  if (mode === "one_by_one") {
    // Flow's composer takes three references at most: the mascot first, then whoever else is in frame, then the base.
    return beats.map((b) => ({
      prompt: b.still_prompt!,
      type: "image" as const,
      aspect_ratio: frame(p),
      max_credits: 0,
      reference_images: refsFor(b, sheets.map((x) => x.s))
        .map((s) => sheets.find((x) => x.s.id === s.id)!.file!)
        .slice(0, 3),
      output_dir: out,
      file_stem: `scene-${pad(b.n)}`,
    }));
  }

  // One agent batch per chapter: the engine writes stills a chapter at a time, and a chapter's prompts (five or six,
  // each up to 2,000 characters) stay well inside what the agent's composer takes in one go.
  const chapters = [...new Set(beats.map((b) => b.chapter))];
  return chapters.map((ch) => {
    const list = beats.filter((b) => b.chapter === ch);
    const used = sheets.filter((x) => list.some((b) => refsFor(b, [x.s]).length));
    return {
      prompt: `Agent batch: ${list.length} stills for ${ch}`,
      type: "image" as const,
      aspect_ratio: frame(p),
      max_credits: 0,
      agent_scenes: list.map((b) => b.still_prompt!),
      agent_numbers: list.map((b) => b.n),
      agent_refs: used.length ? used.map((x) => ({ image: x.file!, name: refName(x.s) })) : undefined,
      agent_scene_refs: used.length ? list.map((b) => refsFor(b, used.map((x) => x.s)).map(refName)) : undefined,
      output_dir: out,
      file_stem: `scene-${pad(list[0].n)}`,
    };
  });
}

export interface ClipPlan {
  jobs: SceneParams[];
  skipped: { beat: number; why: string }[];
}

export function planClips(dir: string, p: Production, only: number[] | undefined, redo: boolean, o: { max_credits: number; model: string; duration: 4 | 6 | 8 | 10; resolution: "360p" | "720p" }): ClipPlan {
  const heroes = (p.beats ?? []).filter((b) => b.hero && (!only || only.includes(b.n)));
  if (!heroes.length) throw new Error("No hero (★) beats to animate. Mark them in the beat map (STATE 4).");
  const skipped: ClipPlan["skipped"] = [];
  const jobs: SceneParams[] = [];
  const out = join(dir, "clips");
  for (const b of heroes) {
    if (clipFile(dir, b.n) && !redo) continue;
    const still = stillFile(dir, b.n);
    if (!still) {
      skipped.push({ beat: b.n, why: "its still isn't drawn yet" });
      continue;
    }
    if (!b.clip_prompt) {
      skipped.push({ beat: b.n, why: "it has no clip prompt yet (STATE 6)" });
      continue;
    }
    if (redo) setAside(clipFile(dir, b.n));
    mkdirSync(out, { recursive: true });
    // Image-to-video: the beat's own still is the exact first frame, so the clip cuts in from the still invisibly.
    jobs.push({
      prompt: b.clip_prompt,
      type: "video",
      model: o.model,
      aspect_ratio: frame(p),
      duration: o.model.startsWith("Omni") ? o.duration : undefined,
      resolution: o.model.startsWith("Omni") ? o.resolution : undefined,
      max_credits: o.max_credits,
      first_frame: still,
      output_dir: out,
      file_stem: `scene-${pad(b.n)}`,
    });
  }
  return { jobs, skipped };
}

export function planThumbnails(root: string, dir: string, p: Production, only: number[] | undefined, redo: boolean): SceneParams[] {
  const thumbs = (p.thumbnails ?? []).filter((t) => !only || only.includes(t.n));
  if (!thumbs.length) throw new Error("This video has no thumbnail prompts yet (STATE 7).");
  const sheets = withMascot(p).map((s) => ({ s, file: sheetPath(root, dir, s) })).filter((x) => x.file);
  const out = join(dir, "thumbs");
  mkdirSync(out, { recursive: true });
  const jobs: SceneParams[] = [];
  for (const t of thumbs) {
    if (thumbFile(dir, t.n) && !redo) continue;
    if (redo) setAside(thumbFile(dir, t.n));
    const text = t.prompt.toUpperCase();
    const refs = sheets.filter(({ s }) => s.kind === "mascot" || (s.handle && text.includes(s.handle.toUpperCase())) || (s.kind === "base" && /BASE/.test(text)) || (s.kind === "threat" && text.includes("THREAT LOCK")));
    jobs.push({ prompt: t.prompt, type: "image", aspect_ratio: frame(p), max_credits: 0, reference_images: refs.map((x) => x.file!).slice(0, 3), output_dir: out, file_stem: `thumb-${t.n}` });
  }
  return jobs;
}
