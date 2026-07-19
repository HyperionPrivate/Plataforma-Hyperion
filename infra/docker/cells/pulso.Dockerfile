# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS pulso-source

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services

# Generated contexts can be materialized over a dirty developer tree. Never
# accept stale compiler output as part of an image build.
RUN find apps packages services -type d -name dist -prune -exec rm -rf '{}' +

FROM pulso-source AS pulso-build

ARG BUILD_FILTER
ARG DEPLOYABLE_PATH

# Compose supplies one immutable package/path pair per component. pnpm resolves
# only that package's dependency closure; no recursive workspace build exists.
RUN test -n "${BUILD_FILTER}" \
  && test -n "${DEPLOYABLE_PATH}" \
  && pnpm install --frozen-lockfile --filter "${BUILD_FILTER}..." \
  && pnpm --filter "${BUILD_FILTER}..." build \
  && test -f "${DEPLOYABLE_PATH}/dist/index.js"

# Materialize a source-free runtime closure. Sibling PULSO manifests are safe
# workspace metadata; only the selected build closure has executable dist files.
RUN mkdir -p /runtime \
  && cp package.json pnpm-lock.yaml pnpm-workspace.yaml /runtime/ \
  && find apps packages services -path '*/node_modules' -prune -o -name package.json \
       -exec cp --parents '{}' /runtime/ \; \
  && find apps packages services -path '*/node_modules' -prune -o -path '*/dist/*' -type f \
       -exec cp --parents '{}' /runtime/ \; \
  && test -f "/runtime/${DEPLOYABLE_PATH}/dist/index.js"

FROM pulso-source AS pulso-migrations-build

RUN pnpm install --frozen-lockfile --filter "@hyperion/pulso-migrations..." \
  && pnpm --filter "@hyperion/pulso-migrations..." build \
  && test -f packages/pulso-migrations/dist/index.js

RUN mkdir -p /runtime \
  && cp package.json pnpm-lock.yaml pnpm-workspace.yaml /runtime/ \
  && find packages -path '*/node_modules' -prune -o -name package.json \
       -exec cp --parents '{}' /runtime/ \; \
  && find packages -path '*/node_modules' -prune -o -path '*/dist/*' -type f \
       -exec cp --parents '{}' /runtime/ \; \
  && cp -R --parents packages/pulso-migrations/sql /runtime/

FROM pulso-source AS pulso-console-build

RUN pnpm install --frozen-lockfile --filter "@hyperion/pulso-console..." \
  && pnpm --filter "@hyperion/pulso-console..." build \
  && test -f apps/pulso-console/dist/pulso-bundle-metafile.json \
  && rm -- apps/pulso-console/dist/pulso-bundle-metafile.json \
  && test -f apps/pulso-console/dist/index.html

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime-base

WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable

FROM runtime-base AS pulso-runtime

ARG BUILD_FILTER
ARG DEPLOYABLE_PATH

COPY --from=pulso-build /runtime/ ./
RUN test -n "${BUILD_FILTER}" \
  && test -n "${DEPLOYABLE_PATH}" \
  && pnpm install --prod --frozen-lockfile --ignore-scripts --filter "${BUILD_FILTER}..." \
  && test -f "${DEPLOYABLE_PATH}/dist/index.js"

RUN mkdir -p /var/lib/hyperion/whatsapp-sessions \
  && chown -R node:node /var/lib/hyperion

USER node

FROM runtime-base AS pulso-migrations

COPY --from=pulso-migrations-build /runtime/ ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/pulso-migrations..."

USER node
CMD ["node", "packages/pulso-migrations/dist/index.js"]

FROM nginxinc/nginx-unprivileged:1.27-alpine@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0 AS pulso-console

ENV BFF_UPSTREAM=http://pulso-bff:8097 \
    CONSOLE_CELL=pulso \
    CONSOLE_ROUTE_PATTERN='^(?:/|/(?:operacion|conversaciones|agenda|rpa|campanas|bi|configuracion)/?)$' \
    NGINX_ENVSUBST_FILTER='^(BFF_UPSTREAM|CONSOLE_CELL|CONSOLE_ROUTE_PATTERN)$'

USER root
RUN find /usr/share/nginx/html -mindepth 1 -maxdepth 1 -exec rm -rf -- '{}' +
USER 101

COPY infra/docker/console.nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=pulso-console-build /app/apps/pulso-console/dist /usr/share/nginx/html

EXPOSE 8080
