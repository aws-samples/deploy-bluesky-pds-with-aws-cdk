FROM ghcr.io/bluesky-social/pds:0.4.5037

RUN apk add --update bash jq util-linux

ENTRYPOINT ["dumb-init", "--"]
CMD ["bash", "-c", "SMTP_MAIL_PASSWORD_ENCODED=`echo $SMTP_MAIL_PASSWORD | jq -Rr @uri` && exec env PDS_EMAIL_SMTP_URL=smtp://$SMTP_MAIL_USERNAME:$SMTP_MAIL_PASSWORD_ENCODED@$SMTP_HOST:587/ node --enable-source-maps index.ts"]
