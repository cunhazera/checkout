# syntax=docker/dockerfile:1
# The mock card processor. Development and demonstration only — it holds no
# card data and settles nothing.
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/gateway/package.json packages/gateway/
COPY packages/totem/package.json packages/totem/
RUN npm ci --workspace @checkout/gateway --include-workspace-root

COPY packages/gateway packages/gateway
USER node
EXPOSE 3220
ENV GATEWAY_HOST=0.0.0.0 GATEWAY_PORT=3220
CMD ["npx", "tsx", "packages/gateway/src/server.ts"]
