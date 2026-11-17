# syntax=docker/dockerfile:1
# Build context: repository root (see docker-compose.yml).

# ---- deps: all workspace dependencies (cached while manifests do not change) ----
FROM node:22-slim AS base
RUN npm install -g pnpm@12.21.0
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN pnpm install --frozen-lockfile --filter @helpdesk/api...

# ---- build: shared package + api ----
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @helpdesk/shared build && pnpm --filter @helpdesk/api build

# ---- prod-deps: production dependencies only ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN pnpm install --frozen-lockfile --prod --filter @helpdesk/api...

# ---- runtime: minimal image, unprivileged user ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    API_PORT=4000 \
    ATTACHMENTS_DIR=/data/attachments
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/drizzle ./apps/api/drizzle
# The attachments volume is created owned by the unprivileged user, so named volumes inherit it.
RUN mkdir -p /data/attachments && chown -R node:node /data
USER node
WORKDIR /app/apps/api
EXPOSE 4000
HEALTHCHECK --interval=5s --timeout=3s --start-period=60s --retries=30 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# exec form, node as PID 1: SIGTERM reaches the app and triggers the graceful shutdown
CMD ["node", "--enable-source-maps", "dist/main.js"]
