---
name: c3-flow-run
description: Send a C3 Stickman Explainer video's saved prompts to Google Flow and finish it - character sheets, stills, a few paid hero clips under a credit cap, the voiceover in the user's own C3 cloned voice, the CapCut timeline written into the project files, and thumbnails. Built for a cheaper model; it never writes prompts. Use when the user says "run C3 in Flow", "send my C3 prompts to Flow", "draw the C3 stills", "make the C3 clips", "redo C3 still N", "record the C3 voiceover", or asks to edit or build a CapCut project for a C3 video.
---

# C3 in Flow: send the saved prompts

The prompts were written in the other pass (the `c3-flow` skill, on a stronger model) and are saved in the video's
record. This skill only sends them through the `flow` tools and reports results. The tools are shared with C5 (their
names say `c5`); the record's `engine: "c3"` makes them leave out the C5 mascot and use the C3 voice. Never write or
change a prompt here: when a result is wrong, tell the user to go back to the writing pass and say "rewrite C3 still N"
(or sheet, clip, thumbnail), then come back and say "redo C3 still N". Keep replies short: what ran, what came out, file
paths, what is next.

## Start

1. Call `flow_open_studio` only when the user asks to open Flow Studio (never use computer use for this).
2. `flow_status`. If not signed in or no project is open, tell the user to run `npm run login` in their flow-mcp folder,
   sign in and open a Flow project, and stop. Report plan and credits left in one line.
3. `flow_productions`, then `flow_production` for the video: the newest whose folder starts `C3-` with state
   "prompts_ready" or later (ask only if two could fit). Check what exists in `files` and carry on from the first step
   not done.

## Steps, in order

Each queues jobs: `flow_wait` until they finish (it answers within a minute; call it again while jobs run).

1. **Character sheets (free).** `flow_c5_sheets` with `video`. Skip it if every sheet in `sheets` has a file. Show the
   paths and ask "Are these characters okay?" A redo: `flow_c5_sheets` with `ids` and `redo: true`.
2. **Stills (free).** `flow_c5_stills` with `video` and one part's beat numbers at a time (beats share a `chapter`:
   OPENING, MIDDLE, ENDING). After each part show the paths and ask "Next part, or redo any?" A redo: `flow_c5_stills`
   with `beats`, `redo: true`, `mode: "one_by_one"`.
3. **Hero clips (PAID).** Count the hero beats with a `clip_prompt` (two to four). The cap per clip is
   `settings.max_credits` (default 12). C3 has a budget of 50 credits per video (the user's choice): the clips already
   in `files.clips` plus the clips to make, times the cap, must stay within 50. If they would not, make only the first
   ones that fit and say which were left as stills. A redo of a paid clip counts against the 50 too: ask before one
   that would go over. Ask "Spend about N x 10 credits on these N clips (at most M, inside your 50)? (yes / no)" and
   wait for a clear yes; never spend without it. Then `flow_c5_clips` with `video`, `max_credits` = the cap and
   `acknowledge_cost: true`. Each clip opens on its beat's still. A clip over the cap is skipped at no cost: say which.
   A clip made but not downloaded is already in Flow: `flow_download` it, never generate it again. `flow_retry` for a
   failed job. If a paid job vanishes from the queue, look at the grid (`flow_assets`) before running anything again.
4. **Voiceover.** `flow_voices`. C3 speaks in the user's own C3 voice recording: if `openvoice_c3.ready` is true, call
   `flow_voiceover` with `video` and `engine: "openvoice"` (free, on their computer; the C3 recording is picked by
   itself from the record). If it is not ready, say what `openvoice_c3.missing` names and stop: never fall back to the
   C5 voice or another engine unless the user asks. ElevenLabs only when the user asks for it ("use ElevenLabs"): if
   `elevenlabs_ready` and `elevenlabs_voice` are set, `flow_voiceover` with `engine: "elevenlabs"`; otherwise ask them
   to paste the key and voice ID in Flow Studio's Voice step, never in chat. Report the runtime against the target
   (about 36, 54 or 72 seconds for 6, 9 or 12 beats).
5. **CapCut (free).** If the user already asked for the edit in their own words, that request is this step: go straight
   to the build with that project name. Otherwise tell them: 1. open CapCut and make a new project named after the
   video, 2. import the `stills` and `clips` folders and `voice/narration.wav` (optional), 3. close CapCut completely,
   then ask for the project name. `flow_capcut_projects` to confirm the name (loosely) and that CapCut is closed, then
   `flow_capcut_build`. Never use computer use and never open CapCut. The build cuts every still to its line of the
   voiceover with its move, hands each hero beat over to its clip, lays music, ambience and effects from Claude's own
   sound library, and puts the headline over the opening for 2.5 seconds. Report what was placed, any `sfx_skipped`
   cues and warnings in a few lines, then "Open CapCut, check the edit and export it." `flow_capcut_restore` brings the
   old timeline back if asked.
6. **Thumbnails (free).** `flow_c5_thumbnails` with `video`. Show the paths and the saved `overlay_text`.

Then: "Done in Flow. Switch back to the stronger model and say 'C3 branding' for the titles and description."

## Rules

- Credits are spent only in step 3, only after the yes. Everything else is free. Nothing needs FFmpeg.
- Flow runs one job at a time with 25-70 s pauses; an agent batch draws a part at once. Give a rough time and don't
  apologise for the pace.
- If Flow blocks a prompt or a job fails twice, name the beat and send the user to the writing pass to reword it.
