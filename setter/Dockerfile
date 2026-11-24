FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# La base SQLite vive en /data: monta un volumen persistente ahí.
ENV DB_PATH=/data/setter.db
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
