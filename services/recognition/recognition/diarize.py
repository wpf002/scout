"""Diarisation: who spoke when, so a multi-speaker probe becomes one probe
per speaker.

The real diariser is pyannote.audio's speaker-diarization pipeline, a gated
model that needs the `models` extra and a Hugging Face token
(RECOGNITION_HF_TOKEN) with the model's terms accepted. Without it, a
request that asks for diarisation is answered 503, never with a guess. The
deterministic diariser (RECOGNITION_EMBEDDER=test) splits the media bytes
on "|" so the per-speaker path can be exercised without a model.

Each speaker's audio is cropped and concatenated into its own media, which
is then embedded and compared like any single-speaker probe, with its own
hash. The caller sees one result per speaker; nothing is averaged across
speakers, because an average of two people is nobody.
"""

from __future__ import annotations

import io
import os
from dataclasses import dataclass
from typing import Protocol

from recognition.embedders import ModelUnavailable, NoSubject


@dataclass(frozen=True)
class SpeakerMedia:
    speaker: str
    media: bytes
    seconds: float | None


class Diariser(Protocol):
    model: str

    def split(self, media: bytes, content_type: str) -> list[SpeakerMedia]: ...


class DeterministicDiariser:
    model = "deterministic-diariser (not a diariser)"

    def split(self, media: bytes, content_type: str) -> list[SpeakerMedia]:
        parts = [p for p in media.split(b"|") if len(p) > 0]
        if not parts:
            raise NoSubject("empty media")
        return [SpeakerMedia(speaker=f"SPEAKER_{i:02d}", media=part, seconds=None) for i, part in enumerate(parts)]


class PyannoteDiariser:
    """pyannote.audio speaker diarisation, then per-speaker crops re-encoded
    as WAV for the voice embedder. Untested where the extra is absent."""

    def __init__(self, source: str) -> None:
        token = os.environ.get("RECOGNITION_HF_TOKEN", "").strip()
        try:
            import torch  # noqa: F401
            import torchaudio  # noqa: F401
            from pyannote.audio import Pipeline
        except ImportError as error:  # pragma: no cover - depends on the extra
            raise ModelUnavailable("VOICE", f"{error}. Install with `uv sync --extra models` (pyannote.audio) and set RECOGNITION_HF_TOKEN.") from error
        if token == "":  # pragma: no cover - depends on the extra
            raise ModelUnavailable("VOICE", "RECOGNITION_HF_TOKEN is not set; the diarisation model is gated and needs an accepted-terms token.")
        self.model = f"pyannote/{source.split('/')[-1]}"
        self._pipeline = Pipeline.from_pretrained(source, use_auth_token=token)

    def split(self, media: bytes, content_type: str) -> list[SpeakerMedia]:  # pragma: no cover - depends on the extra
        import torch  # noqa: F401

        from recognition.embedders import SpeechBrainEmbedder

        # The same stdlib WAV decode the voice embedder uses, so a WAV probe
        # needs no FFmpeg here either.
        waveform, rate = SpeechBrainEmbedder._decode(media)
        if waveform.numel() == 0:
            raise NoSubject("empty audio")
        diarisation = self._pipeline({"waveform": waveform, "sample_rate": rate})
        pieces: dict[str, list[torch.Tensor]] = {}
        seconds: dict[str, float] = {}
        for turn, _, speaker in diarisation.itertracks(yield_label=True):
            start = int(turn.start * rate)
            end = int(turn.end * rate)
            if end <= start:
                continue
            pieces.setdefault(speaker, []).append(waveform[:, start:end])
            seconds[speaker] = seconds.get(speaker, 0.0) + (turn.end - turn.start)
        if not pieces:
            raise NoSubject("no speech found")
        out: list[SpeakerMedia] = []
        for speaker in sorted(pieces, key=lambda s: -seconds[s]):
            buffer = io.BytesIO()
            torchaudio.save(buffer, torch.cat(pieces[speaker], dim=1), rate, format="wav")
            out.append(SpeakerMedia(speaker=speaker, media=buffer.getvalue(), seconds=round(seconds[speaker], 2)))
        return out


_cache: dict[str, Diariser] = {}


def diariser_for() -> Diariser:
    key = os.environ.get("RECOGNITION_EMBEDDER", "")
    if key in _cache:
        return _cache[key]
    if key.lower() == "test":
        diariser: Diariser = DeterministicDiariser()
    else:
        diariser = PyannoteDiariser(os.environ.get("RECOGNITION_DIARIZATION_MODEL", "pyannote/speaker-diarization-3.1"))
    _cache[key] = diariser
    return diariser


def reset_diarisers() -> None:
    _cache.clear()
