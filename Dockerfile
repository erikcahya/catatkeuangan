FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY db ./db
COPY public ./public
USER node
EXPOSE 3000
# Jalankan migrasi dulu, lalu server.
CMD ["sh", "-c", "node scripts/migrate.js && node src/server.js"]
