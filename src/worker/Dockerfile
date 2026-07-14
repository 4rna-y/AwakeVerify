FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY src/worker/pyproject.toml src/worker/requirements.txt ./
COPY src/worker/app/ ./app/
COPY src/worker/shared/ ./shared/
COPY src/worker/gui/ ./gui/

RUN pip install --no-cache-dir .

ARG FACE_LANDMARKER_MODEL_URL=https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task
ARG FACE_LANDMARKER_MODEL_SHA256=64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff

RUN mkdir -p /app/models \
    && curl --fail --location --silent --show-error "$FACE_LANDMARKER_MODEL_URL" --output /app/models/face_landmarker.task \
    && echo "$FACE_LANDMARKER_MODEL_SHA256  /app/models/face_landmarker.task" | sha256sum --check --status

ENTRYPOINT ["python", "-m", "app.main"]
