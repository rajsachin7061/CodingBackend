FROM node:22-trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    g++ \
    openjdk-21-jdk-headless \
    python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV COMPILER_PROVIDER=local
ENV JAVA_COMPILATION_PATH=/usr/bin/javac
ENV JAVA_EXECUTION_PATH=/usr/bin/java
ENV PYTHON_EXECUTION_PATH=/usr/bin/python3
ENV CPP_COMPILATION_PATH=/usr/bin/g++

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3001

CMD ["npm", "start"]
