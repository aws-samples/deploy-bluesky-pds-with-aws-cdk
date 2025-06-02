FROM alpine:3.22.0

RUN apk --no-cache add bash dumb-init aws-cli

COPY entrypoint.sh healthcheck.sh /

ENTRYPOINT ["dumb-init", "--"]
CMD ["/entrypoint.sh"]
