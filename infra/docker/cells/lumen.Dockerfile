# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS source

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services

RUN find apps packages services -type d -name dist -prune -exec rm -rf '{}' +
RUN pnpm install --frozen-lockfile

FROM source AS lumen-migrations-build
RUN pnpm --filter "@hyperion/lumen-migrations..." build \
  && find packages/lumen-migrations/dist -type f \
       \( -name '*.test.*' -o -name '*.spec.*' -o -name '*.d.ts' -o -name '*.js.map' \) -delete

FROM source AS lumen-service-build
RUN pnpm --filter "@hyperion/lumen-service..." build \
  && find packages services -path '*/dist/*' -type f \
       \( -name '*.test.*' -o -name '*.spec.*' -o -name '*.d.ts' -o -name '*.js.map' \) -delete

FROM source AS lumen-bff-build
RUN pnpm --filter "@hyperion/lumen-bff..." build \
  && find packages apps -path '*/dist/*' -type f \
       \( -name '*.test.*' -o -name '*.spec.*' -o -name '*.d.ts' -o -name '*.js.map' \) -delete

FROM source AS lumen-console-build
RUN pnpm --filter "@hyperion/lumen-console..." build \
  && test -f apps/lumen-console/dist/lumen-bundle-metafile.json \
  && rm -- apps/lumen-console/dist/lumen-bundle-metafile.json

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime-base

WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM runtime-base AS lumen-migrations

COPY packages/lumen-migrations/package.json packages/lumen-migrations/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/lumen-migrations"
COPY --from=lumen-migrations-build /app/packages/lumen-migrations/dist packages/lumen-migrations/dist
COPY packages/lumen-migrations/sql packages/lumen-migrations/sql

USER node
CMD ["node", "packages/lumen-migrations/dist/index.js"]

FROM runtime-base AS lumen-service

COPY packages/audit-contracts/package.json packages/audit-contracts/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/durable-events/package.json packages/durable-events/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/lumen-contracts/package.json packages/lumen-contracts/package.json
COPY packages/lumen-migrations/package.json packages/lumen-migrations/package.json
COPY packages/platform-contracts/package.json packages/platform-contracts/package.json
COPY packages/service-runtime/package.json packages/service-runtime/package.json
COPY services/lumen-service/package.json services/lumen-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/lumen-service..."

COPY --from=lumen-service-build /app/packages/audit-contracts/dist packages/audit-contracts/dist
COPY --from=lumen-service-build /app/packages/config/dist packages/config/dist
COPY --from=lumen-service-build /app/packages/database/dist packages/database/dist
COPY --from=lumen-service-build /app/packages/durable-events/dist packages/durable-events/dist
COPY --from=lumen-service-build /app/packages/logger/dist packages/logger/dist
COPY --from=lumen-service-build /app/packages/lumen-contracts/dist packages/lumen-contracts/dist
# Runtime receives only the pure, read-only catalog verifier. Migration SQL,
# runner and bootstrap entrypoints remain exclusive to the migrator target.
COPY --from=lumen-service-build /app/packages/lumen-migrations/dist/schema-manifest.js packages/lumen-migrations/dist/schema-manifest.js
COPY --from=lumen-service-build /app/packages/platform-contracts/dist packages/platform-contracts/dist
COPY --from=lumen-service-build /app/packages/service-runtime/dist packages/service-runtime/dist
COPY --from=lumen-service-build /app/services/lumen-service/dist services/lumen-service/dist

RUN mkdir -p /var/lib/hyperion/lumen-audio \
  && chown -R node:node /var/lib/hyperion
USER node
CMD ["node", "services/lumen-service/dist/index.js"]

FROM runtime-base AS lumen-bff

COPY packages/lumen-contracts/package.json packages/lumen-contracts/package.json
COPY packages/platform-contracts/package.json packages/platform-contracts/package.json
COPY apps/lumen-bff/package.json apps/lumen-bff/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/lumen-bff..."

COPY --from=lumen-bff-build /app/packages/lumen-contracts/dist packages/lumen-contracts/dist
COPY --from=lumen-bff-build /app/packages/platform-contracts/dist packages/platform-contracts/dist
COPY --from=lumen-bff-build /app/apps/lumen-bff/dist apps/lumen-bff/dist

USER node
CMD ["node", "apps/lumen-bff/dist/index.js"]

FROM nginxinc/nginx-unprivileged:1.27-alpine@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0 AS lumen-console

ENV BFF_UPSTREAM=http://lumen-bff:8096 \
    CONSOLE_CELL=lumen \
    CONSOLE_ROUTE_PATTERN='^(?:/|/lumen(?:/[^/]+)?/?)$' \
    NGINX_ENVSUBST_FILTER='^(BFF_UPSTREAM|CONSOLE_CELL|CONSOLE_ROUTE_PATTERN)$'

USER root
RUN find /usr/share/nginx/html -mindepth 1 -maxdepth 1 -exec rm -rf -- '{}' +
USER 101

COPY infra/docker/console.nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=lumen-console-build /app/apps/lumen-console/dist /usr/share/nginx/html

EXPOSE 8080
