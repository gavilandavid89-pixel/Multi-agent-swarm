FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-venv \
    make \
    g++ \
    ca-certificates \
    && npm install --global code-server@4.100.3 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
RUN mkdir -p /workspace /tmp/agent-ide && chown -R node:node /workspace /tmp/agent-ide
COPY --chown=node:node start-agent-ide.sh /usr/local/bin/start-agent-ide
RUN chmod 0755 /usr/local/bin/start-agent-ide

USER node
ENV HOME=/home/node
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/start-agent-ide"]
