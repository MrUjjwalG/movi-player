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
      text: Get Started →
      link: /guide/getting-started
    - theme: alt
      text: Live Demo
      link: https://movi-player-examples.vercel.app/
    - theme: alt
      text: View on GitHub
      link: https://github.com/MrUjjwalG/movi-player

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

<div style="margin-top: 60px; display: flex; flex-direction: column; align-items: center;">
  <h2 style="font-size: 32px; font-weight: 700; margin-bottom: 24px; text-align: center;">Professional UI Out of the Box</h2>
  <img src="./images/element.gif" style="max-width: 100%; border-radius: 12px; box-shadow: 0 20px 50px rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1);" alt="Movi Player Element" />
</div>

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
