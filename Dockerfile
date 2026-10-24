# A host that really can run Chromium: a real Linux image where we have root.
#
#   docker build -t scribd .
#   docker run -p 8000:8000 -v "$PWD/data:/data" \
#     -e SCRIBD_WEB_USER=me -e SCRIBD_WEB_PASS=secret scribd
#
# Works unchanged on any Docker host (Hugging Face Spaces, Fly.io, Render,
# Railway, a VPS). Unlike a panel egg, `playwright install --with-deps` here
# installs libnspr4, libnss3, libatk, libgbm … properly and permanently.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    SCRIBD_WEB_HOST=0.0.0.0 \
    SCRIBD_WEB_DATA=/data

WORKDIR /app

COPY requirements.txt ./
RUN pip install -r requirements.txt \
 && python -m playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

COPY . .

# PDFs, job logs and the fetched libraries live here: mount a volume on it.
VOLUME ["/data"]
EXPOSE 8000

# The web UI: search, tick, download. No shell needed afterwards.
CMD ["python", "-m", "scribd.webapp", "--host", "0.0.0.0", "--port", "8000"]
