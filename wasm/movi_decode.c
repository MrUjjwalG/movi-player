#include "movi.h"
#include <libavutil/imgutils.h>

EMSCRIPTEN_KEEPALIVE
int movi_enable_decoder(MoviContext *ctx, int stream_index) {
  if (!ctx || !ctx->fmt_ctx || stream_index < 0 ||
      stream_index >= (int)ctx->fmt_ctx->nb_streams)
    return -1;
  if (ctx->decoders[stream_index])
    return 0;
  AVStream *stream = ctx->fmt_ctx->streams[stream_index];
  AVCodecParameters *codecpar = stream->codecpar;
  const AVCodec *codec = avcodec_find_decoder(codecpar->codec_id);
  if (!codec)
    return -2;
  AVCodecContext *c = avcodec_alloc_context3(codec);
  if (!c)
    return -3;
  if (avcodec_parameters_to_context(c, codecpar) < 0) {
    avcodec_free_context(&c);
    return -4;
  }
  // Set pkt_timebase from stream time_base (required for subtitle duration
  // handling) FFmpeg uses pkt_timebase to convert packet duration to
  // end_display_time
  c->pkt_timebase = stream->time_base;
  if (avcodec_open2(c, codec, NULL) < 0) {
    avcodec_free_context(&c);
    return -5;
  }
  ctx->decoders[stream_index] = c;
  return 0;
}

EMSCRIPTEN_KEEPALIVE
int movi_send_packet(MoviContext *ctx, int stream_index, uint8_t *data,
                     int size, double pts, double dts, int keyframe) {
  if (!ctx || !ctx->decoders || !ctx->decoders[stream_index])
    return -1;
  AVCodecContext *dec = ctx->decoders[stream_index];
  AVPacket *pkt = av_packet_alloc();
  if (!pkt)
    return -2;
  if (size > 0 && data) {
    if (av_new_packet(pkt, size) < 0) {
      av_packet_free(&pkt);
      return -3;
    }
    memcpy(pkt->data, data, size);
  } else {
    pkt->data = NULL;
    pkt->size = 0;
  }
  AVRational tb = ctx->fmt_ctx->streams[stream_index]->time_base;
  if (pts != 0)
    pkt->pts = (int64_t)(pts / av_q2d(tb));
  if (dts != 0)
    pkt->dts = (int64_t)(dts / av_q2d(tb));
  if (keyframe)
    pkt->flags |= AV_PKT_FLAG_KEY;
  int ret = avcodec_send_packet(dec, pkt);
  av_packet_free(&pkt);
  return ret;
}

EMSCRIPTEN_KEEPALIVE
void movi_set_skip_frame(MoviContext *ctx, int stream_index, int skip_val) {
  if (!ctx || stream_index < 0 || stream_index >= ctx->fmt_ctx->nb_streams)
    return;
  
  AVCodecContext *dec = ctx->decoders[stream_index];
  if (dec) {
    // strict compliance with AVDiscard enum values
    // 0: NONE, 1: NONREF, 2: BIDIR, 3: NONKEY, 4: ALL
    switch (skip_val) {
      case 1: dec->skip_frame = AVDISCARD_NONREF; break;
      case 2: dec->skip_frame = AVDISCARD_BIDIR; break;
      case 3: dec->skip_frame = AVDISCARD_NONKEY; break;
      case 4: dec->skip_frame = AVDISCARD_ALL; break;
      default: dec->skip_frame = AVDISCARD_DEFAULT; break;
    }
  }
}

EMSCRIPTEN_KEEPALIVE
int movi_receive_frame(MoviContext *ctx, int stream_index) {
  if (!ctx || !ctx->frame)
    return -1;
  if (stream_index < 0 || stream_index >= ctx->fmt_ctx->nb_streams)
    return -1;
  AVCodecContext *dec = ctx->decoders[stream_index];
  if (!dec)
    return -1;

  int ret = avcodec_receive_frame(dec, ctx->frame);
  if (ret != 0)
    return ret;

  // Handle audio resampling/downmixing
  // Handle audio resampling/downmixing
  if (dec->codec_type == AVMEDIA_TYPE_AUDIO) {
    int target_channels = ctx->frame->ch_layout.nb_channels;

    // Only downmix if flag is set AND we have more than stereo
    if (ctx->downmix_to_stereo && target_channels > 2) {
      target_channels = 2;
    }

    int needs_resample = (ctx->frame->format != AV_SAMPLE_FMT_FLTP) ||
                         (ctx->frame->ch_layout.nb_channels != target_channels);

    if (needs_resample) {
      SwrContext **swr_p = &ctx->resamplers[stream_index];

      if (!*swr_p) {
        // Calculate output layout
        AVChannelLayout out_layout;
        memset(&out_layout, 0, sizeof(AVChannelLayout));

        if (target_channels == 2 && ctx->frame->ch_layout.nb_channels > 2) {
          av_channel_layout_default(&out_layout, 2);
        } else {
          av_channel_layout_copy(&out_layout, &ctx->frame->ch_layout);
        }

        // Input layout logic
        AVChannelLayout in_layout = ctx->frame->ch_layout;
        // Fix for potentially unspecified layouts in source
        if (in_layout.nb_channels == 6) {
          av_channel_layout_from_mask(&in_layout, AV_CH_LAYOUT_5POINT1);
        } else if (in_layout.nb_channels == 8) {
          av_channel_layout_from_mask(&in_layout, AV_CH_LAYOUT_7POINT1);
        } else if (in_layout.order == AV_CHANNEL_ORDER_UNSPEC) {
          av_channel_layout_default(&in_layout, in_layout.nb_channels);
        }

        int r = swr_alloc_set_opts2(swr_p, &out_layout, AV_SAMPLE_FMT_FLTP,
                                    ctx->frame->sample_rate, &in_layout,
                                    (enum AVSampleFormat)ctx->frame->format,
                                    ctx->frame->sample_rate, 0, NULL);

        av_channel_layout_uninit(&out_layout);

        if (r < 0 || !*swr_p) {
          av_log(NULL, AV_LOG_ERROR, "[MOVI-WASM] swr_alloc failed: %d\n", r);
        } else {
          if (swr_init(*swr_p) < 0) {
            av_log(NULL, AV_LOG_ERROR, "[MOVI-WASM] swr_init failed\n");
            swr_free(swr_p);
          }
        }
      }

      if (*swr_p) {
        int max_out_samples =
            swr_get_out_samples(*swr_p, ctx->frame->nb_samples);

        av_frame_unref(ctx->resampled_frame);
        ctx->resampled_frame->nb_samples = max_out_samples;
        ctx->resampled_frame->format = AV_SAMPLE_FMT_FLTP;
        ctx->resampled_frame->sample_rate = ctx->frame->sample_rate;

        if (target_channels == 2 && ctx->frame->ch_layout.nb_channels > 2) {
          av_channel_layout_default(&ctx->resampled_frame->ch_layout, 2);
        } else {
          av_channel_layout_copy(&ctx->resampled_frame->ch_layout,
                                 &ctx->frame->ch_layout);
        }

        if (av_frame_get_buffer(ctx->resampled_frame, 0) < 0) {
          av_log(NULL, AV_LOG_ERROR, "[MOVI-WASM] Failed to allocate resample buffer\n");
          return -1;
        }

        int ret = swr_convert(*swr_p, ctx->resampled_frame->extended_data,
                              max_out_samples,
                              (const uint8_t **)ctx->frame->extended_data,
                              ctx->frame->nb_samples);

        if (ret >= 0) {
          ctx->resampled_frame->nb_samples = ret;
          ctx->resampled_frame->pts = ctx->frame->pts;
          ctx->resampled_frame->pkt_dts = ctx->frame->pkt_dts;

          AVFrame *tmp = ctx->frame;
          ctx->frame = ctx->resampled_frame;
          ctx->resampled_frame = tmp;
        } else {
          av_log(NULL, AV_LOG_ERROR, "[MOVI-WASM] swr_convert error: %d\n", ret);
        }
      }
    }
  }

  return 0;
}

/**
 * Get decoded video frame as RGBA buffer (converts any format including 10-bit HDR)
 * Returns pointer to RGBA buffer, or NULL on error
 */
EMSCRIPTEN_KEEPALIVE
uint8_t* movi_get_frame_rgba(MoviContext *ctx, int target_width, int target_height) {
  if (!ctx || !ctx->frame) return NULL;
  
  // For audio frames, return NULL
  if (ctx->frame->width == 0 || ctx->frame->height == 0) return NULL;
  
  int src_width = ctx->frame->width;
  int src_height = ctx->frame->height;
  
  // Use original size if target is 0
  if (target_width <= 0) target_width = src_width;
  if (target_height <= 0) target_height = src_height;
  
  // Calculate required buffer size
  int buffer_size = av_image_get_buffer_size(AV_PIX_FMT_RGBA, target_width, target_height, 1);
  
  // Allocate or reallocate RGB buffer if needed
  if (!ctx->rgb_buffer || ctx->rgb_buffer_size < buffer_size) {
    if (ctx->rgb_buffer) {
      av_free(ctx->rgb_buffer);
    }
    ctx->rgb_buffer = av_malloc(buffer_size);
    ctx->rgb_buffer_size = buffer_size;
    if (!ctx->rgb_buffer) {
      av_log(NULL, AV_LOG_ERROR, "[MOVI-WASM] Failed to allocate RGB buffer\n");
      return NULL;
    }
  }
  
  // Allocate rgb_frame if needed
  if (!ctx->rgb_frame) {
    ctx->rgb_frame = av_frame_alloc();
    if (!ctx->rgb_frame) {
      av_log(NULL, AV_LOG_ERROR, "[MOVI-WASM] Failed to allocate RGB frame\n");
      return NULL;
    }
  }
  
  // Create or update sws context
  ctx->sws_ctx = sws_getCachedContext(ctx->sws_ctx,
      src_width, src_height, ctx->frame->format,
      target_width, target_height, AV_PIX_FMT_RGBA,
      SWS_FAST_BILINEAR, NULL, NULL, NULL);
  
  if (!ctx->sws_ctx) {
    av_log(NULL, AV_LOG_ERROR, "[MOVI-WASM] Failed to create SwsContext for format %d\n", ctx->frame->format);
    return NULL;
  }
  
  // Setup rgb_frame to point to rgb_buffer
  av_image_fill_arrays(ctx->rgb_frame->data, ctx->rgb_frame->linesize,
                       ctx->rgb_buffer, AV_PIX_FMT_RGBA, target_width, target_height, 1);
  
  // Convert to RGBA
  sws_scale(ctx->sws_ctx, (const uint8_t *const *)ctx->frame->data,
            ctx->frame->linesize, 0, src_height,
            ctx->rgb_frame->data, ctx->rgb_frame->linesize);
  
  return ctx->rgb_buffer;
}

/**
 * Get RGBA buffer size for current frame
 */
EMSCRIPTEN_KEEPALIVE
int movi_get_frame_rgba_size(MoviContext *ctx) {
  return ctx ? ctx->rgb_buffer_size : 0;
}

/**
 * Get RGBA buffer linesize
 */
EMSCRIPTEN_KEEPALIVE
int movi_get_frame_rgba_linesize(MoviContext *ctx) {
  if (!ctx || !ctx->rgb_frame) return 0;
  return ctx->rgb_frame->linesize[0];
}

EMSCRIPTEN_KEEPALIVE
int movi_decode_subtitle(MoviContext *ctx, int stream_index, uint8_t *data,
                         int size, double pts, double duration) {
  if (!ctx || stream_index < 0 || stream_index >= ctx->fmt_ctx->nb_streams)
    return -1;
  AVCodecContext *dec = ctx->decoders[stream_index];
  if (!dec || dec->codec_type != AVMEDIA_TYPE_SUBTITLE)
    return -1;

  // Free previous subtitle if exists
  if (ctx->subtitle) {
    avsubtitle_free(ctx->subtitle);
    av_freep(&ctx->subtitle);
  }

  // Allocate subtitle structure
  ctx->subtitle = av_malloc(sizeof(AVSubtitle));
  if (!ctx->subtitle)
    return -2;
  memset(ctx->subtitle, 0, sizeof(AVSubtitle));

  // Create packet
  AVPacket *pkt = av_packet_alloc();
  if (!pkt) {
    av_freep(&ctx->subtitle);
    return -3;
  }

  if (size > 0 && data) {
    if (av_new_packet(pkt, size) < 0) {
      av_packet_free(&pkt);
      av_freep(&ctx->subtitle);
      return -4;
    }
    memcpy(pkt->data, data, size);
  } else {
    pkt->data = NULL;
    pkt->size = 0;
  }

  // Set packet PTS and DTS
  // pts is in seconds, convert to stream timebase
  AVRational tb = ctx->fmt_ctx->streams[stream_index]->time_base;
  int64_t packet_pts = AV_NOPTS_VALUE;
  if (pts != 0) {
    // Convert from seconds to stream timebase
    packet_pts = (int64_t)(pts / av_q2d(tb));
    pkt->pts = packet_pts;
    pkt->dts = packet_pts;
  } else {
    pkt->pts = AV_NOPTS_VALUE;
    pkt->dts = AV_NOPTS_VALUE;
  }

  // Set packet duration if provided (from demuxer, e.g., SRT file timestamps)
  // This is critical for FFmpeg to automatically set end_display_time
  // Also store it in context for fallback if FFmpeg doesn't set
  // end_display_time
  if (duration > 0) {
    // Convert from seconds to stream timebase
    pkt->duration = (int64_t)(duration / av_q2d(tb));
    ctx->last_subtitle_packet_duration =
        duration; // Store in seconds for fallback
  } else {
    pkt->duration = 0; // Set to 0 instead of AV_NOPTS_VALUE for subtitles
    ctx->last_subtitle_packet_duration = 0;
  }

  pkt->stream_index = stream_index;

  int got_subtitle = 0;
  int ret = avcodec_decode_subtitle2(dec, ctx->subtitle, &got_subtitle, pkt);

  // After decoding, ensure subtitle pts is set correctly
  // For SubRip subtitles, the packet timestamp is the actual subtitle start
  // time Note: FFmpeg's avcodec_decode_subtitle2 automatically uses packet
  // duration to set end_display_time if codec doesn't set it (see
  // decode.c:1009-1014) So we just need to ensure packet duration is set (which
  // we do above)
  if (got_subtitle && ctx->subtitle) {
    // For SubRip, prefer using the input timestamp (packet timestamp) directly
    // This ensures the subtitle times match the video playback time
    if (pts != 0) {
      // Convert from seconds to AV_TIME_BASE (microseconds)
      ctx->subtitle->pts = (int64_t)(pts * AV_TIME_BASE);
    } else if (ctx->subtitle->pts == AV_NOPTS_VALUE &&
               packet_pts != AV_NOPTS_VALUE) {
      // Fallback: Convert packet PTS from stream timebase to AV_TIME_BASE
      ctx->subtitle->pts =
          av_rescale_q(packet_pts, tb, (AVRational){1, AV_TIME_BASE});
    }
    // end_display_time is automatically set by FFmpeg from packet duration
  }

  av_packet_free(&pkt);

  if (ret < 0) {
    avsubtitle_free(ctx->subtitle);
    av_freep(&ctx->subtitle);
    return ret;
  }

  return got_subtitle ? 0 : AVERROR(EAGAIN);
}

EMSCRIPTEN_KEEPALIVE
int movi_get_subtitle_text(MoviContext *ctx, char *buffer, int buffer_size) {
  if (!ctx || !ctx->subtitle || !buffer || buffer_size <= 0)
    return -1;

  AVSubtitle *sub = ctx->subtitle;
  int total_len = 0;

  // Check if we have any rectangles
  if (sub->num_rects == 0) {
    return 0; // No subtitle rectangles
  }

  // Concatenate text from all rectangles
  for (unsigned i = 0; i < sub->num_rects && total_len < buffer_size - 1; i++) {
    AVSubtitleRect *rect = sub->rects[i];
    if (!rect)
      continue;

    // Debug: log rect type
    // Note: We can't easily log from C in WASM, but we can ensure we handle all
    // cases

    // Handle SUBTITLE_TEXT type (plain text)
    if (rect->type == SUBTITLE_TEXT && rect->text) {
      int len = strlen(rect->text);
      if (total_len + len + 1 < buffer_size) {
        if (total_len > 0) {
          buffer[total_len++] = '\n';
        }
        strncpy(buffer + total_len, rect->text, buffer_size - total_len - 1);
        total_len += len;
      }
    }
    // Handle SUBTITLE_ASS type (ASS/SSA format - used by SubRip/SRT)
    else if (rect->type == SUBTITLE_ASS && rect->ass) {
      const char *ass = rect->ass;
      const char *text_start = NULL;

      // Look for Dialogue: line
      const char *dialogue = strstr(ass, "Dialogue:");
      if (dialogue) {
        // Find the 9th comma (text starts after that)
        // ASS format: Dialogue: Layer, Start, End, Style, Name, MarginL,
        // MarginR, MarginV, Effect, Text
        text_start = dialogue;
        int comma_count = 0;
        while (*text_start && comma_count < 9) {
          if (*text_start == ',')
            comma_count++;
          text_start++;
        }
        // Skip the comma itself if we're on it
        if (*text_start == ',')
          text_start++;
        // Skip any leading whitespace
        while (*text_start == ' ' || *text_start == '\t')
          text_start++;
      } else {
        // No "Dialogue:" prefix - this is a raw ASS event line
        // Format from ff_ass_get_dialog:
        // readorder,layer,style,speaker,0,0,0,,text This has 8 commas before
        // the text (readorder, layer, style, speaker, MarginL, MarginR,
        // MarginV, Effect) But ff_ass_add_rect might also use full Dialogue
        // format, so we need to handle both
        text_start = ass;
        int comma_count = 0;
        // Count commas - need to find where text starts
        // For ff_ass_get_dialog format: 8 commas before text
        // For full Dialogue format: 9 commas before text
        // Try 8 first (most common for SubRip)
        while (*text_start && comma_count < 8) {
          if (*text_start == ',')
            comma_count++;
          text_start++;
        }
        // Skip the comma itself if we're on it
        if (*text_start == ',')
          text_start++;
        // Skip any leading whitespace
        while (*text_start == ' ' || *text_start == '\t')
          text_start++;

        // If we didn't find meaningful text after 8 commas, try 9 (full
        // Dialogue format)
        if (!text_start || !*text_start ||
            (*text_start == '\0' || *text_start == '\r' ||
             *text_start == '\n')) {
          text_start = ass;
          comma_count = 0;
          while (*text_start && comma_count < 9) {
            if (*text_start == ',')
              comma_count++;
            text_start++;
          }
          if (*text_start == ',')
            text_start++;
          while (*text_start == ' ' || *text_start == '\t')
            text_start++;
        }
      }

      // If we found the text start, clean it
      if (text_start && *text_start) {
        // Convert ASS tags to HTML and preserve HTML tags
        const char *clean_text = text_start;
        int len = 0;
        int in_ass_tag = 0;
        int brace_depth = 0;
        const char *tag_start = NULL;

        while (*clean_text && len < buffer_size - total_len - 1) {
          if (*clean_text == '{') {
            if (!in_ass_tag) {
              tag_start = clean_text;
            }
            in_ass_tag = 1;
            brace_depth++;
          } else if (*clean_text == '}') {
            brace_depth--;
            if (brace_depth == 0) {
              // Process ASS tag and convert to HTML
              if (tag_start) {
                int tag_len = (clean_text - tag_start) + 1;
                char ass_tag[256];
                if (tag_len < sizeof(ass_tag)) {
                  strncpy(ass_tag, tag_start, tag_len);
                  ass_tag[tag_len] = '\0';

                  // Convert common ASS tags to HTML
                  if (strstr(ass_tag, "\\i1") || strstr(ass_tag, "\\i")) {
                    if (len + 3 < buffer_size - total_len - 1) {
                      buffer[total_len + len++] = '<';
                      buffer[total_len + len++] = 'i';
                      buffer[total_len + len++] = '>';
                    }
                  } else if (strstr(ass_tag, "\\i0")) {
                    if (len + 4 < buffer_size - total_len - 1) {
                      buffer[total_len + len++] = '<';
                      buffer[total_len + len++] = '/';
                      buffer[total_len + len++] = 'i';
                      buffer[total_len + len++] = '>';
                    }
                  } else if (strstr(ass_tag, "\\b1") ||
                             strstr(ass_tag, "\\b")) {
                    if (len + 3 < buffer_size - total_len - 1) {
                      buffer[total_len + len++] = '<';
                      buffer[total_len + len++] = 'b';
                      buffer[total_len + len++] = '>';
                    }
                  } else if (strstr(ass_tag, "\\b0")) {
                    if (len + 4 < buffer_size - total_len - 1) {
                      buffer[total_len + len++] = '<';
                      buffer[total_len + len++] = '/';
                      buffer[total_len + len++] = 'b';
                      buffer[total_len + len++] = '>';
                    }
                  } else if (strstr(ass_tag, "\\u1") ||
                             strstr(ass_tag, "\\u")) {
                    if (len + 3 < buffer_size - total_len - 1) {
                      buffer[total_len + len++] = '<';
                      buffer[total_len + len++] = 'u';
                      buffer[total_len + len++] = '>';
                    }
                  } else if (strstr(ass_tag, "\\u0")) {
                    if (len + 4 < buffer_size - total_len - 1) {
                      buffer[total_len + len++] = '<';
                      buffer[total_len + len++] = '/';
                      buffer[total_len + len++] = 'u';
                      buffer[total_len + len++] = '>';
                    }
                  }
                  // Ignore other ASS tags (colors, positioning, etc.)
                }
              }
              in_ass_tag = 0;
              tag_start = NULL;
            }
          } else if (!in_ass_tag) {
            // Preserve HTML tags and regular text
            // Handle \N (newline) and \n
            if (*clean_text == '\\' &&
                (clean_text[1] == 'N' || clean_text[1] == 'n')) {
              if (total_len > 0 || len > 0) {
                buffer[total_len + len++] = '\n';
              }
              clean_text++; // skip the N/n
            } else {
              buffer[total_len + len++] = *clean_text;
            }
          }
          clean_text++;
        }

        // Only add if we extracted meaningful text (not just whitespace)
        if (len > 0) {
          // Check if the extracted text is not just whitespace
          int has_content = 0;
          for (int j = 0; j < len; j++) {
            if (buffer[total_len + j] != ' ' && buffer[total_len + j] != '\t' &&
                buffer[total_len + j] != '\n') {
              has_content = 1;
              break;
            }
          }

          if (has_content) {
            if (total_len > 0) {
              buffer[total_len++] = '\n';
            }
            total_len += len;
          }
        }
      }
    }
    // Handle SUBTITLE_BITMAP type (image subtitles) - not supported for text
    // extraction
    else if (rect->type == SUBTITLE_BITMAP) {
      // Bitmap subtitles - can't extract text
      // This would need image rendering support
    }
  }

  buffer[total_len] = '\0';
  return total_len;
}

EMSCRIPTEN_KEEPALIVE
int movi_get_subtitle_times(MoviContext *ctx, double *start, double *end) {
  if (!ctx || !ctx->subtitle || !start || !end)
    return -1;

  AVSubtitle *sub = ctx->subtitle;

  // Check if pts is valid (not AV_NOPTS_VALUE)
  // AV_NOPTS_VALUE is INT64_MIN = -9223372036854775808
  if (sub->pts == AV_NOPTS_VALUE || sub->pts < 0) {
    // If pts is invalid, try to use start_display_time and end_display_time
    // directly These are in milliseconds relative to the packet PTS For now,
    // return 0 for both if pts is invalid
    *start = 0.0;
    *end = 0.0;
    return -1; // Indicate error
  }

  // Convert from AV_TIME_BASE (microseconds) to seconds
  // pts is in AV_TIME_BASE units (1/1000000 seconds)
  double pts_seconds = sub->pts / (double)AV_TIME_BASE;

  // start_display_time and end_display_time are in milliseconds relative to pts
  *start = pts_seconds + sub->start_display_time / 1000.0;
  double end_time = pts_seconds + sub->end_display_time / 1000.0;

  // For PGS/image subtitles, FFmpeg may set end_display_time to a very large
  // value or incorrectly. Check for unreasonable values (more than 1 hour is
  // clearly wrong)
  const double MAX_REASONABLE_DURATION = 3600.0; // 1 hour max

  // FFmpeg automatically sets end_display_time from packet duration if codec
  // doesn't set it (see decode.c:1009-1014). However, sometimes
  // end_display_time is still 0 or invalid even when packet duration is
  // provided. This is a known FFmpeg issue with some codecs. Use fallback: if
  // end_display_time is 0, invalid, or unreasonably large, use packet duration
  // directly
  if (end_time <= *start || (end_time - *start) > MAX_REASONABLE_DURATION) {
    // FFmpeg didn't set end_display_time correctly - use packet duration as
    // fallback
    if (ctx->last_subtitle_packet_duration > 0) {
      // Use stored packet duration (in seconds) - this comes from SRT file
      // timestamps
      end_time = *start + ctx->last_subtitle_packet_duration;
    } else {
      // No packet duration available from FFmpeg - calculate reasonable default
      // For SRT files, FFmpeg should extract duration from timestamp line, but
      // sometimes doesn't Use a minimum duration based on typical subtitle
      // display time Short subtitles (1-2 words) need at least 1.5s, longer
      // ones need more
      double default_duration = 2.0; // Default 2 seconds for unknown duration

      // Try to estimate from subtitle text length if available
      if (sub->num_rects > 0 && sub->rects[0] && sub->rects[0]->text) {
        int text_len = strlen(sub->rects[0]->text);
        // Rough estimate: ~0.1s per character, minimum 1.5s, maximum 5s
        double estimated = text_len * 0.1;
        if (estimated < 1.5)
          estimated = 1.5;
        if (estimated > 5.0)
          estimated = 5.0;
        default_duration = estimated;
      }

      end_time = *start + default_duration;
    }

    // Ensure reasonable bounds (minimum 0.8s, maximum 10s)
    // Some quick dialogues in SRT files are legitimately short (0.8-1.0s)
    if (end_time - *start < 0.8) {
      end_time = *start + 0.8; // Minimum 0.8 seconds for very quick subtitles
    }
    if (end_time - *start > 10.0) {
      end_time = *start + 10.0; // Maximum 10 seconds
    }
  } else {
    // FFmpeg set end_display_time correctly, but ensure reasonable bounds
    // Check for unreasonably large values (likely a bug in FFmpeg for PGS
    // subtitles)
    if ((end_time - *start) > MAX_REASONABLE_DURATION) {
      // Use packet duration as fallback if available
      if (ctx->last_subtitle_packet_duration > 0) {
        end_time = *start + ctx->last_subtitle_packet_duration;
      } else {
        // Use default duration for image subtitles
        end_time = *start + 3.0; // Default 3 seconds for PGS subtitles
      }
    }

    // Ensure minimum duration
    // Some codecs set very short durations (<0.5s) which causes quick
    // disappearance However, respect FFmpeg's calculation if it's reasonable
    // (>= 0.3s)
    if (end_time - *start < 0.3) {
      end_time = *start + 0.3; // Minimum 0.3 seconds (very short but visible)
    }

    // Cap maximum duration to prevent unreasonably long subtitles
    if (end_time - *start > 10.0) {
      end_time = *start + 10.0; // Maximum 10 seconds
    }
  }

  *end = end_time;

  return 0;
}

EMSCRIPTEN_KEEPALIVE
int movi_get_subtitle_image_info(MoviContext *ctx, int *width, int *height,
                                 int *x, int *y) {
  if (!ctx || !ctx->subtitle || !width || !height || !x || !y)
    return -1;

  AVSubtitle *sub = ctx->subtitle;

  // Find first bitmap rectangle
  for (unsigned i = 0; i < sub->num_rects; i++) {
    AVSubtitleRect *rect = sub->rects[i];
    if (!rect)
      continue;

    if (rect->type == SUBTITLE_BITMAP && rect->data[0] && rect->w > 0 &&
        rect->h > 0) {
      *width = rect->w;
      *height = rect->h;
      *x = rect->x;
      *y = rect->y;
      return 0; // Success
    }
  }

  return -1; // No bitmap found
}

EMSCRIPTEN_KEEPALIVE
int movi_get_subtitle_image_data(MoviContext *ctx, uint8_t *buffer,
                                 int buffer_size) {
  if (!ctx || !ctx->subtitle || !buffer || buffer_size <= 0)
    return -1;

  AVSubtitle *sub = ctx->subtitle;

  // Find first bitmap rectangle
  AVSubtitleRect *bitmap_rect = NULL;
  for (unsigned i = 0; i < sub->num_rects; i++) {
    AVSubtitleRect *rect = sub->rects[i];
    if (!rect)
      continue;

    if (rect->type == SUBTITLE_BITMAP && rect->data[0] && rect->w > 0 &&
        rect->h > 0) {
      bitmap_rect = rect;
      break;
    }
  }

  if (!bitmap_rect) {
    return -1; // No bitmap found
  }

  // PGS subtitles use palette-based format (8-bit indexed color)
  // We need to convert to RGBA
  // Format: data[0] = Y plane, data[1] = palette (256 colors, each 4 bytes
  // BGRA)
  int width = bitmap_rect->w;
  int height = bitmap_rect->h;
  int required_size = width * height * 4; // RGBA = 4 bytes per pixel

  if (buffer_size < required_size) {
    return -2; // Buffer too small
  }

  // Get palette (data[1]) - 256 colors, each 4 bytes (BGRA)
  uint8_t *palette = bitmap_rect->data[1];
  if (!palette) {
    return -3; // No palette
  }

  // Get indexed image data (data[0])
  uint8_t *indexed_data = bitmap_rect->data[0];
  int linesize = bitmap_rect->linesize[0];

  if (!indexed_data) {
    return -4; // No image data
  }

  // Convert indexed color to RGBA
  // FFmpeg PGS decoder provides palette in BGRA format, we need RGBA
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      int src_idx = y * linesize + x;
      int color_index = indexed_data[src_idx];

      // Get color from palette (BGRA format)
      int palette_offset = color_index * 4;
      uint8_t b = palette[palette_offset + 0];
      uint8_t g = palette[palette_offset + 1];
      uint8_t r = palette[palette_offset + 2];
      uint8_t a = palette[palette_offset + 3];

      // Write RGBA to output buffer
      int dst_idx = (y * width + x) * 4;
      buffer[dst_idx + 0] = r; // Red
      buffer[dst_idx + 1] = g; // Green
      buffer[dst_idx + 2] = b; // Blue
      buffer[dst_idx + 3] = a; // Alpha
    }
  }

  return required_size; // Return number of bytes written
}

EMSCRIPTEN_KEEPALIVE
void movi_free_subtitle(MoviContext *ctx) {
  if (ctx && ctx->subtitle) {
    avsubtitle_free(ctx->subtitle);
    av_freep(&ctx->subtitle);
  }
}
