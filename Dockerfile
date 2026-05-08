FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY bin ./bin
COPY src ./src

USER node

ENTRYPOINT ["node", "bin/cli.js"]
