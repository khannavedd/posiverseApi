# node:20-slim instead of the full node:20 image — same Node version,
# much smaller (fewer layers to pull on every deploy, smaller attack
# surface). No build/compile step in this app (plain JS, no
# TypeScript/bundler), so a multi-stage build wouldn't buy anything
# beyond what --omit=dev already does below.
FROM node:20-slim

WORKDIR /usr/src/app

# package*.json copied and installed before the rest of the source so
# this layer only re-runs when dependencies actually change, not on
# every code edit.
COPY package*.json ./

# npm ci (not install) — installs exactly what package-lock.json
# specifies instead of potentially updating it, so the same lockfile
# that's tested locally is what ships. --omit=dev drops nodemon (the
# only devDependency), which isn't needed at runtime.
RUN npm ci --omit=dev

# .dockerignore keeps node_modules, .env, and the Firebase service
# account JSON out of the build context entirely — this COPY can't
# leak them into the image even by accident.
COPY . .

# The official node image ships a built-in unprivileged "node" user —
# running as it instead of root is a one-line hardening with no
# downside for a plain HTTP service like this.
USER node

EXPOSE 8080

CMD ["npm", "start"]