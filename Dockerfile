# ---- Builder Stage ----
FROM rust:1.85-slim-bookworm AS builder

RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy SDK first (changes less frequently → better layer caching)
COPY phoenix-rise-sdk/rust/ phoenix-rise-sdk/rust/

# Copy backend source + lockfile
COPY ember-backend/ ember-backend/

WORKDIR /build/ember-backend
RUN cargo build --release

# ---- Runtime Stage ----
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/ember-backend/target/release/ember-backend /usr/local/bin/ember-backend

ENV PORT=10000
ENV RUST_LOG=ember_backend=info

EXPOSE 10000

CMD ["ember-backend"]
