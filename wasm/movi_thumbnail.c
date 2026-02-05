/**
 * movi_thumbnail.c - Fast thumbnail extraction (demux only)
 *
 * Uses callback pattern to bypass Asyncify return value issues.
 */

#include "movi.h"
#include <libswscale/swscale.h>
#include <libavutil/imgutils.h>

// Thumbnail context
struct MoviThumbnailContext {
  AVFormatContext *fmt_ctx;
  AVIOContext *avio_ctx;
  uint8_t *avio_buffer;
  int64_t position;
  int64_t file_size;
  int avio_buffer_size;

  int video_stream_index;
  AVPacket *pkt;
  
  // Decoding support (Software fallback)
  AVCodecContext *dec_ctx;
  AVFrame *frame;
  AVFrame *rgb_frame;
  struct SwsContext *sws_ctx;
  uint8_t *rgb_buffer;
  int rgb_buffer_size;

  // Result storage
  int last_packet_size;
  double last_packet_pts;
};

extern int js_read_async(uint8_t *buffer, int offset_low, int offset_high,
                         int size);
extern int64_t js_seek_async(int offset_low, int offset_high, int whence);

// JS callback declaration
extern void js_thumbnail_packet_ready(int size, double pts);

static int thumbnail_avio_read(void *opaque, uint8_t *buf, int buf_size) {
  struct MoviThumbnailContext *ctx = (struct MoviThumbnailContext *)opaque;
  uint32_t position_low = (uint32_t)(ctx->position & 0xFFFFFFFF);
  uint32_t position_high = (uint32_t)(ctx->position >> 32);

  int bytes_read =
      js_read_async(buf, (int)position_low, (int)position_high, buf_size);
  if (bytes_read > 0) {
    ctx->position += (int64_t)bytes_read;
  } else if (bytes_read == 0) {
    return AVERROR_EOF;
  }
  return bytes_read;
}

static int64_t thumbnail_avio_seek(void *opaque, int64_t offset, int whence) {
  struct MoviThumbnailContext *ctx = (struct MoviThumbnailContext *)opaque;

  if (whence == AVSEEK_SIZE)
    return ctx->file_size;

  int64_t new_pos;
  switch (whence) {
  case SEEK_SET:
    new_pos = offset;
    break;
  case SEEK_CUR:
    new_pos = ctx->position + offset;
    break;
  case SEEK_END:
    new_pos = ctx->file_size + offset;
    break;
  default:
    return -1;
  }

  if (new_pos < 0 || new_pos > ctx->file_size)
    return -1;

  ctx->position = new_pos;
  return new_pos;
}

EMSCRIPTEN_KEEPALIVE
struct MoviThumbnailContext *movi_thumbnail_create(int file_size_low,
                                                   int file_size_high) {
  struct MoviThumbnailContext *ctx = (struct MoviThumbnailContext *)calloc(
      1, sizeof(struct MoviThumbnailContext));
  if (!ctx)
    return NULL;

  ctx->file_size = (int64_t)((uint32_t)file_size_low) +
                   (((int64_t)((uint32_t)file_size_high)) << 32);
  ctx->avio_buffer_size = 32768;
  ctx->video_stream_index = -1;
  ctx->pkt = av_packet_alloc();
  ctx->last_packet_size = 0;
  ctx->last_packet_pts = 0.0;

  return ctx;
}

EMSCRIPTEN_KEEPALIVE
int movi_thumbnail_open(struct MoviThumbnailContext *ctx) {
  if (!ctx || !ctx->pkt)
    return -1;

  ctx->avio_buffer = av_malloc(ctx->avio_buffer_size);
  if (!ctx->avio_buffer)
    return -2;

  ctx->avio_ctx =
      avio_alloc_context(ctx->avio_buffer, ctx->avio_buffer_size, 0, ctx,
                         thumbnail_avio_read, NULL, thumbnail_avio_seek);
  if (!ctx->avio_ctx) {
    av_free(ctx->avio_buffer);
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


  if (avformat_open_input(&ctx->fmt_ctx, NULL, NULL, NULL) < 0)
    return -5;
  if (avformat_find_stream_info(ctx->fmt_ctx, NULL) < 0)
    return -6;

  for (unsigned int i = 0; i < ctx->fmt_ctx->nb_streams; i++) {
    if (ctx->fmt_ctx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
      ctx->video_stream_index = i;
      break;
    }
  }

  if (ctx->video_stream_index < 0)
    return -7;

  // Initialize software decoder for fallback
  AVStream *st = ctx->fmt_ctx->streams[ctx->video_stream_index];
  const AVCodec *codec = avcodec_find_decoder(st->codecpar->codec_id);
  if (codec) {
      ctx->dec_ctx = avcodec_alloc_context3(codec);
      if (ctx->dec_ctx) {
          if (avcodec_parameters_to_context(ctx->dec_ctx, st->codecpar) >= 0) {
              ctx->dec_ctx->thread_count = 1; // Single thread for WASM
              if (avcodec_open2(ctx->dec_ctx, codec, NULL) < 0) {
                   av_log(NULL, AV_LOG_WARNING, "[THUMB] Failed to open software decoder\n");
                   avcodec_free_context(&ctx->dec_ctx);
              } else {
                  av_log(NULL, AV_LOG_DEBUG, "[THUMB] Software decoder initialized\n");
              }
          } else {
             avcodec_free_context(&ctx->dec_ctx);
          }
      }
  }
  
  ctx->frame = av_frame_alloc();
  ctx->rgb_frame = av_frame_alloc();

  return 0;
}

/**
 * Seek and read keyframe - uses callback pattern
 * Reads frames until we get close to target timestamp
 */
EMSCRIPTEN_KEEPALIVE
void movi_thumbnail_read_keyframe(struct MoviThumbnailContext *ctx,
                                  double timestamp) {
  av_log(NULL, AV_LOG_DEBUG, "[THUMB] readKeyframe called: ts=%.2f\n", timestamp);

  if (!ctx || !ctx->fmt_ctx || !ctx->pkt) {
    av_log(NULL, AV_LOG_ERROR, "[THUMB] ERROR: null context\n");
    js_thumbnail_packet_ready(-1, 0.0);
    return;
  }
  if (ctx->video_stream_index < 0) {
    av_log(NULL, AV_LOG_ERROR, "[THUMB] ERROR: video_stream_index=%d\n",
            ctx->video_stream_index);
    js_thumbnail_packet_ready(-2, 0.0);
    return;
  }

  AVStream *st = ctx->fmt_ctx->streams[ctx->video_stream_index];
  int64_t target_ts = (int64_t)(timestamp * (double)st->time_base.den /
                                (double)st->time_base.num);
  int64_t seek_target = (int64_t)(timestamp * AV_TIME_BASE);

  av_log(NULL, AV_LOG_DEBUG, "[THUMB] Seeking to ts=%lld (AV_TIME_BASE=%lld)\n", 
         (long long)target_ts, (long long)seek_target);

  // Flush AVIO buffer before seeking to ensure clean state
  if (ctx->avio_ctx) {
    avio_flush(ctx->avio_ctx);
  }

  // Use avformat_seek_file like the main player does - it's more robust
  int ret = avformat_seek_file(ctx->fmt_ctx, -1, INT64_MIN, seek_target,
                               seek_target, AVSEEK_FLAG_BACKWARD);
  
  if (ret < 0) {
    av_log(NULL, AV_LOG_WARNING, "[THUMB] avformat_seek_file failed, trying av_seek_frame\n");
    ret = av_seek_frame(ctx->fmt_ctx, ctx->video_stream_index, target_ts,
                        AVSEEK_FLAG_BACKWARD);
  }

  if (ret < 0) {
    av_log(NULL, AV_LOG_ERROR, "[THUMB] ERROR: seek failed\n");
    js_thumbnail_packet_ready(-3, 0.0);
    return;
  }

  // Flush after seek to clear internal buffers
  if (ctx->avio_ctx) {
    avio_flush(ctx->avio_ctx);
  }
  
  // Reset position from AVIO context
  if (ctx->fmt_ctx->pb) {
      int64_t current_pos = avio_tell(ctx->fmt_ctx->pb);
      ctx->position = current_pos;
  }

  av_log(NULL, AV_LOG_DEBUG,
          "[THUMB] Seek OK, reading packets to find closest keyframe...\n");

  // Allocate a packet to hold the best keyframe found
  AVPacket *best_pkt = av_packet_alloc();
  if (!best_pkt) {
      av_log(NULL, AV_LOG_ERROR, "[THUMB] ERROR: OOM for best_pkt\n");
      js_thumbnail_packet_ready(-4, 0.0);
      return;
  }

  // Increase search limit to ensure we find a keyframe
  int max_packets = 2000;
  int found_keyframe = 0;
  int64_t best_keyframe_dist = LLONG_MAX;

  while (max_packets-- > 0) {
    int ret = av_read_frame(ctx->fmt_ctx, ctx->pkt);

    if (ret < 0) {
      av_log(NULL, AV_LOG_DEBUG, "[THUMB] EOF/error ret=%d, halting search\n", ret);
      break; 
    }

    if (ctx->pkt->stream_index == ctx->video_stream_index) {
      // Check for keyframe
      if ((ctx->pkt->flags & AV_PKT_FLAG_KEY) && ctx->pkt->size > 0) {
        
        // Use PTS if available, otherwise DTS
        int64_t current_pts = (ctx->pkt->pts != AV_NOPTS_VALUE) ? ctx->pkt->pts : ctx->pkt->dts;
        
        if (current_pts != AV_NOPTS_VALUE) {
            int64_t dist_current = llabs(current_pts - target_ts);

            av_log(NULL, AV_LOG_DEBUG,
                    "[THUMB] Keyframe at pts=%lld (target=%lld, dist=%lld)\n",
                    (long long)current_pts, (long long)target_ts,
                    (long long)dist_current);

            // Is this closer then previous best?
            // Prioritize closer packets. 
            // Also, if we haven't found any yet, take this one.
            if (!found_keyframe || dist_current < best_keyframe_dist || 
               (dist_current == best_keyframe_dist && current_pts < target_ts)) { // Prefer earlier if equal?
               
              best_keyframe_dist = dist_current;
              found_keyframe = 1;
              
              // Save this packet as the best one so far
              av_packet_unref(best_pkt);
              av_packet_ref(best_pkt, ctx->pkt);
              
              av_log(NULL, AV_LOG_DEBUG, "[THUMB] New best candidate saved.\n");
            }

            // Stop if we passed the target significantly (e.g. > 1 sec)
            // But if we haven't found *any* keyframe before target, we might need to keep going?
            // Actually, if we passed target and we already have a keyframe, the one we have 
            // (which is closer or previous) is likely the one we want.
            // If we seek with BACKWARD flag, we expect to be before target.
            // So finding one after target means we crossed it.
            if (current_pts > target_ts) {
               // Verify: Is the current one (after target) closer than the previous one (before target)?
               // If so, we might keep current. If not, we keep previous.
               // Since we already updated 'best_pkt' if 'current' was closer (dist < best),
               // we can just stop now as going further forward won't help.
               av_log(NULL, AV_LOG_DEBUG, "[THUMB] Passed target, stopping search.\n");
               av_packet_unref(ctx->pkt); // Free the scan packet
               break; 
            }
        }
      }
    }

    av_packet_unref(ctx->pkt);
  }

  // Use the best packet we found
  if (found_keyframe) {
    // Move ref from best_pkt to ctx->pkt (where get_packet_data expects it)
    av_packet_unref(ctx->pkt);
    av_packet_move_ref(ctx->pkt, best_pkt);
    
    // Calculate timestamp for callback
    double pts = 0.0;
    if (ctx->pkt->pts != AV_NOPTS_VALUE)
        pts = ctx->pkt->pts * av_q2d(st->time_base);
    else if (ctx->pkt->dts != AV_NOPTS_VALUE)
        pts = ctx->pkt->dts * av_q2d(st->time_base);
        
    ctx->last_packet_size = ctx->pkt->size;
    ctx->last_packet_pts = pts;

    av_log(NULL, AV_LOG_DEBUG,
            "[THUMB] SUCCESS: returning keyframe size=%d, pts=%.2f\n",
            ctx->pkt->size, pts);
            
    js_thumbnail_packet_ready(ctx->pkt->size, pts);
  } else {
      av_log(NULL, AV_LOG_ERROR, "[THUMB] No valid keyframe found after search\n");
      js_thumbnail_packet_ready(-6, 0.0);
  }

  av_packet_free(&best_pkt);
}

EMSCRIPTEN_KEEPALIVE
uint8_t *movi_thumbnail_get_packet_data(struct MoviThumbnailContext *ctx) {
  return (ctx && ctx->pkt) ? ctx->pkt->data : NULL;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *movi_thumbnail_decode_frame(struct MoviThumbnailContext *ctx, int width, int height) {
    if (!ctx || !ctx->dec_ctx || !ctx->pkt || ctx->pkt->size == 0) return NULL;
    
    // Resize buffer if needed (RGBA = 4 bytes per pixel)
    // Use simple size calc 
    int num_bytes = width * height * 4;
    
    if (ctx->rgb_buffer_size < num_bytes) {
        av_free(ctx->rgb_buffer);
        ctx->rgb_buffer = av_malloc(num_bytes);
        ctx->rgb_buffer_size = num_bytes;
    }
    
    // CRITICAL: Flush decoder before sending new random-access packet
    // This ensures no previous state interferes and minimizes latency
    avcodec_flush_buffers(ctx->dec_ctx);
    
    // Decode
    int ret = avcodec_send_packet(ctx->dec_ctx, ctx->pkt);
    if (ret < 0) {
        av_log(NULL, AV_LOG_ERROR, "[THUMB] Decode send packet error: %d\n", ret);
        return NULL;
    }
    
    ret = avcodec_receive_frame(ctx->dec_ctx, ctx->frame);
    
    // If decoder needs more data (EAGAIN) but we only have one packet,
    // we must flush/drain to force it out (common with delay/threading)
    if (ret == AVERROR(EAGAIN)) {
         // Send NULL to enter draining mode
         avcodec_send_packet(ctx->dec_ctx, NULL);
         ret = avcodec_receive_frame(ctx->dec_ctx, ctx->frame);
    }
    
    if (ret < 0) {
         if (ret != AVERROR_EOF)
            av_log(NULL, AV_LOG_ERROR, "[THUMB] Decode receive frame error: %d\n", ret);
         return NULL;
    }
    
    // SwsContext
    ctx->sws_ctx = sws_getCachedContext(ctx->sws_ctx,
        ctx->frame->width, ctx->frame->height, ctx->frame->format,
        width, height, AV_PIX_FMT_RGBA,
        SWS_BILINEAR, NULL, NULL, NULL);
        
    if (!ctx->sws_ctx) return NULL;
    
    // Setup wrapper frame for buffer
    av_image_fill_arrays(ctx->rgb_frame->data, ctx->rgb_frame->linesize,
                         ctx->rgb_buffer, AV_PIX_FMT_RGBA, width, height, 1);
                         
    sws_scale(ctx->sws_ctx, (const uint8_t *const *)ctx->frame->data,
              ctx->frame->linesize, 0, ctx->frame->height,
              ctx->rgb_frame->data, ctx->rgb_frame->linesize);
              
    return ctx->rgb_buffer;
}

/**
 * Clear RGB buffer to free memory after thumbnail generation
 * Call this from JS after copying the thumbnail data
 */
EMSCRIPTEN_KEEPALIVE
void movi_thumbnail_clear_buffer(struct MoviThumbnailContext *ctx) {
  if (!ctx) return;

  if (ctx->rgb_buffer) {
    av_free(ctx->rgb_buffer);
    ctx->rgb_buffer = NULL;
    ctx->rgb_buffer_size = 0;
    av_log(NULL, AV_LOG_DEBUG, "[THUMB] RGB buffer cleared\n");
  }
}

EMSCRIPTEN_KEEPALIVE
void movi_thumbnail_destroy(struct MoviThumbnailContext *ctx) {
  if (!ctx)
    return;

  if (ctx->dec_ctx) avcodec_free_context(&ctx->dec_ctx);
  if (ctx->frame) av_frame_free(&ctx->frame);
  if (ctx->rgb_frame) av_frame_free(&ctx->rgb_frame);
  if (ctx->sws_ctx) sws_freeContext(ctx->sws_ctx);
  if (ctx->rgb_buffer) av_free(ctx->rgb_buffer);

  if (ctx->pkt)
    av_packet_free(&ctx->pkt);
  if (ctx->fmt_ctx)
    avformat_close_input(&ctx->fmt_ctx);
  if (ctx->avio_ctx) {
    av_freep(&ctx->avio_ctx->buffer);
    avio_context_free(&ctx->avio_ctx);
  }

  free(ctx);
}
