FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /data
ENV PORT=8787 DATA_DIR=/data
EXPOSE 8787
CMD ["npm","start"]
