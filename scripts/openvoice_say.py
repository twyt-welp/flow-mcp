"""Speak a text file in the channel's cloned voice with OpenVoice V2 (MeloTTS base voice + tone colour converter).

Called by flow-mcp (src/openvoice.ts) once per voiceover take:
  python openvoice_say.py --repo <OpenVoice folder> --ref <reference.wav> --se <cache.pth> --text <take.txt> --out <take.wav>

The speaker embedding of the reference recording is worked out once and cached in --se, so later takes only load the
models and speak. Prints one JSON line on success: {"output": ..., "seconds": ...}.
"""
import argparse
import json
import os
import sys
import tempfile


def trim(audio, sr, keep=0.04):
    """Cut the quiet off both ends of one spoken sentence, leaving `keep` seconds so no word is clipped."""
    import numpy as np
    hop = max(1, int(sr * 0.01))
    n = len(audio) // hop
    if n == 0:
        return audio
    rms = np.sqrt((audio[: n * hop].reshape(n, hop) ** 2).mean(1))
    loud = np.nonzero(rms > rms.max() * 0.03)[0]
    if not len(loud):
        return audio
    pad = int(sr * keep)
    return audio[max(0, loud[0] * hop - pad): min(len(audio), (loud[-1] + 1) * hop + pad)]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="OpenVoice checkout holding checkpoints_v2/")
    ap.add_argument("--ref", required=True, help="Recording of the voice to clone")
    ap.add_argument("--se", required=True, help="Where the reference's speaker embedding is cached")
    ap.add_argument("--text", required=True, help="UTF-8 text file with the words to speak")
    ap.add_argument("--out", required=True, help="WAV file to write")
    ap.add_argument("--language", default="EN_NEWEST", help="MeloTTS language (EN_NEWEST, EN, ES, FR, ZH, JP, KR)")
    ap.add_argument("--speed", type=float, default=None, help="Default: \"speed\" in openvoice.json beside --ref, else 1.0")
    ap.add_argument("--sdp-ratio", type=float, default=None, help="Rhythm variety (Melo 0.2); default: openvoice.json")
    ap.add_argument("--noise-scale", type=float, default=None, help="Pitch/energy variety (Melo 0.6); default: openvoice.json")
    a = ap.parse_args()
    cfg_file = os.path.join(os.path.dirname(os.path.abspath(a.ref)), "openvoice.json")
    cfg = json.load(open(cfg_file, encoding="utf-8")) if os.path.isfile(cfg_file) else {}
    if a.speed is None:
        a.speed = float(cfg.get("speed", 1.0))
    # MeloTTS leaves only ~0.05 s between the sentences it splits off itself, so the read ran sentence into sentence
    # (2026-10-29, "the pauses are really bad"). Each sentence is spoken on its own and these silences put between.
    sentence_pause = float(cfg.get("sentence_pause", 0.45))
    line_pause = float(cfg.get("line_pause", 0.75))
    # Expression: Melo's defaults (sdp_ratio 0.2, noise_scale 0.6) read flat, and the converter only changes the
    # timbre, so any lift in pitch and rhythm has to come from here. CLI values win, for samples.
    sdp_ratio = a.sdp_ratio if a.sdp_ratio is not None else float(cfg.get("sdp_ratio", 0.2))
    noise_scale = a.noise_scale if a.noise_scale is not None else float(cfg.get("noise_scale", 0.6))

    sys.path.insert(0, a.repo)
    import re
    import numpy as np
    import soundfile
    import torch
    from melo.api import TTS
    from openvoice import se_extractor
    from openvoice.api import ToneColorConverter

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    ckpt = os.path.join(a.repo, "checkpoints_v2")
    converter = ToneColorConverter(os.path.join(ckpt, "converter", "config.json"), device=device)
    converter.load_ckpt(os.path.join(ckpt, "converter", "checkpoint.pth"))

    if os.path.isfile(a.se):
        target_se = torch.load(a.se, map_location=device)
    else:
        work = os.path.join(os.path.dirname(os.path.abspath(a.se)), "openvoice-processed")
        target_se, _ = se_extractor.get_se(a.ref, converter, target_dir=work, vad=True)
        torch.save(target_se.cpu(), a.se)
        target_se = target_se.to(device)

    with open(a.text, encoding="utf-8") as f:
        lines = [" ".join(l.split()) for l in f.read().splitlines() if l.strip()]

    model = TTS(language=a.language, device=device)
    speaker_key, speaker_id = next(iter(model.hps.data.spk2id.items()))
    source_se = torch.load(os.path.join(ckpt, "base_speakers", "ses", f"{speaker_key.lower().replace('_', '-')}.pth"), map_location=device)

    sr = model.hps.data.sampling_rate
    pieces = []
    for li, line in enumerate(lines):
        sentences = [s for s in re.split(r"(?<=[.!?])[\"')\]]*\s+", line) if s.strip()]
        for si, s in enumerate(sentences):
            # Melo pads each sentence with ~0.3 s of quiet at both ends (gaps came out at 1.1 s), so trim it to 40 ms.
            pieces.append(trim(np.asarray(model.tts_to_file(s, speaker_id, None, sdp_ratio=sdp_ratio, noise_scale=noise_scale, speed=a.speed, quiet=True), dtype=np.float32), sr))
            last = li == len(lines) - 1 and si == len(sentences) - 1
            if not last:
                pieces.append(np.zeros(int(sr * (line_pause if si == len(sentences) - 1 else sentence_pause)), dtype=np.float32))

    with tempfile.TemporaryDirectory() as tmp:
        base = os.path.join(tmp, "base.wav")
        soundfile.write(base, np.concatenate(pieces), sr)
        audio = converter.convert(audio_src_path=base, src_se=source_se, tgt_se=target_se, message="@MyShell")

    rate = converter.hps.data.sampling_rate
    soundfile.write(a.out, audio, rate, subtype="PCM_16")
    print(json.dumps({"output": a.out, "seconds": round(len(audio) / rate, 3), "device": device}))


if __name__ == "__main__":
    main()
