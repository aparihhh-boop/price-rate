FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    MEOWMI_DATA_FILE=/data/meowmi.json \
    MEOWMI_UPLOAD_DIR=/data/uploads

WORKDIR /app
COPY --chown=node:node public ./public
COPY --chown=node:node dashboard.js ./dashboard.js
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
CMD ["node", "public/server.js"]
