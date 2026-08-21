# --- build stage: compile TypeScript, including dev dependencies -------------
FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage: production deps only, plus ffmpeg ------------------------
FROM node:24-bookworm-slim AS runtime

# ffmpeg is not used until M1 (audio resampling), but installing it here means
# the image is already correct when that milestone lands.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Run as the unprivileged `node` user that the base image ships with.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

CMD ["node", "dist/index.js"]
