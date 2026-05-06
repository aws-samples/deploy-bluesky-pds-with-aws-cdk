FROM litestream/litestream AS litestream

FROM public.ecr.aws/docker/library/alpine:3.23.4

RUN apk add --no-cache bash dumb-init

COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY entrypoint.sh healthcheck.sh /
COPY litestream.yml /etc/

ENTRYPOINT ["dumb-init", "--"]
CMD ["/entrypoint.sh"]
