# 构建上下文为仓库根目录：docker build -f server/Dockerfile .
FROM node:22-alpine AS web
ENV OPENUI_TELEMETRY_DISABLED=1
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM rust:1-alpine AS server
RUN apk add --no-cache musl-dev
WORKDIR /src/server
COPY server/Cargo.toml server/Cargo.lock server/build.rs ./
COPY server/src ./src
COPY server/migrations ./migrations
COPY --from=web /src/web/dist /src/web/dist
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/server/target \
    cargo build --release --locked && cp target/release/relay /relay

FROM alpine:3.22
RUN apk add --no-cache ca-certificates && adduser -D -H -u 10001 relay
COPY --from=server /relay /usr/local/bin/relay
USER relay
ENV BIND=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/relay"]
