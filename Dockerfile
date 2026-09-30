FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

RUN mkdir -p /app/data/output && chown -R node:node /app
USER node

CMD ["node", "src/cli.js", "help"]
