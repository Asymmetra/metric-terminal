# ---- Builder Stage ----
FROM rust:slim-bookworm AS builder

RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Imperial is a remote HTTP/WS API — no SDK to vendor.
COPY metric-backend/ metric-backend/

WORKDIR /build/metric-backend
RUN cargo build --release

# ---- Runtime Stage ----
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/metric-backend/target/release/metric-backend /usr/local/bin/metric-backend

ENV PORT=10000
ENV RUST_LOG=metric_backend=info

EXPOSE 10000

CMD ["metric-backend"]
