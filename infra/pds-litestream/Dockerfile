FROM litestream/litestream

RUN apt-get update && apt-get install -y --no-install-recommends dumb-init && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh healthcheck.sh /
COPY litestream.yml /etc/

ENTRYPOINT ["dumb-init", "--"]
CMD ["/entrypoint.sh"]
