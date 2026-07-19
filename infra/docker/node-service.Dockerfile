# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services

# Never let local compiler output enter a production build. TypeScript does not
# delete artifacts whose source file was removed, so every image build starts
# from source-only workspace directories.
RUN find apps packages services -type d -name dist -prune -exec rm -rf '{}' +

RUN pnpm install --frozen-lockfile
ARG BUILD_FILTER
# Always materialize the shared runtime closure copied by service-runtime-base.
# Use "..." so transitive deps (e.g. config → platform-contracts) build first.
RUN test -n "$BUILD_FILTER" \
  && pnpm --filter "${BUILD_FILTER}..." \
    --filter "@hyperion/service-runtime..." \
    --filter "@hyperion/contracts..." \
    build

# Runtime images need executable JavaScript only. Keep tests, declarations and
# source maps out of every later COPY --from=build boundary.
RUN find apps packages services -path '*/dist/*' -type f \
      \( -name '*.test.*' -o -name '*.spec.*' -o -name '*.d.ts' -o -name '*.js.map' \) \
      -delete \
  && test -z "$(find apps packages services -path '*/dist/*' -type f \
      \( -name '*.test.*' -o -name '*.spec.*' \) -print -quit)"

# Test-only runner for an isolated Compose rehearsal. It is never referenced by
# production services and receives credentials only at container runtime.
FROM build AS autonomy-e2e-runner

COPY scripts/autonomy ./scripts/autonomy

USER node

CMD ["node", "scripts/autonomy/real-flow.e2e.mjs"]

# Minimal common base for isolated Node runtimes. Service source and service
# artifacts are deliberately not present in this layer.
FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime-base

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Shared runtime closure used by the gateway and application services.
FROM runtime-base AS service-runtime-base

COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/service-runtime/package.json packages/service-runtime/package.json

# contracts remains only for api-gateway / legacy migrations; other services may
# not depend on it, so the build stage above forces that package into dist.
COPY --from=build /app/packages/config/dist packages/config/dist
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/database/dist packages/database/dist
COPY --from=build /app/packages/logger/dist packages/logger/dist
COPY --from=build /app/packages/service-runtime/dist packages/service-runtime/dist

# Services that dispatch durable events additionally receive the event package
# and its production NATS dependencies through their filtered install.
FROM service-runtime-base AS durable-service-runtime-base

COPY packages/durable-events/package.json packages/durable-events/package.json
COPY --from=build /app/packages/durable-events/dist packages/durable-events/dist

# One-shot JetStream administration has its own minimal image. It contains no
# application service artifact and exits after provisioning the fixed topology.
FROM durable-service-runtime-base AS jetstream-topology-bootstrap

RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/durable-events"

USER node

CMD ["node", "packages/durable-events/dist/jetstream-bootstrap.js"]

FROM service-runtime-base AS api-gateway

COPY apps/api-gateway/package.json apps/api-gateway/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/api-gateway..."
COPY --from=build /app/apps/api-gateway/dist apps/api-gateway/dist

USER node

CMD ["node", "apps/api-gateway/dist/index.js"]

FROM service-runtime-base AS identity-service

COPY packages/access-migrations/package.json packages/access-migrations/package.json
COPY packages/platform-contracts/package.json packages/platform-contracts/package.json
COPY services/identity-service/package.json services/identity-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/identity-service..."
COPY --from=build /app/packages/access-migrations/dist/schema-manifest.js packages/access-migrations/dist/schema-manifest.js
COPY --from=build /app/packages/access-migrations/dist/runtime-boundary.js packages/access-migrations/dist/runtime-boundary.js
COPY --from=build /app/packages/access-migrations/dist/config.js packages/access-migrations/dist/config.js
COPY --from=build /app/packages/platform-contracts/dist packages/platform-contracts/dist
COPY --from=build /app/services/identity-service/dist services/identity-service/dist

USER node

CMD ["node", "services/identity-service/dist/index.js"]

FROM service-runtime-base AS tenant-service

COPY packages/access-migrations/package.json packages/access-migrations/package.json
COPY packages/platform-contracts/package.json packages/platform-contracts/package.json
COPY services/tenant-service/package.json services/tenant-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/tenant-service..."
COPY --from=build /app/packages/access-migrations/dist/schema-manifest.js packages/access-migrations/dist/schema-manifest.js
COPY --from=build /app/packages/access-migrations/dist/runtime-boundary.js packages/access-migrations/dist/runtime-boundary.js
COPY --from=build /app/packages/access-migrations/dist/config.js packages/access-migrations/dist/config.js
COPY --from=build /app/packages/platform-contracts/dist packages/platform-contracts/dist
COPY --from=build /app/services/tenant-service/dist services/tenant-service/dist

USER node

CMD ["node", "services/tenant-service/dist/index.js"]

FROM durable-service-runtime-base AS agent-service

COPY services/agent-service/package.json services/agent-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/agent-service..."
COPY --from=build /app/services/agent-service/dist services/agent-service/dist

USER node

CMD ["node", "services/agent-service/dist/index.js"]

FROM durable-service-runtime-base AS audit-service

COPY packages/audit-contracts/package.json packages/audit-contracts/package.json
COPY packages/audit-migrations/package.json packages/audit-migrations/package.json
COPY packages/platform-contracts/package.json packages/platform-contracts/package.json
COPY services/audit-service/package.json services/audit-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/audit-service..."
COPY --from=build /app/packages/audit-contracts/dist packages/audit-contracts/dist
COPY --from=build /app/packages/audit-migrations/dist/schema-manifest.js packages/audit-migrations/dist/schema-manifest.js
COPY --from=build /app/packages/platform-contracts/dist packages/platform-contracts/dist
COPY --from=build /app/services/audit-service/dist services/audit-service/dist

USER node

CMD ["node", "services/audit-service/dist/index.js"]

FROM service-runtime-base AS integration-service

COPY services/integration-service/package.json services/integration-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/integration-service..."
COPY --from=build /app/services/integration-service/dist services/integration-service/dist

USER node

CMD ["node", "services/integration-service/dist/index.js"]

FROM service-runtime-base AS knowledge-service

COPY services/knowledge-service/package.json services/knowledge-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/knowledge-service..."
COPY --from=build /app/services/knowledge-service/dist services/knowledge-service/dist

USER node

CMD ["node", "services/knowledge-service/dist/index.js"]

FROM durable-service-runtime-base AS lumen-service

COPY services/lumen-service/package.json services/lumen-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/lumen-service..."
COPY --from=build /app/services/lumen-service/dist services/lumen-service/dist

USER node

CMD ["node", "services/lumen-service/dist/index.js"]

FROM service-runtime-base AS prompt-flow-service

COPY services/prompt-flow-service/package.json services/prompt-flow-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/prompt-flow-service..."
COPY --from=build /app/services/prompt-flow-service/dist services/prompt-flow-service/dist

USER node

CMD ["node", "services/prompt-flow-service/dist/index.js"]

FROM durable-service-runtime-base AS pulso-iris-service

COPY services/pulso-iris-service/package.json services/pulso-iris-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/pulso-iris-service..."
COPY --from=build /app/services/pulso-iris-service/dist services/pulso-iris-service/dist

USER node

CMD ["node", "services/pulso-iris-service/dist/index.js"]

FROM durable-service-runtime-base AS whatsapp-channel-service

COPY services/whatsapp-channel-service/package.json services/whatsapp-channel-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/whatsapp-channel-service..."
COPY --from=build /app/services/whatsapp-channel-service/dist services/whatsapp-channel-service/dist

RUN mkdir -p /var/lib/hyperion/whatsapp-sessions \
  && chown -R node:node /var/lib/hyperion

USER node

CMD ["node", "services/whatsapp-channel-service/dist/index.js"]

FROM durable-service-runtime-base AS nova-core-service

COPY services/nova-core-service/package.json services/nova-core-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/nova-core-service..."
COPY --from=build /app/services/nova-core-service/dist services/nova-core-service/dist

USER node

CMD ["node", "services/nova-core-service/dist/index.js"]

FROM durable-service-runtime-base AS voice-channel-service

COPY services/voice-channel-service/package.json services/voice-channel-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/voice-channel-service..."
COPY --from=build /app/services/voice-channel-service/dist services/voice-channel-service/dist

USER node

CMD ["node", "services/voice-channel-service/dist/index.js"]

FROM durable-service-runtime-base AS liwa-channel-service

COPY services/liwa-channel-service/package.json services/liwa-channel-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/liwa-channel-service..."
COPY --from=build /app/services/liwa-channel-service/dist services/liwa-channel-service/dist

USER node

CMD ["node", "services/liwa-channel-service/dist/index.js"]

FROM durable-service-runtime-base AS documents-service

COPY services/documents-service/package.json services/documents-service/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/documents-service..."
COPY --from=build /app/services/documents-service/dist services/documents-service/dist

RUN mkdir -p /var/lib/hyperion/documents \
  && chown -R node:node /var/lib/hyperion

USER node

CMD ["node", "services/documents-service/dist/index.js"]

# Migrations have a smaller dependency closure and do not inherit application
# service artifacts.
FROM runtime-base AS migrations

COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/migrations/package.json packages/migrations/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/migrations..."
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/config/dist packages/config/dist
COPY --from=build /app/packages/logger/dist packages/logger/dist
COPY --from=build /app/packages/migrations/dist packages/migrations/dist
COPY --from=build /app/packages/migrations/sql packages/migrations/sql

USER node

CMD ["node", "packages/migrations/dist/index.js"]

# Platform-owned Access schema and ledger. This image contains no product SQL.
FROM runtime-base AS platform-migrations

COPY packages/platform-migrations/package.json packages/platform-migrations/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/platform-migrations"
COPY --from=build /app/packages/platform-migrations/dist packages/platform-migrations/dist
COPY --from=build /app/packages/platform-migrations/sql packages/platform-migrations/sql

USER node

CMD ["node", "packages/platform-migrations/dist/index.js"]

# Neutral Access database bootstrap, migrations and role activation. Runtime
# images receive only the schema manifest and boundary probe above; SQL and
# database-admin entrypoints remain confined to this one-shot image.
FROM runtime-base AS access-migrations

COPY packages/access-migrations/package.json packages/access-migrations/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/access-migrations"
COPY --from=build /app/packages/access-migrations/dist packages/access-migrations/dist
COPY --from=build /app/packages/access-migrations/sql packages/access-migrations/sql

USER node

CMD ["node", "packages/access-migrations/dist/index.js"]

# Audit owns a logical database and a provider-only migration image. The
# service image receives only schema-manifest.js; SQL and bootstrap code stay
# confined to this one-shot target.
FROM runtime-base AS audit-migrations

COPY packages/audit-migrations/package.json packages/audit-migrations/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@hyperion/audit-migrations"
COPY --from=build /app/packages/audit-migrations/dist packages/audit-migrations/dist
COPY --from=build /app/packages/audit-migrations/sql packages/audit-migrations/sql

USER node

CMD ["node", "packages/audit-migrations/dist/index.js"]

# Backward-compatible default target. It is intentionally no longer an
# all-services image; Compose selects an explicit target for every workload.
FROM api-gateway AS runtime
