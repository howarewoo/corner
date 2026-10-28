FROM node:24-bookworm-slim AS workspace
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/design/package.json ./apps/design/package.json
COPY packages/nutrition/package.json ./packages/nutrition/package.json
COPY packages/training/package.json ./packages/training/package.json
COPY packages/workspace/package.json ./packages/workspace/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/ui/package.json ./packages/ui/package.json

FROM workspace AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

# Install into a manifest-only tree so the runtime keeps all workspace links
# and any nested production dependencies without copying source or build tools.
FROM workspace AS production-dependencies
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    CORNER_DEPLOYMENT=local \
    CORNER_ORIGIN=http://127.0.0.1:3000 \
    CORNER_HOST=0.0.0.0 \
    CORNER_PORT=3000 \
    CORNER_DATA_DIR=/app/data
COPY --from=production-dependencies --chown=node:node /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/apps ./apps
COPY --from=production-dependencies --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/server/migrations ./apps/server/migrations
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/packages/nutrition/dist ./packages/nutrition/dist
COPY --from=build --chown=node:node /app/packages/training/dist ./packages/training/dist
COPY --from=build --chown=node:node /app/packages/workspace/dist ./packages/workspace/dist
COPY --from=build --chown=node:node /app/packages/api/dist ./packages/api/dist
COPY --from=build --chown=node:node /app/scripts/healthcheck.mjs ./scripts/healthcheck.mjs
RUN mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node scripts/healthcheck.mjs
CMD ["node", "--env-file-if-exists=.env", "apps/server/dist/index.js"]

