import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const extensionDirectory = fileURLToPath(new URL('../', import.meta.url));

function dataUrl(bytes, mimeType) {
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

function promoHtml({ screenshot, logo, font, size }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Movi Player — ${size} promotional tile</title>
  <style>
    @font-face {
      font-family: Manrope;
      src: url('${font}') format('woff2');
      font-style: normal;
      font-weight: 200 800;
      font-display: block;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; }
    body {
      overflow: hidden;
      color: #f5f6ff;
      background: #090c16;
      font-family: Manrope, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    main { position: relative; width: 100%; height: 100%; overflow: hidden; }
    main::before {
      content: '';
      position: absolute;
      inset: 0;
      background: radial-gradient(ellipse at 84% 42%, #25336655 0%, transparent 65%);
      pointer-events: none;
    }
    .brand { position: absolute; display: flex; align-items: center; font-weight: 800; }
    .brand img { display: block; flex: none; }
    h1 { position: absolute; margin: 0; font-weight: 800; }
    h1 span { color: #a6a5ff; }
    .description { position: absolute; margin: 0; color: #aeb8ce; }
    .formats { position: absolute; display: flex; margin: 0; padding: 0; list-style: none; }
    .formats li { font-weight: 700; }
    .shot {
      position: absolute;
      display: block;
      height: auto;
      outline: 1px solid #53608865;
      box-shadow: 0 24px 68px #0007;
    }
    .footnote { position: absolute; color: #7f8da9; }
    .large .brand { top: 51px; left: 55px; gap: 12px; font-size: 27px; letter-spacing: -0.9px; }
    .large .brand img { width: 43px; height: 43px; }
    .large h1 { top: 151px; left: 56px; font-size: 56px; line-height: 1.17; letter-spacing: -2.6px; }
    .large h1 span { display: block; }
    .large .description { top: 315px; left: 59px; font-size: 19px; line-height: 1.65; }
    .large .formats { top: 417px; left: 59px; gap: 29px; font-size: 17px; letter-spacing: 0.8px; }
    .large .formats li + li { border-left: 1px solid #35405b; padding-left: 29px; }
    .large .shot { left: 617px; top: 44px; width: 752px; }
    .large .footnote { bottom: 42px; left: 59px; font-size: 13px; letter-spacing: 0.15px; }
    .small .brand { top: 16px; left: 17px; gap: 8px; font-size: 22px; letter-spacing: -0.65px; }
    .small .brand img { width: 30px; height: 30px; }
    .small h1 { top: 55px; left: 20px; font-size: 20px; line-height: 1.3; letter-spacing: -0.55px; }
    .small .shot { top: 97px; left: 18px; width: 278px; }
    .small .formats { top: 98px; left: 315px; flex-direction: column; gap: 8px; font-size: 18px; letter-spacing: 0.3px; }
    .small .description { top: 197px; left: 315px; font-size: 10px; line-height: 1.8; }
    .small .footnote { display: none; }
  </style>
</head>
<body>
  <main class="${size}">
    <div class="brand"><img src="${logo}" alt=""><span>Movi Player</span></div>
    <h1>Your videos. <span>Your browser.</span></h1>
    <p class="description">${size === 'large' ? 'Play local files with embedded subtitles.<br>More formats. Right inside Chrome.' : 'Local files.<br>Embedded<br>subtitles.'}</p>
    <ul class="formats" aria-label="Supported formats"><li>MKV</li><li>HEVC</li><li>AV1</li></ul>
    <img class="shot" src="${screenshot}" alt="Real Movi Player Chrome extension during video playback">
    <div class="footnote">CHROME EXTENSION &nbsp; / &nbsp; moviplayer.com</div>
  </main>
</body>
</html>`;
}

export async function renderPromos({
  screenshotPath = path.join(extensionDirectory, 'screenshots/2-playback.png'),
  outputDirectory = path.join(extensionDirectory, 'screenshots'),
  browser = null,
  launchOptions = {},
} = {}) {
  const [screenshotBytes, logoBytes, fontBytes] = await Promise.all([
    readFile(screenshotPath),
    readFile(path.join(extensionDirectory, 'icons/logo.svg')),
    readFile(path.join(extensionDirectory, 'fonts/manrope-latin.woff2')),
  ]);
  const assets = {
    screenshot: dataUrl(screenshotBytes, 'image/png'),
    logo: dataUrl(logoBytes, 'image/svg+xml'),
    font: dataUrl(fontBytes, 'font/woff2'),
  };
  await mkdir(outputDirectory, { recursive: true });
  const activeBrowser = browser ?? await chromium.launch({ headless: true, ...launchOptions });
  const context = await activeBrowser.newContext({ deviceScaleFactor: 1 });
  const page = await context.newPage();
  const outputs = [];
  try {
    for (const tile of [
      { size: 'small', width: 440, height: 280, filename: 'mov-player-promo.png' },
      { size: 'large', width: 1400, height: 560, filename: 'movi-player-promo-big.png' },
    ]) {
      await page.setViewportSize({ width: tile.width, height: tile.height });
      await page.setContent(promoHtml({ ...assets, size: tile.size }));
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map((image) => image.decode()));
        const image = document.querySelector('.shot');
        if (image.naturalWidth / image.naturalHeight !== 1.6) {
          throw new Error('The source screenshot must have an 8:5 aspect ratio (for example, 1280×800).');
        }
        for (const element of document.querySelector('main').children) {
          const bounds = element.getBoundingClientRect();
          if (bounds.left < 0 || bounds.top < 0 || bounds.right > innerWidth || bounds.bottom > innerHeight) {
            throw new Error(`Promo element exceeds tile bounds: ${element.className || element.tagName}`);
          }
        }
      });
      const outputPath = path.join(outputDirectory, tile.filename);
      await page.screenshot({ path: outputPath, type: 'png', animations: 'disabled' });
      outputs.push({ path: outputPath, width: tile.width, height: tile.height });
    }
  } finally {
    await context.close();
    if (!browser) await activeBrowser.close();
  }
  return outputs;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [screenshotPath, outputDirectory] = process.argv.slice(2);
  try {
    const outputs = await renderPromos({ screenshotPath, outputDirectory });
    for (const output of outputs) {
      process.stdout.write(`${output.width}×${output.height} ${output.path}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
