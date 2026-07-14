FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY src/worker/pyproject.toml src/worker/requirements.txt ./
COPY src/worker/app/ ./app/
COPY src/worker/shared/ ./shared/
COPY src/worker/gui/ ./gui/
COPY src/worker/models/ ./models/

RUN pip install --no-cache-dir .

ENTRYPOINT ["python", "-m", "app.main"]
