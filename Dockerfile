# Bailing Wooden Backend (NestJS 11 + Prisma 6) - production image
# Build (no secrets required):
#   docker build -t bailing-backend:<commit> .
# Base image pinned by major (node:22-alpine); no 'latest'.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma
COPY src ./src
# Prisma Client generation requires the schema only (no DB connection).
RUN npx prisma generate && npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Production deps only; prisma stays in devDeps so the client is copied from
# the build stage (same lockfile => identical @prisma/client version).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
# Uploads live on a persistent volume (never inside the image):
#   /app/uploads/products  (product images)
#   /app/uploads/media     (media library)
RUN mkdir -p /app/uploads/products /app/uploads/media \
 && chown -R node:node /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
