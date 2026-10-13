FROM node:22.14.0-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --config.dangerously-allow-all-builds=true
COPY . .
RUN pnpm build

FROM node:22.14.0-alpine
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --config.dangerously-allow-all-builds=true
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/shared ./shared
COPY --from=build /app/local-connector ./local-connector
COPY --from=build /app/tsconfig.json ./tsconfig.json
ENV NODE_ENV=production PORT=4174 DATA_DIR=/app/work/grey HOST=0.0.0.0
RUN mkdir -p /app/work
EXPOSE 4174
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "require('node:http').get('http://127.0.0.1:4174/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
CMD ["node", "--import", "tsx", "server/grey.ts"]
