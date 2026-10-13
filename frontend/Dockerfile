# Build with the workspace root as Docker context.
FROM node:22.14.0-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY frontend/package.json ./frontend/package.json
COPY backend/package.json ./backend/package.json
RUN corepack enable && pnpm install --frozen-lockfile --filter @matrix/frontend --config.dangerously-allow-all-builds=true
COPY frontend ./frontend
COPY shared ./shared
RUN pnpm --dir frontend build

FROM nginx:1.28-alpine
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
