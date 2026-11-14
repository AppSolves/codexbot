# Official musl-compatible Codex runs without Debian's unused system packages.
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4
WORKDIR /app
COPY package.json package-lock.json ./
# Package managers are build tools, never part of the isolated review runtime.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY dist ./dist
ENV HOME=/home/codex CODEX_HOME=/home/codex/.codex
USER 1000:1000
CMD ["node", "dist/src/runner/engine-main.js"]
