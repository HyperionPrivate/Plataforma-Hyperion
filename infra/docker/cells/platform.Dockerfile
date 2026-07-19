# syntax=docker/dockerfile:1

FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS source

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services

RUN find apps packages services -type d -name dist -prune -exec rm -rf '{}' +
RUN pnpm install --frozen-lockfile

FROM source AS access-migrations-build
RUN pnpm --filter "@hyperion/access-migrations..." build \
  && find packages/access-migrations/dist -type f \
       \( -name '*.test.*' -o -name '*.spec.*' -o -name '*.d.ts' -o -name '*.js.map' \) -delete

FROM source AS identity-service-build
RUN pnpm --filter "@hyperion/identity-service..." build \
  && find packages services -path '*/dist/*' -type f \
       \( -name '*.test.*' -o -name '*.spec.*' -o -name '*.d.ts' -o -name '*.js.map' \) -delete

FROM source AS tenant-service-build
RUN pnpm --filter "@hyperion/tenant-service..." build \
  && find packages services -path '*/dist/*' -type f \
       \( -name '*.test.*' -o -name '*.spec.*' -o -name '*.d.ts' -o -name '*.js.map' \) -delete

FROM source AS audit-migrations-build
RUN pnpm --filter "@hyperion/audit-migrations..." build \
  && find packages/audit-migrations/dist -type f \
       \( -name '*.test.*' -o -name '*.spec.*' -o -name '*.d.ts' -o -name '*.js.map' \) -delete

FROM source AS audit-service-build
RUN pnpm --filter "@hyperion/audit-service..." build \
  && find packages services -path '*/dist/*' -type f \
       \( -name '*.test.*' -o -name '*.spec.*' -o -name '*.d.ts' -o -name '*.js.map' \) -delete

FROM source AS platform-admin-bff-build
RUN pnpm --filter "@hyperion/platform-admin-bff..." build \
  && find packages apps -path '*/dist/*' -type f \
       \( -name '*.test.*' -o -name '*.spec.*' -o -name '*.d.ts' -o -name '*.js.map' \) -delete

FROM source AS platform-admin-console-build
RUN pnpm --filter "@hyperion/platform-admin-console..." build \
  && test -f apps/platform-admin-console/dist/platform-admin-bundle-metafile.json \
  && rm -- apps/platform-admin-console/dist/platform-admin-bundle-metafile.json

FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS runtime-base

WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM runtime-base AS access-migrations

COPY packages/access-migrations/package.json packages/access-migrations/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/access-migrations"
COPY --from=access-migrations-build /app/packages/access-migrations/dist packages/access-migrations/dist
COPY packages/access-migrations/sql packages/access-migrations/sql

USER node
CMD ["node", "packages/access-migrations/dist/index.js"]

FROM runtime-base AS identity-service

COPY packages/access-migrations/package.json packages/access-migrations/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/durable-events/package.json packages/durable-events/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/platform-contracts/package.json packages/platform-contracts/package.json
COPY packages/service-runtime/package.json packages/service-runtime/package.json
COPY services/identity-service/package.json services/identity-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/identity-service..."

# Access runtimes receive only the pure readiness and boundary modules. SQL,
# migration runners and bootstrap entrypoints remain in access-migrations.
COPY --from=identity-service-build /app/packages/access-migrations/dist/schema-manifest.js packages/access-migrations/dist/schema-manifest.js
COPY --from=identity-service-build /app/packages/access-migrations/dist/role-manifest.js packages/access-migrations/dist/role-manifest.js
COPY --from=identity-service-build /app/packages/access-migrations/dist/runtime-boundary.js packages/access-migrations/dist/runtime-boundary.js
COPY --from=identity-service-build /app/packages/config/dist packages/config/dist
COPY --from=identity-service-build /app/packages/database/dist packages/database/dist
COPY --from=identity-service-build /app/packages/durable-events/dist packages/durable-events/dist
COPY --from=identity-service-build /app/packages/logger/dist packages/logger/dist
COPY --from=identity-service-build /app/packages/platform-contracts/dist packages/platform-contracts/dist
COPY --from=identity-service-build /app/packages/service-runtime/dist packages/service-runtime/dist
COPY --from=identity-service-build /app/services/identity-service/dist services/identity-service/dist

USER node
CMD ["node", "services/identity-service/dist/index.js"]

FROM runtime-base AS tenant-service

COPY packages/access-migrations/package.json packages/access-migrations/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/platform-contracts/package.json packages/platform-contracts/package.json
COPY packages/service-runtime/package.json packages/service-runtime/package.json
COPY services/tenant-service/package.json services/tenant-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/tenant-service..."

COPY --from=tenant-service-build /app/packages/access-migrations/dist/schema-manifest.js packages/access-migrations/dist/schema-manifest.js
COPY --from=tenant-service-build /app/packages/access-migrations/dist/role-manifest.js packages/access-migrations/dist/role-manifest.js
COPY --from=tenant-service-build /app/packages/access-migrations/dist/runtime-boundary.js packages/access-migrations/dist/runtime-boundary.js
COPY --from=tenant-service-build /app/packages/config/dist packages/config/dist
COPY --from=tenant-service-build /app/packages/database/dist packages/database/dist
COPY --from=tenant-service-build /app/packages/logger/dist packages/logger/dist
COPY --from=tenant-service-build /app/packages/platform-contracts/dist packages/platform-contracts/dist
COPY --from=tenant-service-build /app/packages/service-runtime/dist packages/service-runtime/dist
COPY --from=tenant-service-build /app/services/tenant-service/dist services/tenant-service/dist

USER node
CMD ["node", "services/tenant-service/dist/index.js"]

FROM runtime-base AS audit-migrations

COPY packages/audit-migrations/package.json packages/audit-migrations/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/audit-migrations"
COPY --from=audit-migrations-build /app/packages/audit-migrations/dist packages/audit-migrations/dist
COPY packages/audit-migrations/sql packages/audit-migrations/sql

USER node
CMD ["node", "packages/audit-migrations/dist/index.js"]

FROM runtime-base AS audit-service

COPY packages/audit-contracts/package.json packages/audit-contracts/package.json
COPY packages/audit-migrations/package.json packages/audit-migrations/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/durable-events/package.json packages/durable-events/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/platform-contracts/package.json packages/platform-contracts/package.json
COPY packages/service-runtime/package.json packages/service-runtime/package.json
COPY services/audit-service/package.json services/audit-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/audit-service..."

COPY --from=audit-service-build /app/packages/audit-contracts/dist packages/audit-contracts/dist
# Runtime receives only the pure readiness manifest; migration SQL, runner and
# bootstrap entrypoints remain exclusive to the audit-migrations image.
COPY --from=audit-service-build /app/packages/audit-migrations/dist/schema-manifest.js packages/audit-migrations/dist/schema-manifest.js
COPY --from=audit-service-build /app/packages/config/dist packages/config/dist
COPY --from=audit-service-build /app/packages/database/dist packages/database/dist
COPY --from=audit-service-build /app/packages/durable-events/dist packages/durable-events/dist
COPY --from=audit-service-build /app/packages/logger/dist packages/logger/dist
COPY --from=audit-service-build /app/packages/platform-contracts/dist packages/platform-contracts/dist
COPY --from=audit-service-build /app/packages/service-runtime/dist packages/service-runtime/dist
COPY --from=audit-service-build /app/services/audit-service/dist services/audit-service/dist

USER node
CMD ["node", "services/audit-service/dist/index.js"]

FROM runtime-base AS platform-admin-bff

COPY packages/platform-contracts/package.json packages/platform-contracts/package.json
COPY apps/platform-admin-bff/package.json apps/platform-admin-bff/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/platform-admin-bff..."

COPY --from=platform-admin-bff-build /app/packages/platform-contracts/dist packages/platform-contracts/dist
COPY --from=platform-admin-bff-build /app/apps/platform-admin-bff/dist apps/platform-admin-bff/dist

USER node
CMD ["node", "apps/platform-admin-bff/dist/index.js"]

FROM nginxinc/nginx-unprivileged:1.27-alpine@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0 AS platform-admin-console

ENV BFF_UPSTREAM=http://platform-admin-bff:8098 \
    CONSOLE_CELL=platform \
    CONSOLE_ROUTE_PATTERN='^(?:/|/(?:operators|tenants|grants|catalog)/?)$' \
    NGINX_ENVSUBST_FILTER='^(BFF_UPSTREAM|CONSOLE_CELL|CONSOLE_ROUTE_PATTERN)$'

USER root
RUN find /usr/share/nginx/html -mindepth 1 -maxdepth 1 -exec rm -rf -- '{}' +
USER 101

COPY infra/docker/console.nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=platform-admin-console-build /app/apps/platform-admin-console/dist /usr/share/nginx/html

EXPOSE 8080
