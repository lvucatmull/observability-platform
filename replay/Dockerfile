FROM node:22-alpine AS build

WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci
COPY replay ./replay
RUN npm run build:replay

FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app
COPY replay/server.mjs ./server.mjs
COPY replay/public ./public
COPY --from=build /workspace/replay/dist ./public/assets
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 3210
CMD ["node", "server.mjs"]
