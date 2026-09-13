# Scout recognition service

Gallery-restricted face and voice comparison. **Off by default**
(`RECOGNITION_ENABLED=false`), and the only comparison route requires a gallery
id in its schema. There is no open-world search and no route that takes a probe
without a gallery. See `docs/LEGAL_POSTURE.md`.

```bash
cd services/recognition
uv sync
uv run uvicorn recognition.main:app --port 8200
uv run pytest
```

Models (InsightFace/ArcFace, SpeechBrain ECAPA-TDNN) are an optional
dependency group and arrive in Phase 10 behind the same flag.
