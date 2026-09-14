"""Embedders: media in, a unit vector out.

The real ones (ArcFace via InsightFace for faces, ECAPA-TDNN via SpeechBrain
for voices) are imported lazily and only exist when the `models` extra is
installed: `uv sync --extra models`. Without it, a request that needs a
model is answered 503 with that instruction, never with a made-up vector.

The deterministic embedder hashes the media bytes and is selectable only
by RECOGNITION_EMBEDDER=test. It exists so the gates, the arithmetic
and the API integration can be exercised without a model; it is not a
recogniser and says so in its model name.
"""

from __future__ import annotations

import hashlib
import io
import math
import os
import random
from typing import Any, Protocol


class NoSubject(Exception):
    """The media held nothing to embed (no face found, no speech)."""


class ModelUnavailable(Exception):
    def __init__(self, modality: str, detail: str) -> None:
        super().__init__(f"{modality} model unavailable: {detail}")
        self.modality = modality
        self.detail = detail


class Embedder(Protocol):
    model: str
    dims: int

    def embed(self, media: bytes, content_type: str) -> list[float]: ...


def _unit(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v] if n > 0 else v


class DeterministicEmbedder:
    """Deterministic: identical bytes give identical vectors; different bytes
    give vectors that are, with 64 dimensions, near-orthogonal."""

    model = "test-embedder (not a recogniser)"
    dims = 64

    def __init__(self, modality: str) -> None:
        self.modality = modality

    def embed(self, media: bytes, content_type: str) -> list[float]:
        if len(media) == 0:
            raise NoSubject("empty media")
        seed = int.from_bytes(hashlib.sha256(self.modality.encode() + media).digest()[:8], "big")
        rng = random.Random(seed)
        return _unit([rng.gauss(0.0, 1.0) for _ in range(self.dims)])


class InsightFaceEmbedder:
    """ArcFace embeddings through InsightFace's FaceAnalysis. The largest
    detected face is embedded; an image with no face is NoSubject."""

    dims = 512

    def __init__(self, model_name: str) -> None:
        try:
            import numpy as np  # noqa: F401
            from insightface.app import FaceAnalysis
            from PIL import Image  # noqa: F401
        except ImportError as error:  # pragma: no cover - depends on the extra
            raise ModelUnavailable("FACE", f"{error}. Install with `uv sync --extra models`.") from error
        self.model = f"insightface/{model_name}"
        self._app = FaceAnalysis(name=model_name, providers=["CPUExecutionProvider"])
        self._app.prepare(ctx_id=-1, det_size=(640, 640))

    def embed(self, media: bytes, content_type: str) -> list[float]:  # pragma: no cover - depends on the extra
        import numpy as np
        from PIL import Image, UnidentifiedImageError

        try:
            image = Image.open(io.BytesIO(media)).convert("RGB")
        except (UnidentifiedImageError, OSError, ValueError) as error:
            raise NoSubject(f"not a readable image ({error})") from error
        array = np.asarray(image)[:, :, ::-1]  # RGB → BGR, which InsightFace expects
        faces = self._app.get(array)
        if not faces:
            raise NoSubject("no face detected")
        largest = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
        return _unit([float(x) for x in largest.normed_embedding])


class SpeechBrainEmbedder:
    """ECAPA-TDNN speaker embeddings through SpeechBrain. Single-speaker
    probes; diarisation of multi-speaker audio is not built."""

    dims = 192

    def __init__(self, source: str) -> None:
        try:
            import torch  # noqa: F401
            import torchaudio  # noqa: F401
            from speechbrain.inference.speaker import EncoderClassifier
        except ImportError as error:  # pragma: no cover - depends on the extra
            raise ModelUnavailable("VOICE", f"{error}. Install with `uv sync --extra models`.") from error
        self.model = f"speechbrain/{source.split('/')[-1]}"
        self._encoder = EncoderClassifier.from_hparams(source=source)

    def embed(self, media: bytes, content_type: str) -> list[float]:  # pragma: no cover - depends on the extra
        import torch

        waveform, rate = self._decode(media)
        if waveform.numel() == 0:
            raise NoSubject("empty audio")
        if rate != 16_000:
            import torchaudio

            waveform = torchaudio.functional.resample(waveform, rate, 16_000)
        if waveform.shape[0] > 1:
            waveform = waveform.mean(dim=0, keepdim=True)
        with torch.no_grad():
            embedding = self._encoder.encode_batch(waveform).squeeze()
        return _unit([float(x) for x in embedding.tolist()])

    @staticmethod
    def _decode(media: bytes) -> "tuple[Any, int]":  # pragma: no cover - depends on the extra
        """A WAV probe is decoded with the standard library, so the common
        case needs no FFmpeg. Modern torchaudio routes `load` through
        torchcodec/FFmpeg, which is not always present; anything that is not
        a PCM WAV falls back to that path and, when it is missing, becomes a
        clear NoSubject naming the fix."""
        import wave

        import torch

        try:
            with wave.open(io.BytesIO(media), "rb") as w:
                channels, width, rate, frames = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
                raw = w.readframes(frames)
        except (wave.Error, EOFError):
            try:
                import torchaudio

                tensor, rate = torchaudio.load(io.BytesIO(media))
                return tensor, rate
            except Exception as error:  # noqa: BLE001
                raise NoSubject(f"could not decode audio ({error}); send 16-bit PCM WAV, or install FFmpeg for other formats") from error
        import numpy as np

        dtype = {1: np.uint8, 2: np.int16, 4: np.int32}.get(width)
        if dtype is None:
            raise NoSubject(f"unsupported WAV sample width {width * 8}-bit; send 16-bit PCM WAV")
        samples = np.frombuffer(raw, dtype=dtype).astype(np.float32)
        if width == 1:
            samples = (samples - 128.0) / 128.0
        else:
            samples = samples / float(1 << (width * 8 - 1))
        if channels > 1:
            samples = samples.reshape(-1, channels).T
        else:
            samples = samples.reshape(1, -1)
        return torch.from_numpy(samples), rate


_cache: dict[str, Embedder] = {}


def embedder_for(modality: str) -> Embedder:
    key = f"{os.environ.get('RECOGNITION_EMBEDDER', '')}:{modality}"
    if key in _cache:
        return _cache[key]
    if os.environ.get("RECOGNITION_EMBEDDER", "").lower() == "test":
        embedder: Embedder = DeterministicEmbedder(modality)
    elif modality == "FACE":
        embedder = InsightFaceEmbedder(os.environ.get("RECOGNITION_FACE_MODEL", "buffalo_l"))
    else:
        embedder = SpeechBrainEmbedder(os.environ.get("RECOGNITION_VOICE_MODEL", "speechbrain/spkrec-ecapa-voxceleb"))
    _cache[key] = embedder
    return embedder


def reset_embedders() -> None:
    _cache.clear()
