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

  // Extract 360° spherical projection from side data (MP4 sv3d/st3d, Matroska
  // ProjectionType — the Google Spherical Video metadata). Stored as
  // projection+1 so 0 unambiguously means "no spherical metadata".
  const AVPacketSideData *spherical = av_packet_side_data_get(
      codecpar->coded_side_data, codecpar->nb_coded_side_data,
      AV_PKT_DATA_SPHERICAL);
  if (spherical && spherical->data &&
      spherical->size >= sizeof(AVSphericalMapping)) {
      const AVSphericalMapping *mapping =
          (const AVSphericalMapping *)spherical->data;
      info->projection = (int)mapping->projection + 1;
  } else {
      info->projection = 0;
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
// ---- Seeking a Matroska that never got an index --------------------------
//
// Matroska keeps its seek index (Cues) at the end of the file, and a file whose
// tail was truncated has none — the SeekHead still points at where the Cues
// were meant to be, and there is nothing there. FFmpeg's Matroska demuxer has
// no read_timestamp callback, so with no index there is no binary search to
// fall back on: av_seek_frame simply reads FORWARD from wherever it is. On a
// 4.2GB, 2h42m WEB-DL that means downloading gigabytes to reach a seek — the
// player sits in "seeking" and the byte counter climbs. Measured on such a
// file, ffmpeg's own CLI spent 25 minutes on a seek to one hour without ever
// producing a frame, and had read 90MB of a 5-minute seek at the 100s mark.
//
// But the container is still perfectly navigable: every Cluster carries its own
// timestamp, and clusters are self-delimiting. So do the search the demuxer
// cannot — binary-search the file by BYTE, read the timestamp of whatever
// cluster each probe lands on, and hand the result to FFmpeg as index entries
// through the same public API its own demuxers use. About twenty 256KB probes
// cover a 4GB file, and the seek that follows is an ordinary indexed one.
//
// Every cluster the search touches is kept, not just the winner: they are all
// valid resync points, and a viewer who seeks once usually seeks again nearby.
#define MOVI_MKV_PROBE_WINDOW (256 * 1024)
// How far a single probe may read forward looking for a cluster header before
// it gives up. Clusters are a second or two of media apart, so this is orders
// of magnitude more slack than any sane muxer needs.
#define MOVI_MKV_PROBE_SCAN (16 * 1024 * 1024)
#define MOVI_MKV_PROBE_BUDGET 32
#define MOVI_MKV_PROBE_MS 15000
// How far behind the target an existing index entry may sit before it stops
// being worth using. Landing this much early costs a forward read of the same
// size, which is the very thing being avoided.
#define MOVI_MKV_INDEX_TOLERANCE_S 30.0

// Tell the source that the reads about to arrive are a SEARCH, not a playhead.
// Without it an HTTP source reads the bisection as a series of seeks and
// restarts its download at each probe — 12MB fetched to answer a 256KB
// question, a dozen times over. Advisory: sources that don't implement it are
// unaffected.
EM_JS(void, js_probe_mode, (int on), {
  if (Module.onProbeMode)
    Module.onProbeMode(on);
});

int movi_fmt_is_matroska(const AVFormatContext *fmt) {
  const char *n = (fmt && fmt->iformat) ? fmt->iformat->name : NULL;
  return n && (strcmp(n, "matroska,webm") == 0 || strcmp(n, "matroska") == 0 ||
               strcmp(n, "webm") == 0);
}

static int movi_is_matroska(const MoviContext *ctx) {
  return ctx && movi_fmt_is_matroska(ctx->fmt_ctx);
}

// One EBML variable-length integer. Element IDs are written WITH their length
// marker, sizes without it — hence keep_marker. Advances *p past the field.
static int64_t movi_ebml_vint(const uint8_t *buf, int len, int *p,
                              int keep_marker) {
  if (*p < 0 || *p >= len)
    return -1;
  uint8_t first = buf[*p];
  if (first == 0)
    return -1; // 8+ byte lengths are not used by anything we read here
  int n = 1;
  uint8_t mask = 0x80;
  while (!(first & mask)) {
    mask >>= 1;
    n++;
  }
  if (n > 8 || *p + n > len)
    return -1;
  int64_t v = keep_marker ? first : (first & (mask - 1));
  for (int i = 1; i < n; i++)
    v = (v << 8) | buf[*p + i];
  *p += n;
  return v;
}

// Find the first Cluster at or after `from` and read its timestamp, in the
// stream time base (Matroska scales both by TimecodeScale, so a cluster's
// stored value IS its pts). Returns 0 on success.
static int movi_mkv_probe_cluster(AVFormatContext *fmt, int64_t file_size,
                                  int64_t from, uint8_t *buf, int64_t *out_pos,
                                  int64_t *out_ts) {
  if (from < 0)
    from = 0;
  if (file_size > 0 && from >= file_size)
    return -1;
  // Keep reading forward until a cluster turns up. One window is not enough:
  // this file's clusters run about a megabyte, so a 256KB look at a random
  // offset lands INSIDE one three times out of four. Treating that as "no
  // cluster here" and stepping the search forward by a window broke the
  // bisection — the low bound crept up on every miss and the search converged
  // on the end of the file instead of the target (seek to 50:00 landed at
  // 41:00). Scanning to the next cluster instead keeps every probe informative;
  // the answer just lies a little past where we looked.
  int64_t scanned = 0;
  while (scanned < MOVI_MKV_PROBE_SCAN) {
  if (file_size > 0 && from >= file_size)
    return -1;
  if (avio_seek(fmt->pb, from, SEEK_SET) < 0)
    return -1;
  int got = avio_read(fmt->pb, buf, MOVI_MKV_PROBE_WINDOW);
  if (got <= 16)
    return -1;
  for (int i = 0; i + 12 < got; i++) {
    // Cluster ID, 0x1F43B675.
    if (buf[i] != 0x1F || buf[i + 1] != 0x43 || buf[i + 2] != 0xB6 ||
        buf[i + 3] != 0x75)
      continue;
    int p = i + 4;
    if (movi_ebml_vint(buf, got, &p, 0) < 0) // cluster size (may be unknown)
      continue;
    // Timestamp (0xE7) is required to be the cluster's first child, but a
    // CRC-32 or Void may legally sit ahead of it.
    for (int guard = 0; guard < 8 && p < got; guard++) {
      int64_t id = movi_ebml_vint(buf, got, &p, 1);
      if (id < 0)
        break;
      int64_t esz = movi_ebml_vint(buf, got, &p, 0);
      if (esz < 0 || esz > (int64_t)(got - p))
        break;
      if (id == 0xE7) {
        if (esz < 1 || esz > 8)
          break;
        int64_t ts = 0;
        for (int k = 0; k < (int)esz; k++)
          ts = (ts << 8) | buf[p + k];
        *out_pos = from + i;
        *out_ts = ts;
        return 0;
      }
      p += (int)esz;
    }
    // Those four bytes were frame data that happened to look like a cluster.
    // Keep scanning the window rather than giving up on it.
  }
  // Overlap by the longest header we might have straddled.
  from += got - 16;
  scanned += got;
  }
  return -1;
}

// Binary-search the file for the cluster covering `target_sec` and feed what it
// finds into the stream's index. Returns 0 if the index gained anything.
int movi_mkv_index_near_fmt(AVFormatContext *fmt, int64_t file_size, int anchor,
                            double target_sec) {
  if (!movi_fmt_is_matroska(fmt) || anchor < 0 || file_size <= 0 ||
      anchor >= (int)fmt->nb_streams)
    return -1;
  AVStream *st = fmt->streams[anchor];
  double tbd = av_q2d(st->time_base);
  if (tbd <= 0)
    tbd = 0.001;
  uint8_t *buf = av_malloc(MOVI_MKV_PROBE_WINDOW);
  if (!buf)
    return -1;

  const int64_t saved = avio_tell(fmt->pb);
  js_probe_mode(1);
  const int64_t deadline =
      av_gettime_relative() + (int64_t)MOVI_MKV_PROBE_MS * 1000;
  const double duration = fmt->duration != AV_NOPTS_VALUE
                              ? (double)fmt->duration / AV_TIME_BASE
                              : 0.0;
  int64_t lo = 0, hi = file_size;
  int64_t best_pos = -1;
  int added = 0;

  for (int i = 0; i < MOVI_MKV_PROBE_BUDGET && lo < hi; i++) {
    if (av_gettime_relative() > deadline)
      break;
    int64_t mid = lo + (hi - lo) / 2;
    int64_t cpos = 0, cts = 0;
    if (movi_mkv_probe_cluster(fmt, file_size, mid, buf, &cpos, &cts) < 0) {
      // Nothing between here and the end of the scan — treat everything from
      // mid onwards as unusable rather than moving the low bound up, which is
      // what let a miss drag the search past the target.
      hi = mid;
      continue;
    }
    double t = cts * tbd;
    // A timestamp outside the file's own duration means those bytes were not a
    // cluster header after all.
    if (t < -1.0 || (duration > 0 && t > duration * 1.05)) {
      hi = mid;
      continue;
    }
    if (av_add_index_entry(st, cpos, cts, 0, 0, AVINDEX_KEYFRAME) >= 0)
      added++;
    if (t <= target_sec) {
      if (best_pos < 0 || cpos > best_pos)
        best_pos = cpos;
      if (target_sec - t < 6.0)
        break; // a GOP or two of forward reading — cheaper than another probe
      lo = cpos + 1;
    } else {
      hi = mid; // the cluster starts at or after mid, so this always shrinks
    }
  }

  js_probe_mode(0);
  av_free(buf);
  // The probes left the read cursor wherever the last one landed. Every caller
  // follows this with a real seek that repositions anyway, but a failed search
  // must not leave the demuxer reading from a random offset.
  if (saved >= 0)
    avio_seek(fmt->pb, saved, SEEK_SET);
  return added > 0 ? 0 : -1;
}

/**
 * True when this stream's index cannot answer a seek to `target_sec` — no
 * entry at or before it, or the nearest one so far behind that landing there
 * means reading forward through the very stretch the index was meant to skip.
 */
int movi_index_misses(AVStream *st, double target_sec, double tolerance_s) {
  double tb = av_q2d(st->time_base);
  if (tb <= 0)
    tb = 0.001;
  int64_t want = (int64_t)(target_sec / tb);
  int idx = av_index_search_timestamp(st, want, AVSEEK_FLAG_BACKWARD);
  if (idx < 0)
    return 1;
  const AVIndexEntry *e = avformat_index_get_entry(st, idx);
  if (!e)
    return 1;
  return (double)(want - e->timestamp) * tb > tolerance_s;
}

int movi_mkv_index_misses(AVStream *st, double target_sec) {
  return movi_index_misses(st, target_sec, MOVI_MKV_INDEX_TOLERANCE_S);
}

// ---------------------------------------------------------------------------
// MPEG-TS: land on the keyframe that OWNS the target, not the one after it.
//
// A transport stream carries no index. FFmpeg seeks it by bisecting on
// timestamps, which finds a byte position whose time is near the target — but
// "near" is measured over ANY frame, so the position it settles on is
// routinely a little PAST the random-access point the target belongs to. The
// decoder is flushed by then and needs a keyframe, so it drops everything
// until the NEXT one: a whole GOP later.
//
// Read off a 120fps HEVC DoVi stream with two-second keyframes: the seek
// landed just past the CRA it was aiming at, 249 packets were skipped hunting
// for a keyframe, the picture stood still for 1.17 seconds and then resumed
// two seconds further on — with the sound, which needed no keyframe, playing
// that stretch to nobody.
//
// The container does say where its random-access points are, in a bit that
// costs nothing to find: every TS packet's adaptation field carries a
// random_access_indicator, set on the packet that begins one. So do what the
// Matroska path does for clusters — walk the file in small windows, read the
// points out of the bytes, and hand them to FFmpeg as index entries through
// the public API. ff_seek_frame_binary consults the index to bound its search,
// so an entry at the target IS the position it seeks to, and the decoder gets
// its keyframe in the first packet.
#define MOVI_TS_PACKET 188
#define MOVI_TS_PROBE_WINDOW (256 * 1024)
// A run of TS packets long enough to cross a GOP on any sane muxer. 4K120 runs
// about 6MB a second, so this is a couple of seconds of the heaviest stream
// this player opens.
#define MOVI_TS_PROBE_SCAN (16 * 1024 * 1024)
#define MOVI_TS_PROBE_BUDGET 24
// How much of an access unit to read before deciding what it is. The delimiter,
// the parameter sets and the first slice header live at the very front.
#define MOVI_TS_AU_SCAN 1024
#define MOVI_TS_PROBE_MS 4000
int movi_fmt_is_mpegts(const AVFormatContext *fmt) {
  const char *n = (fmt && fmt->iformat) ? fmt->iformat->name : NULL;
  return n && (strcmp(n, "mpegts") == 0 || strcmp(n, "mpegtsraw") == 0);
}

static int movi_is_mpegts(const MoviContext *ctx) {
  return ctx && movi_fmt_is_mpegts(ctx->fmt_ctx);
}

// Where the 188-byte grid starts inside a window. A read lands mid-packet far
// more often than not, and one 0x47 proves nothing — it is an ordinary byte
// value. Three in a row at the right spacing is the standard test.
static int movi_ts_sync(const uint8_t *buf, int len) {
  for (int i = 0; i + 2 * MOVI_TS_PACKET < len; i++) {
    if (buf[i] == 0x47 && buf[i + MOVI_TS_PACKET] == 0x47 &&
        buf[i + 2 * MOVI_TS_PACKET] == 0x47)
      return i;
  }
  return -1;
}

// The PTS of a PES packet, in 90kHz, or -1 when it carries none. `p` points at
// the payload of a packet whose payload_unit_start_indicator was set, so a PES
// header starts there: 00 00 01 <stream_id>, a length, two flag bytes, a header
// length, and then the PTS in five bytes with four marker bits woven through
// it (ISO 13818-1, 2.4.3.7).
static int64_t movi_ts_pes_pts(const uint8_t *p, int len) {
  if (len < 14 || p[0] != 0x00 || p[1] != 0x00 || p[2] != 0x01)
    return -1;
  if (!(p[7] & 0x80)) // PTS_DTS_flags
    return -1;
  const uint8_t *q = p + 9;
  int64_t pts = ((int64_t)(q[0] & 0x0e)) << 29;
  pts |= ((int64_t)q[1]) << 22;
  pts |= ((int64_t)(q[2] & 0xfe)) << 14;
  pts |= ((int64_t)q[3]) << 7;
  pts |= ((int64_t)(q[4] & 0xfe)) >> 1;
  return pts;
}

/**
 * Does this access unit begin at a random-access point, read from the video
 * itself?
 *
 * The adaptation field's random_access_indicator is the cheap answer, and many
 * streams simply do not set it — the file this was written for has keyframes
 * every two seconds and not one marked packet in sixty megabytes. The picture
 * still says so: an access unit that starts with an IRAP NAL is a random-access
 * point whatever the container flags. `au` is the start of the elementary
 * stream for one access unit (the PES payload, and as much of the packets
 * following it as was gathered).
 */
static int movi_ts_au_is_irap(const uint8_t *au, int len, enum AVCodecID codec) {
  for (int i = 0; i + 4 < len; i++) {
    if (au[i] || au[i + 1] || au[i + 2] != 1)
      continue;
    uint8_t b = au[i + 3];
    if (codec == AV_CODEC_ID_HEVC) {
      int type = (b >> 1) & 0x3f;
      // BLA_W_LP(16) … CRA_NUT(21): every IRAP the spec defines. A CRA is a
      // usable entry point even where a decoder later needs its leading
      // pictures dropped — that is handled downstream.
      if (type >= 16 && type <= 21)
        return 1;
      // Parameter sets and the access unit delimiter come first; keep walking.
      if (type == 32 || type == 33 || type == 34 || type == 35 || type == 39)
        continue;
      if (type < 32)
        return 0; // a non-IRAP slice: this access unit is not an entry point
    } else if (codec == AV_CODEC_ID_H264) {
      int type = b & 0x1f;
      if (type == 5)
        return 1;
      if (type == 7 || type == 8 || type == 9 || type == 6)
        continue;
      if (type == 1)
        return 0;
    } else {
      return 0; // other codecs keep to the container's own flag
    }
  }
  return 0;
}

// The first random-access point at or after `from` on `pid`: its byte offset
// and its PTS. Reads forward in windows until one turns up, because a probe
// lands wherever the bisection puts it and the nearest point can be a GOP away.
static int movi_ts_probe_rap(AVFormatContext *fmt, int64_t file_size,
                             int64_t from, int pid, uint8_t *buf,
                             enum AVCodecID codec, int64_t *out_pos,
                             int64_t *out_pts) {
  if (from < 0)
    from = 0;
  if (file_size > 0 && from >= file_size)
    return -1;
  int64_t scanned = 0;
  while (scanned < MOVI_TS_PROBE_SCAN) {
    if (avio_seek(fmt->pb, from, SEEK_SET) < 0)
      return -1;
    int got = avio_read(fmt->pb, buf, MOVI_TS_PROBE_WINDOW);
    if (got <= 2 * MOVI_TS_PACKET)
      return -1;
    int base = movi_ts_sync(buf, got);
    if (base < 0) {
      // Not a readable grid here — step on by most of a window rather than
      // giving up, since a damaged or padded stretch is still only a stretch.
      from += got - 2 * MOVI_TS_PACKET;
      scanned += got;
      continue;
    }
    for (int off = base; off + MOVI_TS_PACKET <= got; off += MOVI_TS_PACKET) {
      const uint8_t *pkt = buf + off;
      if (pkt[0] != 0x47)
        break; // grid lost; the next window re-syncs
      int this_pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
      if (this_pid != pid)
        continue;
      int pusi = pkt[1] & 0x40;
      if (!pusi)
        continue; // a point begins an access unit, which begins a PES packet
      int afc = (pkt[3] >> 4) & 0x03;
      int af_len = (afc >= 2) ? pkt[4] : -1;
      if (afc >= 2 && (af_len < 0 || 5 + af_len > MOVI_TS_PACKET))
        continue;
      const uint8_t *payload = (afc >= 2) ? pkt + 5 + af_len : pkt + 4;
      int payload_len = MOVI_TS_PACKET - (int)(payload - pkt);
      if (payload_len <= 0)
        continue;
      int64_t pts = movi_ts_pes_pts(payload, payload_len);
      if (pts < 0)
        continue; // a point we cannot place is no use as an index entry

      // The container's own word, when it gives one.
      int rap = (afc >= 2 && af_len >= 1 && (pkt[5] & 0x40)) ? 1 : 0;
      if (!rap) {
        // …and when it does not, ask the picture. Gather this access unit's
        // elementary stream — the rest of this packet, and the packets of the
        // same PID that follow it until the next one starts — and read the NAL
        // types out of it. Bounded: the parameter sets and the first slice
        // header sit at the front, so a few packets is always enough.
        uint8_t au[MOVI_TS_AU_SCAN];
        int au_len = 0;
        int hdr = (payload_len > 8) ? 9 + payload[8] : payload_len;
        if (hdr < payload_len) {
          int n = payload_len - hdr;
          if (n > MOVI_TS_AU_SCAN)
            n = MOVI_TS_AU_SCAN;
          memcpy(au, payload + hdr, n);
          au_len = n;
        }
        for (int nx = off + MOVI_TS_PACKET;
             nx + MOVI_TS_PACKET <= got && au_len < MOVI_TS_AU_SCAN;
             nx += MOVI_TS_PACKET) {
          const uint8_t *nb = buf + nx;
          if (nb[0] != 0x47)
            break;
          int npid = ((nb[1] & 0x1f) << 8) | nb[2];
          if (npid != pid)
            continue;
          if (nb[1] & 0x40)
            break; // the next access unit has started
          int nafc = (nb[3] >> 4) & 0x03;
          const uint8_t *np = (nafc >= 2) ? nb + 5 + nb[4] : nb + 4;
          int nlen = MOVI_TS_PACKET - (int)(np - nb);
          if (nlen <= 0 || np < nb || np + nlen > nb + MOVI_TS_PACKET)
            break;
          if (nlen > MOVI_TS_AU_SCAN - au_len)
            nlen = MOVI_TS_AU_SCAN - au_len;
          memcpy(au + au_len, np, nlen);
          au_len += nlen;
        }
        rap = movi_ts_au_is_irap(au, au_len, codec);
      }
      if (!rap)
        continue;
      *out_pos = from + off;
      *out_pts = pts;
      return 0;
    }
    from += got - (got % MOVI_TS_PACKET);
    scanned += got;
    if (file_size > 0 && from >= file_size)
      return -1;
  }
  return -1;
}

// Binary-search the file for the random-access point covering `target_sec` and
// feed everything it touches into the stream's index. Returns 0 if the index
// gained anything.
int movi_ts_index_near_fmt(AVFormatContext *fmt, int64_t file_size, int anchor,
                           double target_sec) {
  if (!movi_fmt_is_mpegts(fmt) || anchor < 0 || file_size <= 0 ||
      anchor >= (int)fmt->nb_streams)
    return -1;
  AVStream *st = fmt->streams[anchor];
  // For a transport stream FFmpeg keeps the PID in AVStream.id, and the stream
  // time base is the 90kHz PES clock — so a PTS read out of the bytes needs no
  // conversion to be an index entry.
  const int pid = st->id;
  if (pid <= 0 || pid > 0x1fff)
    return -1;
  const enum AVCodecID codec = st->codecpar->codec_id;
  double tbd = av_q2d(st->time_base);
  if (tbd <= 0)
    tbd = 1.0 / 90000.0;
  uint8_t *buf = av_malloc(MOVI_TS_PROBE_WINDOW);
  if (!buf)
    return -1;

  const int64_t saved = avio_tell(fmt->pb);
  js_probe_mode(1);
  const int64_t deadline =
      av_gettime_relative() + (int64_t)MOVI_TS_PROBE_MS * 1000;
  const double duration = fmt->duration != AV_NOPTS_VALUE
                              ? (double)fmt->duration / AV_TIME_BASE
                              : 0.0;
  // The stream's own start, which a transport stream rarely puts at zero.
  const double start =
      st->start_time != AV_NOPTS_VALUE ? st->start_time * tbd : 0.0;
  int64_t lo = 0, hi = file_size;
  int64_t best_pos = -1;
  double best_t = 0.0;
  int added = 0;

  for (int i = 0; i < MOVI_TS_PROBE_BUDGET && lo < hi; i++) {
    if (av_gettime_relative() > deadline)
      break;
    int64_t mid = lo + (hi - lo) / 2;
    int64_t ppos = 0, ppts = 0;
    if (movi_ts_probe_rap(fmt, file_size, mid, pid, buf, codec, &ppos, &ppts) <
        0) {
      hi = mid;
      continue;
    }
    double t = ppts * tbd;
    // A timestamp outside the file's own span means those bytes were not what
    // they looked like — or the 33-bit PES clock has wrapped, which is the same
    // answer either way: do not index it.
    if (t < start - 1.0 || (duration > 0 && t > start + duration * 1.05)) {
      hi = mid;
      continue;
    }
    if (av_add_index_entry(st, ppos, ppts, 0, 0, AVINDEX_KEYFRAME) >= 0)
      added++;
    if (t <= target_sec) {
      if (ppos > best_pos) {
        best_pos = ppos;
        best_t = t;
      }
      // Close enough that another bisection is not worth its read; the walk
      // below closes the rest of the distance in single windows.
      if (target_sec - t < 2.5)
        break;
      lo = ppos + 1;
    } else {
      hi = mid;
    }
  }

  // Walk forward to the LAST point at or before the target.
  //
  // The bisection stops as soon as it is within a couple of seconds, and the
  // points are a GOP apart — so what it settles on can be one or two GOPs
  // earlier than it needs to be, and every one of those is a GOP of frames
  // decoded and thrown away before the picture reaches the playhead. Each step
  // here is one small read, and there are never many: the loop stops at the
  // first point past the target.
  for (int i = 0; i < 4 && best_pos >= 0; i++) {
    if (av_gettime_relative() > deadline)
      break;
    int64_t npos = 0, npts = 0;
    if (movi_ts_probe_rap(fmt, file_size, best_pos + MOVI_TS_PACKET, pid, buf,
                          codec, &npos, &npts) < 0)
      break;
    double nt = npts * tbd;
    if (nt > target_sec)
      break;
    if (av_add_index_entry(st, npos, npts, 0, 0, AVINDEX_KEYFRAME) >= 0)
      added++;
    if (npos <= best_pos)
      break; // no forward progress; nothing more to find
    best_pos = npos;
    best_t = nt;
  }
  (void)best_t;

  js_probe_mode(0);
  av_free(buf);
  // The probes left the cursor where the last one landed; the caller's real
  // seek repositions, but a failed search must not leave it adrift.
  if (saved >= 0)
    avio_seek(fmt->pb, saved, SEEK_SET);
  return added > 0 ? 0 : -1;
}

/**
 * Put the demuxer ON the random-access point that owns `target_sec`.
 *
 * Indexing the points is not enough by itself: the mpegts demuxer answers a
 * seek with its own timestamp bisection and never consults the index, so it
 * lands AT the target — mid-GOP — and the flushed decoder then throws away
 * every packet until the next point. Measured on a 120fps stream with
 * two-second keyframes: 46 to 166 packets skipped and the picture resuming
 * 0.42s to 1.42s PAST where it was asked to go.
 *
 * The index is still what makes this possible, because it holds the one thing
 * the demuxer cannot work out — where the point starts. Seek to that BYTE and
 * the very first packet is the keyframe. The frames between it and the target
 * are decoded and dropped, which is what seeking into a GOP costs in every
 * container; nothing is skipped and nothing waits.
 *
 * Returns 0 when the demuxer was moved.
 */
int movi_ts_seek_to_rap(AVFormatContext *fmt, int anchor, double target_sec) {
  if (!movi_fmt_is_mpegts(fmt) || anchor < 0 ||
      anchor >= (int)fmt->nb_streams)
    return -1;
  AVStream *st = fmt->streams[anchor];
  double tb = av_q2d(st->time_base);
  if (tb <= 0)
    return -1;
  int idx = av_index_search_timestamp(st, (int64_t)(target_sec / tb),
                                      AVSEEK_FLAG_BACKWARD);
  if (idx < 0)
    return -1;
  const AVIndexEntry *e = avformat_index_get_entry(st, idx);
  if (!e || e->pos < 0)
    return -1;
  // Far enough behind and the decode-and-drop costs more than the GOP wait it
  // is replacing — but that line sits well past the scan's own "look again"
  // threshold. A two-second GOP hands back a point up to two seconds early by
  // definition, and refusing it there sent the seek straight back to the
  // behaviour this exists to replace.
  if (target_sec - e->timestamp * tb > MOVI_TS_LAND_MAX_S)
    return -1;
  return av_seek_frame(fmt, anchor, e->pos,
                       AVSEEK_FLAG_BYTE | AVSEEK_FLAG_BACKWARD) >= 0
             ? 0
             : -1;
}

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

  // Anchor the seek on the VIDEO stream, and forbid landing past the target.
  //
  // This used to pass stream_index = -1 with max_ts = INT64_MAX — the caller's
  // stream_index was accepted and then dropped on the floor. Both halves of
  // that hurt, and together they produce a seek that lands SECONDS late, but
  // only sometimes:
  //
  //  - With -1, FFmpeg picks its own default stream to seek by (and reads the
  //    timestamp in AV_TIME_BASE). On a Matroska file that is routinely the
  //    audio stream, whose packets sit on a much finer grid than the video
  //    GOP — so the position it settles on is an audio boundary, and the video
  //    keyframe belonging to it has already gone past.
  //  - With max_ts = INT64_MAX, avformat_seek_file is explicitly permitted to
  //    satisfy the request with a position AFTER the target, so nothing stops
  //    it choosing the next index entry.
  //
  // Captured on Chromium mobile, a 1080p H.264 WEB-DL, 15 seeks: 12 landed
  // within 40ms of the target and 3 landed +2.87s, +6.13s and +6.46s late —
  // each one logging "Found IDR keyframe after seek (craSkipped=0)", i.e. the
  // player's keyframe filter had skipped nothing and the demuxer's own first
  // video keyframe really was a whole GOP past where it was asked to go. The
  // giveaway is that AUDIO arrived at the right timestamp on all three, so
  // the container position was fine and only the video anchor was wrong:
  // "Video-audio gap 6121ms exceeds 200ms; syncing clock to video". What the
  // viewer sees is a seek that hangs and then resumes several seconds ahead of
  // where they put the playhead.
  //
  // So: seek by the video stream in its own time base, with max_ts pinned to
  // the target. The permissive form is kept as a fallback, because the comment
  // it replaces recorded a real failure — some files have no usable index at
  // or before the target and the strict call returns an error rather than
  // landing early. Falling back reproduces exactly the old behaviour, so the
  // worst case here is what shipped before.
  int anchor = stream_index;
  if (anchor < 0 || anchor >= (int)ctx->fmt_ctx->nb_streams ||
      ctx->fmt_ctx->streams[anchor]->codecpar->codec_type !=
          AVMEDIA_TYPE_VIDEO) {
    anchor = av_find_best_stream(ctx->fmt_ctx, AVMEDIA_TYPE_VIDEO, -1, -1, NULL,
                                 0);
  }

  // Nothing to look up? Then build the lookup first (see movi_mkv_index_near).
  // Only when the index cannot serve this seek: a file WITH Cues, or one whose
  // clusters have already been parsed once, comes through here untouched.
  if (anchor >= 0 && movi_is_matroska(ctx) &&
      movi_mkv_index_misses(ctx->fmt_ctx->streams[anchor], timestamp)) {
    movi_mkv_index_near_fmt(ctx->fmt_ctx, ctx->file_size, anchor, timestamp);
  }

  // A transport stream has no index at all, and the bisection that stands in
  // for one lands past the random-access point as often as on it. Find the
  // point itself and index it (see movi_ts_index_near_fmt) — the seek that
  // follows then starts the decoder on a keyframe instead of a GOP of packets
  // it has to throw away.
  int ret = -1;
  if (anchor >= 0 && movi_is_mpegts(ctx)) {
    if (movi_index_misses(ctx->fmt_ctx->streams[anchor], timestamp,
                          MOVI_TS_INDEX_TOLERANCE_S)) {
      movi_ts_index_near_fmt(ctx->fmt_ctx, ctx->file_size, anchor, timestamp);
    }
    ret = movi_ts_seek_to_rap(ctx->fmt_ctx, anchor, timestamp);
  }

  if (ret < 0 && anchor >= 0) {
    // avformat_seek_file reads min/ts/max in the ANCHOR stream's time base
    // once a stream index is given — not AV_TIME_BASE.
    AVRational tb = ctx->fmt_ctx->streams[anchor]->time_base;
    int64_t stream_target =
        (int64_t)(timestamp / (av_q2d(tb) > 0 ? av_q2d(tb) : 1.0));
    ret = avformat_seek_file(ctx->fmt_ctx, anchor, INT64_MIN, stream_target,
                             stream_target, seek_flags);
  }

  int64_t seek_target = (int64_t)(timestamp * AV_TIME_BASE);
  if (ret < 0) {
    // Use INT64_MAX for max_ts to allow FFmpeg to find the nearest keyframe
    // The BACKWARD flag ensures we prefer positions at or before seek_target
    // Using seek_target as max_ts was too restrictive and caused seeks to fail
    // or jump to EOF when no keyframe exactly matched the target position
    ret = avformat_seek_file(ctx->fmt_ctx, -1, INT64_MIN, seek_target,
                             INT64_MAX, seek_flags);
  }
  if (ret < 0) {
    // Fallback to av_seek_frame if avformat_seek_file fails
    ret = av_seek_frame(ctx->fmt_ctx, -1, seek_target, seek_flags);
  }

  // After seek, clear stale EOF state.
  //
  // Do NOT avio_flush() here. On a *read* context, avio_flush() discards the
  // AVIO buffer WITHOUT rewinding s->pos (see FFmpeg aviobuf.c: seekback is
  // forced to 0 for read). After avformat_seek_file, the raw-audio demuxer has
  // already read ahead to resync to the next sync frame; that data lives in the
  // AVIO buffer waiting to be parsed into the first post-seek packets. Flushing
  // it throws the read-ahead away, so the stream silently jumps forward by the
  // buffered amount and hits EOF early — duration appears to shrink and seeks
  // near the end of audio-only (eac3/ac3/mp3) files end prematurely. Indexed
  // video seeks don't trip this because they don't do byte-estimate resync.
  if (ret >= 0) {
    // CRITICAL: Clear AVIO eof_reached flag after successful seek.
    // Without this, a prior EOF (e.g. from poster-frame reads reaching end
    // of a short file) causes av_read_frame to immediately return EOF even
    // though we just seeked back to a valid position.
    if (ctx->fmt_ctx->pb) {
      ctx->fmt_ctx->pb->eof_reached = 0;
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
    }
    // For non-Matroska formats, do NOT overwrite ctx->position here.
    // ctx->position is the source-side *physical* read cursor; FFmpeg already
    // keeps it in sync via avio_seek_callback / avio_read_callback during the
    // seek. avio_tell() returns the *logical consume* position, which trails
    // the physical cursor by whatever the demuxer read ahead to resync to the
    // next sync frame (raw eac3/ac3/mp3 etc.). Clobbering the cursor with that
    // smaller value makes the source replay buffered bytes and hit EOF early
    // by ~the read-ahead amount — duration appears to shrink near the end.
  }

  return ret;
}

// Recover a duration the container never wrote down, by demuxing to EOF.
//
// Some files carry no duration at all. The common one is a Matroska muxed in
// "live" mode — unknown segment size (01 FF FF FF FF FF FF FF), no Duration
// element in Info, no Cues — which is what you get when a downloader pipes
// into an ffmpeg whose output isn't seekable, so the header never gets patched
// on close. FFmpeg leaves fmt_ctx->duration at AV_NOPTS_VALUE for these and
// none of its own fallbacks rescue it: estimate_timings_from_pts is restricted
// to the mpeg family, and the bitrate estimate can't run because bit_rate is
// itself derived from a duration that doesn't exist. `ffprobe` on such a file
// prints duration=N/A, so this is not something the WASM layer got wrong.
//
// The one thing that always works is to read every packet and keep the largest
// end timestamp. That's demux only — no decoding — so it is cheap on CPU: a
// 5.5MB Matroska (2660 packets) scans in ~4ms natively. What it isn't cheap on
// is I/O, since it pulls the whole source through the read callbacks, hence the
// caller-supplied wall-clock budget.
//
// Blowing the budget returns -1 rather than the partial maximum. A duration
// that's too short is worse than no duration at all — the seek bar, the clock's
// time clamp and every near-end check trust it, so a truncated value makes the
// file look like it ends early.
//
// Byte-offset tail probing was tried first and doesn't work here — the
// Matroska demuxer parses EBML sequentially, so av_seek_frame(AVSEEK_FLAG_BYTE)
// is a no-op for it and a raw avio_seek leaves the demuxer's own state pointing
// at the start anyway. Both "tail probes" measured identical to a full scan.
EMSCRIPTEN_KEEPALIVE
double movi_scan_duration(MoviContext *ctx, int budget_ms) {
  if (!ctx || !ctx->fmt_ctx)
    return -1.0;

  AVPacket *pkt = av_packet_alloc();
  if (!pkt)
    return -1.0;

  int64_t deadline = av_gettime_relative() + (int64_t)budget_ms * 1000;
  double best = -1.0;
  int timed_out = 0;
  unsigned int seen = 0;

  for (;;) {
    av_packet_unref(pkt);
    int ret = av_read_frame(ctx->fmt_ctx, pkt);
    if (ret < 0)
      break; // EOF, or an error we can't read past — keep what we have

    if (pkt->stream_index >= 0 &&
        pkt->stream_index < (int)ctx->fmt_ctx->nb_streams) {
      AVStream *stream = ctx->fmt_ctx->streams[pkt->stream_index];
      int64_t ts = (pkt->pts != AV_NOPTS_VALUE) ? pkt->pts : pkt->dts;
      if (ts != AV_NOPTS_VALUE) {
        int64_t end_ts = ts + (pkt->duration > 0 ? pkt->duration : 0);
        double end = (double)end_ts * av_q2d(stream->time_base);
        if (end > best)
          best = end;
      }
    }

    // av_gettime_relative() is far more expensive than the loop body, so only
    // consult the clock every 256 packets.
    if (((++seen) & 0xFF) == 0 && av_gettime_relative() > deadline) {
      timed_out = 1;
      break;
    }
  }

  av_packet_unref(pkt);
  av_packet_free(&pkt);

  // Put the demuxer back at the start. Go through movi_seek_to so the Matroska
  // EBML resync and the eof_reached clear live in exactly one place — reaching
  // EOF above sets that flag, and without clearing it av_read_frame returns EOF
  // immediately for the rest of the session.
  movi_seek_to(ctx, 0.0, -1, AVSEEK_FLAG_BACKWARD);

  if (timed_out || best <= 0.0)
    return -1.0;
  return best;
}

// Find the first VCL slice NAL in a (possibly multi-NAL) packet and return its
// raw nal_unit_type — HEVC: (byte0 >> 1) & 0x3F (VCL = 0..31); H.264: byte0 &
// 0x1F (VCL = 1..5). Returns -1 if no VCL slice is found, the packet is too
// small, or the codec isn't H.264/HEVC.
//
// CRITICAL: a packet is NOT just one NAL. In MKV/MP4 a keyframe is typically
// [AUD][VPS][SPS][PPS][SEI…][slice…]. Reading only the first NAL (an AUD/PS)
// always misclassifies — we must walk every NAL and inspect the first VCL one.
// Packets may be Annex B (00 00 01 start codes) or length-prefixed (4-byte
// big-endian, hvcC/avcC). We detect which by probing for a leading start code.
//
// `out_hdr`, when non-NULL, receives the slice's raw NAL header bytes: [0] is
// the first byte (H.264 keeps nal_ref_idc there), [1] the second (HEVC keeps
// nuh_temporal_id_plus1 there; 0 for H.264, whose header is one byte). Neither
// can carry an emulation-prevention byte — those are only inserted after two
// zero bytes inside the payload — so they can be read raw.
static int movi_first_vcl_nal(enum AVCodecID codec_id, const uint8_t *data,
                              int size, uint8_t out_hdr[2]) {
  if (out_hdr) {
    out_hdr[0] = 0;
    out_hdr[1] = 0;
  }
  if (!data || size < 5)
    return -1; // too small to inspect

  if (codec_id != AV_CODEC_ID_HEVC && codec_id != AV_CODEC_ID_H264)
    return -1; // only H.264/HEVC carry the NAL types we classify

  // Detect format: Annex B if the packet starts with a 3- or 4-byte start code.
  int is_annexb = (data[0] == 0 && data[1] == 0 &&
                   (data[2] == 1 || (data[2] == 0 && data[3] == 1)));

  int i = 0;
  if (is_annexb) {
    // Walk NAL units delimited by 00 00 01 / 00 00 00 01 start codes.
    while (i + 3 < size) {
      // Find next start code.
      if (data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1) {
        int nal_off = i + 3;
        if (nal_off >= size)
          break;
        int hdr = data[nal_off];
        int t = (codec_id == AV_CODEC_ID_HEVC) ? ((hdr >> 1) & 0x3F)
                                               : (hdr & 0x1F);
        int is_vcl = (codec_id == AV_CODEC_ID_HEVC) ? (t >= 0 && t <= 31)
                                                    : (t >= 1 && t <= 5);
        if (is_vcl) {
          if (out_hdr) {
            out_hdr[0] = (uint8_t)hdr;
            out_hdr[1] = (nal_off + 1 < size) ? data[nal_off + 1] : 0;
          }
          return t; // first VCL slice decides
        }
        i = nal_off + 1;
      } else {
        i++;
      }
    }
  } else {
    // Length-prefixed (4-byte big-endian length before each NAL).
    while (i + 4 < size) {
      uint32_t nal_len = ((uint32_t)data[i] << 24) | ((uint32_t)data[i + 1] << 16) |
                         ((uint32_t)data[i + 2] << 8) | (uint32_t)data[i + 3];
      int nal_off = i + 4;
      // A length that doesn't fit is a length we can't walk past: `i = nal_off
      // + nal_len` would land beyond the buffer, and for a large enough value
      // wrap negative through the (int) cast and step the loop BACKWARDS out of
      // the allocation. Packets from FFmpeg are well formed, but the read path
      // already guards against corrupt ones near EOF (see the size check in
      // readFrame), and this is the one place that trusted the bytes.
      if (nal_len == 0 || nal_off >= size ||
          nal_len > (uint32_t)(size - nal_off))
        break;
      int hdr = data[nal_off];
      int t = (codec_id == AV_CODEC_ID_HEVC) ? ((hdr >> 1) & 0x3F)
                                             : (hdr & 0x1F);
      int is_vcl = (codec_id == AV_CODEC_ID_HEVC) ? (t >= 0 && t <= 31)
                                                  : (t >= 1 && t <= 5);
      if (is_vcl) {
        if (out_hdr) {
          out_hdr[0] = (uint8_t)hdr;
          out_hdr[1] = (nal_off + 1 < size) ? data[nal_off + 1] : 0;
        }
        return t;
      }
      i = nal_off + (int)nal_len; // advance past this NAL
    }
  }

  return -1; // no VCL slice found
}

static int movi_first_vcl_nal_type(enum AVCodecID codec_id, const uint8_t *data,
                                   int size) {
  return movi_first_vcl_nal(codec_id, data, size, NULL);
}

// sps_max_sub_layers_minus1 sits in the first RBSP byte of an HEVC SPS —
// sps_video_parameter_set_id u(4) | sps_max_sub_layers_minus1 u(3) |
// sps_temporal_id_nesting_flag u(1) — i.e. two bytes past the NAL header. That
// byte can never be an emulation-prevention byte (those need two zero bytes
// ahead of them inside the payload, and there is no payload ahead of it), so it
// reads raw. Returns the sub-layer COUNT, or 0 if `nal` is too short.
static int movi_hevc_sps_sub_layers(const uint8_t *nal, int len) {
  if (!nal || len < 3)
    return 0;
  return ((nal[2] >> 1) & 0x07) + 1;
}

// How many temporal sub-layers an HEVC stream carries. Returns 0 for "don't
// know" — callers must not read that as "one".
//
// The hvcC record has a field for exactly this (byte 21 is
// constantFrameRate(2) | numTemporalLayers(3) | temporalIdNested(1) |
// lengthSizeMinusOne(2)), but it is optional and encoders routinely leave it at
// 0. The 4K60 HEVC Main 10 source this was written for does: byte 21 = 0x07,
// numTemporalLayers = 0, while its SPS plainly says one sub-layer. So when the
// field is silent, walk the record's parameter-set arrays to the first SPS and
// ask the bitstream. Extradata that isn't an hvcC at all (raw Annex B, as
// mpegts hands over) is walked by start code instead.
static int movi_hevc_num_temporal_layers(const AVCodecParameters *par) {
  if (!par || par->codec_id != AV_CODEC_ID_HEVC || !par->extradata)
    return 0;
  const uint8_t *e = par->extradata;
  int n = par->extradata_size;

  if (n >= 23 && e[0] == 1) {
    int declared = (e[21] >> 3) & 0x07;
    if (declared > 0)
      return declared;
    // Silent field — walk numOfArrays worth of parameter-set arrays looking
    // for the SPS. Each array is
    //   array_completeness(1) reserved(1) NAL_unit_type(6) | numNalus u(16)
    // followed by numNalus × (nalUnitLength u(16) | that many bytes).
    int p = 22;
    int arrays = e[p++];
    for (int a = 0; a < arrays && p < n; a++) {
      int nal_type = e[p++] & 0x3F;
      if (p + 1 >= n)
        break;
      int count = (e[p] << 8) | e[p + 1];
      p += 2;
      for (int k = 0; k < count && p + 1 < n; k++) {
        int len = (e[p] << 8) | e[p + 1];
        p += 2;
        if (len <= 0 || p + len > n)
          return 0; // malformed — say nothing
        if (nal_type == 33)
          return movi_hevc_sps_sub_layers(e + p, len); // 33 = SPS_NUT
        p += len;
      }
    }
    return 0;
  }

  // Raw Annex B extradata: find the SPS by start code.
  for (int i = 0; i + 4 < n; i++) {
    if (e[i] == 0 && e[i + 1] == 0 && e[i + 2] == 1) {
      int off = i + 3;
      if (((e[off] >> 1) & 0x3F) == 33)
        return movi_hevc_sps_sub_layers(e + off, n - off);
      i = off;
    }
  }
  return 0;
}

// Can this picture be dropped without orphaning anything that follows it?
//
// Containers are supposed to say so — AV_PKT_FLAG_DISPOSABLE comes off MP4's
// `sdtp` sample-dependency table or a fragment's `trun` sample flags — but
// plenty of files carry neither, and then every frame looks load-bearing. A
// plain (non-fragmented) MP4 written without an sdtp box is the common case:
// measured on a 4K60 HEVC Main 10 source, two of every three pictures are
// TRAIL_N and not one of them was flagged. So read the answer out of the
// bitstream instead, in the same NAL scan the IDR/RASL classification already
// does.
//
//   H.264: nal_ref_idc == 0 means the picture is not used for reference by ANY
//   later picture. Unconditional, so it needs no further qualification.
//
//   HEVC: an even VCL NAL type in 0..14 is a "_N" picture — TRAIL_N, TSA_N,
//   STSA_N, RADL_N, RASL_N — which the spec defines as not referenced by
//   subsequent pictures OF THE SAME SUB-LAYER. Pictures in a HIGHER sub-layer
//   may still reference it, so "_N" alone is not enough: it is only free to
//   drop when it already sits in the highest sub-layer the stream has. Nothing
//   can reference upward, so at the top there is no one left to orphan.
//
// Returns 0 whenever the codec, the NAL, or the sub-layer count can't be
// established — an unknown picture is treated as load-bearing.
static int movi_packet_is_non_ref(enum AVCodecID codec_id, const uint8_t *data,
                                  int size, int num_temporal_layers) {
  uint8_t hdr[2] = {0, 0};
  int t = movi_first_vcl_nal(codec_id, data, size, hdr);
  if (t < 0)
    return 0;

  if (codec_id == AV_CODEC_ID_H264)
    return (((hdr[0] >> 5) & 0x03) == 0) ? 1 : 0; // nal_ref_idc == 0

  if (codec_id != AV_CODEC_ID_HEVC)
    return 0;
  if (num_temporal_layers <= 0)
    return 0; // sub-layer count unknown — can't prove it's the top one
  if (t > 14 || (t & 1))
    return 0; // not a sub-layer non-reference ("_N") picture
  int tid = (hdr[1] & 0x07) - 1; // nuh_temporal_id_plus1
  return (tid == num_temporal_layers - 1) ? 1 : 0;
}

// Classify whether a keyframe packet is a TRUE random-access point that a
// hardware WebCodecs decoder will accept as a `key` chunk.
//
// FFmpeg flags both closed-GOP IDR and open-GOP CRA pictures as AV_PKT_FLAG_KEY,
// but WebCodecs rejects a CRA sent as `key` ("wasn't a key frame") because its
// leading RASL pictures reference the previous GOP. We tell them apart by the
// first VCL slice NAL type:
//   HEVC: 19/20 = IDR, 16-18 = BLA (true RAP). 21 = CRA (open-GOP) — not a key.
//   H.264: 5 = IDR (true key).
//
// Returns 1 if the keyframe is a true IDR/BLA random-access point, 0 otherwise.
// Falls back to 1 (safe default: assume true key) when no VCL slice is found or
// the codec isn't H.264/HEVC, so we never wedge waiting for an IDR we failed to
// recognize.
static int movi_packet_is_idr(enum AVCodecID codec_id, const uint8_t *data,
                              int size) {
  if (codec_id != AV_CODEC_ID_HEVC && codec_id != AV_CODEC_ID_H264)
    return 1; // other codecs: honor container keyframe flag

  int t = movi_first_vcl_nal_type(codec_id, data, size);
  if (t < 0)
    return 1; // too small / no VCL slice — assume true key (safe default)

  if (codec_id == AV_CODEC_ID_HEVC)
    return (t == 19 || t == 20 || t == 16 || t == 17 || t == 18) ? 1 : 0;
  return (t == 5) ? 1 : 0; // H.264 IDR
}

// Classify whether a packet is an HEVC RASL leading picture (NAL type 8=RASL_N
// / 9=RASL_R). RASL pictures trail a CRA in decode order but reference the
// pre-CRA GOP; when the CRA is a random-access resume (references flushed) they
// are orphaned and must be discarded (NoRaslOutputFlag=1). Chrome drops them
// internally; Safari/VideoToolbox throws a hard EncodingError — so JS skips
// them after a CRA resume. HEVC only; 0 for every other codec and NAL type.
static int movi_packet_is_rasl(enum AVCodecID codec_id, const uint8_t *data,
                               int size) {
  if (codec_id != AV_CODEC_ID_HEVC)
    return 0;
  int t = movi_first_vcl_nal_type(codec_id, data, size);
  return (t == 8 || t == 9) ? 1 : 0;
}

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
  // Distinguish true IDR/BLA random-access keyframes from open-GOP CRA frames
  // so JS can send CRA as `delta` and keep the hardware decoder running. Only
  // meaningful for keyframes; non-keyframes carry is_idr = 0.
  if (info->keyframe)
    info->is_idr =
        movi_packet_is_idr(stream->codecpar->codec_id, ctx->pkt->data,
                           ctx->pkt->size);
  else
    info->is_idr = 0;
  // Flag HEVC RASL leading pictures so JS can drop the orphaned ones after a
  // CRA/BLA random-access resume (Safari hard-errors on them). Keyframes are
  // never RASL; non-HEVC codecs always carry is_rasl = 0.
  info->is_rasl =
      info->keyframe
          ? 0
          : movi_packet_is_rasl(stream->codecpar->codec_id, ctx->pkt->data,
                                ctx->pkt->size);
  // Non-reference frame: safe for JS to drop under load (nothing references it).
  // Keyframes are never disposable. The container's own flag is authoritative
  // when it is there; when it isn't — a plain MP4 with no sdtp box, which is
  // most of them — fall back to reading it off the bitstream, which costs one
  // more walk to the first VCL NAL of a packet we are already walking.
  info->disposable =
      (!info->keyframe && (ctx->pkt->flags & AV_PKT_FLAG_DISPOSABLE) != 0) ? 1
                                                                           : 0;
  if (!info->keyframe && !info->disposable)
    info->disposable = movi_packet_is_non_ref(
        stream->codecpar->codec_id, ctx->pkt->data, ctx->pkt->size,
        movi_hevc_num_temporal_layers(stream->codecpar));
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

  // AV1 Temporal Delimiter prepend: MP4/ISOBMFF stores one temporal unit per
  // sample and strips the Temporal Delimiter OBU, but the WebCodecs low-overhead
  // bitstream format (per the AV1 codec registration / ISOBMFF binding) expects
  // each chunk to be a complete temporal unit. Prepend a TD OBU (0x12 0x00 =
  // type TEMPORAL_DELIMITER, has_size=1, payload size 0) when the packet doesn't
  // already start with one, so every chunk is a well-formed temporal unit.
  // NOTE: this is for spec-compliant packaging; it does NOT cure the separate,
  // non-deterministic HW-decoder crash on bare show_existing_frame OBUs (~3-byte
  // re-display frames) — that originates inside Chrome's AV1 decoder and still
  // recovers via decoder recreate. Harmless to keep: all frames decode with it.
  int td_prepend = 0;
  if (stream->codecpar->codec_id == AV_CODEC_ID_AV1 && ctx->pkt->size >= 1) {
    int obu_type = (ctx->pkt->data[0] >> 3) & 0x0f;
    if (obu_type != 2) // 2 = OBU_TEMPORAL_DELIMITER; only add if missing
      td_prepend = 1;
  }

  int copy_size = ctx->pkt->size + (td_prepend ? 2 : 0);
  if (copy_size > buffer_size) {
    // Log error or return specific code to signal buffer too small
    return AVERROR(ENOBUFS);
  }
  if (td_prepend) {
    buffer[0] = 0x12; // TD OBU header: obu_type=2, obu_has_size_field=1
    buffer[1] = 0x00; // leb128 payload size = 0
    memcpy(buffer + 2, ctx->pkt->data, ctx->pkt->size);
  } else {
    memcpy(buffer, ctx->pkt->data, ctx->pkt->size);
  }
  // info->size must reflect the actual emitted byte count (incl. any prepended
  // TD), because JS slices the packet buffer by info->size — not by this
  // return value.
  info->size = copy_size;
  return copy_size;
}

// Chapter support
EMSCRIPTEN_KEEPALIVE
int movi_get_chapter_count(MoviContext *ctx) {
  if (!ctx || !ctx->fmt_ctx)
    return 0;
  return (int)ctx->fmt_ctx->nb_chapters;
}

EMSCRIPTEN_KEEPALIVE
double movi_get_chapter_start(MoviContext *ctx, int index) {
  if (!ctx || !ctx->fmt_ctx || index < 0 || index >= (int)ctx->fmt_ctx->nb_chapters)
    return -1.0;
  AVChapter *ch = ctx->fmt_ctx->chapters[index];
  return ch->start * av_q2d(ch->time_base);
}

EMSCRIPTEN_KEEPALIVE
double movi_get_chapter_end(MoviContext *ctx, int index) {
  if (!ctx || !ctx->fmt_ctx || index < 0 || index >= (int)ctx->fmt_ctx->nb_chapters)
    return -1.0;
  AVChapter *ch = ctx->fmt_ctx->chapters[index];
  return ch->end * av_q2d(ch->time_base);
}

EMSCRIPTEN_KEEPALIVE
int movi_get_chapter_title(MoviContext *ctx, int index, char *buffer, int buffer_size) {
  if (!ctx || !ctx->fmt_ctx || !buffer || buffer_size <= 0 ||
      index < 0 || index >= (int)ctx->fmt_ctx->nb_chapters)
    return 0;
  AVChapter *ch = ctx->fmt_ctx->chapters[index];
  const AVDictionaryEntry *entry = av_dict_get(ch->metadata, "title", NULL, 0);
  if (entry && entry->value) {
    strncpy(buffer, entry->value, buffer_size - 1);
    buffer[buffer_size - 1] = '\0';
    return (int)strlen(buffer);
  }
  buffer[0] = '\0';
  return 0;
}
