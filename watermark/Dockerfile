# Node 22 base image. Google's mirror of Docker Hub by default — Docker Hub
# times out from the deploy server. Override with --build-arg BASE_IMAGE=node:22-alpine.
ARG BASE_IMAGE=mirror.gcr.io/library/node:22-alpine
FROM ${BASE_IMAGE}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY scada-config.json ./
COPY public/ ./public/
EXPOSE 4000
CMD ["node", "server.js"]
