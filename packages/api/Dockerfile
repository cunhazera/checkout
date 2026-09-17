# syntax=docker/dockerfile:1

# Build stage: compile TypeScript, then install production dependencies only.
FROM node:22-alpine AS build
WORKDIR /app

# Workspace manifests first, so a dependency change is the only thing that
# invalidates the install layer.
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/gateway/package.json packages/gateway/
COPY packages/totem/package.json packages/totem/
RUN npm ci --workspace @checkout/api --include-workspace-root

COPY packages/api packages/api
RUN npm run build --workspace @checkout/api

# Drop dev dependencies (tsx, vitest, the mock gateway) from what ships.
RUN npm prune --omit=dev --workspace @checkout/api --include-workspace-root

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/api/dist packages/api/dist
COPY --from=build /app/packages/api/package.json packages/api/
# The migration runner reads these at runtime, and the seed reads seeds/.
COPY packages/api/src/db/migrations packages/api/dist/db/migrations
COPY seeds seeds

# Never run as root in a container that talks to the network.
USER node

EXPOSE 3210
ENV HOST=0.0.0.0 PORT=3210

# No shell form: PID 1 must receive SIGTERM directly, or close-with-grace never
# runs and in-flight payments are cut off instead of finishing.
CMD ["node", "packages/api/dist/server.js"]
