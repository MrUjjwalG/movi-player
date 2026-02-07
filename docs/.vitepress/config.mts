import { defineConfig } from "vitepress";

// https://vitepress.dev/reference/site-config
export default defineConfig({
  base: "/movi-player/",
  title: "Movi-Player",
  description:
    "Modern, modular video player for the web powered by WebCodecs + FFmpeg WASM",

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/logo.svg" }],
    ["script", { src: "/movi-player/coi-serviceworker.js" }],
    ["meta", { name: "theme-color", content: "#646cff" }],
    ["meta", { property: "og:type", content: "website" }],
    [
      "meta",
      { property: "og:title", content: "Movi-Player - Modern Video Player" },
    ],
    [
      "meta",
      {
        property: "og:description",
        content: "WebCodecs + FFmpeg WASM powered video player for the web",
      },
    ],
  ],

  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    logo: "/logo.svg",

    nav: [
      { text: "Home", link: "/" },
      { text: "Guide", link: "/guide/getting-started" },
      { text: "API", link: "/api/player" },
      { text: "Examples", link: "https://movi-player-examples.vercel.app/" },
      {
        text: "v1.0.0",
        items: [
          { text: "Changelog", link: "/changelog" },
          { text: "Contributing", link: "/contributing" },
        ],
      },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Introduction",
          items: [
            {
              text: "What is Movi-Player?",
              link: "/guide/what-is-movi-player",
            },
            { text: "Getting Started", link: "/guide/getting-started" },
            { text: "Why Movi-Player?", link: "/guide/why-movi-player" },
            { text: "Use Cases", link: "/guide/use-cases" },
          ],
        },
        {
          text: "Core Concepts",
          items: [
            { text: "Architecture", link: "/guide/architecture" },
            { text: "Modules", link: "/guide/modules" },
            { text: "HDR Support", link: "/guide/hdr-support" },
            { text: "Standards Compliance", link: "/guide/standards" },
          ],
        },
        {
          text: "Usage",
          items: [
            { text: "Custom Element", link: "/guide/custom-element" },
            { text: "Programmatic API", link: "/guide/programmatic-api" },
            { text: "Local File Playback", link: "/guide/local-files" },
            { text: "Multi-Track Support", link: "/guide/multi-track" },
          ],
        },
        {
          text: "Advanced",
          items: [
            { text: "Performance", link: "/guide/performance" },
            { text: "Troubleshooting", link: "/guide/troubleshooting" },
          ],
        },
      ],
      "/api/": [
        {
          text: "API Reference",
          items: [
            { text: "MoviPlayer", link: "/api/player" },
            { text: "Demuxer", link: "/api/demuxer" },
            { text: "MoviElement", link: "/api/element" },
            { text: "Sources", link: "/api/sources" },
            { text: "Events", link: "/api/events" },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/MrUjjwalG/movi-player" },
      { icon: "npm", link: "https://www.npmjs.com/package/movi-player" },
    ],

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2024-present Ujjwal Kashyap",
    },

    search: {
      provider: "local",
    },

    editLink: {
      pattern: "https://github.com/MrUjjwalG/movi-player/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
  },
});
