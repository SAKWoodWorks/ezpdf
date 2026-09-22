FROM node:20-bookworm-slim

RUN groupadd --system app && useradd --system --gid app --create-home app
WORKDIR /app
RUN chown app:app /app
USER app

EXPOSE 3000
CMD ["npm", "run", "start"]
