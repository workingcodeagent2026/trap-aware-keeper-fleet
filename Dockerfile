FROM node:22-slim
RUN useradd --create-home --shell /usr/sbin/nologin appuser
WORKDIR /home/appuser/app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
USER appuser
CMD ["node", "index.js"]
