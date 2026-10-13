FROM node:22.14.0-alpine
RUN apk add --no-cache git python3
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY frontend/package.json ./frontend/package.json
COPY backend/package.json ./backend/package.json
RUN corepack enable && pnpm install --frozen-lockfile --config.dangerously-allow-all-builds=true
