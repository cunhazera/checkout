# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/gateway/package.json packages/gateway/
COPY packages/totem/package.json packages/totem/
RUN npm ci --workspace @checkout/totem --include-workspace-root

COPY packages/totem packages/totem
# No VITE_STORE_ID here on purpose: identity is read at runtime from
# /totem.json, which provisioning writes per device. Baking it in would give
# every totem cloned from this image the same id.
RUN npm run build --workspace @checkout/totem

FROM nginx:alpine AS runtime
COPY --from=build /app/packages/totem/dist /usr/share/nginx/html
COPY packages/totem/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
