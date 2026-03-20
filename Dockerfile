FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    python3-pip \
  && rm -rf /var/lib/apt/lists/*

COPY api ./api
COPY load-env.js ./load-env.js

RUN python3 -m venv /app/.venv-argos \
  && /app/.venv-argos/bin/pip install --no-cache-dir -r /app/api/local/requirements.txt

ENV NODE_ENV=production \
  TRANSLATION_API_HOST=0.0.0.0 \
  TRANSLATION_API_PORT=8787 \
  LOCAL_TRANSLATE_VENV=/app/.venv-argos \
  LOCAL_TRANSLATE_PYTHON=/app/.venv-argos/bin/python \
  LOCAL_TRANSLATE_MODEL_DIR=/app/models/argos \
  LOCAL_MARIAN_MODEL_DIR=/app/models/marian

RUN mkdir -p /app/models/argos /app/models/marian

EXPOSE 8787

CMD ["node", "api/server.js"]
