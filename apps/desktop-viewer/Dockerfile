FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    ca-certificates \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY server.js ./
RUN node --check server.js && mkdir -p /tmp/swarm-viewer-chrome && chown -R node:node /app /tmp/swarm-viewer-chrome
USER node
EXPOSE 3300
CMD ["npm", "start"]
