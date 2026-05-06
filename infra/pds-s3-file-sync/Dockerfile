FROM public.ecr.aws/docker/library/alpine:3.23.4

RUN apk --no-cache add bash dumb-init aws-cli

COPY entrypoint.sh healthcheck.sh /

ENTRYPOINT ["dumb-init", "--"]
CMD ["/entrypoint.sh"]
