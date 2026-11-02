FROM node:24.22.1-alpine

RUN apk add --no-cache iputils

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
