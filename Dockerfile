# syntax=docker/dockerfile:1

# ── deps: all dependencies (dev + prod), shared by dev and build ──
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── dev: tsx watch, src/ is bind-mounted by docker-compose ──
FROM deps AS dev
ENV NODE_ENV=development
EXPOSE 3000
CMD ["npm", "run", "dev"]

# ── build: compile src/ → dist/ ──
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── prod: compiled JS + production dependencies only ──
FROM node:24-alpine AS prod
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/ || exit 1
CMD ["node", "dist/index.js"]
