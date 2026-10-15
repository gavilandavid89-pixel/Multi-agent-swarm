FROM node:25-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
RUN npm run check
ENV NODE_ENV=production
CMD ["node", "server.js"]
