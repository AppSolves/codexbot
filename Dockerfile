# Official musl-compatible Codex runs without Debian's unused system packages.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
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
