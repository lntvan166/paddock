# syntax=docker/dockerfile:1
FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:web

FROM oven/bun:1-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
COPY --from=build /app/package.json ./
# Bun resolves the @server/@shared path aliases at runtime from tsconfig.json —
# without it, "bun src/server/index.ts" fails with "Cannot find module '@server/routes'".
COPY --from=build /app/tsconfig.json ./
EXPOSE 8787
CMD ["bun", "src/server/index.ts"]
