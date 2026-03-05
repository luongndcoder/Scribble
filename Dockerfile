# ─── Meeting Minutes App (Node.js) ───
FROM node:20-slim

WORKDIR /app

# Install ffmpeg for audio conversion
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --production

COPY . .

RUN mkdir -p uploads audio_files data

EXPOSE 3001

CMD ["node", "server.js"]
