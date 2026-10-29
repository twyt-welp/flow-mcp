import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";

// Plain-code audio and media basics, so the C5 pipeline needs no FFmpeg: WAV in and out, and the length and size of
// the files CapCut is given (WAV, MP3, MP4/MOV/M4A, PNG, JPEG, WebP) read straight from their headers.

export interface Pcm {
  rate: number;
  channels: Float32Array[];
}

export function writeWav(file: string, { rate, channels }: Pcm) {
  const n = channels[0]?.length ?? 0;
  const ch = channels.length;
  const buf = Buffer.alloc(44 + n * ch * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * ch * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * ch * 2, 28);
  buf.writeUInt16LE(ch * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * ch * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      buf.writeInt16LE(Math.round(v * 32767), o);
      o += 2;
    }
  writeFileSync(file, buf);
}

export function readWav(file: string): Pcm {
  const b = readFileSync(file);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${file} is not a WAV file.`);
  let o = 12, rate = 0, ch = 0, bits = 0, fmt = 1;
  while (o + 8 <= b.length) {
    const id = b.toString("ascii", o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === "fmt ") {
      fmt = b.readUInt16LE(o + 8);
      ch = b.readUInt16LE(o + 10);
      rate = b.readUInt32LE(o + 12);
      bits = b.readUInt16LE(o + 22);
    } else if (id === "data") {
      const bytes = Math.min(size, b.length - o - 8);
      const step = bits / 8;
      const n = Math.floor(bytes / (step * ch));
      const channels = Array.from({ length: ch }, () => new Float32Array(n));
      for (let i = 0; i < n; i++)
        for (let c = 0; c < ch; c++) {
          const p = o + 8 + (i * ch + c) * step;
          channels[c][i] = fmt === 3 ? b.readFloatLE(p) : bits === 16 ? b.readInt16LE(p) / 32768 : bits === 24 ? b.readIntLE(p, 3) / 8388608 : bits === 32 ? b.readInt32LE(p) / 2147483648 : (b[p] - 128) / 128;
        }
      return { rate, channels };
    }
    o += 8 + size + (size % 2);
  }
  throw new Error(`${file} has no audio data.`);
}

// Raw signed 16-bit mono, as Gemini's speech comes back.
export const fromPcm16 = (raw: Buffer, rate: number): Pcm => {
  const n = Math.floor(raw.length / 2);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = raw.readInt16LE(i * 2) / 32768;
  return { rate, channels: [mono] };
};

// A gentle level match: bring the loudest peak to about -1.5 dB so every take sits at the same volume.
export function normalise(p: Pcm, peakDb = -1.5): Pcm {
  let peak = 0;
  for (const c of p.channels) for (const v of c) peak = Math.max(peak, Math.abs(v));
  if (!peak) return p;
  const g = Math.pow(10, peakDb / 20) / peak;
  return { rate: p.rate, channels: p.channels.map((c) => c.map((v) => v * g)) };
}

// Takes off rumble below about 80 Hz (a one-pole high-pass), which is what keeps a voice clean under music.
export function highpass(p: Pcm, hz = 80): Pcm {
  const a = 1 / (1 + (2 * Math.PI * hz) / p.rate);
  return {
    rate: p.rate,
    channels: p.channels.map((c) => {
      const out = new Float32Array(c.length);
      let prevIn = 0, prevOut = 0;
      for (let i = 0; i < c.length; i++) {
        prevOut = a * (prevOut + c[i] - prevIn);
        prevIn = c[i];
        out[i] = prevOut;
      }
      return out;
    }),
  };
}

// Linear resampling: plenty for speech, and only used when two takes come back at different rates.
export function resample(p: Pcm, rate: number): Pcm {
  if (p.rate === rate) return p;
  const ratio = p.rate / rate;
  return {
    rate,
    channels: p.channels.map((c) => {
      const n = Math.floor(c.length / ratio);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = i * ratio, j = Math.floor(x), f = x - j;
        out[i] = c[j] * (1 - f) + (c[j + 1] ?? c[j]) * f;
      }
      return out;
    }),
  };
}

export const mono = (p: Pcm): Float32Array => {
  if (p.channels.length === 1) return p.channels[0];
  const out = new Float32Array(p.channels[0].length);
  for (const c of p.channels) for (let i = 0; i < out.length; i++) out[i] += c[i] / p.channels.length;
  return out;
};

// Joins takes end to end with a short silence between them, at the first take's sample rate.
export function joinTakes(parts: Pcm[], gapS: number): Pcm {
  const rate = parts[0].rate;
  const list = parts.map((p) => resample({ rate: p.rate, channels: [mono(p)] }, rate).channels[0]);
  const gap = Math.round(gapS * rate);
  const out = new Float32Array(list.reduce((a, c) => a + c.length, 0) + gap * (list.length - 1));
  let o = 0;
  for (const c of list) {
    out.set(c, o);
    o += c.length + gap;
  }
  return { rate, channels: [out] };
}

// Where the speaker pauses: runs of quiet 20 ms frames at least `minS` long, measured against the take's own loudness,
// so a soft voice and a loud one are judged alike. Also gives the first and last moment of speech.
export function pauses(p: Pcm, minS = 0.2): { speech: [number, number]; pauses: { start: number; end: number }[] } {
  const c = mono(p);
  const hop = Math.round(p.rate * 0.02);
  const rms: number[] = [];
  for (let i = 0; i + hop <= c.length; i += hop) {
    let s = 0;
    for (let k = i; k < i + hop; k++) s += c[k] * c[k];
    rms.push(Math.sqrt(s / hop));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const thr = Math.max(floor * 2, loud * 0.08, 1e-4);
  const quiet = rms.map((v) => v < thr);
  const first = quiet.indexOf(false), last = quiet.lastIndexOf(false);
  const out: { start: number; end: number }[] = [];
  if (first < 0) return { speech: [0, 0], pauses: out };
  let run = -1;
  for (let i = first; i <= last + 1; i++) {
    if (i <= last && quiet[i]) {
      if (run < 0) run = i;
    } else if (run >= 0) {
      if ((i - run) * 0.02 >= minS) out.push({ start: run * 0.02, end: i * 0.02 });
      run = -1;
    }
  }
  return { speech: [first * 0.02, (last + 1) * 0.02], pauses: out };
}

/* ---------- lengths and sizes from file headers ---------- */

export interface MediaInfo {
  width: number;
  height: number;
  duration: number; // seconds, 0 for stills
  audio: boolean;
}

export function mediaInfo(file: string): MediaInfo {
  const ext = file.toLowerCase().split(".").pop() ?? "";
  try {
    if (ext === "wav") {
      const h = wavHeader(file);
      return { width: 0, height: 0, duration: h, audio: true };
    }
    if (ext === "mp3") return { width: 0, height: 0, duration: mp3Duration(file), audio: true };
    if (["mp4", "mov", "m4a", "m4v", "aac"].includes(ext)) return mp4Info(file);
    if (["png", "jpg", "jpeg", "webp"].includes(ext)) return { ...imageSize(file), duration: 0, audio: false };
  } catch (err) {
    throw new Error(`Couldn't read "${file}": ${err instanceof Error ? err.message : err}`);
  }
  throw new Error(`"${file}" isn't a file type the timeline can use (WAV, MP3, MP4, MOV, M4A, PNG, JPEG or WebP).`);
}

export const duration = (file: string) => mediaInfo(file).duration;

function wavHeader(file: string): number {
  const fd = openSync(file, "r");
  try {
    const b = Buffer.alloc(4096);
    readSync(fd, b, 0, 4096, 0);
    let o = 12, rate = 0, block = 0;
    while (o + 8 <= b.length) {
      const id = b.toString("ascii", o, o + 4), size = b.readUInt32LE(o + 4);
      if (id === "fmt ") {
        rate = b.readUInt32LE(o + 12);
        block = b.readUInt16LE(o + 20);
      } else if (id === "data") {
        const size2 = Math.min(size, statSync(file).size - o - 8);
        return size2 / (rate * block);
      }
      o += 8 + size + (size % 2);
    }
  } finally {
    closeSync(fd);
  }
  throw new Error("no data chunk");
}

// Sums every MPEG audio frame (exact for constant and variable bitrate), after skipping any ID3 tag.
function mp3Duration(file: string): number {
  const b = readFileSync(file);
  let o = 0;
  if (b.toString("ascii", 0, 3) === "ID3") o = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f));
  const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  let seconds = 0;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) {
      o++;
      continue;
    }
    const ver = (b[o + 1] >> 3) & 3, layer = (b[o + 1] >> 1) & 3, bri = b[o + 2] >> 4, sri = (b[o + 2] >> 2) & 3, padding = (b[o + 2] >> 1) & 1;
    if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) {
      o++;
      continue;
    }
    const rate = RATES[ver][sri];
    const kbps = (ver === 3 ? BR1 : BR2)[bri];
    const samples = ver === 3 ? 1152 : 576;
    const len = Math.floor(((samples / 8) * kbps * 1000) / rate) + padding;
    if (len < 4) break;
    seconds += samples / rate;
    o += len;
  }
  if (!seconds) throw new Error("no MP3 frames found");
  return seconds;
}

// MP4 family: the movie length from mvhd, picture size from the video track's tkhd, sound if any track is 'soun'.
function mp4Info(file: string): MediaInfo {
  const b = readFileSync(file);
  const out: MediaInfo = { width: 0, height: 0, duration: 0, audio: false };
  const walk = (start: number, end: number, track?: { w: number; h: number; kind?: string }) => {
    let o = start;
    while (o + 8 <= end) {
      let size = b.readUInt32BE(o);
      const type = b.toString("ascii", o + 4, o + 8);
      let head = 8;
      if (size === 1) {
        size = Number(b.readBigUInt64BE(o + 8));
        head = 16;
      } else if (size === 0) size = end - o;
      if (size < head) break;
      const body = o + head;
      if (type === "moov" || type === "mdia" || type === "minf") walk(body, o + size, track);
      else if (type === "trak") {
        const t = { w: 0, h: 0, kind: undefined as string | undefined };
        walk(body, o + size, t);
        if (t.kind === "vide" && t.w) {
          out.width = t.w;
          out.height = t.h;
        }
        if (t.kind === "soun") out.audio = true;
      } else if (type === "mvhd") {
        const v = b[body];
        const scale = v === 1 ? b.readUInt32BE(body + 20) : b.readUInt32BE(body + 12);
        const dur = v === 1 ? Number(b.readBigUInt64BE(body + 24)) : b.readUInt32BE(body + 16);
        out.duration = dur / scale;
      } else if (type === "tkhd" && track) {
        const v = b[body];
        const at = body + (v === 1 ? 88 : 76);
        track.w = b.readUInt32BE(at) / 65536;
        track.h = b.readUInt32BE(at + 4) / 65536;
      } else if (type === "hdlr" && track) track.kind = b.toString("ascii", body + 8, body + 12);
      o += size;
    }
  };
  walk(0, b.length);
  if (!out.duration) throw new Error("no movie header (is the file complete?)");
  return out;
}

function imageSize(file: string): { width: number; height: number } {
  const b = readFileSync(file);
  if (b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const kind = b.toString("ascii", 12, 16);
    if (kind === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const m = b[o + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: b.readUInt16BE(o + 5), width: b.readUInt16BE(o + 7) };
      o += 2 + b.readUInt16BE(o + 2);
    }
  }
  throw new Error("unknown image format");
}
