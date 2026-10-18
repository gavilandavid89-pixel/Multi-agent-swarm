FROM node:22-bookworm-slim AS node22

FROM codercom/code-server:4.100.3

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-venv \
    make \
    g++ \
    ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Keep code-server's bundled runtime intact; expose Node 22 for projects and tests.
COPY --from=node22 /usr/local/bin/node /usr/local/bin/node
COPY --from=node22 /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && mkdir -p /workspace /tmp/agent-ide \
    && chown -R coder:coder /workspace /tmp/agent-ide

COPY --chown=coder:coder start-agent-ide.sh /usr/local/bin/start-agent-ide
RUN chmod 0755 /usr/local/bin/start-agent-ide

USER coder
WORKDIR /workspace
ENV HOME=/home/coder
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/start-agent-ide"]
