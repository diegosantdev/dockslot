FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/sdk-typescript/package.json packages/sdk-typescript/package.json
RUN npm ci --no-audit --no-fund
COPY . .

FROM base AS server
USER node
EXPOSE 4000
CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]

FROM base AS web-build
ENV API_INTERNAL_URL=http://api:4000
RUN npm run build -w @dockslot/web

FROM web-build AS web
RUN chown -R node:node /app/apps/web/.next
USER node
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["node", "../../node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"]
