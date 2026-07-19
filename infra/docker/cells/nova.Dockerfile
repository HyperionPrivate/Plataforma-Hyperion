# syntax=docker/dockerfile:1.7

FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS nova-source

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./

# Every build stage installs and builds one deployable plus its workspace
# dependency closure. BuildKit only evaluates ancestors of the selected target,
# so a nova-core image never compiles or publishes Voice, LIWA or Documents.
FROM nova-source AS nova-bff-build
COPY apps/nova-bff apps/nova-bff
COPY packages/audit-contracts packages/audit-contracts
COPY packages/nova-contracts packages/nova-contracts
COPY packages/platform-contracts packages/platform-contracts
RUN pnpm install --frozen-lockfile --filter "@hyperion/nova-bff..." \
  && pnpm --filter "@hyperion/nova-bff..." build

FROM nova-source AS nova-console-build
COPY apps/nova-console apps/nova-console
COPY packages/audit-contracts packages/audit-contracts
COPY packages/nova-contracts packages/nova-contracts
COPY packages/platform-contracts packages/platform-contracts
RUN pnpm install --frozen-lockfile --filter "@hyperion/nova-console..." \
  && pnpm --filter "@hyperion/nova-console..." build \
  && test -f apps/nova-console/dist/nova-bundle-metafile.json \
  && rm -- apps/nova-console/dist/nova-bundle-metafile.json \
  && test -f apps/nova-console/dist/index.html

FROM nova-source AS nova-migrations-build
COPY packages/nova-migrations packages/nova-migrations
RUN pnpm install --frozen-lockfile --filter "@hyperion/nova-migrations..." \
  && pnpm --filter "@hyperion/nova-migrations..." build

FROM nova-source AS nova-service-build-source
COPY packages/audit-contracts packages/audit-contracts
COPY packages/database packages/database
COPY packages/logger packages/logger
COPY packages/nova-config packages/nova-config
COPY packages/nova-contracts packages/nova-contracts
COPY packages/nova-durable-events packages/nova-durable-events
COPY packages/nova-service-runtime packages/nova-service-runtime
COPY packages/platform-contracts packages/platform-contracts

FROM nova-service-build-source AS nova-core-service-build
COPY services/nova-core-service services/nova-core-service
RUN pnpm install --frozen-lockfile --filter "@hyperion/nova-core-service..." \
  && pnpm --filter "@hyperion/nova-core-service..." build

FROM nova-service-build-source AS voice-channel-service-build
COPY services/voice-channel-service services/voice-channel-service
RUN pnpm install --frozen-lockfile --filter "@hyperion/voice-channel-service..." \
  && pnpm --filter "@hyperion/voice-channel-service..." build

FROM nova-service-build-source AS liwa-channel-service-build
COPY services/liwa-channel-service services/liwa-channel-service
RUN pnpm install --frozen-lockfile --filter "@hyperion/liwa-channel-service..." \
  && pnpm --filter "@hyperion/liwa-channel-service..." build

FROM nova-service-build-source AS documents-service-build
COPY services/documents-service services/documents-service
RUN pnpm install --frozen-lockfile --filter "@hyperion/documents-service..." \
  && pnpm --filter "@hyperion/documents-service..." build

FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS nova-bff

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/nova-bff/package.json apps/nova-bff/package.json
COPY packages/platform-contracts/package.json packages/platform-contracts/package.json
COPY packages/audit-contracts/package.json packages/audit-contracts/package.json
COPY packages/nova-contracts/package.json packages/nova-contracts/package.json

RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/nova-bff..."

COPY --from=nova-bff-build /app/apps/nova-bff/dist apps/nova-bff/dist
COPY --from=nova-bff-build /app/packages/platform-contracts/dist packages/platform-contracts/dist
COPY --from=nova-bff-build /app/packages/audit-contracts/dist packages/audit-contracts/dist
COPY --from=nova-bff-build /app/packages/nova-contracts/dist packages/nova-contracts/dist

USER node

EXPOSE 8095

CMD ["node", "apps/nova-bff/dist/index.js"]

FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS nova-service-runtime-source

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/platform-contracts/package.json packages/platform-contracts/package.json
COPY packages/audit-contracts/package.json packages/audit-contracts/package.json
COPY packages/nova-contracts/package.json packages/nova-contracts/package.json
COPY packages/nova-config/package.json packages/nova-config/package.json
COPY packages/nova-service-runtime/package.json packages/nova-service-runtime/package.json
COPY packages/nova-durable-events/package.json packages/nova-durable-events/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/logger/package.json packages/logger/package.json

FROM nova-service-runtime-source AS nova-core-service

COPY services/nova-core-service/package.json services/nova-core-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/nova-core-service..."

COPY --from=nova-core-service-build /app/packages/platform-contracts/dist packages/platform-contracts/dist
COPY --from=nova-core-service-build /app/packages/audit-contracts/dist packages/audit-contracts/dist
COPY --from=nova-core-service-build /app/packages/nova-contracts/dist packages/nova-contracts/dist
COPY --from=nova-core-service-build /app/packages/nova-config/dist packages/nova-config/dist
COPY --from=nova-core-service-build /app/packages/nova-service-runtime/dist packages/nova-service-runtime/dist
COPY --from=nova-core-service-build /app/packages/nova-durable-events/dist packages/nova-durable-events/dist
COPY --from=nova-core-service-build /app/packages/database/dist packages/database/dist
COPY --from=nova-core-service-build /app/packages/logger/dist packages/logger/dist
COPY --from=nova-core-service-build /app/services/nova-core-service/dist services/nova-core-service/dist

USER node

EXPOSE 8091

CMD ["node", "services/nova-core-service/dist/index.js"]

FROM nova-service-runtime-source AS voice-channel-service

COPY services/voice-channel-service/package.json services/voice-channel-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/voice-channel-service..."

COPY --from=voice-channel-service-build /app/packages/platform-contracts/dist packages/platform-contracts/dist
COPY --from=voice-channel-service-build /app/packages/audit-contracts/dist packages/audit-contracts/dist
COPY --from=voice-channel-service-build /app/packages/nova-contracts/dist packages/nova-contracts/dist
COPY --from=voice-channel-service-build /app/packages/nova-config/dist packages/nova-config/dist
COPY --from=voice-channel-service-build /app/packages/nova-service-runtime/dist packages/nova-service-runtime/dist
COPY --from=voice-channel-service-build /app/packages/nova-durable-events/dist packages/nova-durable-events/dist
COPY --from=voice-channel-service-build /app/packages/database/dist packages/database/dist
COPY --from=voice-channel-service-build /app/packages/logger/dist packages/logger/dist
COPY --from=voice-channel-service-build /app/services/voice-channel-service/dist services/voice-channel-service/dist

USER node

EXPOSE 8092

CMD ["node", "services/voice-channel-service/dist/index.js"]

FROM nova-service-runtime-source AS liwa-channel-service

COPY services/liwa-channel-service/package.json services/liwa-channel-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/liwa-channel-service..."

COPY --from=liwa-channel-service-build /app/packages/platform-contracts/dist packages/platform-contracts/dist
COPY --from=liwa-channel-service-build /app/packages/audit-contracts/dist packages/audit-contracts/dist
COPY --from=liwa-channel-service-build /app/packages/nova-contracts/dist packages/nova-contracts/dist
COPY --from=liwa-channel-service-build /app/packages/nova-config/dist packages/nova-config/dist
COPY --from=liwa-channel-service-build /app/packages/nova-service-runtime/dist packages/nova-service-runtime/dist
COPY --from=liwa-channel-service-build /app/packages/nova-durable-events/dist packages/nova-durable-events/dist
COPY --from=liwa-channel-service-build /app/packages/database/dist packages/database/dist
COPY --from=liwa-channel-service-build /app/packages/logger/dist packages/logger/dist
COPY --from=liwa-channel-service-build /app/services/liwa-channel-service/dist services/liwa-channel-service/dist

USER node

EXPOSE 8093

CMD ["node", "services/liwa-channel-service/dist/index.js"]

FROM nova-service-runtime-source AS documents-service

COPY services/documents-service/package.json services/documents-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/documents-service..."

COPY --from=documents-service-build /app/packages/platform-contracts/dist packages/platform-contracts/dist
COPY --from=documents-service-build /app/packages/audit-contracts/dist packages/audit-contracts/dist
COPY --from=documents-service-build /app/packages/nova-contracts/dist packages/nova-contracts/dist
COPY --from=documents-service-build /app/packages/nova-config/dist packages/nova-config/dist
COPY --from=documents-service-build /app/packages/nova-service-runtime/dist packages/nova-service-runtime/dist
COPY --from=documents-service-build /app/packages/nova-durable-events/dist packages/nova-durable-events/dist
COPY --from=documents-service-build /app/packages/database/dist packages/database/dist
COPY --from=documents-service-build /app/packages/logger/dist packages/logger/dist
COPY --from=documents-service-build /app/services/documents-service/dist services/documents-service/dist

RUN mkdir -p /var/lib/hyperion/documents \
  && chown -R node:node /var/lib/hyperion

USER node

EXPOSE 8094

CMD ["node", "services/documents-service/dist/index.js"]

FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS nova-migrations

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/nova-migrations/package.json packages/nova-migrations/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/nova-migrations..."

COPY --from=nova-migrations-build /app/packages/nova-migrations/dist packages/nova-migrations/dist
COPY --from=nova-migrations-build /app/packages/nova-migrations/sql packages/nova-migrations/sql

USER node

CMD ["node", "packages/nova-migrations/dist/index.js"]

FROM nginxinc/nginx-unprivileged:1.27-alpine@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0 AS nova-console

ENV BFF_UPSTREAM=http://nova-bff:8095 \
    CONSOLE_CELL=nova \
    CONSOLE_ROUTE_PATTERN='^/$' \
    NGINX_ENVSUBST_FILTER='^(BFF_UPSTREAM|CONSOLE_CELL|CONSOLE_ROUTE_PATTERN)$'

USER root
RUN find /usr/share/nginx/html -mindepth 1 -maxdepth 1 -exec rm -rf -- '{}' +
USER 101

COPY infra/docker/console.nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=nova-console-build /app/apps/nova-console/dist /usr/share/nginx/html

EXPOSE 8080
