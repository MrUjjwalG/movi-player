# Sources API

Movi-Player provides different source adapters for various input types.

## Available Sources

| Source       | Use Case    | Import                |
| ------------ | ----------- | --------------------- |
| `HttpSource` | Remote URLs | `movi-player/demuxer` |
| `FileSource` | Local files | `movi-player/demuxer` |

## HttpSource

For loading videos from HTTP/HTTPS URLs.

### Basic Usage

```typescript
import { Demuxer, HttpSource } from "movi-player/demuxer";

const source = new HttpSource("https://example.com/video.mp4");
const demuxer = new Demuxer(source);

await demuxer.open();
console.log("Duration:", demuxer.getDuration());
```

### With Player

```typescript
import { MoviPlayer, HttpSource } from "movi-player/player";

const player = new MoviPlayer({
  source: { url: "https://example.com/video.mp4" },
  canvas: document.getElementById("canvas") as HTMLCanvasElement,
});

// Or with explicit HttpSource
const source = new HttpSource("https://example.com/video.mp4");
const player = new MoviPlayer({
  source: { url: source.url },
  canvas: document.getElementById("canvas") as HTMLCanvasElement,
});
```

### CORS Requirements

::: warning CORS
HttpSource requires the server to send proper CORS headers:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, HEAD
Access-Control-Expose-Headers: Content-Length, Content-Range
```

:::

### Features

- ✅ Range request support (seeking)
- ✅ Automatic chunk caching
- ✅ HEAD request for file size
- ✅ Error recovery

## FileSource

For loading local files from the user's device.

### Basic Usage

```typescript
import { Demuxer, FileSource } from "movi-player/demuxer";

const fileInput = document.getElementById("file") as HTMLInputElement;

fileInput.addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;

  const source = new FileSource(file);
  const demuxer = new Demuxer(source);

  await demuxer.open();
  console.log("File:", file.name);
  console.log("Duration:", demuxer.getDuration());
});
```

### With Player

```typescript
import { MoviPlayer } from "movi-player/player";

fileInput.addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;

  const player = new MoviPlayer({
    source: { file },
    canvas: document.getElementById("canvas") as HTMLCanvasElement,
  });

  await player.load({ file });
  await player.play();
});
```

### Features

- ✅ No CORS needed
- ✅ Instant seeking (no network latency)
- ✅ LRU cache for chunks
- ✅ Memory efficient (2MB chunks)
- ✅ Works offline

### Memory Management

FileSource uses intelligent chunking:

```typescript
// Internal configuration
const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB chunks
const MAX_CACHED_CHUNKS = 50; // ~100MB max cache

// LRU cache evicts least recently used chunks
// when cache is full
```

## Source Interface

All sources implement the `SourceAdapter` interface:

```typescript
interface SourceAdapter {
  // Get total file size
  getSize(): Promise<number>;

  // Read bytes from offset
  read(offset: number, length: number): Promise<Uint8Array>;

  // Close and cleanup
  close(): void;
}
```

### Creating Custom Sources

You can create custom sources:

```typescript
import type { SourceAdapter } from "movi-player/demuxer";

class CustomSource implements SourceAdapter {
  private data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  async getSize(): Promise<number> {
    return this.data.byteLength;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    return this.data.slice(offset, offset + length);
  }

  close(): void {
    // Cleanup
  }
}

// Usage
const customSource = new CustomSource(videoData);
const demuxer = new Demuxer(customSource);
```

## Source Selection

The player automatically selects the appropriate source:

```typescript
// Auto-detect from URL
player.load({ url: "https://example.com/video.mp4" });
// → Uses HttpSource

// Auto-detect from File
player.load({ file: selectedFile });
// → Uses FileSource

// Explicit type
player.load({ url: "https://example.com/video.mp4", type: "http" });
player.load({ file: selectedFile, type: "file" });
```

## Error Handling

### HttpSource Errors

```typescript
try {
  const source = new HttpSource(url);
  const demuxer = new Demuxer(source);
  await demuxer.open();
} catch (error) {
  if (error.message.includes("CORS")) {
    console.error("CORS error: Server must allow cross-origin requests");
  } else if (error.message.includes("404")) {
    console.error("File not found");
  } else if (error.message.includes("network")) {
    console.error("Network error");
  }
}
```

### FileSource Errors

```typescript
try {
  const source = new FileSource(file);
  const demuxer = new Demuxer(source);
  await demuxer.open();
} catch (error) {
  if (error.message.includes("format")) {
    console.error("Unsupported file format");
  } else if (error.message.includes("corrupt")) {
    console.error("File may be corrupted");
  }
}
```

## Performance Comparison

| Metric       | HttpSource        | FileSource |
| ------------ | ----------------- | ---------- |
| Initial load | Network dependent | Instant    |
| Seeking      | ~100-500ms        | <10ms      |
| Memory       | ~200MB            | ~100-400MB |
| Offline      | ❌                | ✅         |
| CORS         | Required          | Not needed |
