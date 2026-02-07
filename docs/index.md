---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: "Movi-Player"
  text: "Modern Video Player for the Web"
  tagline: WebCodecs + FFmpeg WASM powered. HDR support. No server processing.
  image:
    src: /logo.svg
    alt: Movi-Player
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/MrUjjwalG/movi-player
    - theme: alt
      text: Live Demo
      link: https://movi-player-examples.vercel.app/

features:
  - icon: ⚡
    title: Hardware-First Decoding
    details: WebCodecs API with automatic FFmpeg WASM fallback for universal browser support.
  - icon: 🌈
    title: HDR Support
    details: Full HDR10, HLG, BT.2020 metadata extraction and Display-P3 rendering.
  - icon: 🎯
    title: Modular Design
    details: Use only what you need — demuxer (45KB), player (180KB), or full element (410KB).
  - icon: 🚀
    title: No Server Required
    details: All video parsing, demuxing, and decoding happens entirely in the browser.
  - icon: 📦
    title: Universal Format Support
    details: MP4, MKV, WebM, MOV, MPEG-TS, and more via FFmpeg WASM.
  - icon: 🔄
    title: Multi-Track Support
    details: Multiple audio and subtitle tracks without any conversion or processing.
---

<style>
:root {
  --vp-home-hero-name-color: transparent;
  --vp-home-hero-name-background: -webkit-linear-gradient(120deg, #bd34fe 30%, #41d1ff);
  --vp-home-hero-image-background-image: linear-gradient(-45deg, #bd34fe50 50%, #47caff50 50%);
  --vp-home-hero-image-filter: blur(44px);
}

@media (min-width: 640px) {
  :root {
    --vp-home-hero-image-filter: blur(56px);
  }
}

@media (min-width: 960px) {
  :root {
    --vp-home-hero-image-filter: blur(68px);
  }
}
</style>
