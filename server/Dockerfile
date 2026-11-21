# Multi-stage Dockerfile for self-hosting Excalidesk Share & Collaboration server + Web Viewer
FROM node:22-alpine AS web-builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json tsconfig.node.json vite.config.ts ./
COPY scripts ./scripts
COPY bench/gen-scene.mjs ./bench/gen-scene.mjs
COPY public ./public
COPY src ./src
ENV EXCALIDESK_RELEASE=1
RUN npm run build

FROM node:22-alpine AS server-builder
WORKDIR /server
COPY server/package.json ./
RUN npm install
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3456
ENV DATA_DIR=/data
ENV STATIC_DIR=/app/web
ENV SHARE_TTL_DAYS=30
ENV MAX_BODY_MB=25

RUN mkdir -p /data && chown -R node:node /data /app
COPY --from=server-builder --chown=node:node /server/package.json ./package.json
COPY --from=server-builder --chown=node:node /server/node_modules ./node_modules
COPY --from=server-builder --chown=node:node /server/dist/src ./dist
COPY --from=web-builder --chown=node:node /app/dist ./web

USER node
EXPOSE 3456
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1

CMD ["node", "dist/index.js"]
