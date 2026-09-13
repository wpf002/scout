# Scout resolution service

Python, FastAPI. Owns normalization, blocking, pairwise scoring and clustering
for v2 entity resolution. The API calls it; it never reads the database on its
own and every request carries the scope context the API resolved.

```bash
cd services/resolution
uv sync --extra scoring
uv run uvicorn resolution.main:app --port 8100
uv run pytest
```

Phase 2 ships `/healthz` and `/version`. The pipeline lands in Phase 6. See
`docs/ENTITY_RESOLUTION.md` for the model.
