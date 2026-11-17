FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# اعتماديات الإنتاج أولاً حتى تُستفاد من طبقات البناء
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# بقية المشروع (بدون data / waha-sessions / .env — انظر .dockerignore)
COPY . .

# مجلد البيانات يُركَّب من الخارج في الإنتاج، لكن نجهّزه للاستخدام المحلي
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3005
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
