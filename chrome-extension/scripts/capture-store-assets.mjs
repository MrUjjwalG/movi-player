import { chromium } from 'playwright';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(process.env.MOVI_CAPTURE_OUTPUT || join(extensionDir, 'screenshots'));
const mediaDir = resolve(process.env.MOVI_CAPTURE_MEDIA || join(extensionDir, '../test-media/chrome-store'));
const profile = await mkdtemp(join(tmpdir(), 'movi-store-capture-'));
const messages = [];
const captures = [];
await mkdir(outputDir, { recursive: true });

const context = await chromium.launchPersistentContext(profile, {
  ...(process.env.MOVI_CHROMIUM_PATH ? { executablePath: process.env.MOVI_CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--autoplay-policy=no-user-gesture-required'],
});

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  page.on('console', message => messages.push({ type: message.type(), text: message.text() }));
  page.on('pageerror', error => messages.push({ type: 'pageerror', text: error.message }));
  await page.goto(`chrome-extension://${extensionId}/player.html`);
  await page.evaluate(() => customElements.whenDefined('movi-player'));
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(outputDir, '4-home.png') });
  captures.push({ filename: '4-home.png', width: 1280, height: 800 });
  await page.locator('#filePicker').setInputFiles(join(mediaDir, 'Sintel-trailer.mkv'));
  await page.waitForFunction(() => document.querySelector('#player').currentTime > 1, null, { timeout: 60000 });
  async function resetCaptureScroll() {
    // Playwright's scroll-into-view can scroll the overflow-hidden custom
    // element itself. Restore that scroll without changing product styles.
    await page.locator('#player').evaluate(el => { el.scrollTop = 0; el.scrollLeft = 0; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  async function capture(filename) {
    await resetCaptureScroll();
    const state = await page.locator('#player').evaluate(el => {
      const host = el.getBoundingClientRect();
      const canvas = el.shadowRoot.querySelector('canvas').getBoundingClientRect();
      if (el.scrollTop || Math.abs(canvas.top - host.top) > 1) throw new Error('Player canvas has scrolled outside the capture');
      const media = el.player?.getMediaInfo();
      return { time: el.currentTime, duration: el.duration, format: media?.formatName,
        tracks: media?.tracks.map(({ id, type, codec, label, channels, width, height }) => ({ id, type, codec, label, channels, width, height })),
        subtitleText: el.shadowRoot.querySelector('.movi-subtitle-overlay')?.textContent.trim(),
        selectedSubtitle: el.shadowRoot.querySelector('.movi-subtitle-track-active .movi-subtitle-track-label')?.textContent,
        playlistItems: document.querySelectorAll('.playlist-item').length,
        loadedThumbnails: [...document.querySelectorAll('.playlist-thumb-img')].filter(img => !img.hidden && img.complete && img.naturalWidth > 0).length,
      };
    });
    await page.screenshot({ path: join(outputDir, filename) });
    captures.push({ filename, width: 1280, height: 800, ...state });
    process.stdout.write(`Captured ${filename}\n`);
  }
  async function showFrame(start = 24) {
    await page.evaluate(async start => {
      const player = document.querySelector('#player');
      player.currentTime = start;
      await player.play();
    }, start);
    // currentTime changes before a seek paints. Let actual playback advance
    // beyond the target so the capture cannot retain the old decoded frame.
    await page.waitForFunction(start => document.querySelector('#player').currentTime > start + 1.2, start, { timeout: 60000 });
    await page.evaluate(() => document.querySelector('#player').pause());
    await resetCaptureScroll();
    // Rest ABOVE the seek band, not in it: the band reaches 18px over the
    // track, and since the first-hover thumbnail got fast the old resting
    // spot summoned a preview that sat over the picture in every capture.
    await page.mouse.move(520, 690);
    await page.waitForTimeout(700);
  }
  await showFrame();
  await capture('archive-previous/playback.png');
  await page.locator('#player').evaluate(el => el.setAttribute('subtitlesize', '75'));
  await page.getByRole('button', { name: 'Subtitles/Captions', exact: true }).click();
  await resetCaptureScroll();
  await page.locator('.movi-subtitle-track-item').filter({ hasText: 'Film credits' }).click();
  await showFrame();
  await page.locator('.movi-subtitle-track-item.movi-subtitle-track-active').filter({ hasText: 'Film credits' }).waitFor();
  await page.locator('.movi-osd-container').waitFor({ state: 'hidden' });
  await capture('5-subtitles.png');
  await page.locator('.movi-subtitle-track-item[data-track-id="null"]').click();
  await page.getByRole('button', { name: 'Subtitles/Captions', exact: true }).click();
  await page.getByRole('button', { name: 'Audio Track', exact: true }).click();
  await resetCaptureScroll();
  await page.mouse.move(520, 690);
  await page.locator('.movi-osd-container').waitFor({ state: 'hidden' });
  await capture('archive-previous/audio-tracks.png');
  await page.getByRole('button', { name: 'Audio Track', exact: true }).click();
  await page.locator('#filePicker').setInputFiles(['01 - Sintel - Rooftops.mkv', '02 - Sintel - Mountains.mp4', '03 - Sintel - Desert.webm'].map(name => join(mediaDir, name)));
  await page.locator('#playlistPanel').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('.playlist-thumb-img:not([hidden])').length >= 3, null, { timeout: 60000 });
  await showFrame(4);
  await capture('archive-previous/playlist.png');
  const failures = messages.filter(message => ['error', 'pageerror'].includes(message.type) || /EncodingError|decoder.*failed/i.test(message.text));
  if (failures.length) throw new Error(`Capture logged errors: ${JSON.stringify(failures)}`);
  const hashes = {};
  for (const filename of ['player.html', 'player.js', 'dist/element.slim.js', 'dist/movi.wasm']) {
    hashes[filename] = createHash('sha256').update(await readFile(join(extensionDir, filename))).digest('hex');
  }
  await writeFile(join(outputDir, 'capture-report.json'), JSON.stringify({ capturedAt: new Date().toISOString(), browser: context.browser()?.version(), extensionId, sourceHashes: hashes, captures, errors: failures }, null, 2));
} finally {
  await writeFile(join(outputDir, 'capture-console.json'), JSON.stringify(messages, null, 2));
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
