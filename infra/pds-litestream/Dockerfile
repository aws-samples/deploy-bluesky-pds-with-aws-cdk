FROM public.ecr.aws/docker/library/alpine:3.23.4

RUN apk add --no-cache bash dumb-init && \
    wget -q https://github.com/benbjohnson/litestream/releases/download/v0.5.11/litestream-0.5.11-linux-x86_64.tar.gz -O /tmp/litestream.tar.gz && \
    tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin/ litestream && \
    rm /tmp/litestream.tar.gz
COPY entrypoint.sh healthcheck.sh /
COPY litestream.yml /etc/

ENTRYPOINT ["dumb-init", "--"]
CMD ["/entrypoint.sh"]
