# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    CI=true \
    CHROME_BIN=/usr/bin/chromium \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1

# A broad, reproducible toolchain for isolated project checks.
# This image is for local/CI sandboxing, not the privileged orchestration worker.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils findutils git make gcc g++ pkg-config \
      python3 python3-dev python3-pip python3-venv python3-pytest \
      default-jdk-headless golang-go php-cli ruby-full rustc cargo \
      chromium chromium-sandbox xvfb xauth x11-utils fonts-liberation libnss3 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 runner \
    && useradd --uid 10001 --gid runner --create-home --shell /bin/bash runner \
    && mkdir -p /workspace /tmp/runner-home \
    && chown -R runner:runner /workspace /tmp/runner-home

ENV HOME=/tmp/runner-home
WORKDIR /workspace
USER runner

# The caller supplies the command. No project code is copied into this image.
CMD ["bash"]
