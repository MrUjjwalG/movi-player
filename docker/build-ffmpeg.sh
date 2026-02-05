#!/bin/bash
set -e

ls -R /src/dist/ffmpeg/lib || echo "Directory not found"
if [ -z "$FORCE_FFMPEG" ] && [ -f "/src/dist/ffmpeg/lib/libavformat.a" ]; then
    if [ -d "${FFMPEG_SRC}" ]; then
        echo "FFmpeg Source Version:"
        cd ${FFMPEG_SRC} && (git describe --tags --always || echo "Unknown (git describe failed)")
        cd - > /dev/null
    fi
    echo "=== FFmpeg libraries found, skipping build (set FORCE_FFMPEG=true to rebuild) ==="
else
    echo "=== Building FFmpeg for WASM ==="
    
    cd ${FFMPEG_SRC}
    
    # Clean previous build
    make clean 2>/dev/null || true
    make distclean 2>/dev/null || true

    # Configure FFmpeg for WASM with size optimizations
    # -Oz: Maximum size optimization (instead of -O3 speed)
    # --enable-small: Trade speed for size
    # -flto: Link-time optimization
    emconfigure ./configure \
        --prefix=/src/dist/ffmpeg \
        --target-os=none \
        --arch=x86_32 \
        --cc=emcc \
        --cxx=em++ \
        --ar=emar \
        --ranlib=emranlib \
        --disable-all \
        --disable-asm \
        --disable-debug \
        --disable-programs \
        --disable-doc \
        --disable-autodetect \
        --enable-small \
        --enable-avcodec \
        --enable-avformat \
        --enable-avutil \
        --enable-swresample \
        --enable-swscale \
        --enable-protocol=file \
        --enable-demuxer=mov,mp4,m4a,mj2,avi,flv,matroska,webm,asf,mpegts,flac,ogg,wav,srt,ass,ssa,webvtt \
        --enable-decoder=h264,hevc,vp9,vp8,av1,aac,aac_latm,mp3,opus,vorbis,flac,ac3,eac3,dca,pcm_s16le,pcm_s24le,pcm_f32le,subrip,ass,ssa,mov_text,pgssub,dvb_subtitle,dvdsubtitle,webvtt,srt \
        --enable-parser=h264,hevc,vp8,vp9,av1,aac,mp3,opus,vorbis,flac,hdmv_pgs_subtitle \
        --enable-bsf=aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb,iso_media_metadata_manipulator,extract_extradata,vp9_superframe \
        --extra-cflags="-Oz -flto -s USE_PTHREADS=0 -D_FILE_OFFSET_BITS=64" \
        --extra-cxxflags="-Oz -flto -D_FILE_OFFSET_BITS=64" \
        --extra-ldflags="-s WASM=1 -Oz -flto"

    echo "=== Compiling FFmpeg ==="
    emmake make -j$(nproc)

    echo "=== Installing FFmpeg ==="
    emmake make install
fi

echo "=== Building movi WASM module ==="
cd /src

# Create output directory
mkdir -p /src/dist/wasm

# Build the movi WASM module with Asyncify for async I/O
# Uses custom AVIO with JavaScript callbacks instead of WORKERFS
# Enable 64-bit file offsets for files >= 2GB support
# Size optimizations:
#   -Oz: Maximum size optimization (instead of -O3 for speed)
#   -flto: Link-time optimization for better dead code elimination
#   -s ASSERTIONS=0: Remove debug assertions
#   -s DISABLE_EXCEPTION_THROWING=1: Remove exception handling overhead
#   -s LEGACY_RUNTIME=0: Use modern, smaller Emscripten runtime
#   -g0: No debug info, no name section, no DWARF
#   -s ELIMINATE_DUPLICATE_FUNCTIONS=1: Remove duplicate function definitions
#   -s TEXTDECODER=2: Use built-in browser TextDecoder
#   -s STACK_OVERFLOW_CHECK=0: Remove stack overflow checks
#   -s SUPPORT_LONGJMP=0: Disable longjmp/setjmp support
#   -s SUPPORT_ERRNO=0: Disable errno support
#   -s ASYNCIFY_STACK_SIZE=524288: Reduce asyncify stack from 1MB to 512KB
emcc /src/wasm/*.c \
    -I/src/dist/ffmpeg/include \
    -L/src/dist/ffmpeg/lib \
    -lavformat -lavcodec -lavutil -lswresample -lswscale \
    -Oz \
    -flto \
    -D_FILE_OFFSET_BITS=64 \
    -s WASM=1 \
    -s EXPORT_ES6=1 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME="createMoviModule" \
    -s ENVIRONMENT=web,worker \
    -s INITIAL_MEMORY=256MB \
    -s MAXIMUM_MEMORY=4GB \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s ASYNCIFY=1 \
    -s ASYNCIFY_STACK_SIZE=524288 \
    -s "ASYNCIFY_ADD=['movi_open','movi_read_frame','movi_seek_to','movi_thumbnail_open','movi_thumbnail_read_keyframe']" \
    -s "ASYNCIFY_IMPORTS=['js_read_async','js_seek_async','js_thumbnail_packet_ready']" \
    -s EXPORTED_RUNTIME_METHODS='["ccall", "cwrap", "FS", "stringToNewUTF8", "UTF8ToString", "lengthBytesUTF8", "addFunction", "HEAPU8"]' \
    -s EXPORTED_FUNCTIONS='["_malloc", "_free", "_movi_create", "_movi_destroy", "_movi_open", "_movi_read_frame", "_movi_seek_to", "_movi_get_duration", "_movi_get_start_time", "_movi_get_stream_count", "_movi_get_stream_info", "_movi_get_extradata", "_movi_set_log_level", "_movi_set_file_size", "_movi_enable_decoder", "_movi_send_packet", "_movi_receive_frame", "_movi_decode_subtitle", "_movi_get_subtitle_text", "_movi_get_subtitle_times", "_movi_get_subtitle_image_info", "_movi_get_subtitle_image_data", "_movi_free_subtitle", "_movi_get_frame_width", "_movi_get_frame_height", "_movi_get_frame_format", "_movi_get_frame_linesize", "_movi_get_frame_data", "_movi_get_frame_samples", "_movi_get_frame_channels", "_movi_get_frame_sample_rate", "_movi_enable_audio_downmix", "_movi_thumbnail_create", "_movi_thumbnail_destroy", "_movi_thumbnail_open", "_movi_thumbnail_read_keyframe", "_movi_thumbnail_get_packet_data", "_movi_thumbnail_decode_frame"]' \
    -s ASSERTIONS=0 \
    -s DISABLE_EXCEPTION_THROWING=1 \
    -s ALLOW_TABLE_GROWTH=1 \
    -s INVOKE_RUN=0 \
    -s SINGLE_FILE=1 \
    -s LEGACY_RUNTIME=0 \
    -g0 \
    -s MINIFY_HTML=0 \
    -s ELIMINATE_DUPLICATE_FUNCTIONS=1 \
    -s STACK_OVERFLOW_CHECK=0 \
    -s TEXTDECODER=2 \
    -s SUPPORT_LONGJMP=0 \
    -s SUPPORT_ERRNO=0 \
    --closure 0 \
    --js-library /src/wasm/library_movi.js \
    -o /src/dist/wasm/movi.js

echo "=== Build complete ==="
ls -la /src/dist/wasm/
