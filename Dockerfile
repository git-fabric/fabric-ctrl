# @git-fabric/fabric-ctrl — multi-stage build
FROM node:22-alpine AS builder

# Git required for github: dependencies in package.json
RUN apk add --no-cache git

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine

LABEL org.opencontainers.image.title="@git-fabric/fabric-ctrl"
LABEL org.opencontainers.image.description="Zero-trust control plane — GitHub App webhooks, fabric-invoke orchestration, MCP aggregation"
LABEL org.opencontainers.image.source="https://github.com/git-fabric/fabric-ctrl"

# Git required for github: dependencies in package.json
RUN apk add --no-cache git && \
    addgroup -g 1001 -S fabric && adduser -u 1001 -S fabric -G fabric

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist

USER fabric
ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/app/index.js"]
