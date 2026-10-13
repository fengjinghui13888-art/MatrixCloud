# API backend image; no frontend assets are served by Express.
FROM node:22.14.0-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY frontend/package.json ./frontend/package.json
COPY backend/package.json ./backend/package.json
RUN corepack enable && pnpm install --frozen-lockfile --filter xhs-matrix-ops --filter @matrix/backend --config.dangerously-allow-all-builds=true
COPY backend ./backend
COPY shared ./shared
COPY scripts ./scripts
COPY local-connector ./local-connector
COPY workbuddy-connector ./workbuddy-connector
COPY migration ./migration
RUN pnpm --dir backend build

FROM node:22.14.0-alpine
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production PORT=4174 DATA_DIR=/app/work/grey HOST=0.0.0.0
RUN mkdir -p /app/work
EXPOSE 4174
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "require('node:http').get('http://127.0.0.1:4174/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
CMD ["node", "--import", "tsx", "backend/server/grey.ts"]
