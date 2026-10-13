FROM node:24-alpine
RUN apk add --no-cache sqlite git python3
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --config.dangerously-allow-all-builds=true
