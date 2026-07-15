# syntax=docker/dockerfile:1

FROM node:22-alpine AS dependencies

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_API_BASE_URL=https://api.awaver.4rnay.net
ARG NEXT_PUBLIC_BACKEND_HEALTH_URL=https://api.awaver.4rnay.net/health/ready
ARG NEXT_PUBLIC_WORKER_HEALTH_URL=https://worker.api.awaver.4rnay.net/health/ready
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL} \
    NEXT_PUBLIC_BACKEND_HEALTH_URL=${NEXT_PUBLIC_BACKEND_HEALTH_URL} \
    NEXT_PUBLIC_WORKER_HEALTH_URL=${NEXT_PUBLIC_WORKER_HEALTH_URL} \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

COPY --from=build --chown=nextjs:nodejs /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
