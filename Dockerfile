FROM node:18-alpine

WORKDIR /app

# Copiar package.json
COPY package.json .

# Instalar dependencias
RUN npm install --production

# Copiar servidor
COPY realtime-server.js .

# Exponer puerto
EXPOSE 8080

# Iniciar
CMD ["node", "realtime-server.js"]
