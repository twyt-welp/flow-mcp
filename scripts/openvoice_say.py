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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="OpenVoice checkout holding checkpoints_v2/")
    ap.add_argument("--ref", required=True, help="Recording of the voice to clone")
    ap.add_argument("--se", required=True, help="Where the reference's speaker embedding is cached")
    ap.add_argument("--text", required=True, help="UTF-8 text file with the words to speak")
    ap.add_argument("--out", required=True, help="WAV file to write")
    ap.add_argument("--language", default="EN_NEWEST", help="MeloTTS language (EN_NEWEST, EN, ES, FR, ZH, JP, KR)")
    ap.add_argument("--speed", type=float, default=1.0)
    a = ap.parse_args()

    sys.path.insert(0, a.repo)
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
        text = " ".join(f.read().split())

    model = TTS(language=a.language, device=device)
    speaker_key, speaker_id = next(iter(model.hps.data.spk2id.items()))
    source_se = torch.load(os.path.join(ckpt, "base_speakers", "ses", f"{speaker_key.lower().replace('_', '-')}.pth"), map_location=device)

    with tempfile.TemporaryDirectory() as tmp:
        base = os.path.join(tmp, "base.wav")
        model.tts_to_file(text, speaker_id, base, speed=a.speed)
        audio = converter.convert(audio_src_path=base, src_se=source_se, tgt_se=target_se, message="@MyShell")

    rate = converter.hps.data.sampling_rate
    soundfile.write(a.out, audio, rate, subtype="PCM_16")
    print(json.dumps({"output": a.out, "seconds": round(len(audio) / rate, 3), "device": device}))


if __name__ == "__main__":
    main()
