# Imagen liviana (glibc: @libsql/client trae binarios precompilados para Debian)
FROM node:22-slim
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/webpush.db
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
# Si no usás Turso, montá un volumen en /data para no perder la base
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
