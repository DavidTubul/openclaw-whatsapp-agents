#!/usr/bin/env python3
# shared/tools/transcribe-fw.py — pluggable faster-whisper backend for transcribe-media.mjs.
#
# Transcribes ONE audio file to Hebrew text on stdout. Exit codes are meaningful to the Node caller:
#   0  -> success; the transcript text is on stdout
#   3  -> backend unavailable (faster-whisper not importable / model can't load) — the caller keeps
#         the file queued and retries on a later run (do NOT mark it failed)
#   1  -> per-file transcription error (corrupt/unreadable audio) — the caller marks it failed
#
# NEVER prints a fake/empty "success": an empty transcript still exits 0 only when the model ran and
# genuinely produced nothing (very short/silent clip); otherwise it errors. WhatsApp voice notes are
# short opus/ogg, so a small model on CPU (int8) is enough for Hebrew.
#
# Config via env:
#   WHISPER_MODEL       model size (default "small"; "medium" is better Hebrew but heavier)
#   WHISPER_DEVICE      "cpu" (default)
#   WHISPER_COMPUTE     compute type (default "int8")
#   WHISPER_LANG        language (default "he")
import os
import sys


def eprint(*a):
    print(*a, file=sys.stderr, flush=True)


def main():
    if len(sys.argv) < 2:
        eprint("usage: transcribe-fw.py <audio-file>")
        return 1
    path = sys.argv[1]
    if not os.path.isfile(path):
        eprint(f"no such file: {path}")
        return 1

    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # backend not installed / import error
        eprint(f"faster-whisper unavailable: {e}")
        return 3

    model_size = os.environ.get("WHISPER_MODEL", "small")
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    compute = os.environ.get("WHISPER_COMPUTE", "int8")
    lang = os.environ.get("WHISPER_LANG", "he")

    try:
        model = WhisperModel(model_size, device=device, compute_type=compute)
    except Exception as e:  # model download/load failed (offline, disk, etc.)
        eprint(f"model load failed ({model_size}/{device}/{compute}): {e}")
        return 3

    try:
        segments, _info = model.transcribe(path, language=lang, beam_size=1, vad_filter=True)
        text = "".join(seg.text for seg in segments).strip()
    except Exception as e:
        eprint(f"transcription failed: {e}")
        return 1

    sys.stdout.write(text)
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
