FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY knowledge/ ./knowledge/
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime

WORKDIR /app

RUN apk add --no-cache dumb-init

COPY --from=build --chown=node:node /app/dist/ ./dist/
COPY --from=build --chown=node:node /app/node_modules/ ./node_modules/
COPY --from=build --chown=node:node /app/package.json ./package.json

# Mount a real project here and set RPGMAKER_PROJECT_PATH=/app/project.
# Discovery and pure builders work without selecting a project.
RUN mkdir -p /app/project && chown node:node /app/project

ENV NODE_ENV=production
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
