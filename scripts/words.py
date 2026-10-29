"""Hear when every word of a voiceover take is spoken, with faster-whisper from OpenVoice's own Python.

Called by flow-mcp (src/openvoice.ts) once per take, after it is recorded:
  python words.py --wav <take.wav> --out <words.json> [--model base.en]

OpenVoice already installs faster-whisper, so the captions need nothing new beyond the speech model, which faster-whisper
fetches once from Hugging Face (base.en, about 145 MB) and keeps in its cache. Writes [{"text", "start", "end"}, ...].
"""
import argparse
import json


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="base.en")
    a = ap.parse_args()

    import ctranslate2
    from faster_whisper import WhisperModel

    cuda = ctranslate2.get_cuda_device_count() > 0
    model = WhisperModel(a.model, device="cuda" if cuda else "cpu", compute_type="float16" if cuda else "int8")
    segments, _ = model.transcribe(a.wav, language="en", word_timestamps=True, vad_filter=False, beam_size=5)
    words = [
        {"text": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)}
        for s in segments
        for w in (s.words or [])
        if w.word.strip()
    ]
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(words, f)
    print(json.dumps({"words": len(words), "device": "cuda" if cuda else "cpu"}))


if __name__ == "__main__":
    main()
