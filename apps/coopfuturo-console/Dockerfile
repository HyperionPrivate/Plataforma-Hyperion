# Ops UI PULSO — Next.js standalone
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_API_MODE=live
ARG NEXT_PUBLIC_PILOT_CORE_URL=/pilot-core
ARG NEXT_PUBLIC_REQUIRE_AUTH=true
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_API_MODE=$NEXT_PUBLIC_API_MODE
ENV NEXT_PUBLIC_PILOT_CORE_URL=$NEXT_PUBLIC_PILOT_CORE_URL
ENV NEXT_PUBLIC_REQUIRE_AUTH=$NEXT_PUBLIC_REQUIRE_AUTH
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Runtime BFF → Hyperion api-gateway (override in Compose).
ENV HYPERION_GATEWAY_URL=http://api-gateway:8080
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=25s \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
