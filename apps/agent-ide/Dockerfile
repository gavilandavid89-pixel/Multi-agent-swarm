FROM codercom/code-server:4.100.3

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    nodejs \
    npm \
    python3 \
    python3-venv \
    make \
    g++ \
    ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /workspace /tmp/agent-ide && chown -R coder:coder /workspace /tmp/agent-ide
COPY start-agent-ide.sh /usr/local/bin/start-agent-ide
RUN chmod 0755 /usr/local/bin/start-agent-ide

USER coder
WORKDIR /workspace
ENV HOME=/home/coder
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/start-agent-ide"]
