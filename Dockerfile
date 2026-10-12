# EasyTesting in a container: the web app plus Chromium for running tests.
# Build:  docker build -t easytesting .
# Run:    docker run -p 8080:8080 -v heal-data:/data easytesting
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=8080 \
    HOST=0.0.0.0 \
    # A shared server should not run uploaded code. Set to "on" only on a machine you trust.
    HEAL_CODE_UPLOADS=off

WORKDIR /app

# Dependencies first, so rebuilding after a code change is fast. The build needs the dev tools too.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Chromium and the system libraries it needs, at the version the app uses.
RUN npx playwright-core install --with-deps chromium && rm -rf /var/lib/apt/lists/*

COPY . .
RUN npm run build && npm prune --omit=dev

# Run as a normal user, with the data folder owned by it.
RUN useradd --create-home --uid 10001 app && mkdir -p /data && chown -R app:app /data
USER app
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Accounts are on, so listening on all interfaces is allowed. Put HTTPS in front of it and set HEAL_HTTPS=1.
CMD ["node", "dist/cli.js", "serve", "--data", "/data"]
