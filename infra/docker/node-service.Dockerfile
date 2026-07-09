# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services

ARG VITE_API_BASE_URL=http://localhost:8080
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN pnpm install --frozen-lockfile
RUN pnpm -r build

# Static web console served by unprivileged nginx (no Node, no devDependencies).
FROM nginxinc/nginx-unprivileged:1.27-alpine AS web-console

COPY infra/docker/web-console.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web-console/dist /usr/share/nginx/html

# Default target: runtime image for all Node services, production deps only.
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api-gateway/package.json apps/api-gateway/package.json
COPY apps/web-console/package.json apps/web-console/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/migrations/package.json packages/migrations/package.json
COPY packages/service-runtime/package.json packages/service-runtime/package.json
COPY services/agent-service/package.json services/agent-service/package.json
COPY services/audit-service/package.json services/audit-service/package.json
COPY services/identity-service/package.json services/identity-service/package.json
COPY services/integration-service/package.json services/integration-service/package.json
COPY services/knowledge-service/package.json services/knowledge-service/package.json
COPY services/prompt-flow-service/package.json services/prompt-flow-service/package.json
COPY services/pulso-iris-service/package.json services/pulso-iris-service/package.json
COPY services/tenant-service/package.json services/tenant-service/package.json
COPY services/whatsapp-channel-service/package.json services/whatsapp-channel-service/package.json

RUN pnpm install --prod --frozen-lockfile --ignore-scripts

COPY --from=build /app/packages/config/dist packages/config/dist
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/database/dist packages/database/dist
COPY --from=build /app/packages/logger/dist packages/logger/dist
COPY --from=build /app/packages/migrations/dist packages/migrations/dist
COPY --from=build /app/packages/migrations/sql packages/migrations/sql
COPY --from=build /app/packages/service-runtime/dist packages/service-runtime/dist
COPY --from=build /app/apps/api-gateway/dist apps/api-gateway/dist
COPY --from=build /app/services/agent-service/dist services/agent-service/dist
COPY --from=build /app/services/audit-service/dist services/audit-service/dist
COPY --from=build /app/services/identity-service/dist services/identity-service/dist
COPY --from=build /app/services/integration-service/dist services/integration-service/dist
COPY --from=build /app/services/knowledge-service/dist services/knowledge-service/dist
COPY --from=build /app/services/prompt-flow-service/dist services/prompt-flow-service/dist
COPY --from=build /app/services/pulso-iris-service/dist services/pulso-iris-service/dist
COPY --from=build /app/services/tenant-service/dist services/tenant-service/dist
COPY --from=build /app/services/whatsapp-channel-service/dist services/whatsapp-channel-service/dist

RUN mkdir -p /var/lib/hyperion/whatsapp-sessions \
  && chown -R node:node /var/lib/hyperion

USER node

CMD ["node", "apps/api-gateway/dist/index.js"]
