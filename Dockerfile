# Build stage
FROM node:22-alpine AS build
RUN apk add --no-cache git
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY tests ./tests
COPY scripts/sanitize-check.mjs ./scripts/sanitize-check.mjs
RUN npm ci --no-fund --no-audit && npm run build && node --test "dist/tests/**/*.test.js"

# Runtime stage: dist only — gyeoljae has zero runtime dependencies.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
ENTRYPOINT ["node", "dist/src/cli/poll.js"]
