FROM python:3.14-slim-trixie AS base

FROM base AS builder

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

ENV UV_LINK_MODE=copy

WORKDIR /app/server

COPY server/pyproject.toml ./
ARG UV_INDEX_URL
ENV UV_INDEX_URL=${UV_INDEX_URL}
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --no-dev --no-install-project

COPY server/LICENSES ./LICENSES
COPY server/babeldoc ./babeldoc
COPY server/pdf2zh_next ./pdf2zh_next
COPY server/rapidocr_onnxruntime ./rapidocr_onnxruntime
COPY server/README.md server/THIRD_PARTY_NOTICES.md server/server.py server/task_manager.py server/pdf2zh_next_service.py ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --no-dev

FROM base AS runtime

ENV PATH="/app/server/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app/server

# Preserve the editable install path and translates mount.
COPY --from=builder /app/server /app/server

EXPOSE 8890

CMD ["zotero-pdf2zh-next", "--host", "0.0.0.0", "--port", "8890"]
