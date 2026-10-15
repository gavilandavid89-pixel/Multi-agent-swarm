FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap xvfb xauth iproute2 python3 ca-certificates fonts-liberation fonts-noto-color-emoji libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 libxrender1 libxshmfence1 libxtst6 && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && mkdir -p /ms-playwright && PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx playwright install chromium
COPY server.js browser-harness.mjs ./
RUN node --check server.js && node --check browser-harness.mjs
EXPOSE 10000
CMD ["node", "server.js"]
