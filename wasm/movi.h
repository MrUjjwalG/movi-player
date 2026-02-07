#ifndef MOVI_H
#define MOVI_H

#include <emscripten.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavformat/avio.h>
#include <libavutil/avutil.h>
#include <libavutil/display.h>
#include <libavutil/pixdesc.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>



// Stream types matching TypeScript
typedef enum {
  STREAM_TYPE_VIDEO = 0,
  STREAM_TYPE_AUDIO = 1,
  STREAM_TYPE_SUBTITLE = 2,
  STREAM_TYPE_UNKNOWN = 3
} StreamType;

// Stream info struct - matches TypeScript
typedef struct {
  int index;
  int type;
  int codec_id;
  char codec_name[32];
  int width;
  int height;
  double frame_rate;
  int channels;
  int sample_rate;
  double duration;
  int64_t bit_rate;
  int extradata_size;
  int profile;
  int level;
  char language[8]; // ISO 639-2/B language code (3 chars + null terminator)
  char label[64];   // Track label/title from metadata
  int rotation;     // Rotation in degrees (e.g. 0, 90, 180, 270)
  char color_primaries[32];
  char color_transfer[32];
  char color_matrix[32];
  char pixel_format[32];
  char color_range[32];
} StreamInfo;

// Packet info struct
typedef struct {
  int stream_index;
  int keyframe;
  double timestamp;
  double dts;
  double duration;
  int size;
} PacketInfo;

// Demuxer context with custom AVIO
typedef struct {
  AVFormatContext *fmt_ctx;
  AVPacket *pkt;
  AVIOContext *avio_ctx;
  uint8_t *avio_buffer;
  int64_t position;  // Current read position
  int64_t file_size; // Total file size
  int avio_buffer_size;

  // Decoding support
  AVCodecContext **decoders;
  SwrContext **resamplers;
  AVFrame *frame;
  AVFrame *resampled_frame;
  AVSubtitle *subtitle;                 // For subtitle decoding
  double last_subtitle_packet_duration; // Store packet duration for fallback
  int downmix_to_stereo;
  
  // RGB conversion support (for 10-bit HDR to 8-bit RGBA)
  struct SwsContext *sws_ctx;
  AVFrame *rgb_frame;
  uint8_t *rgb_buffer;
  int rgb_buffer_size;
} MoviContext;

EMSCRIPTEN_KEEPALIVE double movi_get_start_time(MoviContext *ctx);
EMSCRIPTEN_KEEPALIVE int movi_get_format_name(MoviContext *ctx, char *buffer, int buffer_size);
EMSCRIPTEN_KEEPALIVE int movi_get_metadata_title(MoviContext *ctx, char *buffer, int buffer_size);

// JS-WASM Bridge (defined in movi.c or other files with EM_JS)
extern int js_read_async(uint8_t *buffer, int offset_low, int offset_high,
                         int size);
extern int64_t js_seek_async(int offset_low, int offset_high, int whence);
extern int64_t js_get_file_size(void);

// Remuxer context (forward declaration)
typedef struct MoviRemuxContext MoviRemuxContext;

// Thumbnail context (forward declaration)
typedef struct MoviThumbnailContext MoviThumbnailContext;

#endif // MOVI_H
