FROM node:24-alpine
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .
RUN mkdir -p /data

ENV NODE_ENV=production
ENV DB_PATH=/data/finpredict.db
ENV PORT=3000

EXPOSE 3000

# Seed on first run if DB doesn't exist, then start
CMD sh -c 'if [ ! -f /data/finpredict.db ]; then node --experimental-sqlite seed.js; fi && node --experimental-sqlite server.js'
