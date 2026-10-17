FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3200 RUNNER_WORKDIR=/tmp/swarm-runs
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium xvfb xauth ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /tmp/swarm-runs /tmp/runner-home \
  && chown -R node:node /tmp/swarm-runs /tmp/runner-home
COPY --chown=node:node package.json ./
COPY --chown=node:node server.js ./
COPY --chown=node:node tests ./tests
RUN node --check server.js && node --test tests/*.test.js
ENV CHROME_BIN=/usr/bin/chromium HOME=/tmp/runner-home
USER node
EXPOSE 3200
CMD ["node", "server.js"]
