FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends squid ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/squid/squid.conf
COPY squid.conf /etc/squid/squid.conf
COPY allowed-domains.txt /etc/squid/allowed-domains.txt
EXPOSE 3128
USER proxy
CMD ["-N", "-f", "/etc/squid/squid.conf"]
