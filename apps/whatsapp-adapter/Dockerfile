# syntax=docker/dockerfile:1.7
FROM python:3.12.10-slim-bookworm AS builder
WORKDIR /build
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*
COPY packages/platform-kit /build/packages/platform-kit
COPY apps/whatsapp-adapter/requirements.txt /build/requirements.txt
COPY apps/whatsapp-adapter/pyproject.toml /build/pyproject.toml
COPY apps/whatsapp-adapter/src /build/src
RUN pip install --no-cache-dir --prefix=/install /build/packages/platform-kit \
 && pip install --no-cache-dir --prefix=/install -r /build/requirements.txt \
 && pip install --no-cache-dir --prefix=/install --no-deps /build \
 && PYTHONPATH=/install/lib/python3.12/site-packages python -c "import platform_kit; print(platform_kit.__file__)"

FROM python:3.12.10-slim-bookworm AS runtime
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends curl \
 && useradd --create-home --uid 10001 appuser \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/src
COPY --from=builder /install /usr/local
COPY --from=builder /build/src ./src
COPY apps/whatsapp-adapter/alembic.ini ./alembic.ini
COPY apps/whatsapp-adapter/alembic ./alembic
USER 10001
EXPOSE 8202
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8202/health/live || exit 1
CMD ["uvicorn", "whatsapp_adapter.main:app", "--host", "0.0.0.0", "--port", "8202"]
