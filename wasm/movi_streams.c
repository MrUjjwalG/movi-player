#include "movi.h"

EMSCRIPTEN_KEEPALIVE
double movi_get_duration(MoviContext *ctx) {
  if (!ctx || !ctx->fmt_ctx)
    return 0.0;
  if (ctx->fmt_ctx->duration != AV_NOPTS_VALUE)
    return (double)ctx->fmt_ctx->duration / AV_TIME_BASE;
  return 0.0;
}

EMSCRIPTEN_KEEPALIVE
double movi_get_start_time(MoviContext *ctx) {
  if (!ctx || !ctx->fmt_ctx)
    return 0.0;
  if (ctx->fmt_ctx->start_time != AV_NOPTS_VALUE) {
    return (double)ctx->fmt_ctx->start_time / AV_TIME_BASE;
  }
  return 0.0;
}

EMSCRIPTEN_KEEPALIVE
int movi_get_stream_count(MoviContext *ctx) {
  return (ctx && ctx->fmt_ctx) ? ctx->fmt_ctx->nb_streams : 0;
}

EMSCRIPTEN_KEEPALIVE
int movi_get_stream_info(MoviContext *ctx, int stream_index, StreamInfo *info) {
  if (!ctx || !ctx->fmt_ctx || !info || stream_index < 0 ||
      stream_index >= (int)ctx->fmt_ctx->nb_streams)
    return -1;
  AVStream *stream = ctx->fmt_ctx->streams[stream_index];
  AVCodecParameters *codecpar = stream->codecpar;
  memset(info, 0, sizeof(StreamInfo));
  info->index = stream_index;
  info->codec_id = codecpar->codec_id;
  info->profile = codecpar->profile;
  info->level = codecpar->level;
  const AVCodecDescriptor *desc = avcodec_descriptor_get(codecpar->codec_id);
  if (desc && desc->name)
    strncpy(info->codec_name, desc->name, sizeof(info->codec_name) - 1);
  switch (codecpar->codec_type) {
  case AVMEDIA_TYPE_VIDEO:
    info->type = STREAM_TYPE_VIDEO;
    info->width = codecpar->width;
    info->height = codecpar->height;
    if (stream->avg_frame_rate.den > 0)
      info->frame_rate = av_q2d(stream->avg_frame_rate);
    
    // Color Metadata for HDR
    const char *prim = av_color_primaries_name(codecpar->color_primaries);
    if (prim) strncpy(info->color_primaries, prim, sizeof(info->color_primaries) - 1);
    
    const char *trc = av_color_transfer_name(codecpar->color_trc);
    if (trc) strncpy(info->color_transfer, trc, sizeof(info->color_transfer) - 1);
    
    const char *mtx = av_color_space_name(codecpar->color_space);
    if (mtx) strncpy(info->color_matrix, mtx, sizeof(info->color_matrix) - 1);
    
    // Pixel Format
    const char *pix = av_get_pix_fmt_name((enum AVPixelFormat)codecpar->format);
    if (pix) strncpy(info->pixel_format, pix, sizeof(info->pixel_format) - 1);

    // Color Range
    const char *range = av_color_range_name(codecpar->color_range);
    if (range) strncpy(info->color_range, range, sizeof(info->color_range) - 1);
    break;
  case AVMEDIA_TYPE_AUDIO:
    info->type = STREAM_TYPE_AUDIO;
    info->channels = codecpar->ch_layout.nb_channels;
    info->sample_rate = codecpar->sample_rate;
    break;
  case AVMEDIA_TYPE_SUBTITLE:
    info->type = STREAM_TYPE_SUBTITLE;
    break;
  default:
    info->type = STREAM_TYPE_UNKNOWN;
  }
  info->bit_rate = codecpar->bit_rate;
  info->extradata_size = codecpar->extradata_size;
  if (stream->duration != AV_NOPTS_VALUE)
    info->duration = stream->duration * av_q2d(stream->time_base);
  else if (ctx->fmt_ctx->duration != AV_NOPTS_VALUE)
    info->duration = (double)ctx->fmt_ctx->duration / AV_TIME_BASE;

  // Extract language from metadata
  AVDictionaryEntry *lang_tag =
      av_dict_get(stream->metadata, "language", NULL, 0);
  if (lang_tag && lang_tag->value) {
    strncpy(info->language, lang_tag->value, sizeof(info->language) - 1);
    info->language[sizeof(info->language) - 1] = '\0';
  } else {
    info->language[0] = '\0';
  }

  // Extract label from metadata (try "title" first, then "handler_name")
  AVDictionaryEntry *label_tag =
      av_dict_get(stream->metadata, "title", NULL, 0);
  if (!label_tag || !label_tag->value) {
    label_tag = av_dict_get(stream->metadata, "handler_name", NULL, 0);
  }
  if (label_tag && label_tag->value) {
    strncpy(info->label, label_tag->value, sizeof(info->label) - 1);
    info->label[sizeof(info->label) - 1] = '\0';
  } else {
    info->label[0] = '\0';
  }

  // Extract rotation from display matrix side data
  // Use av_packet_side_data_get to iterate stream side data
  int32_t *display_matrix = NULL;
  
  const AVPacketSideData *sd = av_packet_side_data_get(codecpar->coded_side_data, codecpar->nb_coded_side_data, AV_PKT_DATA_DISPLAYMATRIX);
  if (sd && sd->size >= 9 * 4) {
      display_matrix = (int32_t *)sd->data;
  }
  
  if (display_matrix) {
      double rotation = -av_display_rotation_get(display_matrix);
      // Normalize rotation (e.g. -90 becomes 270)
      if (rotation < 0) rotation += 360;
      info->rotation = (int)round(rotation) % 360;
  } else {
      info->rotation = 0;
  }

  return 0;
}

EMSCRIPTEN_KEEPALIVE
int movi_get_extradata(MoviContext *ctx, int stream_index, uint8_t *buffer,
                       int buffer_size) {
  if (!ctx || !ctx->fmt_ctx || !buffer || stream_index < 0 ||
      stream_index >= (int)ctx->fmt_ctx->nb_streams)
    return -1;
  AVCodecParameters *codecpar = ctx->fmt_ctx->streams[stream_index]->codecpar;
  if (!codecpar->extradata || codecpar->extradata_size <= 0)
    return 0;
  int copy_size = codecpar->extradata_size;
  if (copy_size > buffer_size)
    copy_size = buffer_size;
  memcpy(buffer, codecpar->extradata, copy_size);
  return copy_size;
}

EMSCRIPTEN_KEEPALIVE
int movi_seek_to(MoviContext *ctx, double timestamp, int stream_index,
                 int flags) {
  if (!ctx || !ctx->fmt_ctx)
    return -1;

  // Flush AVIO buffer before seeking to ensure clean state
  // This is critical for large files (>= 2GB) to prevent sequential reads
  // Without flushing, FFmpeg might read from cached buffer instead of seeking
  if (ctx->avio_ctx) {
    avio_flush(ctx->avio_ctx);
  }

  // Ensure we seek to keyframe (BACKWARD flag) to avoid decoder errors
  // This is especially important for Matroska/WebM formats
  int seek_flags = flags;
  if (!(seek_flags & AVSEEK_FLAG_ANY)) {
    // If not explicitly requesting ANY frame, ensure we seek to keyframe
    seek_flags |= AVSEEK_FLAG_BACKWARD;
  }

  int64_t seek_target = (int64_t)(timestamp * AV_TIME_BASE);
  // Use INT64_MAX for max_ts to allow FFmpeg to find the nearest keyframe
  // The BACKWARD flag ensures we prefer positions at or before seek_target
  // Using seek_target as max_ts was too restrictive and caused seeks to fail
  // or jump to EOF when no keyframe exactly matched the target position
  int ret = avformat_seek_file(ctx->fmt_ctx, -1, INT64_MIN, seek_target,
                               INT64_MAX, seek_flags);
  if (ret < 0) {
    // Fallback to av_seek_frame if avformat_seek_file fails
    ret = av_seek_frame(ctx->fmt_ctx, -1, seek_target, seek_flags);
  }

  // After seek, flush again and reset position tracking
  // This ensures FFmpeg's internal buffers are cleared and position is synced
  // For large files, this prevents FFmpeg from reading sequentially from old
  // position For Matroska/WebM, this helps with resync after seek
  if (ret >= 0) {
    if (ctx->avio_ctx) {
      avio_flush(ctx->avio_ctx);
    }

    // For Matroska/WebM format, we need to ensure resync position is set
    // This helps avoid EBML parsing errors after seek
    const char *format_name =
        ctx->fmt_ctx->iformat ? ctx->fmt_ctx->iformat->name : NULL;
    if (format_name && (strcmp(format_name, "matroska,webm") == 0 ||
                        strcmp(format_name, "webm") == 0 ||
                        strcmp(format_name, "matroska") == 0)) {
      // Reset internal format state by flushing and ensuring clean position
      // The format demuxer will handle resync on next read
      // IMPORTANT: Use int64_t for position to handle files >= 2GB
      if (ctx->fmt_ctx->pb) {
        int64_t current_pos = avio_tell(ctx->fmt_ctx->pb);
        // Ensure position tracking uses 64-bit arithmetic for large files
        ctx->position = current_pos;
        // Small backward seek to ensure we're at a valid EBML boundary
        // This helps Matroska resync properly after seek for large files
        if (current_pos > 0 && current_pos < ctx->file_size) {
          avio_seek(ctx->fmt_ctx->pb, current_pos, SEEK_SET);
        }
      }
    } else {
      // For other formats, just sync position
      // IMPORTANT: Use int64_t for position to handle files >= 2GB
      if (ctx->fmt_ctx->pb) {
        int64_t current_pos = avio_tell(ctx->fmt_ctx->pb);
        ctx->position = current_pos;
      }
    }
  }

  return ret;
}

EMSCRIPTEN_KEEPALIVE
int movi_read_frame(MoviContext *ctx, PacketInfo *info, uint8_t *buffer,
                    int buffer_size) {
  if (!ctx || !ctx->fmt_ctx || !ctx->pkt || !info || !buffer)
    return -1;
  av_packet_unref(ctx->pkt);
  int ret = av_read_frame(ctx->fmt_ctx, ctx->pkt);
  if (ret < 0)
    return (ret == AVERROR_EOF) ? 0 : ret;
  if (ctx->pkt->stream_index < 0 ||
      ctx->pkt->stream_index >= (int)ctx->fmt_ctx->nb_streams)
    return 0;
  AVStream *stream = ctx->fmt_ctx->streams[ctx->pkt->stream_index];
  info->stream_index = ctx->pkt->stream_index;
  info->keyframe = (ctx->pkt->flags & AV_PKT_FLAG_KEY) != 0;
  info->size = ctx->pkt->size;
  if (ctx->pkt->pts != AV_NOPTS_VALUE)
    info->timestamp = ctx->pkt->pts * av_q2d(stream->time_base);
  else if (ctx->pkt->dts != AV_NOPTS_VALUE)
    info->timestamp = ctx->pkt->dts * av_q2d(stream->time_base);
  else
    info->timestamp = 0.0;

  if (ctx->pkt->dts != AV_NOPTS_VALUE)
    info->dts = ctx->pkt->dts * av_q2d(stream->time_base);
  else
    info->dts = info->timestamp;

  if (ctx->pkt->duration > 0)
    info->duration = ctx->pkt->duration * av_q2d(stream->time_base);
  else if (stream->avg_frame_rate.num > 0 && stream->avg_frame_rate.den > 0)
    info->duration = 1.0 / av_q2d(stream->avg_frame_rate);
  else
    info->duration = 0.0;

  int copy_size = ctx->pkt->size;
  if (copy_size > buffer_size) {
    // Log error or return specific code to signal buffer too small
    return AVERROR(ENOBUFS);
  }
  memcpy(buffer, ctx->pkt->data, copy_size);
  return copy_size;
}
