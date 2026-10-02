// Store screenshots for the two "works on any page" features: the hover
// play button on a media link (REAL — content.js injected by the loaded
// extension paints it) and the "Open with MoviPlayer" context-menu entry
// (drawn — a native Chrome menu cannot be captured headless, so a faithful
// macOS Chrome menu is composed at the cursor; the item text and placement
// match background.js).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(process.env.MOVI_CAPTURE_OUTPUT || join(extensionDir, 'screenshots'));
const logo = `data:image/svg+xml;base64,${(await readFile(join(extensionDir, 'icons/logo.svg'))).toString('base64')}`;

const page_html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Shared folder — Family videos</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f9; color: #1c2230; }
  header { background: #fff; border-bottom: 1px solid #e4e7ee; padding: 18px 36px; display: flex; align-items: center; gap: 14px; }
  .folder { width: 38px; height: 38px; border-radius: 9px; background: #eef0fe; display: grid; place-items: center; color: #5b63f2; }
  header h1 { font-size: 17px; letter-spacing: -0.2px; }
  header p { color: #71798b; font-size: 12.5px; }
  .pill { margin-left: auto; border: 1px solid #dfe3ec; border-radius: 999px; padding: 7px 16px; font-weight: 600; font-size: 13px; color: #434b5e; background: #fff; }
  .pill.primary { background: #5b63f2; border-color: #5b63f2; color: #fff; }
  main { max-width: 980px; margin: 30px auto; background: #fff; border: 1px solid #e4e7ee; border-radius: 12px; overflow: hidden; }
  .cols { display: grid; grid-template-columns: 1fr 110px 150px; padding: 11px 24px; color: #818aa0; font-size: 11.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; border-bottom: 1px solid #edf0f5; }
  .row { display: grid; grid-template-columns: 1fr 110px 150px; align-items: center; padding: 13px 24px; border-bottom: 1px solid #f1f3f7; text-decoration: none; color: inherit; position: relative; }
  .row:last-child { border-bottom: 0; }
  .row:hover { background: #f8f9fe; }
  .name { display: flex; align-items: center; gap: 12px; font-weight: 600; font-size: 13.5px; }
  .fic { width: 34px; height: 34px; border-radius: 8px; display: grid; place-items: center; flex: none; }
  .fic.video { background: #eef0fe; color: #5b63f2; }
  .fic.doc { background: #eafaf1; color: #27a567; }
  .fic.audio { background: #fdf1e6; color: #e08b2e; }
  .name small { display: block; font-weight: 500; color: #8b93a7; font-size: 11.5px; }
  .size, .date { color: #6d7589; font-size: 13px; }
</style></head><body>
<header>
  <div class="folder"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z"/></svg></div>
  <div><h1>Family videos</h1><p>Shared folder · 9 items · 4.4 GB</p></div>
  <span class="pill">Download all</span><span class="pill primary">Share</span>
</header>
<main>
  <div class="cols"><span>Name</span><span>Size</span><span>Modified</span></div>
  ${[
    ['video', 'Anniversary dinner 4K.mkv', 'MKV video', '812 MB', 'Yesterday'],
    ['video', 'Goa trip — day 2.mp4', 'MP4 video', '645 MB', '28 Sep 2026'],
    ['video', 'Diwali 2025 highlights.mkv', 'MKV video', '1.1 GB', '12 Sep 2026'],
    ['doc', 'Guest list.pdf', 'PDF document', '86 KB', '2 Sep 2026'],
    ['video', 'Baby steps compilation.webm', 'WebM video', '214 MB', '14 Aug 2026'],
    ['video', 'Haldi ceremony — drone.mov', 'QuickTime video', '488 MB', '9 Aug 2026'],
    ['audio', 'Wedding speech — papa.flac', 'FLAC audio', '41 MB', '9 Aug 2026'],
    ['video', 'School annual day.ts', 'MPEG-TS video', '902 MB', '21 Jul 2026'],
    ['video', 'Holi 2025 slow-mo.mkv', 'MKV video', '356 MB', '15 Mar 2026'],
  ].map(([kind, name, sub, size, date]) => `
  <a class="row" href="https://files.example.com/${encodeURIComponent(name)}">
    <span class="name"><span class="fic ${kind}">${kind === 'video'
      ? '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
      : kind === 'audio'
        ? '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z"/></svg>'
        : '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm0 2 4 4h-4z"/></svg>'}</span>
      <span>${name}<small>${sub}</small></span></span>
    <span class="size">${size}</span><span class="date">${date}</span>
  </a>`).join('')}
</main>
</body></html>`;

const cursor = (x, y) => `
  const c = document.createElement('div');
  c.style.cssText = 'position:fixed;left:${x}px;top:${y}px;z-index:2147483647;pointer-events:none';
  c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M5 2 L5 19 L9.5 15 L12.5 21.5 L15 20.3 L12 14 L18 14 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  document.body.appendChild(c);`;

// macOS Chrome link context menu, with the extension's real entry where
// extension items live (its own group above Inspect).
const contextMenu = (x, y) => `
  const m = document.createElement('div');
  m.style.cssText = 'position:fixed;left:${x}px;top:${y}px;z-index:2147483646;background:rgba(252,252,253,0.98);backdrop-filter:blur(30px);border:1px solid #d6d6dc;border-radius:8px;box-shadow:0 10px 36px rgba(0,0,0,0.22),0 2px 8px rgba(0,0,0,0.10);padding:5px;min-width:252px;font:13px/1 -apple-system,BlinkMacSystemFont,sans-serif;color:#242427';
  const item = (label, opts = {}) => {
    const r = document.createElement('div');
    r.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:5px;' + (opts.active ? 'background:#4a74f2;color:#fff;' : '') + (opts.dim ? 'color:#9a9aa2;' : '');
    if (opts.icon) r.innerHTML = '<img src="${logo}" width="16" height="16" style="flex:none"><span>' + label + '</span>';
    else r.textContent = label;
    return r;
  };
  const sep = () => { const s = document.createElement('div'); s.style.cssText = 'height:1px;background:#e3e3e8;margin:5px 10px'; return s; };
  ['Open Link in New Tab','Open Link in New Window','Open Link in Incognito Window'].forEach(l => m.appendChild(item(l)));
  m.appendChild(sep());
  ['Save Link As\\u2026','Copy Link Address'].forEach(l => m.appendChild(item(l)));
  m.appendChild(sep());
  m.appendChild(item('Open with MoviPlayer', { icon: true, active: true }));
  m.appendChild(sep());
  m.appendChild(item('Inspect'));
  document.body.appendChild(m);`;

const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(page_html); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const { mkdtemp, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const profile = await mkdtemp(join(tmpdir(), 'movi-showcase-'));
const context = await chromium.launchPersistentContext(profile, {
  ...(process.env.MOVI_CHROMIUM_PATH ? { executablePath: process.env.MOVI_CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
});
try {
  const page = await context.newPage();
  await page.goto(origin);
  // The REAL hover affordance: content.js has decorated every media link; the
  // disc shows on the hovered row.
  const row = page.locator('.row', { hasText: 'Goa trip' });
  await row.locator('.movi-ext-play-btn').waitFor({ state: 'attached', timeout: 15000 });
  await row.hover();
  await page.waitForTimeout(350);
  const btn = await row.locator('.movi-ext-play-btn').boundingBox();
  await page.evaluate(cursor(btn.x + 20, btn.y + 16));
  await page.screenshot({ path: join(outputDir, '2-hover-play.png') });
  process.stdout.write('Captured 2-hover-play.png\\n');
  await page.evaluate(() => document.querySelectorAll('body > div:last-child').forEach(n => n.remove()));

  // The context-menu entry, drawn at the third row's link.
  const row3 = page.locator('.row', { hasText: 'Diwali' });
  await page.mouse.move(0, 0); // no hover disc in this shot
  await page.waitForTimeout(450); // let the disc's 0.2s opacity transition finish
  const b3 = await row3.boundingBox();
  const mx = Math.round(b3.x + 330), my = Math.round(b3.y + 26);
  await page.evaluate(contextMenu(mx, my));
  await page.evaluate(cursor(mx - 4, my - 6));
  await page.screenshot({ path: join(outputDir, '3-context-menu.png') });
  process.stdout.write('Captured 3-context-menu.png\\n');
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
  server.close();
}
