FROM node:22-alpine
WORKDIR /app
RUN mkdir -p /app/data && chown -R node:node /app/data
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
USER node
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/index.mjs"]
