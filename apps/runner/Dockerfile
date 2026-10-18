# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    CI=true \
    CHROME_BIN=/usr/bin/chromium \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1

# Broad local/CI toolchain. Never run generated code in the Worker container.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils findutils procps git make gcc g++ pkg-config \
      python3 python3-dev python3-pip python3-venv python3-pytest \
      default-jdk-headless maven golang-go php-cli composer ruby-full ruby-bundler rustc cargo \
      chromium chromium-sandbox xvfb xauth x11-utils fonts-liberation libnss3 \
      curl unzip libx11-6 libxcursor1 libxinerama1 libxi6 libxrandr2 libasound2 \
      libpulse0 libudev1 libgl1 libfontconfig1 libfreetype6 libxkbcommon0 \
      libwayland-client0 libwayland-cursor0 libwayland-egl1 libdecor-0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 runner \
    && useradd --uid 10001 --gid runner --create-home --shell /bin/bash runner \
    && mkdir -p /workspace /tmp/runner-home /opt/swarm-runner \
    && chown -R runner:runner /workspace /tmp/runner-home /opt/swarm-runner

# Pin the Godot engine and verify the upstream release checksum at image-build time.
RUN set -eux; \
    curl -fsSL --retry 3 --connect-timeout 15 --max-time 180 \
      https://github.com/godotengine/godot/releases/download/4.4.1-stable/Godot_v4.4.1-stable_linux.x86_64.zip \
      -o /tmp/Godot_v4.4.1-stable_linux.x86_64.zip; \
    curl -fsSL --retry 3 --connect-timeout 15 --max-time 180 \
      https://github.com/godotengine/godot/releases/download/4.4.1-stable/SHA512-SUMS.txt \
      -o /tmp/godot-sha512.txt; \
    grep 'Godot_v4.4.1-stable_linux.x86_64.zip$' /tmp/godot-sha512.txt > /tmp/godot-checksum.txt; \
    test -s /tmp/godot-checksum.txt; \
    cd /tmp && sha512sum -c /tmp/godot-checksum.txt; \
    mkdir -p /opt/godot; \
    unzip -q /tmp/Godot_v4.4.1-stable_linux.x86_64.zip -d /opt/godot; \
    install -m 0755 /opt/godot/Godot_v4.4.1-stable_linux.x86_64 /usr/local/bin/godot; \
    if ldd /usr/local/bin/godot | grep -q 'not found'; then ldd /usr/local/bin/godot; exit 1; fi; \
    rm -rf /tmp/Godot_v4.4.1-stable_linux.x86_64.zip /tmp/godot-sha512.txt /tmp/godot-checksum.txt /opt/godot

COPY --chown=runner:runner browser-smoke.mjs /opt/swarm-runner/browser-smoke.mjs
COPY --chown=runner:runner godot-smoke.sh /opt/swarm-runner/godot-smoke.sh

ENV HOME=/tmp/runner-home
WORKDIR /workspace
USER runner

CMD ["bash"]
