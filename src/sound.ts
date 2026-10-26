import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalise, writeWav } from "./audio.js";

// Claude's own sound library: every sound effect, ambience bed and music track is synthesised here in plain code, so a
// video needs no downloads, no licences and no paid music service. Files are written once into the channel folder and
// named with plenty of synonyms ("door_bang_slam_shut"), which is how the CapCut build matches them to the engine's
// SOUND cues. The user's own files in their sound folder always win over these when both match.

const SR = 44100;
// Bump when a recipe changes, so the next build writes the library again.
const VERSION = "1";

type Buf = Float32Array;
const len = (s: number) => Math.max(1, Math.round(s * SR));
const blank = (s: number) => new Float32Array(len(s));
const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

// Seeded, so the library comes out identical on every computer.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- building blocks ---------- */

function noise(s: number, r: () => number, color: "white" | "pink" | "brown" = "white"): Buf {
  const x = blank(s);
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < x.length; i++) {
    const w = r() * 2 - 1;
    if (color === "white") x[i] = w;
    else if (color === "pink") {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      x[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
    } else {
      last = (last + 0.02 * w) / 1.02;
      x[i] = last * 3.5;
    }
  }
  return x;
}

type Hz = number | ((t: number) => number);

function osc(s: number, f: Hz, shape: "sine" | "saw" | "square" | "tri" = "sine", phase = 0): Buf {
  const x = blank(s);
  let p = phase;
  for (let i = 0; i < x.length; i++) {
    const fr = typeof f === "number" ? f : f(i / SR);
    p += fr / SR;
    p -= Math.floor(p);
    x[i] = shape === "sine" ? Math.sin(2 * Math.PI * p) : shape === "saw" ? 2 * p - 1 : shape === "square" ? (p < 0.5 ? 1 : -1) : 1 - 4 * Math.abs(p - 0.5);
  }
  return x;
}

// RBJ biquad; the cutoff may move over time (recomputed every 32 samples), which is what makes a whoosh sweep.
function filter(x: Buf, kind: "lp" | "hp" | "bp", f: Hz, q = 0.707): Buf {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  for (let i = 0; i < x.length; i++) {
    if (i % 32 === 0) {
      const fr = Math.min(SR * 0.45, Math.max(20, typeof f === "number" ? f : f(i / SR)));
      const w = (2 * Math.PI * fr) / SR, cs = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
      if (kind === "lp") [b0, b1, b2] = [(1 - cs) / 2, 1 - cs, (1 - cs) / 2];
      else if (kind === "hp") [b0, b1, b2] = [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2];
      else [b0, b1, b2] = [al, 0, -al];
      [b0, b1, b2, a1, a2] = [b0 / a0, b1 / a0, b2 / a0, (-2 * cs) / a0, (1 - al) / a0];
    }
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

const shape = (x: Buf, env: (t: number) => number) => {
  for (let i = 0; i < x.length; i++) x[i] *= env(i / SR);
  return x;
};
const decay = (tau: number, attack = 0.002) => (t: number) => Math.min(1, t / attack) * Math.exp(-t / tau);
const swell = (a: number, total: number, r: number) => (t: number) => Math.min(1, t / a) * Math.min(1, Math.max(0, (total - t) / r));

function mix(dst: Buf, src: Buf, at: number, gain = 1) {
  const o = Math.round(at * SR);
  for (let i = 0; i < src.length && o + i < dst.length; i++) if (o + i >= 0) dst[o + i] += src[i] * gain;
  return dst;
}

const sum = (...xs: Buf[]) => {
  const out = new Float32Array(Math.max(...xs.map((x) => x.length)));
  for (const x of xs) mix(out, x, 0);
  return out;
};

// A small Schroeder room: four damped combs and two all-passes. `size` stretches the room, `mix` is wet level.
function reverb(x: Buf, wet = 0.3, size = 1, tail = 2.5): Buf {
  const n = x.length + len(tail);
  const out = new Float32Array(n);
  const acc = new Float32Array(n);
  for (const d of [1557, 1617, 1491, 1422, 1277, 1356]) {
    const delay = Math.round(d * size), buf = new Float32Array(delay);
    let k = 0, lp = 0;
    for (let i = 0; i < n; i++) {
      const y = buf[k];
      lp = y * 0.7 + lp * 0.3;
      buf[k] = (i < x.length ? x[i] : 0) + lp * 0.84;
      acc[i] += y / 6;
      k = (k + 1) % delay;
    }
  }
  let y = acc;
  for (const d of [225, 556, 441]) {
    const delay = Math.round(d * size), buf = new Float32Array(delay), z = new Float32Array(n);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const b = buf[k];
      const v = y[i] + b * 0.5;
      buf[k] = v;
      z[i] = b - v * 0.5;
      k = (k + 1) % delay;
    }
    y = z;
  }
  for (let i = 0; i < n; i++) out[i] = (i < x.length ? x[i] * (1 - wet) : 0) + y[i] * wet * 2.2;
  return out;
}

// A struck tone from partials [ratio, level, decay seconds]: piano, bell, music box, clinks.
function strike(f: number, s: number, partials: [number, number, number][], attack = 0.003): Buf {
  const out = blank(s);
  for (const [ratio, amp, tau] of partials) mix(out, shape(osc(s, f * ratio, "sine"), decay(tau, attack)), 0, amp);
  return out;
}

const piano = (f: number, s: number) => filter(strike(f, s, [[1, 1, 1.6], [2, 0.45, 0.9], [3, 0.2, 0.55], [4, 0.1, 0.35], [5.02, 0.05, 0.2]], 0.004), "lp", 4000);
const bell = (f: number, s = 3) => strike(f, s, [[1, 1, 2.2], [2.76, 0.5, 1.3], [5.4, 0.28, 0.6], [8.93, 0.12, 0.3]]);
const musicBox = (f: number, s = 1.6) => strike(f, s, [[1, 1, 0.9], [3, 0.12, 0.4], [4.2, 0.18, 0.25]], 0.001);

function pad(f: number, s: number, cutoff = 1400, attack = 1.4, release = 1.6): Buf {
  const x = sum(osc(s, f, "saw"), osc(s, f * 1.004, "saw", 0.3), osc(s, f * 0.996, "saw", 0.7), osc(s, f / 2, "sine"));
  return shape(filter(x, "lp", cutoff, 0.6), swell(attack, s, release));
}

function kick(r: () => number) {
  const s = 0.45;
  return sum(shape(osc(s, (t) => 45 + 85 * Math.exp(-t * 28), "sine"), decay(0.18)), shape(filter(noise(0.02, r), "lp", 3000), decay(0.004)));
}
const snare = (r: () => number) => sum(shape(filter(noise(0.25, r), "bp", 2200, 0.8), decay(0.07)), shape(osc(0.12, 190, "tri"), decay(0.04)));
const hat = (r: () => number) => shape(filter(noise(0.08, r), "hp", 7500), decay(0.018));

// A loop with no click: whatever rings past the end (reverb, a last note) is folded back over the start.
function fold(x: Buf, loop: number): Buf {
  const n = len(loop);
  const out = x.slice(0, n);
  for (let i = n; i < x.length; i++) out[(i - n) % n] += x[i];
  return out;
}

// For noise beds: the end crossfades into the start, so the bed loops forever without a seam.
function seamless(x: Buf, loop: number, fade = 2): Buf {
  const n = len(loop), f = len(fade);
  const out = x.slice(0, n);
  for (let i = 0; i < f && n + i < x.length; i++) {
    const t = i / f;
    out[i] = x[i] * Math.sqrt(t) + x[n + i] * Math.sqrt(1 - t);
  }
  return out;
}

/* ---------- sound effects ---------- */

function thud(r: () => number, f0 = 70, s = 0.7) {
  return sum(shape(osc(s, (t) => f0 * 0.55 + f0 * Math.exp(-t * 18), "sine"), decay(0.16)), shape(filter(noise(s, r, "brown"), "lp", 700), decay(0.09)));
}
function knockOnce(r: () => number, f = 210) {
  return sum(shape(filter(noise(0.18, r), "bp", f * 1.7, 4), decay(0.03)), shape(osc(0.18, f, "sine"), decay(0.045)));
}
function step(r: () => number, bright = 1) {
  return sum(shape(filter(noise(0.22, r, "pink"), "lp", 900 * bright), decay(0.05, 0.006)), shape(filter(noise(0.1, r), "bp", 2400 * bright, 2), decay(0.015)));
}
function ping(r: () => number, base: number, s = 0.8) {
  return strike(base * (0.9 + r() * 0.2), s, [[1, 1, 0.25], [1.58, 0.6, 0.18], [2.43, 0.45, 0.12], [3.9, 0.25, 0.07]], 0.0005);
}

type Recipe = (r: () => number) => Buf;

const SFX: Record<string, Recipe> = {
  whoosh_swish_swoosh_swipe_transition_fast_pass: (r) => shape(filter(noise(1.0, r), "bp", (t) => 300 + 3200 * Math.sin(Math.PI * Math.min(1, t / 0.95)) ** 2, 1.4), (t) => Math.sin(Math.PI * Math.min(1, t / 1.0)) ** 2),
  impact_thud_hit_punch_body_fall_drop_thump: (r) => reverb(thud(r, 75, 0.9), 0.15, 0.6, 0.8),
  door_bang_slam_shut_close_slammed: (r) => reverb(sum(thud(r, 85, 1.0), mix(blank(1), shape(filter(noise(0.5, r), "bp", 180, 3), decay(0.12)), 0, 0.8), mix(blank(1), shape(filter(noise(0.3, r), "bp", 1500, 6), decay(0.05)), 0.05, 0.3)), 0.25, 0.9, 1.2),
  knock_knocking_door_wood_tap: (r) => reverb([0, 0.22, 0.44].reduce<Buf>((b, at) => mix(b, knockOnce(r, 200 + r() * 20), at), blank(1.0)), 0.15, 0.7, 0.6),
  footsteps_walking_steps_feet_footstep_approach: (r) => [0, 0.55, 1.1, 1.65, 2.2, 2.75].reduce<Buf>((b, at, i) => mix(b, step(r, 0.8 + r() * 0.4), at + r() * 0.04, 0.6 + i * 0.08), blank(3.1)),
  running_footsteps_run_fleeing_chase_steps: (r) => Array.from({ length: 10 }, (_, i) => i * 0.29).reduce<Buf>((b, at) => mix(b, step(r, 1.1 + r() * 0.3), at + r() * 0.02), blank(3.1)),
  heartbeat_heart_pulse_beating_tension_nervous: (r) => {
    const b = blank(3.6);
    for (let k = 0; k < 4; k++) {
      mix(b, filter(thud(r, 55, 0.3), "lp", 200), k * 0.86);
      mix(b, filter(thud(r, 50, 0.3), "lp", 180), k * 0.86 + 0.24, 0.7);
    }
    return b;
  },
  creak_creaking_wood_door_floor_floorboard_hinge_squeak: (r) => {
    const s = 1.8;
    const grains = osc(s, (t) => 18 + 10 * Math.sin(t * 3.1), "square").map((v) => Math.max(0, v));
    const x = filter(osc(s, (t) => 95 + 50 * Math.sin(t * 1.7) + 20 * Math.sin(t * 7), "saw"), "bp", (t) => 700 + 400 * Math.sin(t * 2.3), 5);
    for (let i = 0; i < x.length; i++) x[i] *= 0.4 + 0.6 * grains[i];
    return reverb(shape(x, swell(0.15, s, 0.4)), 0.2, 0.8, 0.8);
  },
  click_lock_latch_switch_bolt_unlock_key: (r) => sum(shape(filter(noise(0.08, r), "hp", 3000), decay(0.006)), mix(blank(0.4), shape(filter(noise(0.08, r), "bp", 2200, 3), decay(0.01)), 0.12, 0.9), mix(blank(0.4), shape(osc(0.1, 1800, "sine"), decay(0.015)), 0.12, 0.3)),
  metal_clink_cans_clinking_tin_rattle_jar_supplies: (r) => {
    const b = blank(1.8);
    for (let k = 0; k < 7; k++) mix(b, ping(r, 1900 + r() * 1800, 0.6), k * 0.18 + r() * 0.08, 0.5 + r() * 0.5);
    return reverb(b, 0.12, 0.6, 0.6);
  },
  coins_money_cash_clink_change_kaching_register: (r) => {
    const b = blank(1.6);
    for (let k = 0; k < 9; k++) mix(b, ping(r, 3200 + r() * 2600, 0.5), 0.05 + k * 0.07 + r() * 0.05, 0.4 + r() * 0.4);
    return mix(b, bell(2093, 1.4), 0.55, 0.4);
  },
  glass_shatter_break_smash_window_broken_crash: (r) => {
    const b = shape(filter(noise(1.6, r), "hp", 2500), decay(0.18, 0.001));
    for (let k = 0; k < 40; k++) mix(b, ping(r, 2500 + r() * 5000, 0.5), r() * r() * 1.2, 0.15 + r() * 0.3);
    return reverb(sum(b, mix(blank(0.5), thud(r, 120, 0.3), 0, 0.5)), 0.2, 0.8, 1);
  },
  thunder_rumble_storm_boom_lightning_crack: (r) => {
    const s = 5;
    const crack = shape(filter(noise(0.6, r), "hp", 800), decay(0.08, 0.001));
    const roll = shape(filter(noise(s, r, "brown"), "lp", (t) => 600 * Math.exp(-t / 1.5) + 90), (t) => Math.min(1, t / 0.05) * Math.exp(-t / 1.6) * (0.7 + 0.3 * Math.sin(t * 9 + Math.sin(t * 3))));
    return reverb(sum(mix(blank(s), crack, 0, 0.6), roll), 0.3, 1.4, 2);
  },
  riser_rise_build_buildup_tension_swell_suspense_up: (r) => {
    const s = 3.2;
    const air = filter(noise(s, r), "bp", (t) => 300 * Math.pow(18, t / s), 1.2);
    const tone = filter(sum(osc(s, (t) => 110 * Math.pow(2, t / s * 1.5), "saw"), osc(s, (t) => 111 * Math.pow(2, t / s * 1.5), "saw")), "lp", (t) => 400 + 3000 * (t / s));
    return shape(sum(air, mix(blank(s), tone, 0, 0.35)), (t) => Math.pow(t / s, 2.2) * Math.min(1, (s - t) / 0.03));
  },
  boom_braam_cinematic_hit_bass_drop_trailer_impact: (r) => {
    const s = 4;
    const brass = filter(sum(osc(s, 43.65, "saw"), osc(s, 43.9, "saw", 0.4), osc(s, 87.3, "saw", 0.2)), "lp", (t) => 200 + 1200 * Math.exp(-t * 1.8), 0.9);
    const sub = shape(osc(s, (t) => 38 + 30 * Math.exp(-t * 6), "sine"), decay(1.2, 0.005));
    return reverb(sum(shape(brass, decay(1.3, 0.02)), sub, mix(blank(s), shape(filter(noise(0.4, r), "lp", 2500), decay(0.06)), 0, 0.5)), 0.3, 1.5, 2.5);
  },
  alarm_beep_warning_beeping_alert_buzzer: () => {
    const b = blank(2.4);
    for (let k = 0; k < 6; k++) mix(b, shape(filter(osc(0.18, k % 2 ? 660 : 880, "square"), "lp", 3000), swell(0.005, 0.18, 0.01)), k * 0.4, 0.5);
    return b;
  },
  siren_wail_emergency_police_air_raid: () => reverb(shape(filter(osc(4, (t) => 600 + 500 * Math.sin(Math.PI * t * 0.5 - Math.PI / 2) ** 2, "saw"), "lp", 2500), swell(0.3, 4, 0.8)), 0.3, 1.3, 1.5),
  phone_buzz_vibrate_vibration_notification_text: () => {
    const b = blank(1.3);
    for (const at of [0, 0.55]) mix(b, shape(filter(osc(0.35, 165, "square"), "lp", 600), (t) => swell(0.01, 0.35, 0.02)(t) * (0.7 + 0.3 * Math.sin(t * 2 * Math.PI * 22))), at, 0.6);
    return b;
  },
  clock_tick_ticking_timer_countdown_watch_seconds: (r) => {
    const b = blank(5);
    for (let k = 0; k < 5; k++) mix(b, shape(filter(noise(0.05, r), "bp", k % 2 ? 3200 : 4200, 6), decay(0.006, 0.0005)), k, 0.9);
    return reverb(b, 0.15, 0.5, 0.4);
  },
  hammer_mallet_pound_nail_wood_hit_build_board: (r) => reverb([0, 0.5, 1.0, 1.5].reduce<Buf>((b, at) => mix(b, sum(knockOnce(r, 260 + r() * 30), mix(blank(0.2), ping(r, 2400, 0.15), 0, 0.15)), at), blank(2)), 0.2, 0.8, 0.8),
  crowd_murmur_people_voices_chatter_group_talking: (r) => {
    const s = 8;
    const b = blank(s + 2);
    for (let v = 0; v < 14; v++) {
      const f1 = 400 + r() * 500, rate = 2 + r() * 3, ph = r() * 10;
      const voice = filter(filter(noise(s + 2, r, "pink"), "bp", (t) => f1 * (1 + 0.3 * Math.sin(t * rate + ph)), 3), "lp", 2200);
      mix(b, shape(voice, (t) => 0.4 + 0.6 * Math.max(0, Math.sin(t * rate * 1.3 + ph)) ** 2), 0, 0.5);
    }
    return seamless(b, s);
  },
  groan_moan_zombie_growl_creature_infected_monster_snarl: (r) => {
    const s = 2.4;
    const src = sum(osc(s, (t) => 85 + 25 * Math.sin(t * 1.3) + 6 * Math.sin(t * 31), "saw"), mix(blank(s), noise(s, r), 0, 0.25));
    const x = sum(filter(src, "bp", (t) => 500 + 200 * Math.sin(t * 2), 4), mix(blank(s), filter(src, "bp", 1100, 5), 0, 0.6), mix(blank(s), filter(src, "lp", 300), 0, 0.5));
    return reverb(shape(x, (t) => swell(0.35, s, 0.6)(t) * (0.75 + 0.25 * Math.sin(t * 17))), 0.25, 1, 1.2);
  },
  breath_gasp_inhale_sigh_breathing_shock_scared: (r) => shape(filter(noise(0.9, r, "pink"), "bp", (t) => 900 + 900 * (t / 0.9), 1.5), (t) => Math.sin(Math.PI * Math.min(1, t / 0.9)) ** 1.5),
  gunshot_gun_shot_bang_fire_pistol_rifle: (r) => reverb(sum(shape(filter(noise(0.5, r), "lp", 6000), decay(0.03, 0.0005)), thud(r, 110, 0.5)), 0.35, 1.6, 2),
  drip_water_drop_leak_droplet_dripping: (r) => [0, 0.7, 1.5].reduce<Buf>((b, at) => mix(b, shape(osc(0.12, (t) => 900 + 2600 * t * 8, "sine"), decay(0.02, 0.001)), at + r() * 0.1, 0.6), blank(2)),
  splash_water_splash_puddle_wade_river: (r) => {
    const b = shape(filter(noise(1.2, r), "lp", (t) => 5000 * Math.exp(-t * 3) + 400), decay(0.22, 0.004));
    for (let k = 0; k < 12; k++) mix(b, shape(osc(0.06, (t) => 500 + r() * 900 + t * 9000, "sine"), decay(0.015)), 0.15 + r() * 0.8, 0.2);
    return b;
  },
  chime_ding_bell_notification_success_reveal_idea: () => reverb(sum(bell(1318.5, 2.5), mix(blank(2.5), bell(1975.5, 2.2), 0.12, 0.6)), 0.3, 1.1, 1.5),
  pop_bubble_blip_ui_appear_tick: () => shape(osc(0.12, (t) => 900 * Math.exp(-t * 25) + 300, "sine"), decay(0.03, 0.001)),
  rustle_cloth_bag_paper_rummage_search_pack: (r) => {
    const b = blank(1.6);
    for (let k = 0; k < 14; k++) mix(b, shape(filter(noise(0.15, r), "bp", 2500 + r() * 3500, 1.5), decay(0.04, 0.01)), r() * 1.4, 0.3 + r() * 0.4);
    return b;
  },
  static_radio_noise_glitch_interference_tv_broadcast: (r) => shape(filter(noise(2, r), "bp", (t) => 1800 + 1200 * Math.sin(t * 13), 0.8), (t) => swell(0.02, 2, 0.1)(t) * (0.5 + 0.5 * (Math.sin(t * 47) > 0.6 ? 0 : 1))),
};

/* ---------- ambience beds (loop forever) ---------- */

const AMBIENCE: Record<string, Recipe> = {
  wind_howling_gusts_storm_outdoor_cold_desolate: (r) => {
    const s = 32;
    const gust = (t: number) => 0.5 + 0.3 * Math.sin(t * 0.37) + 0.2 * Math.sin(t * 0.91 + 1);
    const x = sum(filter(noise(s + 2, r, "pink"), "bp", (t) => 350 + 500 * gust(t), 1.2), mix(blank(s + 2), filter(noise(s + 2, r), "bp", (t) => 900 + 700 * gust(t + 2), 6), 0, 0.3));
    return seamless(shape(x, (t) => 0.5 + 0.5 * gust(t)), s);
  },
  rain_rainfall_downpour_storm_roof_wet: (r) => {
    const s = 30;
    const x = sum(filter(noise(s + 2, r, "pink"), "lp", 6000), mix(blank(s + 2), filter(noise(s + 2, r, "brown"), "lp", 400), 0, 0.5));
    for (let k = 0; k < 900; k++) mix(x, shape(filter(noise(0.03, r), "bp", 3000 + r() * 4000, 2), decay(0.006, 0.0005)), r() * (s + 1), 0.2 + r() * 0.3);
    return seamless(x, s);
  },
  crickets_night_insects_quiet_evening_outdoor_calm: (r) => {
    const s = 24;
    const x = mix(blank(s + 2), filter(noise(s + 2, r, "pink"), "lp", 500), 0, 0.15);
    for (let c = 0; c < 5; c++) {
      const f = 4200 + r() * 900, rate = 2 + r() * 1.5, ph = r() * 6;
      const chirp = osc(s + 2, f, "sine");
      mix(x, shape(chirp, (t) => (Math.sin(t * 2 * Math.PI * rate + ph) > 0.3 ? 1 : 0) * (0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 30) ** 2) * 0.12), 0);
    }
    return seamless(x, s);
  },
  room_tone_indoor_quiet_silence_inside_house_still: (r) => seamless(sum(filter(noise(22, r, "brown"), "lp", 220), mix(blank(22), filter(noise(22, r, "pink"), "lp", 1500), 0, 0.08), mix(blank(22), osc(22, 60, "sine"), 0, 0.02)), 20),
  city_hum_distant_traffic_urban_town_street: (r) => {
    const s = 30;
    const x = sum(filter(noise(s + 2, r, "brown"), "lp", 350), mix(blank(s + 2), filter(noise(s + 2, r, "pink"), "bp", 900, 0.7), 0, 0.2));
    for (let k = 0; k < 5; k++) mix(x, shape(filter(noise(5, r, "pink"), "bp", 500 + r() * 400, 1), (t) => Math.sin(Math.PI * t / 5) ** 2), r() * (s - 3), 0.5);
    return seamless(x, s);
  },
  generator_hum_machine_engine_drone_power_motor: (r) => {
    const s = 20;
    const x = filter(sum(osc(s + 2, 50, "saw"), osc(s + 2, 100.4, "square"), mix(blank(s + 2), noise(s + 2, r, "brown"), 0, 0.5)), "lp", 500);
    return seamless(shape(x, (t) => 0.85 + 0.15 * Math.sin(t * 2 * Math.PI * 7)), s);
  },
  fire_crackle_campfire_fireplace_flames_burning_warm: (r) => {
    const s = 24;
    const x = mix(blank(s + 2), filter(noise(s + 2, r, "brown"), "lp", 300), 0, 0.8);
    for (let k = 0; k < 500; k++) mix(x, shape(filter(noise(0.02, r), "hp", 1500 + r() * 3000), decay(0.003 + r() * 0.006, 0.0003)), r() * (s + 1), 0.15 + r() * r() * 0.8);
    return seamless(x, s);
  },
  dripping_cave_basement_bunker_water_echo_underground: (r) => {
    const s = 24;
    const x = mix(blank(s + 2), filter(noise(s + 2, r, "brown"), "lp", 180), 0, 0.6);
    for (let k = 0; k < 22; k++) mix(x, shape(osc(0.1, (t) => 800 + r() * 500 + t * 20000, "sine"), decay(0.02, 0.001)), r() * s, 0.3 + r() * 0.3);
    return seamless(reverb(x, 0.45, 1.8, 0), s);
  },
};

/* ---------- music beds (loop forever, instrumental) ---------- */

// Chords as MIDI notes; each recipe tiles its bars exactly, so the end of the loop leads straight back into the start.
const CHORDS = {
  minor: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], // Am F C G
  sadder: [[57, 60, 64], [52, 55, 59], [53, 57, 60], [52, 56, 59]], // Am Em F E
  major: [[48, 52, 55], [55, 59, 62], [57, 60, 64], [53, 57, 60]], // C G Am F
  calm: [[48, 52, 55, 59], [53, 57, 60, 64], [45, 48, 52, 55], [50, 53, 57, 60]], // Cmaj7 Fmaj7 Am7 Dm7
};

const MUSIC: Record<string, Recipe> = {
  tense_suspense_dread_dark_ominous_pulse_synth_drone_thriller_danger: (r) => {
    const bar = 3, bars = 16, s = bar * bars;
    const out = blank(s + 4);
    mix(out, filter(sum(osc(s + 4, midi(33), "saw"), osc(s + 4, midi(33) * 1.003, "saw"), osc(s + 4, midi(34), "sine")), "lp", (t) => 260 + 120 * Math.sin((t * 2 * Math.PI) / s * 2)), 0, 0.5);
    const roots = [45, 45, 46, 44];
    for (let b = 0; b < bars; b++)
      for (let e = 0; e < 8; e++) {
        const note = filter(osc(0.3, midi(roots[Math.floor(b / 4) % 4] + (e === 7 ? 12 : 0)), "square"), "lp", 900 + 500 * (b % 4) / 3);
        mix(out, shape(note, decay(0.11, 0.004)), b * bar + e * (bar / 8), 0.22);
      }
    for (let b = 0; b < bars; b += 4) mix(out, bell(midi(81 + (b % 8 ? 1 : 0)), 3), b * bar + 1.5, 0.05);
    for (let b = 0; b < bars; b += 2) mix(out, filter(thud(r, 45, 1.2), "lp", 150), b * bar, 0.45);
    return fold(reverb(out, 0.3, 1.3, 3), s);
  },
  sad_melancholy_emotional_piano_grief_somber_loss_sorrow_heartbreak: () => {
    const bar = 3.6, bars = 16, s = bar * bars;
    const out = blank(s + 5);
    for (let b = 0; b < bars; b++) {
      const ch = CHORDS.sadder[b % 4];
      mix(out, pad(midi(ch[0] - 12), bar + 1.4, 700, 1.2, 1.2), b * bar, 0.12);
      const arp = [ch[0], ch[1], ch[2], ch[1] + 12, ch[2], ch[1]];
      arp.forEach((n, i) => mix(out, piano(midi(n), 2.4), b * bar + i * (bar / 6), 0.32));
      if (b % 2 === 1) mix(out, piano(midi(ch[2] + 12), 3), b * bar + bar * 0.5, 0.22);
    }
    return fold(reverb(out, 0.38, 1.5, 4), s);
  },
  hopeful_uplifting_warm_strings_inspiring_resolve_rebuild_determined_new_start: () => {
    const bar = 2.4, bars = 20, s = bar * bars;
    const out = blank(s + 5);
    for (let b = 0; b < bars; b++) {
      const ch = CHORDS.major[b % 4];
      for (const n of ch) mix(out, pad(midi(n), bar + 1.2, 1600, 0.8, 1.1), b * bar, 0.07);
      mix(out, pad(midi(ch[0] - 12), bar + 1, 500, 0.3, 0.9), b * bar, 0.12);
      if (b >= 4) [0, 1, 2, 1, 2, 3, 2, 1].forEach((k, i) => mix(out, musicBox(midi((ch[k % 3] ?? ch[0]) + 12 + (k === 3 ? 12 : 0)), 1.2), b * bar + i * (bar / 8), 0.12));
    }
    return fold(reverb(out, 0.32, 1.4, 4), s);
  },
  action_urgent_driving_percussion_chase_intense_battle_fight_run_escape: (r) => {
    const beat = 0.5, bar = beat * 4, bars = 24, s = bar * bars;
    const out = blank(s + 3);
    const k = kick(r), sn = snare(r), h = hat(r);
    const roots = [45, 45, 41, 43];
    for (let b = 0; b < bars; b++) {
      const root = roots[Math.floor(b / 2) % 4];
      for (let q = 0; q < 4; q++) {
        mix(out, k, b * bar + q * beat, q % 2 ? 0.6 : 0.9);
        if (q % 2) mix(out, sn, b * bar + q * beat, 0.5);
      }
      for (let e = 0; e < 8; e++) mix(out, h, b * bar + e * (beat / 2), e % 2 ? 0.18 : 0.28);
      for (let e = 0; e < 8; e++) mix(out, shape(filter(osc(0.24, midi(root - 12 + (e % 4 === 3 ? 12 : 0)), "saw"), "lp", 700), decay(0.12, 0.003)), b * bar + e * (beat / 2), 0.35);
      if (b % 4 === 0) mix(out, pad(midi(root + 12), bar * 4 + 1, 1800, 0.2, 0.8), b * bar, 0.06);
    }
    return fold(reverb(out, 0.15, 1, 2), s);
  },
  eerie_creepy_horror_unsettling_ambient_mystery_haunting_strange_dark: (r) => {
    const s = 48;
    const out = blank(s + 5);
    for (const [n, d] of [[52, 0], [53, 0.3], [59, 0.7], [64, -0.4]] as [number, number][]) mix(out, shape(osc(s + 5, (t) => midi(n) * (1 + 0.004 * Math.sin((t * 2 * Math.PI) / s * 3 + d)), "sine"), (t) => 0.6 + 0.4 * Math.sin((t * 2 * Math.PI) / s * 2 + d)), 0, 0.12);
    mix(out, filter(noise(s + 5, r, "pink"), "bp", (t) => 1200 + 600 * Math.sin((t * 2 * Math.PI) / s), 6), 0, 0.15);
    for (let k = 0; k < 8; k++) mix(out, bell(midi([76, 77, 83, 82][k % 4]), 4), k * 6 + 2, 0.06);
    return fold(reverb(out, 0.5, 1.8, 5), s);
  },
  calm_peaceful_soft_gentle_ambient_quiet_reflective_relaxed_morning: () => {
    const bar = 4, bars = 12, s = bar * bars;
    const out = blank(s + 5);
    for (let b = 0; b < bars; b++) {
      const ch = CHORDS.calm[b % 4];
      for (const n of ch) mix(out, pad(midi(n), bar + 1.5, 1100, 1.5, 1.5), b * bar, 0.06);
      [ch[3] + 12, ch[1] + 12].forEach((n, i) => mix(out, piano(midi(n), 3), b * bar + 0.5 + i * 2, 0.16));
    }
    return fold(reverb(out, 0.4, 1.6, 5), s);
  },
  flashback_memory_nostalgic_dreamy_past_music_box_childhood_remember_lullaby: () => {
    const bar = 3, bars = 12, s = bar * bars;
    const out = blank(s + 5);
    const tune = [76, 79, 81, 79, 76, 74, 72, 74, 76, 74, 72, 69];
    for (let b = 0; b < bars; b++) {
      const ch = CHORDS.minor[b % 4];
      mix(out, pad(midi(ch[0]), bar + 1.4, 900, 1.2, 1.4), b * bar, 0.08);
      for (let i = 0; i < 3; i++) mix(out, musicBox(midi(tune[(b * 3 + i) % tune.length] ?? 76)), b * bar + i * 1, 0.28);
    }
    return fold(reverb(out, 0.45, 1.7, 4), s);
  },
  epic_triumphant_victory_heroic_climax_finale_big: (r) => {
    const beat = 0.6, bar = beat * 4, bars = 16, s = bar * bars;
    const out = blank(s + 4);
    const k = kick(r);
    for (let b = 0; b < bars; b++) {
      const ch = CHORDS.major[b % 4];
      for (const n of ch) mix(out, pad(midi(n), bar + 1, 2400, 0.3, 0.9), b * bar, 0.08);
      mix(out, pad(midi(ch[0] - 12), bar + 1, 600, 0.1, 0.8), b * bar, 0.15);
      for (let q = 0; q < 4; q++) mix(out, k, b * bar + q * beat, q === 0 ? 0.9 : 0.4);
      if (b % 2 === 0) mix(out, thud(r, 60, 1.2), b * bar, 0.4);
    }
    return fold(reverb(out, 0.3, 1.5, 3), s);
  },
};

/* ---------- writing the library ---------- */

const GROUPS = { sfx: SFX, ambience: AMBIENCE, music: MUSIC } as const;

// Writes any missing file into <dir>/{sfx,ambience,music}. A few seconds the first time, instant afterwards.
export function ensureSoundLibrary(dir: string): { dir: string; made: number; files: number } {
  const stamp = join(dir, "library-version.txt");
  const fresh = !(existsSync(stamp) && readFileSync(stamp, "utf8").trim() === VERSION);
  let made = 0, files = 0;
  for (const [group, recipes] of Object.entries(GROUPS)) {
    const out = join(dir, group);
    mkdirSync(out, { recursive: true });
    const want = new Set(Object.keys(recipes).map((n) => `${n}.wav`));
    // Only files this library made are ever removed: anything the user drops in here is left alone.
    if (fresh) for (const f of readdirSync(out)) if (f.endsWith(".wav") && !want.has(f) && /^[a-z_]+\.wav$/.test(f)) rmSync(join(out, f), { force: true });
    let seed = 1;
    for (const [name, recipe] of Object.entries(recipes)) {
      const file = join(out, `${name}.wav`);
      seed++;
      files++;
      if (!fresh && existsSync(file)) continue;
      const x = recipe(rng(seed * 7919));
      // Effects and beds are levelled hot (CapCut's volume does the mixing); music a little lower, as a bed.
      const level = normalise({ rate: SR, channels: [x] }, group === "music" ? -3 : -1.5);
      // A steady sound (an alarm, a hum) normalised to its peak would be far louder than a hit: cap its average level.
      const c = level.channels[0];
      const rms = Math.sqrt(c.reduce((a, v) => a + v * v, 0) / c.length);
      const cap = Math.pow(10, -15 / 20);
      if (rms > cap) for (let i = 0; i < c.length; i++) c[i] *= cap / rms;
      writeWav(file, level);
      made++;
    }
  }
  writeFileSync(stamp, VERSION);
  return { dir, made, files };
}

export const SOUND_NAMES = { sfx: Object.keys(SFX), ambience: Object.keys(AMBIENCE), music: Object.keys(MUSIC) };
