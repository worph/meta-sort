# meta-sort standalone Docker image
# Includes: Redis, nginx, rclone, FFmpeg, Node.js backend, React UI, and Editor
#
# Build standalone:
#   docker build -t meta-sort .
#
# Build with custom meta-core (for development):
#   docker build --build-arg META_CORE_IMAGE=meta-core:local -t meta-sort .

# Stage 0: Get meta-core binary from published image
ARG META_CORE_IMAGE=ghcr.io/worph/meta-core:latest
FROM ${META_CORE_IMAGE} AS meta-core

# Stage 1: Build UI
FROM node:21-alpine AS ui-builder

WORKDIR /build

# Copy UI package and install
COPY packages/meta-sort-ui/package.json ./
RUN npm install

# Copy UI source and build
COPY packages/meta-sort-ui/ ./
RUN npm run build

# Stage 2: Build Editor
FROM node:21-alpine AS editor-builder

WORKDIR /build

# Copy editor package and install
COPY packages/meta-sort-editor/package.json ./
RUN npm install

# Copy editor source and build
COPY packages/meta-sort-editor/ ./
RUN npm run build

# Stage 3: Build Backend using pnpm workspace
FROM node:21-alpine AS backend-builder

# Install pnpm
RUN npm install -g pnpm

WORKDIR /build

# Copy workspace configuration
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy all packages for the workspace
COPY packages/shared/ ./packages/shared/
COPY packages/async-utils/ ./packages/async-utils/
COPY packages/meta-sort-core/ ./packages/meta-sort-core/

# Install all dependencies
RUN pnpm install --frozen-lockfile || pnpm install

# Build shared dependencies first
RUN pnpm --filter="@metazla/meta-interface" build || true
RUN pnpm --filter="@metazla/meta-hash" build || true
RUN pnpm --filter="@metazla/filename-tools" build || true

# Build async-utils
RUN pnpm --filter="@worph/async-utils" build || true

# Build the core package
RUN pnpm --filter="@meta-sort/core" build

# Stage 4: Runtime
FROM ubuntu:22.04

# Container registry metadata
LABEL org.opencontainers.image.source=https://github.com/worph/meta-sort
LABEL org.opencontainers.image.description="MetaMesh file processing and metadata extraction service"
LABEL org.opencontainers.image.licenses=MIT

# Avoid prompts during install
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    ca-certificates \
    nginx \
    redis-server \
    supervisor \
    ffmpeg \
    apache2-utils \
    fuse3 \
    unzip \
    cifs-utils \
    nfs-common \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 21
RUN curl -fsSL https://deb.nodesource.com/setup_21.x | bash - \
    && apt-get install -y nodejs

# Install rclone
RUN curl https://rclone.org/install.sh | bash

# Create directories
RUN mkdir -p \
    /app/backend \
    /app/ui \
    /app/editor \
    /data/watch \
    /data/cache \
    /data/redis \
    /data/mounts \
    /meta-core/db/redis \
    /meta-core/locks \
    /meta-core/services \
    /files \
    /var/log/supervisor \
    /var/log/nginx \
    /root/.config/rclone

# Copy built UI
COPY --from=ui-builder /build/dist /app/ui
RUN chmod -R 755 /app/ui

# Copy built Editor
COPY --from=editor-builder /build/dist /app/editor
RUN chmod -R 755 /app/editor

# Copy built backend with all dependencies
COPY --from=backend-builder /build/packages/meta-sort-core/dist /app/backend/dist
COPY --from=backend-builder /build/packages/meta-sort-core/package.json /app/backend/

# Copy plugins directory (plugins are now external container plugins)
# COPY --from=backend-builder /build/packages/meta-sort-core/plugins /app/backend/plugins

# Copy node_modules (has all deps including workspace packages)
COPY --from=backend-builder /build/node_modules /app/node_modules

# Recreate ALL pnpm symlinks (pnpm stores in .pnpm, symlinks at top level)
RUN for pkg_path in /app/node_modules/.pnpm/*/node_modules/*; do \
      pkg_name=$(basename "$pkg_path"); \
      if [ ! -L "/app/node_modules/$pkg_name" ] && [ ! -d "/app/node_modules/$pkg_name" ]; then \
        ln -sf "$pkg_path" /app/node_modules/$pkg_name 2>/dev/null || true; \
      fi; \
    done

# Also handle scoped packages (@scope/name)
RUN for scope_path in /app/node_modules/.pnpm/*/node_modules/@*; do \
      if [ -d "$scope_path" ]; then \
        scope_name=$(basename "$scope_path"); \
        mkdir -p "/app/node_modules/$scope_name" 2>/dev/null; \
        for pkg_path in "$scope_path"/*; do \
          pkg_name=$(basename "$pkg_path"); \
          if [ ! -L "/app/node_modules/$scope_name/$pkg_name" ] && [ ! -d "/app/node_modules/$scope_name/$pkg_name" ]; then \
            ln -sf "$pkg_path" /app/node_modules/$scope_name/$pkg_name 2>/dev/null || true; \
          fi; \
        done; \
      fi; \
    done

# Copy built workspace packages (overwrite symlinks with actual dist)
COPY --from=backend-builder /build/packages/shared/meta-hash/dist /app/node_modules/@metazla/meta-hash/dist
COPY --from=backend-builder /build/packages/shared/meta-hash/package.json /app/node_modules/@metazla/meta-hash/
COPY --from=backend-builder /build/packages/shared/meta-interface/dist /app/node_modules/@metazla/meta-interface/dist
COPY --from=backend-builder /build/packages/shared/meta-interface/package.json /app/node_modules/@metazla/meta-interface/
COPY --from=backend-builder /build/packages/shared/filename-tool/dist /app/node_modules/@metazla/filename-tools/dist
COPY --from=backend-builder /build/packages/shared/filename-tool/package.json /app/node_modules/@metazla/filename-tools/
COPY --from=backend-builder /build/packages/async-utils/dist /app/node_modules/@worph/async-utils/dist
COPY --from=backend-builder /build/packages/async-utils/package.json /app/node_modules/@worph/async-utils/

# Copy meta-core sidecar binary
COPY --from=meta-core /usr/local/bin/meta-core /usr/local/bin/meta-core
RUN chmod +x /usr/local/bin/meta-core

# Copy configuration files
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/redis.conf /etc/redis/redis.conf
COPY docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Create nginx htpasswd file (default: admin/admin)
RUN htpasswd -bc /etc/nginx/.htpasswd admin admin

# Environment variables
ENV NODE_ENV=production \
    NODE_PATH=/app/node_modules \
    WATCH_PATHS=/data/watch \
    META_CORE_PATH=/meta-core \
    FILES_PATH=/files \
    REDIS_URL=redis://127.0.0.1:6379 \
    REDIS_PREFIX=meta-sort: \
    API_HOST=0.0.0.0 \
    API_PORT=3000

# Set working directory for backend
WORKDIR /app/backend

# Expose port 80 (nginx)
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost/health || exit 1

# Start supervisord (manages redis, backend, nginx)
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
