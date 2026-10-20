# 前端构建使用构建机原生架构，产物为纯静态文件，可供 amd64 / arm64 共用。
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS frontend
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# 与现有桌面发布统一使用有效的 pnpm 锁文件，不依赖仓库历史 npm 锁文件。
RUN npm install -g pnpm@11 --no-audit --no-fund && pnpm install --frozen-lockfile
COPY . .
RUN npm run build:web

# 原生同步业务以无 GUI 工作进程运行，与桌面端共用同一份 Rust 源码。
FROM rust:1-bookworm AS sync-engine
WORKDIR /build
COPY src-tauri/src ./src-tauri/src
COPY server/native ./server/native
RUN cargo build --locked --release --manifest-path server/native/Cargo.toml

# 运行镜像仅包含网页服务依赖和静态文件，不携带 Rust、桌面运行时或本机数据。
FROM node:22-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/CrazyFigure/NoteBoard" \
      org.opencontainers.image.licenses="GPL-3.0-only" \
      org.opencontainers.image.title="NoteBoard"
ENV NODE_ENV=production PORT=3000 NOTEBOARD_DATA_DIR=/data NOTEBOARD_STATIC_DIR=/app/dist-web
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && mkdir -p /data/workspace /data/state && chown -R node:node /data
COPY server/*.mjs ./
COPY server/font-files.json ./
COPY --from=sync-engine /build/server/native/target/release/noteboard-sync-server ./noteboard-sync-server
COPY LICENSE /app/LICENSE
# 插件兼容性读取部署中的真实主程序版本，与桌面端采用同一版本来源。
COPY package.json /app/package.json
COPY --from=frontend /build/dist-web /app/dist-web
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "index.mjs"]
