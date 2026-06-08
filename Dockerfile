FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
RUN npm run postbuild

FROM node:22-alpine AS runtime

WORKDIR /app

RUN apk add --no-cache dumb-init

COPY --from=build /app/dist/ ./dist/
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/package.json ./package.json

RUN mkdir -p /app/project/data /app/project/img/characters /app/project/img/faces /app/project/img/enemies /app/project/img/battlers /app/project/img/pictures
COPY knowledge/ /app/knowledge/
RUN echo '{"gameTitle":"Dummy","startMapId":1,"startX":0,"startY":0,"partyMembers":[],"switches":[""],"variables":[""],"versionId":0}' > /app/project/data/System.json
RUN echo '[]' > /app/project/data/MapInfos.json
RUN echo '[null]' > /app/project/data/Actors.json
RUN echo '[null]' > /app/project/data/Classes.json
RUN echo '[null]' > /app/project/data/Skills.json
RUN echo '[null]' > /app/project/data/Items.json
RUN echo '[null]' > /app/project/data/Weapons.json
RUN echo '[null]' > /app/project/data/Armors.json
RUN echo '[null]' > /app/project/data/Enemies.json
RUN echo '[null]' > /app/project/data/Troops.json
RUN echo '[null]' > /app/project/data/States.json
RUN echo '[null]' > /app/project/data/Tilesets.json
RUN echo '[null]' > /app/project/data/CommonEvents.json

ENV NODE_ENV=production
ENV RPGMAKER_PROJECT_PATH=/app/project

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
