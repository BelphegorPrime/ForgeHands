# Builder: installs the dev dependencies and fails the build on a type error. Nothing from this stage but the sources ends up in the image.
FROM node:26-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY test ./test
COPY ui ./ui
RUN npm run typecheck && npm run ui:build

# Runtime: Node runs the TypeScript sources directly (type stripping), so there is no compile output and no node_modules.
FROM node:26-alpine
WORKDIR /app
RUN mkdir -p /app/data && chown -R node:node /app/data
COPY --chown=node:node package.json ./
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/dist/dashboard ./dist/dashboard
USER node
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/index.ts"]
