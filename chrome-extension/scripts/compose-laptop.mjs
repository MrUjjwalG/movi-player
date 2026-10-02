// Composite a real player capture onto a laptop-scene photo's screen area.
// Usage: node compose-laptop.mjs <scene.png> <capture.png> <out.png> "tlx,tly trx,try brx,bry blx,bly" [--debug]
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const [scenePath, capturePath, outPath, quadArg] = process.argv.slice(2).filter(a => a !== '--debug');
const debug = process.argv.includes('--debug');
const quad = quadArg.split(' ').map(p => p.split(',').map(Number)); // TL TR BR BL

const dataUrl = (bytes) => `data:image/png;base64,${bytes.toString('base64')}`;
const [scene, capture] = await Promise.all([readFile(scenePath), readFile(capturePath)]);

// Projective map of the unit square onto a quad, as a CSS matrix3d.
function adj(m) { return [
  m[4]*m[8]-m[5]*m[7], m[2]*m[7]-m[1]*m[8], m[1]*m[5]-m[2]*m[4],
  m[5]*m[6]-m[3]*m[8], m[0]*m[8]-m[2]*m[6], m[2]*m[3]-m[0]*m[5],
  m[3]*m[7]-m[4]*m[6], m[1]*m[6]-m[0]*m[7], m[0]*m[4]-m[1]*m[3]]; }
function mul(a, b) { const c = []; for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++)
  c[3*r+k] = a[3*r]*b[k] + a[3*r+1]*b[3+k] + a[3*r+2]*b[6+k]; return c; }
function basisToPoints(p1, p2, p3, p4) {
  const m = [p1[0], p2[0], p3[0], p1[1], p2[1], p3[1], 1, 1, 1];
  const v = adj(m).map((x, i) => 0); // placeholder, computed below
  const a = adj(m);
  const vv = [
    a[0]*p4[0] + a[1]*p4[1] + a[2],
    a[3]*p4[0] + a[4]*p4[1] + a[5],
    a[6]*p4[0] + a[7]*p4[1] + a[8]];
  return mul(m, [vv[0], 0, 0, 0, vv[1], 0, 0, 0, vv[2]]);
}
function general2DProjection(w, h, [tl, tr, br, bl]) {
  const s = basisToPoints([0, 0], [w, 0], [0, h], [w, h]);
  const d = basisToPoints(tl, tr, bl, br);
  const t = mul(d, adj(s));
  for (let i = 0; i < 9; i++) t[i] = t[i] / t[8];
  return [t[0], t[3], 0, t[6], t[1], t[4], 0, t[7], 0, 0, 1, 0, t[2], t[5], 0, t[8]];
}

const browser = await chromium.launch({
  headless: true,
  ...(process.env.MOVI_CHROMIUM_PATH ? { executablePath: process.env.MOVI_CHROMIUM_PATH } : { channel: 'chromium' }),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const m = general2DProjection(1280, 800, quad);
await page.setContent(`<!doctype html><style>
  * { margin: 0; }
  body { width: 1280px; height: 800px; overflow: hidden; position: relative; }
  .scene { position: absolute; inset: 0; }
  .shot { position: absolute; left: 0; top: 0; width: 1280px; height: 800px;
    transform-origin: 0 0; transform: matrix3d(${m.join(',')});
    ${debug ? 'opacity: 0.55; outline: 3px solid red;' : ''} }
</style>
<img class="scene" src="${dataUrl(scene)}">
<img class="shot" src="${dataUrl(capture)}">`);
await page.evaluate(() => Promise.all([...document.images].map(i => i.decode())));
await page.screenshot({ path: outPath, type: 'png' });
await browser.close();
process.stdout.write(`${outPath}\n`);
