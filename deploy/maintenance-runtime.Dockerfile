# Maintenance remains separate from business containers.
ARG VERIFIED_BASE=matrix-cloud-backend:verified-maintenance-base
FROM ${VERIFIED_BASE}
USER root
RUN apk add --no-cache git python3 py3-requests docker-cli
WORKDIR /opt/matrix-maintenance/runtime
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
RUN ln -s /app/node_modules ./node_modules
COPY backend ./backend
RUN ln -s /app/backend/node_modules ./backend/node_modules
COPY shared ./shared
COPY scripts /opt/matrix-maintenance/trusted
ENV MAINTENANCE_CONFIG=/etc/matrix-maintenance/config.json
CMD ["node", "--import", "tsx", "backend/server/maintenance.ts"]
