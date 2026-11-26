FROM node:20-bookworm-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg libsndfile1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY requirements.txt ./
RUN pip3 install --break-system-packages -r requirements.txt
COPY . .
RUN mkdir -p /data
ENV PORT=8787 DATA_DIR=/data STEM_DEVICE=cpu
EXPOSE 8787
CMD ["npm","start"]
