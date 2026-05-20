FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV PI_ROTATOR_DIR=/data
EXPOSE 51200
VOLUME ["/data"]

CMD ["npm", "start"]
