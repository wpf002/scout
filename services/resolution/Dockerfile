FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --extra scoring
COPY resolution ./resolution
ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8100
CMD ["uvicorn", "resolution.main:app", "--host", "0.0.0.0", "--port", "8100"]
