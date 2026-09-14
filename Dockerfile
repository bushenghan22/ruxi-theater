# Dockerfile —— 《入戏》容器化（零 npm 依赖，任意容器平台直接跑）
# 本地试跑：docker build -t ruxi . && docker run -p 4173:4173 --env DEEPSEEK_API_KEY=sk-xxx ruxi
FROM node:20-alpine
WORKDIR /app

# 只拷运行时需要的文件（.env 永远不进镜像，密钥由平台环境变量注入）
COPY package.json ./
COPY server.mjs ./
COPY public ./public
COPY data/plays ./data/plays
COPY data/ai-mode ./data/ai-mode
COPY data/stories.json ./data/stories.json

ENV NODE_ENV=production
EXPOSE 4173
CMD ["node", "server.mjs"]
