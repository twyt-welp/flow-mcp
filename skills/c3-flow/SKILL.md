---
name: c3-flow
description: Write a C3 Stickman Explainer video (a vertical Short under a minute) for Google Flow - ideas, researched script, character sheets, beat map, still and hero clip prompts, thumbnail prompts, and afterwards the titles and description - saved for the flow tools to run. Use when the user says "new C3 video", "run the C3 engine", "make a stickman explainer", "write the C3 prompts", "rewrite C3 still N" or "C3 branding". Sending the saved prompts to Flow, the voiceover and the CapCut edit belong to the c3-flow-run skill.
---

# C3 Stickman Explainer → Google Flow → CapCut

`engine.md` in this folder is the creative engine: states, STYLE ANCHOR, ACCENT lock, visual safety rules, audio-safe
word swaps, timing and every prompt format. Read it in full at the start and follow it exactly, except where this file
overrides it.

**C3 has its own Flow connector, `flow-c3`** (the user's rule, 2026-10-29): its own Flow Studio at
http://127.0.0.1:8788, its own Chrome window signed in to the C3 Google account (never the C5 one) and its own video
folder. Use ONLY the `flow-c3` connector's tools for C3, never the `flow` connector (that one is C5's). Its tools have
the same names as C5's (`flow_production`, `flow_c5_stills` ... the names say `c5`, they serve both); what makes a
video C3 is `engine: "c3"` in its record. If no `flow-c3` connector is listed, tell the user to close Claude,
double-click "Add C3 connector" in their flow-mcp folder, start Claude again, and double-click "Sign in to Flow C3"
once. A C3 video is a vertical 9:16 YouTube Short just under a minute (the user's rule, 2026-10-29):
the tools draw its stills, clips and thumbnails 9:16 by themselves, and the CapCut build puts it on a 9:16 canvas with
word-by-word highlight captions. It has no mascot: each video draws its own one or two characters, and the voiceover
uses the C3 recording of the user's own voice.

Everything for one video is saved with `flow_production` (one record per video, in its own folder). Save each state's
output there as you produce it: the other tools read their prompts from it, and Flow Studio C3
(http://127.0.0.1:8788) shows it live.

## Two passes: writing here, Flow on a cheaper model

This skill runs on the strongest model and only WRITES; the `c3-flow-run` skill runs on a cheaper model (or the user
presses Flow Studio's buttons) and SENDS the saved prompts to Flow. So, unless the user asks to do it all in one go:
- Do STATES 1-6 and the writing part of STATE 7, saving everything with `flow_production` as below. Never call
  `flow_c5_sheets`, `flow_c5_stills`, `flow_c5_clips`, `flow_c5_thumbnails`, `flow_narrate`, `flow_voiceover` or
  `flow_capcut_build`, and skip `flow_status`.
- Keep engine.md's HARD STOPs; the user reviews the written prompts, not pictures. STATE 5 goes one part per turn.
- In STATE 6 save the `clip_prompt`s and the per-clip cap (`settings.max_credits`), but do not ask to spend credits:
  the spending yes is asked in the other pass.
- When the thumbnail prompts are saved, set `state: "prompts_ready"` and end with this reminder, word for word:
  "⏰ REMINDER: switch to the cheaper model now (the model menu under the message box), then say 'run C3 in Flow',
  or press the buttons in Flow Studio C3 (http://127.0.0.1:8788). Its Flow window must be signed in to your C3
  Google account. Come back to the strong model for any prompt that needs rewriting, and for 'C3 branding' once the
  voiceover is done."
- This pass is for the strong model. If you can tell you are a smaller, cheaper model (a Haiku or Sonnet, say), say
  once at the start: "⏰ You're on a cheaper model. Switch to the strong model for writing, then carry on." and wait.
- Later visits: "rewrite C3 still N" (or sheet, clip, thumbnail) -> read the record, rewrite that prompt as engine.md
  says with the user's note, save it, and tell them to say "redo still N" in the cheaper pass. "C3 branding" -> STATE 8. "Shorten the C3 script" (the voiceover ran over 58 s) -> cut words from the beats that
  run longest, keep every fact and the beat count, re-save the script and the beats' `text`, and tell them to record
  the voiceover again.
- "Do it all in one go": also run the Flow steps of `c3-flow-run` at the end of each state (sheets after STATE 3,
  the part's stills after each STATE 5 turn, clips after the spending yes in STATE 6, voiceover and CapCut before
  STATE 7, thumbnails in STATE 7).

## Before STATE 1

0. Always, first: call the `flow-c3` connector's `flow_open_studio` so the user can read along and review the stills
   in Flow Studio C3 (it only opens the panel in their browser and never touches Flow). Never use computer use for
   it. If it doesn't open, tell the user to double-click "Flow Studio C3" in their flow-mcp folder.
1. Call `flow_productions`. If a C3 video (folder starting `C3-`) is part-way through, ask once whether to carry on
   with it or start a new one.
2. Name a new video's folder `C3-<yyyy-mm-dd>` (add `-2`, `-3` for a second one that day), and save
   `engine: "c3"` in its first `flow_production` call. Never give a C3 video a `C5-` folder.

## State overrides

**STATE 1 — Ideas.** If the user gave topics (in chat, or in Flow Studio's Topics tab, saved as `my_topics`), build the
ideas from those first. Search the web for every idea to rate how overdone it is, as engine.md says (each line ends
with its Saturation rating and reason). Save them as `topics` (`n`, `title`, `hook`, `saturation` = the rating and its
reason) with `engine: "c3"` and `state: "ideas"`. When the
user picks, save `picked` and a working `title`.

**STATE 2 — Script.** Research with web search; never invent a detail. Show the script as one paragraph, then the HOOK CHECK line
(the three openings tried, their scores, the winner) and any FACT FLAG line, as engine.md says. Never show a script
whose opening scored under 8: rewrite it first. Save it as `script.chapters`: three entries, `marker` `OPENING`, `MIDDLE` and
`ENDING`, each with its part's narration as `text`, split at the beat boundaries the timing table gives, so together
they are the whole paragraph word for word. Save the FACT FLAG line, if any, as `script.ledger`. Each extension
re-saves the whole script. Set `state: "script"`.

**STATE 3 — Characters.** Write the ACCENT line, sheet prompts and CHARACTER LOCKs as engine.md says. Save each
character as a sheet: `{ id: "clerk", kind: "character", handle: "@CLERK", lock: <CHARACTER LOCK>, prompt: <the full
sheet prompt> }` (id = the handle in lower case, no @). Never save a mascot sheet for C3. (The accent needs no field of its own:
it is filled into the STYLE ANCHOR in every prompt.) Closing line: "Are these characters okay?" On a change, update that sheet's lock and prompt.

**STATE 4 — Beat map.** Output the table and save `beats` with `replace_beats: true`: `n`, `chapter` (`OPENING`,
`MIDDLE` or `ENDING`, exactly as in the script), `text` (the beat's exact spoken words: each part's beats together
must be its whole `text`, in order, nothing left out; the voiceover is timed from these), `shot`, `who` (the handles
in frame) and `hero: true` on the ★ beats. Set `state: "beats"`.

**STATE 5 — Scene stills (one part per turn).** Write the part's still prompts as engine.md says, then save them onto
the beats (merge by `n`):
- `still_prompt`: the whole prompt, locks pasted word for word, ending with its NEGATIVE PROMPT
- `move`: the EDIT NOTE move as `push_in`, `pull_out`, `pan_left`, `pan_right` or `hold`
- `overlay`: Beat 1 only, the headline exactly as it should read on screen; empty for every other beat
- `sfx`: the effects that land on this beat, in plain words. The library has: whoosh, impact/thud, door bang, knock,
  footsteps, running footsteps, heartbeat, creak, click/lock, metal/cans clink, coins, glass shatter, thunder, riser,
  boom/braam, alarm beep, siren, phone buzz, clock tick, hammer, crowd murmur, gasp/breath, drip, splash, chime/ding,
  pop, rustle, radio static. Ambience: wind, rain, crickets/night, room tone, city hum, generator hum, fire crackle,
  dripping cave/bunker. Music moods: tense, sad, hopeful, action, eerie, calm, flashback/nostalgic, epic. C3 is quiet
  and restrained: few effects, soft beds, mostly calm, sad or nostalgic music.

Save the part's SOUND line into `sound` (`chapter`, `music`, `sfx`, `ambient`). Set `state: "stills"`.

**STATE 6 — Hero clips.** Write one clip prompt per ★ beat as engine.md says and save it as `clip_prompt`. C3 has a budget
of 50 credits per video (the user's choice, 2026-10-29: Flow's free allowance), so the hero clips times the per-clip cap
must stay within 50: save `settings.max_credits` = 12 unless the user names a lower cap (2 clips for 6 beats,
3 for 9: both fit). Set `state: "clips"` and
end with "Type 'next' for thumbnails." (the clips are made in the other pass).

**STATE 7 — Thumbnails.** Write the 5 prompts as engine.md says, save them as `thumbnails` (`n` 1-5, `template` = a
two-word description of the variant, `prompt`) and the HEADLINE OPTIONS as `overlay_text`. Then `state:
"prompts_ready"` and the closing line from "Two passes" above.

**STATE 8 — Branding & export.** Unchanged. Save `branding` (`titles`, `description`, `hashtags`) and
`state: "done"`. The production document, if asked for, goes to `production.md` in the video's folder (`dir` from
`flow_production`).

**STATE 9 — Reset.** Unchanged. A new video gets a new `C3-` folder.

## Rules that always apply

- Every generation prompt stays self-contained, with the locks pasted word for word. Apply the visual safety rules and
  audio-safe word swaps silently.
- Never put on-screen text in a prompt. The headline comes from Beat 1's `overlay`, and the CapCut build places it.
- Nothing in this pass costs credits. Tell the user file paths in plain words.
