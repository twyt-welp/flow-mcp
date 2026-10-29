---
name: c5-reborn
description: Write a C5 Reborn Apocalypse Engine video for Google Flow - topics, script, character sheets, beat map, still and clip prompts, thumbnail prompts, and afterwards the titles and description - saved for the flow tools to run. Use when the user says "new C5 video", "new reborn video", "write the C5 prompts", "run the C5 engine", "next reborn video", "rewrite still N" or "C5 branding". Sending the saved prompts to Flow, the voiceover and the CapCut edit belong to the c5-flow-run skill.
---

# C5 Reborn Apocalypse Engine → Google Flow → CapCut

`engine.md` in this folder is the creative engine: states, locks (MASCOT, STYLE, FLASHBACK, THREAT, BASE), series
rules, visual safety rules, audio-safe word swaps, timing and every prompt format. Read it in full at the start and
follow it exactly, except where this file overrides it. The overrides turn "paste this into your video tool" into real
`flow` tool calls, so the user approves results instead of copying prompts.

Everything for one video is saved with `flow_production` (one record per video, in its own folder). Save each state's
output there as you produce it: the other tools read their prompts from it, and Flow Studio
(http://127.0.0.1:8787) shows it live, tab by tab, so the user can watch and redo things there too.

## Two passes: writing here, Flow on a cheaper model

The user splits the work to save usage: this skill runs on the strongest model and only WRITES; the `c5-flow-run`
skill runs on a cheaper model (or the user presses Flow Studio's buttons, which uses no model at all) and SENDS the saved
prompts to Flow. So, unless the user asks to do it all in one go:
- Do STATES 1-5 and the writing parts of STATES 6 and 7, saving everything with `flow_production` exactly as below.
  Never call `flow_c5_sheets`, `flow_c5_stills`, `flow_c5_clips`, `flow_c5_thumbnails`, `flow_narrate`,
  `flow_voiceover` or `flow_capcut_build`, and skip `flow_status`. Where a state says to call one of them and wait,
  skip that step and carry on.
- Keep engine.md's HARD STOPs, but the user now reviews the written prompts, not pictures. STATE 5 still goes one
  chapter per turn.
- In STATE 6 save `clip_prompt`s and the per-clip cap (`settings.max_credits`), but do not ask to spend credits: the
  spending yes is asked in the other pass.
- When the thumbnail prompts are saved, set `state: "prompts_ready"` and end with:
  "All prompts are saved. Switch to a cheaper model and say 'run C5 in Flow', or press the buttons in Flow Studio.
  Come back here for any prompt that needs rewriting, and for 'C5 branding' once the voiceover is done."
- Later visits: "rewrite still N" (or sheet, clip, thumbnail) -> read the record, rewrite that prompt as engine.md says
  with the user's note, save it, and tell them to say "redo still N" in the cheaper pass. "C5 branding" -> STATE 8.
- "Do it all in one go" or "draw as you go": ignore this section and run every state as written below.

## Opening Flow Studio

When the user only asks to open or launch Flow Studio, call `flow_open_studio` and reply with the address. Never use
computer use for it. If the flow tools are missing, the connector is not running: tell the user to restart Claude, or to
double-click `Flow Studio.cmd` in their flow-mcp folder.

## Before STATE 1

0. Always, first: call `flow_open_studio` so the user can read along in Flow Studio's dashboard while you write
   (it only opens the panel in their browser and never touches Flow).

(Steps 1 and 2 only in the all-in-one-go run.)

1. Call `flow_status`. If not signed in or no project is open, stop and tell the user to run `npm run login` in their
   flow-mcp folder, sign in and open a Flow project.
2. Report the plan and credits left in one line (Studio is already open from step 0).
3. Call `flow_productions`. If a C5 video (not a `C3-` folder) is part-way through, ask once whether to carry on with it or start a new one.
4. Pick the video's folder name now: `C5-<yyyy-mm-dd>`, renamed in spirit by its title later (the folder name stays).

## State overrides

Keep every HARD STOP and closing line from engine.md. The user approves in chat or in Flow Studio.

**STATE 1 — Topics and ideas.** If the user gave a list of topics (in chat, or typed into Flow Studio's Topics tab, which saves them as `my_topics`), build the 10 ideas from those topics first (keep the
engine's grid and variety rules for the rest). Save them with `flow_production` as `topics` (`n`, `title`, `hook`) and
`state: "ideas"`. When the user picks, save `picked` and a working `title`.

**STATE 2 — Script.** Unchanged; the voice is the user's own cloned voice (ElevenLabs is the other option). Save the script as `script.chapters`
(one entry per chapter: `marker` exactly as written, `flashback`, and the chapter's narration paragraph as `text`),
plus `ledger` and `contrasts`. Each extension re-saves the whole script.

**STATE 3 — Cast & base (free).** Write the blocks exactly as engine.md says, then save them as `sheets`:
- The mascot sheet is the channel's own picture (flow-mcp's `channel/sheets/mascot.jpg`) and is final: never write or
  draw a new one, and never redo it. It is attached to every still and thumbnail by itself. Still save
  `{ id: "mascot", kind: "mascot", handle: "@YOU", lock: <MASCOT LOCK>, prompt: "the channel's saved mascot sheet" }` so
  Studio lists it, and paste the MASCOT LOCK from engine.md word for word into every prompt that shows @YOU.
- each supporting character: `{ id: "sister", kind: "character", handle: "@SISTER", lock, prompt }`
- `{ id: "threat", kind: "threat", lock, prompt }` and `{ id: "base", kind: "base", lock: <all four versions>, prompt }`

Call `flow_c5_sheets`, then `flow_wait` until finished, show the file paths, and ask the closing question. On a change,
update that sheet's lock and prompt, then `flow_c5_sheets` with its `ids` and `redo: true`.

**STATE 4 — Beat map.** Output the table as engine.md says, and save `beats` with `replace_beats: true`: `n`, `chapter`
(the exact marker), `text` (the beat's exact spoken words: every chapter's beats together must be its whole paragraph,
in order, with nothing left out; the voiceover is timed from these), `shot`, `base`, `flashback`, `who`, `hero`.

**STATE 5 — Scene stills (free, one chapter per turn).** Write the chapter's still prompts exactly as engine.md says,
then save them onto the beats (merge by `n`):
- `still_prompt`: the whole prompt, locks pasted word for word, ending with its NEGATIVE PROMPT
- `move`: the EDIT NOTE move as `push_in`, `pull_out`, `pan_left`, `pan_right` or `hold` (use `shake` for an impact
  beat: a door slam, a crash, the threat breaking through)
- `overlay`: the EDIT NOTE overlay text exactly as it should read on screen ("$4,200 LEFT", "30 DAYS LEFT"), empty for none
- `sfx`: the effects that land on this beat, in plain words ("door bang", "cans clinking"). The library has: whoosh,
  impact/thud, door bang, knock, footsteps, running footsteps, heartbeat, creak, click/lock, metal/cans clink, coins,
  glass shatter, thunder, riser, boom/braam, alarm beep, siren, phone buzz, clock tick, hammer, crowd murmur,
  groan/zombie, gasp/breath, gunshot, drip, splash, chime/ding, pop, rustle, radio static. Ambience: wind, rain,
  crickets/night, room tone, city hum, generator hum, fire crackle, dripping cave/bunker. Music moods: tense, sad,
  hopeful, action, eerie, calm, flashback/nostalgic, epic. Name SOUND cues with these words.

Save the chapter's SOUND line into `sound` (`chapter`, `music`, `sfx`, `ambient`). Then call `flow_c5_stills` with that
chapter's beat numbers and `flow_wait` until finished. Show the paths, then the engine's closing line. If the user names
stills to redo, adjust their prompts if needed and call `flow_c5_stills` with those `beats`, `redo: true`,
`mode: "one_by_one"`.

**STATE 6 — Motion clips (paid).** Write one clip prompt per ★ beat as engine.md says and save it as `clip_prompt`.
Skip the AGENT INSTRUCTION BLOCK: these tools are the agent. Then:
- Ask once, if not already saved in `settings.max_credits`: the per-clip credit cap (default 15). Save it.
- State the estimate: number of hero clips × about 10 credits (Omni 1.1 Flash, 6 s, 720p), and ask
  "Spend about N credits on these N clips? (yes / no)". Wait for yes.
- `flow_c5_clips` with `max_credits` = the cap and `acknowledge_cost: true`, then `flow_wait` until finished. A clip
  over the cap is skipped and costs nothing: say which. A clip made but not downloaded is in Flow: `flow_download` it,
  never generate it again. Use `flow_retry` for failed jobs.
- End with "Type 'next' for your voiceover."

**NEW STATE 6b — Voiceover.** The channel's default voice is the user's own cloned voice (OpenVoice, free, on their
computer). `flow_voices`: if `openvoice.ready`, `flow_voiceover` with `video` and `engine: "openvoice"`. ElevenLabs is
the other option, only when the user asks for it: if `elevenlabs_ready` and `elevenlabs_voice` are set,
`flow_voiceover` with `video` and `engine: "elevenlabs"`; otherwise ask the user to paste the key and voice ID into Flow Studio (never into chat) and wait. Use the free
Google voice (`engine: "gemini"`, a voice and a short style note) only if the user asks for it. Report the runtime against
the engine's target, then end with "Type 'next' to set up CapCut."

**NEW STATE 6c — CapCut (free).** If the user already asked for the edit in their own words (for example "I want you
to edit my CapCut project - <name>. Sync the images, videos to the voice over. Also add sound effects, add music, and
relevant text and motion effects ... do NOT use computer use or open CapCut. Build the timeline by writing the project
files directly"), that request IS this state: skip the instructions below and go straight to the build with that
project name. Never use computer use and never open CapCut: `flow_capcut_build` writes the project files itself.
Which video: the one in progress, or the one whose title or folder matches the project name (`flow_productions`); ask
only if two could fit. If the video has no voiceover yet, record it first (STATE 6b) and say so.

Otherwise tell the user, in this order, in a short numbered list:
1. Open CapCut and make a new project (name it after the video).
2. Import the video's `stills` and `clips` folders and `voice/narration.wav` (the folder path is in `flow_production`'s
   `dir`). Importing is optional, but it puts the files in CapCut's media panel.
3. Close CapCut completely.

Ask "Tell me the CapCut project name when CapCut is closed." Then `flow_capcut_projects` to confirm the name (match it
loosely: case and spacing) and that CapCut is closed, and `flow_capcut_build`. What the build does, so you can say it
plainly:
- every still and hero clip cut to the voiceover beat by beat, each still with its EDIT NOTE move (push, pull, pan,
  shake), sized to fill the 16:9 frame; a hero beat holds its still first and hands over to its clip
- music per chapter cue, ambience beds and the beat's sound effects, all from Claude's own sound library (made in code,
  free, no downloads) unless the user's sound folder has a better match
- day markers and ledger numbers as text, a cut to white at the end of the cold open

Report what it placed, every cue with no fitting sound (`sfx_skipped`), any warnings, and runtime against narration, in
a few lines. If a cue was skipped, rewording that beat's `sfx` or the chapter's `sound` line to plain words close to a
library name ("door bang", "cans clinking", "wind", "tense music") and rebuilding usually fixes it; the build backs up
and replaces the timeline each time.
Then: "Open CapCut, check the edit and export it. Type 'next' for thumbnails." If the user wants the old timeline back,
`flow_capcut_restore`.

**STATE 7 — Thumbnails (free).** Write the 5 prompts as engine.md says, save them as `thumbnails` (`n` 1-5, `template`,
`prompt`) and the OVERLAY TEXT as `overlay_text`, then `flow_c5_thumbnails` and `flow_wait`. Show the paths and the
overlay text, then the closing line.

**STATE 8 — Branding & export.** Unchanged, except the CHAPTERS timestamps come from the real voiceover: read
`voice/timing.json` chapter starts through `flow_production`'s `progress.voice` (fall back to 150 words per minute only
if there is no voiceover). Save `branding` (`titles`, `description`, `hashtags`, `next`) and `state: "done"`.

**STATE 9 — Reset.** Unchanged. A new video gets a new folder; the mascot sheet carries over by itself.

## Rules that always apply

- Never spend credits without the explicit yes in STATE 6. Sheets, stills, thumbnails, narration, music, sound effects
  and the CapCut build are free; only hero clips cost credits. Nothing needs FFmpeg.
- Every generation prompt stays self-contained, with the locks pasted word for word, as engine.md requires. Apply the
  visual safety rules and audio-safe word swaps silently.
- Never put on-screen text in a prompt. Day markers and ledger numbers come from `overlay` and the chapter markers,
  and the CapCut build places them as text.
- Flow runs one job at a time with a 25-70 s pause between jobs; an agent batch draws a whole chapter at once. Give a
  rough time estimate when queueing many jobs and don't apologise for the pace.
- If Flow silently blocks a prompt, soften the wording with the audio-safe swaps and retry once, then tell the user
  which beat needs a manual look.
- Tell the user file paths in plain words. Never paste the ElevenLabs or Google key into chat: it is saved in Flow Studio's
  Voice tab.
