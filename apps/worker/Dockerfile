FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium chromium-sandbox xvfb xauth \
  && rm -rf /var/lib/apt/lists/*
ENV CHROME_BIN=/usr/bin/chromium
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
RUN npm run check && mkdir -p /app/data/artifacts && chown -R node:node /app/data
ENV NODE_ENV=production
USER node
RUN node scripts/browser-smoke-test.mjs
CMD ["node", "server.js"]
