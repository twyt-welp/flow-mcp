---
name: c5-flow-run
description: Send a C5 video's saved prompts to Google Flow and finish it - character sheets, stills, paid hero clips under a credit cap, the Google voiceover, the CapCut timeline written into the project files, and thumbnails. Built for a cheaper model; it never writes prompts. Use when the user says "run C5 in Flow", "send my prompts to Flow", "draw the stills", "make the clips", "redo still N", "record the voiceover", "open Flow Studio", or asks to edit, sync or build a CapCut project ("edit my CapCut project - [project name]", "build the timeline by writing the project files").
---

# C5 in Flow: send the saved prompts

The prompts were written in the other pass (the `c5-reborn` skill, on a stronger model) and are saved in the video's
record. This skill only sends them through the `flow` tools and reports results. Never write or change a prompt here:
when a result is wrong, tell the user to go back to the writing pass and say "rewrite still N" (or sheet, clip,
thumbnail), then come back and say "redo still N". Keep replies short: what ran, what came out, file paths, what is next.

## Start

1. Flow Studio is already open from the writing pass, so do not open it again. Call `flow_open_studio` only when the
   user asks to open Flow Studio (never use computer use for this), and if that was all they asked, stop there.
2. `flow_status`. If not signed in or no project is open, tell the user to run `npm run login` in their flow-mcp folder,
   sign in and open a Flow project, and stop. Report plan and credits left in one line.
3. `flow_productions`, then `flow_production` for the video (the newest with state "prompts_ready" or later; ask only if
   two could fit). Check what exists in `files` and carry on from the first step not done.

## Steps, in order

Each queues jobs: `flow_wait` until they finish (it answers within a minute; call it again while jobs run).

1. **Sheets (free).** `flow_c5_sheets` with `video`. Skip it if every sheet in `sheets` has a file. Show the paths.
2. **Stills (free).** `flow_c5_stills` with `video` and one chapter's beat numbers at a time (beats share a `chapter`).
   After each chapter show the paths and ask "Next chapter, or redo any?" A redo: `flow_c5_stills` with `beats`,
   `redo: true`, `mode: "one_by_one"`.
3. **Hero clips (PAID).** Count the hero beats with a `clip_prompt`. The cap per clip is `settings.max_credits`
   (default 15). Ask "Spend about N x 10 credits on these N clips? (yes / no)" and wait for a clear yes; never spend
   without it. Then `flow_c5_clips` with `video`, `max_credits` = the cap and `acknowledge_cost: true`. A clip over the
   cap is skipped at no cost: say which. A clip made but not downloaded is already in Flow: `flow_download` it, never
   generate it again. `flow_retry` for a failed job. If a paid job vanishes from the queue, look at the grid
   (`flow_assets`) before running anything again.
4. **Voiceover (free).** `flow_voices`. Use `settings.voice` if saved; otherwise record two short samples of the cold
   open with `flow_narrate` in two fitting Google voices and let the user pick. `flow_voiceover` with the voice and a
   style note of a few words ("calm, low and tense"). Report the runtime. If the key is missing, tell the user to paste
   it in Flow Studio, step 5 Voice, "Google AI Studio key" - never in chat.
5. **CapCut (free).** If the user already asked for the edit in their own words, that request is this step: go straight
   to the build with that project name. Otherwise tell them: 1. open CapCut and make a new project named after the
   video, 2. import the `stills` and `clips` folders and `voice/narration.wav` (optional), 3. close CapCut completely,
   then ask for the project name. `flow_capcut_projects` to confirm the name (loosely) and that CapCut is closed, then
   `flow_capcut_build`. Never use computer use and never open CapCut. Report what was placed, any `sfx_skipped` cues and
   warnings in a few lines, then "Open CapCut, check the edit and export it." `flow_capcut_restore` brings the old
   timeline back if asked.
6. **Thumbnails (free).** `flow_c5_thumbnails` with `video`. Show the paths and the saved `overlay_text`.

Then: "Done in Flow. Switch back to the stronger model and say 'C5 branding' for the titles and description."

## Rules

- Credits are spent only in step 3, only after the yes. Everything else is free. Nothing needs FFmpeg.
- Flow runs one job at a time with 25-70 s pauses; an agent batch draws a chapter at once. Give a rough time and don't
  apologise for the pace.
- If Flow blocks a prompt or a job fails twice, name the beat and send the user to the writing pass to reword it.
