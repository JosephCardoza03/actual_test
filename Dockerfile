FROM node:22-alpine

# Set Working Directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Copy Prisma schema BEFORE install
COPY prisma ./prisma

# Install Dependencies (now prisma generate works)
RUN npm install

# Copy rest of app code
COPY . .

# Expose correct port
EXPOSE 5003

# Run app
CMD ["node", "./src/server.js"]