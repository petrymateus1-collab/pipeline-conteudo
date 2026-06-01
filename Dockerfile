FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

RUN pip install openai-whisper

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY index.js ./

EXPOSE 8080

CMD ["node", "index.js"]
