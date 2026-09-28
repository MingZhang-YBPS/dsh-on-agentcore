# Spike 02 运行镜像：固定 Node 22 版本，依赖按 package-lock.json 精确安装
FROM node:22.23.3-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY tools ./tools
CMD ["node", "src/runner.mjs"]
