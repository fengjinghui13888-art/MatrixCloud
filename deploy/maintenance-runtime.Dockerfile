# Keep the maintenance runtime independent from the business container and editable repository.
# Pass a local tag verified against the recorded business image ID.
ARG VERIFIED_BASE=matrix-cloud:verified-maintenance-base
FROM ${VERIFIED_BASE}
USER root
RUN apk add --no-cache git python3 py3-requests docker-cli
WORKDIR /opt/matrix-maintenance/runtime
COPY package.json pnpm-lock.yaml ./
RUN ln -s /app/node_modules ./node_modules
COPY server ./server
COPY scripts /opt/matrix-maintenance/trusted
COPY tsconfig.json ./
ENV MAINTENANCE_CONFIG=/etc/matrix-maintenance/config.json
CMD ["node", "--import", "tsx", "server/maintenance.ts"]
