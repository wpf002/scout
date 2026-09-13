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
from typing import Protocol


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
        from PIL import Image

        image = Image.open(io.BytesIO(media)).convert("RGB")
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
        import torchaudio

        waveform, rate = torchaudio.load(io.BytesIO(media))
        if waveform.numel() == 0:
            raise NoSubject("empty audio")
        if rate != 16_000:
            waveform = torchaudio.functional.resample(waveform, rate, 16_000)
        if waveform.shape[0] > 1:
            waveform = waveform.mean(dim=0, keepdim=True)
        with torch.no_grad():
            embedding = self._encoder.encode_batch(waveform).squeeze()
        return _unit([float(x) for x in embedding.tolist()])


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
