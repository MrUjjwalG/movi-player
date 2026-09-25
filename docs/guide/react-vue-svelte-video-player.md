---
title: "React, Vue & Svelte Video Player for MKV, HEVC, HLS and DASH"
description: "A React, Vue 3 and Svelte video player component that plays MKV, HEVC, AV1, HLS and DASH in the browser. Typed props and events, a slim build, and Next.js client-component setup."
head:
  - - meta
    - property: og:title
      content: "React, Vue & Svelte Video Player for MKV, HEVC, HLS and DASH"
  - - meta
    - property: og:description
      content: "A React, Vue 3 and Svelte video player component that plays MKV, HEVC, AV1, HLS and DASH in the browser. Typed props and events, a slim build, and Next.js client-component setup."
  - - script
    - type: application/ld+json
    - "{\"@context\": \"https://schema.org\", \"@type\": \"FAQPage\", \"mainEntity\": [{\"@type\": \"Question\", \"name\": \"Is there a React video player that plays MKV and HEVC?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Yes. movi-player ships a React component at movi-player/react that wraps the same engine, so MKV, HEVC, HLS and DASH all play from React.\"}}, {\"@type\": \"Question\", \"name\": \"Do I need a separate package for Vue or Svelte?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"No. The wrappers ship inside the main package: movi-player/react, movi-player/vue and movi-player/svelte.\"}}, {\"@type\": \"Question\", \"name\": \"Does it work with Next.js?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Yes, from a client component. The player needs the browser's media APIs, so render it on the client rather than during server rendering.\"}}, {\"@type\": \"Question\", \"name\": \"What is the slim build?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Each wrapper has a /slim twin that keeps the WebAssembly engine as a separate movi.wasm file, so the JavaScript is smaller and the WASM is cached on its own.\"}}]}"
---

# React, Vue and Svelte video player

`movi-player` ships first-party components for React, Vue 3 and Svelte inside the main package. They are thin, typed wrappers over the same engine, so everything the element plays — MKV, HEVC, AV1, HLS, DASH, multi-audio, subtitles — plays from your framework, and every attribute is a prop.

```bash
npm install movi-player
```

## React

```tsx
import { MoviPlayer } from "movi-player/react";

export function Watch() {
  return (
    <MoviPlayer
      src="https://example.com/movie.mkv"
      controls
      thumb
      onReady={(el) => console.log("duration", el.duration)}
    />
  );
}
```

`ref` forwards the underlying element, so `ref.current.play()` and the rest of its API are typed.

### Next.js

Render the player from a client component, since it needs the browser's media APIs:

```tsx
"use client";
import { MoviPlayer } from "movi-player/react";

export default function Player({ src }: { src: string }) {
  return <MoviPlayer src={src} controls />;
}
```

## Vue 3

```vue
<script setup lang="ts">
import { MoviPlayer } from "movi-player/vue";
</script>

<template>
  <MoviPlayer src="https://example.com/stream.m3u8" controls />
</template>
```

## Svelte

```svelte
<script>
  import MoviPlayer from "movi-player/svelte";
  let player;
</script>

<MoviPlayer bind:element={player} src="https://example.com/manifest.mpd" controls />
```

## Slim build

Every wrapper has a `/slim` twin with the same props. It keeps the WebAssembly engine as a separate `movi.wasm`, which you host next to your bundle:

```tsx
import { MoviPlayer } from "movi-player/react/slim";

<MoviPlayer src="video.mkv" controls wasmurl="/movi.wasm" />;
```

Use one entry per app — importing both the default and the slim build ships the engine twice.

## Try it

Every attribute on the [examples page](https://moviplayer.com/examples) works as a prop. For streaming specifics see the [HLS](/guide/hls-player) and [DASH](/guide/dash-player) guides.

## FAQ

### Is there a React video player that plays MKV and HEVC?

Yes. movi-player ships a React component at movi-player/react that wraps the same engine, so MKV, HEVC, HLS and DASH all play from React.

### Do I need a separate package for Vue or Svelte?

No. The wrappers ship inside the main package: movi-player/react, movi-player/vue and movi-player/svelte.

### Does it work with Next.js?

Yes, from a client component. The player needs the browser's media APIs, so render it on the client rather than during server rendering.

### What is the slim build?

Each wrapper has a /slim twin that keeps the WebAssembly engine as a separate movi.wasm file, so the JavaScript is smaller and the WASM is cached on its own.
