FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN mkdir -p data uploads/documents uploads/images uploads/code uploads/3d-models uploads/other
EXPOSE 3000
CMD ["node", "server.js"]
