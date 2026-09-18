import { chromium } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(process.env.MOVI_CAPTURE_OUTPUT || join(extensionDir, 'screenshots'));
const mediaDir = resolve(process.env.MOVI_CAPTURE_MEDIA || join(extensionDir, '../test-media/chrome-store'));
const profile = await mkdtemp(join(tmpdir(), 'movi-store-capture-'));
const messages = [];
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
  await page.screenshot({ path: join(outputDir, '1-home.png') });
  await page.locator('#filePicker').setInputFiles(join(mediaDir, 'Sintel-trailer.mkv'));
  await page.waitForFunction(() => document.querySelector('#player').currentTime > 1, { timeout: 60000 });
  await page.evaluate(() => { document.querySelector('#player').currentTime = 25; });
  await page.waitForFunction(() => document.querySelector('#player').currentTime >= 25);
  await page.evaluate(() => document.querySelector('#player').pause());
  await page.mouse.move(520, 755);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(outputDir, '2-playback.png') });
  await writeFile(join(outputDir, 'capture-state.json'), JSON.stringify(await page.evaluate(() => {
    const el = document.querySelector('#player');
    return { url: location.href, time: el.currentTime, duration: el.duration, tracks: el.player?.getMediaInfo(), buttons: [...el.shadowRoot.querySelectorAll('button')].map(b => ({ label: b.getAttribute('aria-label'), title: b.title, class: b.className, text: b.innerText })), menus: el.shadowRoot.innerText };
  }), null, 2));
} finally {
  await writeFile(join(outputDir, 'capture-console.json'), JSON.stringify(messages, null, 2));
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
