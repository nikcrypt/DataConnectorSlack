# Build from repo root:
#   docker build -f phase2/Dockerfile -t phase2-platform .
FROM node:20-bookworm-slim

WORKDIR /app

COPY phase2/package.json phase2/package-lock.json* ./phase2/
WORKDIR /app/phase2
RUN npm install --omit=dev

COPY phase2/ ./
# Phase 1 connectors for WORKER_MODE=live
COPY src /app/src
COPY package.json /app/package.json

ENV NODE_ENV=production
USER node

CMD ["node", "src/api/server.js"]
