FROM node:24-bookworm-slim

RUN groupadd --gid 10001 app && useradd --uid 10001 --gid app --create-home app
WORKDIR /app
RUN chown app:app /app
USER app

COPY --chown=app:app package.json package-lock.json ./
RUN npm ci
COPY --chown=app:app . .
RUN npm run build

EXPOSE 3000
CMD ["npm", "run", "start"]
