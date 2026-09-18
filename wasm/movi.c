/**
 * movi.c - FFmpeg WASM Demuxer with Asyncify (Main entry)
 */

#include "movi.h"

// Forward declarations of JavaScript async functions using EM_JS
// IMPORTANT: Uses split 32-bit low/high parts to handle 64-bit offsets for
// files >= 2GB
EM_JS(int, js_read_async,
      (uint8_t *buffer, int offset_low, int offset_high, int size), {
        // Reconstruct 64-bit offset from low/high 32-bit parts
        // CRITICAL: Convert signed ints to unsigned 32-bit values before BigInt
        // conversion This prevents negative values when offset_low >= 2^31
        var lowUnsigned = offset_low >>> 0;   // Convert to unsigned 32-bit
        var highUnsigned = offset_high >>> 0; // Convert to unsigned 32-bit
        var offset = BigInt(lowUnsigned) + (BigInt(highUnsigned) * 4294967296n);
        // Convert to Number for compatibility, but log warning if >
        // MAX_SAFE_INTEGER
        var offsetNum = Number(offset);
        if (offset > Number.MAX_SAFE_INTEGER) {
          console.warn("[movi.c] Read offset exceeds MAX_SAFE_INTEGER:",
                       offset);
        }
  return Asyncify.handleAsync(function() {
    return new Promise(function(resolve) {
      Module._pendingRead = {buffer : buffer,
                             size : size,
                             resolve : function(bytesRead){resolve(bytesRead); }
      };
      if (Module.onReadRequest) {
    // Pass both BigInt and Number for compatibility
    Module.onReadRequest(offset, size);
      } else {
    console.error("[movi.c] No onReadRequest handler registered");
    resolve(-1);
      }
      });
});
});

// IMPORTANT: Returns int64_t and uses split 32-bit low/high parts to handle
// 64-bit offsets for files >= 2GB
EM_JS(int64_t, js_seek_async, (int offset_low, int offset_high, int whence), {
  // Reconstruct 64-bit offset from low/high 32-bit parts
  // CRITICAL: Convert signed ints to unsigned 32-bit values before BigInt
  // conversion This prevents negative values when offset_low >= 2^31
  var lowUnsigned = offset_low >>> 0;   // Convert to unsigned 32-bit
  var highUnsigned = offset_high >>> 0; // Convert to unsigned 32-bit
  var offset = BigInt(lowUnsigned) + (BigInt(highUnsigned) * 4294967296n);
  return Asyncify.handleAsync(function() {
    return new Promise(function(resolve) {
      Module._pendingSeek = {resolve : function(n){
          // Ensure result is always BigInt for 64-bit precision
          try {if (typeof(n) == "number"){n = BigInt(Math.floor(n));
            } else if (typeof(n) != "bigint") {
      n = BigInt(n);
            }
          } catch(e) {
    console.error("[movi.c] Failed to convert seek result to BigInt:", e);
    n = -1n;
          }
        resolve(n);
      }
}
;
if (Module.onSeekRequest) {
  // Pass BigInt directly to maintain precision for large offsets
  Module.onSeekRequest(offset, whence);
} else {
  console.error("[movi.c] No onSeekRequest handler registered");
  resolve(-1n);
}
});
});
});

// IMPORTANT: Returns int64_t to handle file sizes >= 2GB
EM_JS(int64_t, js_get_file_size, (void), {
  var size = Module._fileSize || 0;
  // Ensure we return BigInt for large file sizes
  if (typeof size === 'bigint') {
    return size;
  }
  return BigInt(Math.floor(size));
});

// AVIO read callback
// IMPORTANT: Uses split 32-bit low/high parts to handle 64-bit offsets for
// files >= 2GB
static int avio_read_callback(void *opaque, uint8_t *buf, int buf_size) {
  MoviContext *ctx = (MoviContext *)opaque;
  // Split int64_t position into two 32-bit parts for JavaScript BigInt
  // reconstruction Use unsigned casts to avoid sign extension issues with
  // values >= 2GB
  uint32_t position_low = (uint32_t)(ctx->position & 0xFFFFFFFF);
  uint32_t position_high = (uint32_t)(ctx->position >> 32);
  // IMPORTANT: Cast to int but treat as unsigned in JavaScript
  // JavaScript will interpret negative ints as unsigned when using BigInt
  // arithmetic We pass as int for EM_JS signature, but JS will convert to
  // unsigned BigInt
  int offset_low = (int)position_low;
  int offset_high = (int)position_high;
  int bytes_read = js_read_async(buf, offset_low, offset_high, buf_size);
  if (bytes_read > 0) {
    // Use int64_t arithmetic to ensure correct handling of large positions
    ctx->position += (int64_t)bytes_read;
  } else if (bytes_read == 0) {
    return AVERROR_EOF;
  }
  return bytes_read;
}

// AVIO seek callback
// IMPORTANT: Uses int64_t throughout to handle offsets >= 2GB correctly
static int64_t avio_seek_callback(void *opaque, int64_t offset, int whence) {
  MoviContext *ctx = (MoviContext *)opaque;
  if (whence == AVSEEK_SIZE) {
    return ctx->file_size;
  }
  int64_t new_pos;
  switch (whence) {
  case SEEK_SET:
    new_pos = offset;
    break;
  case SEEK_CUR:
    // Use int64_t arithmetic to ensure correct handling of large offsets
    new_pos = ctx->position + offset;
    break;
  case SEEK_END:
    // Use int64_t arithmetic to ensure correct handling of large file sizes
    new_pos = ctx->file_size + offset;
    break;
  default:
    return -1;
  }
  // Validate position range (use int64_t comparisons)
  if (new_pos < 0 || new_pos > ctx->file_size)
    return -1;
  // Update position using 64-bit value
  ctx->position = new_pos;
  return new_pos;
}

EMSCRIPTEN_KEEPALIVE
MoviContext *movi_create(void) {
  MoviContext *ctx = (MoviContext *)calloc(1, sizeof(MoviContext));
  if (!ctx)
    return NULL;
  ctx->pkt = av_packet_alloc();
  if (!ctx->pkt) {
    free(ctx);
    return NULL;
  }
  ctx->avio_buffer_size = 524288; // 512KB buffer for fewer JS callbacks
  return ctx;
}

// IMPORTANT: Reconstructs int64_t file size from low/high 32-bit parts
// This ensures correct handling of file sizes >= 2GB
EMSCRIPTEN_KEEPALIVE
void movi_set_file_size(MoviContext *ctx, int size_low, int size_high) {
  if (ctx) {
    // Reconstruct 64-bit file size from two 32-bit parts
    // Use unsigned casts to avoid sign extension issues with values >= 2GB
    uint32_t low = (uint32_t)size_low;
    uint32_t high = (uint32_t)size_high;
    ctx->file_size = (int64_t)low + ((int64_t)high << 32);
  }
}

// Narrow the open budget, in BYTES and MILLISECONDS. Either at 0 keeps the
// default. Must be called before movi_open — FFmpeg reads these while opening.
EMSCRIPTEN_KEEPALIVE
void movi_set_probe_limits(MoviContext *ctx, int probe_bytes, int analyze_ms) {
  if (!ctx)
    return;
  ctx->probe_size = probe_bytes > 0 ? (int64_t)probe_bytes : 0;
  ctx->max_analyze_us =
      analyze_ms > 0 ? (int64_t)analyze_ms * (AV_TIME_BASE / 1000) : 0;
}

EMSCRIPTEN_KEEPALIVE
void movi_destroy(MoviContext *ctx) {
  if (!ctx)
    return;
  movi_abatch_free(ctx);
  if (ctx->fmt_ctx)
    avformat_close_input(&ctx->fmt_ctx);
  if (ctx->avio_ctx) {
    av_freep(&ctx->avio_ctx->buffer);
    avio_context_free(&ctx->avio_ctx);
  }
  if (ctx->pkt)
    av_packet_free(&ctx->pkt);
  if (ctx->decoders) {
    if (ctx->fmt_ctx) {
      for (int i = 0; i < ctx->fmt_ctx->nb_streams; i++) {
        if (ctx->decoders[i])
          avcodec_free_context(&ctx->decoders[i]);
        if (ctx->resamplers && ctx->resamplers[i])
          swr_free(&ctx->resamplers[i]);
      }
    }
    free(ctx->decoders);
    if (ctx->resamplers)
      free(ctx->resamplers);
  }
  if (ctx->subtitle) {
    avsubtitle_free(ctx->subtitle);
    av_freep(&ctx->subtitle);
  }
  if (ctx->prefetched_cues) {
    for (int i = 0; i < ctx->prefetched_cue_count; i++) {
      free(ctx->prefetched_cues[i].text);
    }
    free(ctx->prefetched_cues);
    ctx->prefetched_cues = NULL;
    ctx->prefetched_cue_count = 0;
    ctx->prefetched_cue_capacity = 0;
  }
  if (ctx->frame)
    av_frame_free(&ctx->frame);
  if (ctx->resampled_frame)
    av_frame_free(&ctx->resampled_frame);
  // Cleanup RGB conversion resources
  if (ctx->sws_ctx)
    sws_freeContext(ctx->sws_ctx);
  if (ctx->rgb_frame)
    av_frame_free(&ctx->rgb_frame);
  if (ctx->rgb_buffer)
    av_free(ctx->rgb_buffer);
  free(ctx);
}

// One attempt at opening, with a given budget. Leaves nothing behind on
// failure, so the caller can simply try again with a bigger one.
static int movi_try_open(MoviContext *ctx, int64_t probe, int64_t analyze,
                         int quick) {
  ctx->position = 0;
  ctx->avio_buffer = av_malloc(ctx->avio_buffer_size);
  if (!ctx->avio_buffer)
    return -2;
  ctx->avio_ctx =
      avio_alloc_context(ctx->avio_buffer, ctx->avio_buffer_size, 0, ctx,
                         avio_read_callback, NULL, avio_seek_callback);
  if (!ctx->avio_ctx) {
    av_freep(&ctx->avio_buffer);
    return -3;
  }
  ctx->avio_ctx->seekable = AVIO_SEEKABLE_NORMAL;
  ctx->fmt_ctx = avformat_alloc_context();
  if (!ctx->fmt_ctx) {
    av_freep(&ctx->avio_ctx->buffer);
    avio_context_free(&ctx->avio_ctx);
    return -4;
  }
  ctx->fmt_ctx->pb = ctx->avio_ctx;
  ctx->fmt_ctx->probesize = probe;
  ctx->fmt_ctx->max_analyze_duration = analyze;
  if (quick) {
    // The part of stream_info nobody asks for. FFmpeg works out a frame rate by
    // DECODING frames until it is confident — for a container that states its
    // own rate (MP4, WebM do) that is pure cost, and it is usually the largest
    // single piece of the open. 0 means "believe the container".
    ctx->fmt_ctx->fps_probe_size = 0;
    // And it will buffer up to 2500 packets while identifying a codec. A file
    // that names its codecs in the header needs a tiny fraction of that.
    ctx->fmt_ctx->max_probe_packets = 64;
  }

  int ret = avformat_open_input(&ctx->fmt_ctx, NULL, NULL, NULL);
  if (ret < 0) {
    // avformat_open_input frees fmt_ctx itself on failure; the avio is ours.
    if (ctx->avio_ctx) {
      av_freep(&ctx->avio_ctx->buffer);
      avio_context_free(&ctx->avio_ctx);
      ctx->avio_ctx = NULL;
    }
    ctx->avio_buffer = NULL;
    ctx->fmt_ctx = NULL;
    return ret;
  }

  // Not fatal: a file with no PTS still plays, and this is the case the old
  // code deliberately continued past.
  int info_ret = avformat_find_stream_info(ctx->fmt_ctx, NULL);
  if (info_ret < 0) {
    av_log(NULL, AV_LOG_WARNING,
           "avformat_find_stream_info failed: %d, continuing anyway\n",
           info_ret);
  }
  return (int)ctx->fmt_ctx->nb_streams;
}

// Did the cheap attempt actually learn what it needed? A budget that ran out
// mid-probe does not fail loudly — it comes back with streams whose codec is
// unknown, or a video whose size nobody worked out, and playback then breaks
// somewhere further along where the cause is invisible.
static int movi_open_is_complete(MoviContext *ctx) {
  if (!ctx->fmt_ctx || ctx->fmt_ctx->nb_streams == 0)
    return 0;
  int usable = 0;
  for (unsigned i = 0; i < ctx->fmt_ctx->nb_streams; i++) {
    AVCodecParameters *par = ctx->fmt_ctx->streams[i]->codecpar;
    if (!par || par->codec_id == AV_CODEC_ID_NONE)
      return 0;
    if (par->codec_type == AVMEDIA_TYPE_VIDEO) {
      if (par->width <= 0 || par->height <= 0)
        return 0;
      usable = 1;
    } else if (par->codec_type == AVMEDIA_TYPE_AUDIO) {
      if (par->sample_rate <= 0)
        return 0;
      usable = 1;
    }
  }
  return usable;
}

static void movi_close_attempt(MoviContext *ctx) {
  if (ctx->fmt_ctx)
    avformat_close_input(&ctx->fmt_ctx);
  if (ctx->avio_ctx) {
    av_freep(&ctx->avio_ctx->buffer);
    avio_context_free(&ctx->avio_ctx);
    ctx->avio_ctx = NULL;
  }
  ctx->avio_buffer = NULL;
  ctx->fmt_ctx = NULL;
}

EMSCRIPTEN_KEEPALIVE
int movi_open(MoviContext *ctx) {
  if (!ctx)
    return -1;

  const int64_t FULL_PROBE = 10 * 1024 * 1024;
  const int64_t FULL_ANALYZE = 5 * AV_TIME_BASE;
  // Enough for any file that describes itself up front, which is most of them:
  // an MP4's moov and a WebM's header live in the first few hundred KB.
  const int64_t QUICK_PROBE = 1024 * 1024;
  const int64_t QUICK_ANALYZE = 1 * AV_TIME_BASE;

  // A host that stated its own budget means it, either way.
  if (ctx->probe_size > 0 || ctx->max_analyze_us > 0) {
    return movi_try_open(ctx,
                         ctx->probe_size > 0 ? ctx->probe_size : FULL_PROBE,
                         ctx->max_analyze_us > 0 ? ctx->max_analyze_us
                                                 : FULL_ANALYZE,
                         0);
  }

  // Otherwise: ask for little, and only pay for more if little was not enough.
  // The retry is close to free — the bytes it re-reads were just read, so they
  // come from the source's buffer rather than the network — while the file that
  // needed nothing more has already opened.
  int ret = movi_try_open(ctx, QUICK_PROBE, QUICK_ANALYZE, 1);
  if (ret > 0 && movi_open_is_complete(ctx))
    goto opened;

  av_log(NULL, AV_LOG_INFO,
         "quick probe insufficient (ret %d), retrying with the full budget\n",
         ret);
  movi_close_attempt(ctx);
  ret = movi_try_open(ctx, FULL_PROBE, FULL_ANALYZE, 0);
  if (ret < 0)
    return ret;

opened:
  ctx->decoders = (AVCodecContext **)calloc(ctx->fmt_ctx->nb_streams,
                                            sizeof(AVCodecContext *));
  ctx->resamplers =
      (SwrContext **)calloc(ctx->fmt_ctx->nb_streams, sizeof(SwrContext *));
  ctx->frame = av_frame_alloc();
  ctx->resampled_frame = av_frame_alloc();
  return (int)ctx->fmt_ctx->nb_streams;
}

EMSCRIPTEN_KEEPALIVE
void movi_set_log_level(int level) { av_log_set_level(level); }

EMSCRIPTEN_KEEPALIVE
void movi_enable_audio_downmix(MoviContext *ctx, int enable) {
  if (ctx)
    ctx->downmix_to_stereo = enable;
}

EMSCRIPTEN_KEEPALIVE
int movi_get_format_name(MoviContext *ctx, char *buffer, int buffer_size) {
  if (!ctx || !ctx->fmt_ctx || !ctx->fmt_ctx->iformat || !buffer || buffer_size <= 0)
    return -1;
  
  const char *name = ctx->fmt_ctx->iformat->name;
  if (!name) return -1;
  
  strncpy(buffer, name, buffer_size - 1);
  buffer[buffer_size - 1] = '\0';
  return strlen(buffer);
}



EMSCRIPTEN_KEEPALIVE
/**
 * Any container tag, by name — artist, album, date, whatever the file carries.
 *
 * The title had a getter of its own and nothing else did, so a cover-art view
 * could name the track and never the artist. Same shape as the title getter,
 * with the key passed in.
 */
EMSCRIPTEN_KEEPALIVE
int movi_get_metadata_tag(MoviContext *ctx, const char *key, char *buffer,
                          int buffer_size) {
  if (!ctx || !ctx->fmt_ctx || !key || !buffer || buffer_size <= 0)
    return -1;

  const AVDictionaryEntry *tag =
      av_dict_get(ctx->fmt_ctx->metadata, key, NULL, AV_DICT_IGNORE_SUFFIX);
  if (!tag || !tag->value)
    return -2;

  strncpy(buffer, tag->value, buffer_size - 1);
  buffer[buffer_size - 1] = '\0';
  return strlen(buffer);
}

int movi_get_metadata_title(MoviContext *ctx, char *buffer, int buffer_size) {
  if (!ctx || !ctx->fmt_ctx || !buffer || buffer_size <= 0)
    return -1;
    
  AVDictionaryEntry *tag = NULL;
  tag = av_dict_get(ctx->fmt_ctx->metadata, "title", NULL, AV_DICT_IGNORE_SUFFIX);
  
  if (!tag || !tag->value)
    return -2;
    
  strncpy(buffer, tag->value, buffer_size - 1);
  buffer[buffer_size - 1] = '\0';
  return strlen(buffer);
}
