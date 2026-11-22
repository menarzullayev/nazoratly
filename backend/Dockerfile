# syntax=docker/dockerfile:1.7
# Build context = repository root:  docker build -f backend/Dockerfile -t nazoratly-api .
FROM python:3.13-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.11.3 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/src ./src
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.13-slim
RUN useradd --system --uid 10001 --no-create-home app
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY db/migrations /app/db/migrations
ENV PATH=/app/.venv/bin:$PATH PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 NAZORATLY_MIGRATIONS_DIR=/app/db/migrations
USER app
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).status == 200 else 1)"
CMD ["uvicorn", "nazoratly.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-server-header", "--no-access-log"]
