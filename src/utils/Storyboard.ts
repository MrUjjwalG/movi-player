/**
 * Storyboards — the scrub previews a source brings with it.
 *
 * A preview normally costs a seek and a decode, because the frame has to be
 * made. A storyboard is the other way round: the frames were made once,
 * ahead of time, and stitched into a grid — one JPEG holding dozens of tiny
 * pictures, one per few seconds of runtime. Hovering then costs arithmetic and
 * a crop, and the mosaic is an ordinary image the browser caches like any
 * other. It is what YouTube ("storyboard"), Netflix and every trick-play
 * implementation does, and what the DASH-IF and HLS image tracks carry.
 *
 * Two shapes are understood, because both are what people actually have:
 *
 *   • a WebVTT thumbnail track — the interoperable form, cues whose payload is
 *     an image URL with a media fragment: `sprite.jpg#xywh=160,0,160,90`
 *   • a tile spec — rows, columns and a list of mosaics with their durations,
 *     which is the shape YouTube publishes and yt-dlp reports
 */

/** One picture inside a mosaic. */
export interface StoryboardTile {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * The whole mosaic's size, when it can be worked out — the spec states it,
   * and a VTT track gives it away through the extents of its own cues. A
   * caller painting the mosaic behind a window (rather than cropping it) needs
   * it to scale the image: a tile's size alone says nothing about the sheet
   * it sits in.
   */
  sheetWidth?: number;
  sheetHeight?: number;
}

/**
 * Mosaics described by their grid, rather than cue by cue.
 *
 * Two ways to say it, because two are in use:
 *
 *   • the mosaics listed outright, each with the stretch of video it covers —
 *     what YouTube publishes and yt-dlp reports
 *   • a sprite and a clock: one URL (optionally with an `{index}` placeholder
 *     for a sequence), a tile size, a column count, and how many seconds a tile
 *     stands for — the videojs-sprite-thumbnails configuration, tile for tile
 *
 * The second form needs the video's duration to know how many tiles there are,
 * so it is expanded when that is known rather than when it is set.
 */
export interface StoryboardSpec {
  /** Tiles across each mosaic. */
  columns: number;
  /**
   * Tiles down each mosaic. Omitted in the sprite form means one sheet holds
   * the whole video, and the row count follows from its length.
   */
  rows?: number;
  /** One tile's size in the mosaic. */
  width: number;
  height: number;
  /** The mosaics in order, each covering `duration` seconds of the video. */
  fragments?: Array<{ url: string; duration: number }>;
  /**
   * Sprite form: the sheet's URL, with an optional `{index}` placeholder that
   * counts from 0 for a sequence of sheets.
   */
  url?: string;
  /** Sprite form: seconds one tile stands for. Defaults to 1, as video.js does. */
  interval?: number;
}

interface Cue {
  start: number;
  end: number;
  tile: StoryboardTile;
}

/** "00:01:02.500" / "01:02.500" / "62.5" → seconds. */
function parseTimestamp(text: string): number {
  const parts = text.trim().split(":");
  if (parts.length === 0) return NaN;
  let seconds = 0;
  for (const part of parts) {
    const value = parseFloat(part.replace(",", "."));
    if (!Number.isFinite(value)) return NaN;
    seconds = seconds * 60 + value;
  }
  return seconds;
}

export class Storyboard {
  private constructor(
    private readonly cues: Cue[],
    /** Uniform cue length, when there is one — makes the lookup a division. */
    private readonly step: number,
    readonly coverage: number,
  ) {}

  /**
   * Build from a WebVTT thumbnail track. Cue payloads are image URLs, resolved
   * against the track's own address, and the fragment names the rectangle:
   * `#xywh=x,y,w,h`. A cue without one takes the whole image.
   */
  static parseVtt(text: string, baseUrl: string): Storyboard | null {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const cues: Cue[] = [];
    for (let i = 0; i < lines.length; i++) {
      const arrow = lines[i].indexOf("-->");
      if (arrow < 0) continue;
      const start = parseTimestamp(lines[i].slice(0, arrow));
      // Cue settings can follow the end time, separated by a space.
      const end = parseTimestamp(lines[i].slice(arrow + 3).split(/\s+/)[1] ?? "");
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const payload = (lines[i + 1] || "").trim();
      if (!payload) continue;
      const hash = payload.lastIndexOf("#xywh=");
      let x = 0,
        y = 0,
        width = 0,
        height = 0;
      let href = payload;
      if (hash >= 0) {
        href = payload.slice(0, hash);
        const nums = payload
          .slice(hash + 6)
          .split(",")
          .map((n) => parseFloat(n));
        if (nums.length === 4 && nums.every((n) => Number.isFinite(n))) {
          [x, y, width, height] = nums;
        }
      }
      let url = href;
      try {
        url = new URL(href, baseUrl).href;
      } catch {
        /* keep it as written — a relative path may still resolve for the page */
      }
      cues.push({ start, end, tile: { url, x, y, width, height } });
    }
    if (cues.length === 0) return null;
    cues.sort((a, b) => a.start - b.start);
    // The sheet is at least as big as the furthest corner any of its cues
    // reaches. Every tile of a grid is the same size, so for a full sheet this
    // is exact; for a part-filled last sheet it is the used area, which is what
    // matters for placing tiles inside it anyway.
    const extents = new Map<string, { w: number; h: number }>();
    for (const cue of cues) {
      const t = cue.tile;
      const e = extents.get(t.url) ?? { w: 0, h: 0 };
      e.w = Math.max(e.w, t.x + t.width);
      e.h = Math.max(e.h, t.y + t.height);
      extents.set(t.url, e);
    }
    for (const cue of cues) {
      const e = extents.get(cue.tile.url);
      if (e && e.w > 0 && e.h > 0) {
        cue.tile.sheetWidth = e.w;
        cue.tile.sheetHeight = e.h;
      }
    }
    return new Storyboard(cues, uniformStep(cues), cues[cues.length - 1].end);
  }

  /**
   * Build from a tile spec. Each mosaic covers its own stretch of the video and
   * holds `columns * rows` pictures, so a tile is one division and two
   * remainders away from any time.
   */
  static fromSpec(spec: StoryboardSpec, duration = 0): Storyboard | null {
    const fragments = Storyboard.fragmentsOf(spec, duration);
    if (!fragments) return null;
    const rows =
      spec.rows ??
      Math.max(
        1,
        Math.ceil(duration / ((spec.interval || 1) * Math.max(1, spec.columns))),
      );
    const perMosaic = Math.max(1, spec.columns * rows);
    const cues: Cue[] = [];
    let at = 0;
    for (const fragment of fragments) {
      const duration = fragment.duration > 0 ? fragment.duration : 0;
      const step = duration / perMosaic;
      for (let i = 0; i < perMosaic; i++) {
        const start = at + i * step;
        // The last mosaic is usually short — its tiles past the end of the
        // video are blank, and a cue for them would hand back a blank picture.
        if (step <= 0 || start >= at + duration) break;
        cues.push({
          start,
          end: start + step,
          tile: {
            url: fragment.url,
            x: (i % spec.columns) * spec.width,
            y: Math.floor(i / spec.columns) * spec.height,
            width: spec.width,
            height: spec.height,
            sheetWidth: spec.columns * spec.width,
            sheetHeight: rows * spec.height,
          },
        });
      }
      at += duration;
    }
    if (cues.length === 0) return null;
    return new Storyboard(cues, uniformStep(cues), at);
  }

  /**
   * The mosaics a spec describes — listed outright, or worked out from a sprite
   * and an interval the way videojs-sprite-thumbnails does: a sheet holds
   * `columns × rows` tiles of `interval` seconds each, and `{index}` counts
   * sheets from zero. Without `rows` the sheet is however tall it needs to be
   * to hold the whole video, which is that plugin's single-sprite case.
   */
  private static fragmentsOf(
    spec: StoryboardSpec,
    duration: number,
  ): Array<{ url: string; duration: number }> | null {
    if (spec.fragments && spec.fragments.length > 0) return spec.fragments;
    if (!spec.url || !(spec.columns > 0)) return null;
    // Nothing to expand against yet — the caller asks again once the duration
    // is known, which is the tick after the source opens.
    if (!(duration > 0)) return null;
    const interval = spec.interval && spec.interval > 0 ? spec.interval : 1;
    const rowDuration = interval * spec.columns;
    const rows = spec.rows ?? Math.ceil(duration / rowDuration);
    const sheetDuration = rowDuration * Math.max(1, rows);
    const sheets = Math.max(1, Math.ceil(duration / sheetDuration));
    const out: Array<{ url: string; duration: number }> = [];
    for (let i = 0; i < sheets; i++) {
      out.push({
        url: spec.url.replace("{index}", String(i)),
        duration: Math.min(sheetDuration, duration - i * sheetDuration),
      });
    }
    return out;
  }

  /**
   * The mosaics, in the order they cover the video. A caller that paints them
   * itself warms them from this — one image serves dozens of previews, and the
   * one after the pointer is the one about to be needed.
   */
  sheets(): string[] {
    const seen: string[] = [];
    for (const cue of this.cues) {
      if (seen[seen.length - 1] !== cue.tile.url && !seen.includes(cue.tile.url)) {
        seen.push(cue.tile.url);
      }
    }
    return seen;
  }

  /** The picture that belongs to a moment, or null past the end of the board. */
  tileAt(time: number): StoryboardTile | null {
    if (!(time >= 0) || this.cues.length === 0) return null;
    if (this.step > 0) {
      const index = Math.floor((time - this.cues[0].start) / this.step);
      const cue = this.cues[Math.min(Math.max(index, 0), this.cues.length - 1)];
      // Trust the division only where it lands inside the cue it picked; a
      // board with a ragged last mosaic falls through to the search.
      if (cue && time >= cue.start && time < cue.end) return cue.tile;
    }
    let lo = 0;
    let hi = this.cues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cue = this.cues[mid];
      if (time < cue.start) hi = mid - 1;
      else if (time >= cue.end) lo = mid + 1;
      else return cue.tile;
    }
    // Just past the last cue a picture is still the right answer: the board's
    // last tile usually ends a rounding error short of the video's own end, and
    // a hover there should not go blank. FAR past it is a different thing — a
    // board that covers only part of the video (a partial or truncated one)
    // would otherwise answer for the whole of the rest with a picture from
    // where it stopped, and nothing would ever fall through to decoding. One
    // cue's worth of slack draws that line.
    const last = this.cues[this.cues.length - 1];
    const slack = Math.max(this.step, last.end - last.start, 1);
    if (time >= last.start && time < last.end + slack) return last.tile;
    return null;
  }
}

/** The cue length when every cue shares one, else 0. */
function uniformStep(cues: Cue[]): number {
  if (cues.length < 2) return 0;
  const step = cues[1].start - cues[0].start;
  if (!(step > 0)) return 0;
  for (let i = 2; i < cues.length; i++) {
    if (Math.abs(cues[i].start - cues[i - 1].start - step) > 0.001) return 0;
  }
  return step;
}
