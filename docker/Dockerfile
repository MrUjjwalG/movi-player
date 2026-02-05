# syntax=docker/dockerfile:1
FROM --platform=linux/arm64 emscripten/emsdk:latest

LABEL maintainer="movi"
LABEL description="FFmpeg WASM build environment for movi"

# Install build dependencies
RUN apt-get update && apt-get install -y \
    git \
    make \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# Clone FFmpeg (will be mounted from host for dev, or cloned for CI)
ARG FFMPEG_VERSION=n7.1.3
RUN git clone --depth 1 --branch ${FFMPEG_VERSION} https://github.com/FFmpeg/FFmpeg.git /opt/FFmpeg

# Build script
COPY build-ffmpeg.sh /opt/build-ffmpeg.sh
RUN chmod +x /opt/build-ffmpeg.sh

ENV FFMPEG_SRC=/opt/FFmpeg

CMD ["/opt/build-ffmpeg.sh"]
