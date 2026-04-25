FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

COPY src/ ./src/

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
