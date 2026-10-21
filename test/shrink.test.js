import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { shrink } from '../src/index.js';

const noise = (w, h, ch) => {
  const b = Buffer.alloc(w * h * ch);
  for (let i = 0; i < b.length; i++) b[i] = (i * 2654435761) >>> 24;
  return sharp(b, { raw: { width: w, height: h, channels: ch } });
};
const gradient = (w, h, alpha) => {
  const ch = alpha ? 4 : 3;
  const b = Buffer.alloc(w * h * ch);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      b[i] = x & 255;
      b[i + 1] = y & 255;
      b[i + 2] = (x + y) & 255;
      if (alpha) b[i + 3] = (x - w / 2) ** 2 + (y - h / 2) ** 2 < (w / 3) ** 2 ? 255 : 0;
    }
  return sharp(b, { raw: { width: w, height: h, channels: ch } });
};

test('png with alpha becomes smaller avif and keeps alpha', async () => {
  const png = await gradient(600, 400, true).png().toBuffer();
  const r = await shrink(png);
  assert.equal(r.format, 'avif');
  assert.ok(r.data.length < png.length);
  const m = await sharp(r.data).metadata();
  assert.equal(m.format, 'heif');
  assert.equal(m.hasAlpha, true);
  assert.deepEqual([r.width, r.height], [600, 400]);
});

test('fully opaque alpha channel is dropped', async () => {
  const png = await gradient(300, 300, false).ensureAlpha().png().toBuffer();
  const r = await shrink(png);
  assert.equal((await sharp(r.data).metadata()).hasAlpha, false);
});

test('maxBytes is a hard cap', async () => {
  const jpg = await noise(1200, 900, 3).jpeg({ quality: 95 }).toBuffer();
  for (const max of [60_000, 15_000, 4_000]) {
    const r = await shrink(jpg, { maxBytes: max });
    assert.ok(r.data.length <= max, `${r.data.length} > ${max}`);
  }
});

test('max dimensions keep aspect ratio and never enlarge', async () => {
  const png = await gradient(1000, 500, false).png().toBuffer();
  const r = await shrink(png, { maxWidth: 200 });
  assert.deepEqual([r.width, r.height], [200, 100]);
  const small = await shrink(png, { maxWidth: 4000 });
  assert.deepEqual([small.width, small.height], [1000, 500]);
});

test('exif orientation is applied', async () => {
  const jpg = await gradient(400, 200, false).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const r = await shrink(jpg);
  assert.deepEqual([r.width, r.height], [200, 400]);
});

test('animations stay animated as webp', async () => {
  const frames = await Promise.all([0, 1, 2, 3].map((i) => gradient(120 + i, 120, true).resize(120, 120).png().toBuffer()));
  const gif = await sharp(frames, { join: { animated: true } }).gif({ delay: [100, 100, 100, 100], loop: 0 }).toBuffer();
  const r = await shrink(gif);
  assert.equal(r.format, 'webp');
  assert.equal(r.frames, 4);
  const m = await sharp(r.data, { animated: true }).metadata();
  assert.equal(m.pages, 4);
  assert.deepEqual([r.width, r.height], [120, 120]);
  const still = await shrink(gif, { animated: false });
  assert.equal(still.frames, 1);
  assert.equal(still.format, 'avif');
  assert.deepEqual([still.width, still.height], [120, 120]);
  const constrainedStill = await shrink(gif, { animated: false, maxHeight: 60 });
  assert.deepEqual([constrainedStill.width, constrainedStill.height], [60, 60]);
});

test('already tiny input is kept unless forced', async () => {
  const tiny = await noise(32, 32, 3).avif({ quality: 20 }).toBuffer();
  const meta = await sharp(tiny).metadata();
  assert.equal(meta.format, 'heif');
  assert.equal(meta.compression, 'av1');
  const r = await shrink(tiny, { quality: 100 });
  assert.equal(r.kept, true);
  assert.equal(r.format, 'avif');
  assert.ok(r.data.equals(tiny));
  const forced = await shrink(tiny, { quality: 100, keepSmaller: false });
  assert.equal(forced.kept, false);
  const explicitWebp = await shrink(tiny, { format: 'webp' });
  assert.equal(explicitWebp.format, 'webp');
  assert.equal(explicitWebp.kept, false);
});

test('every output format decodes', async () => {
  const png = await gradient(200, 200, true).png().toBuffer();
  for (const format of ['avif', 'webp', 'jpeg', 'png']) {
    const r = await shrink(png, { format, keepSmaller: false });
    const m = await sharp(r.data).metadata();
    assert.equal(m.format, format === 'avif' ? 'heif' : format);
  }
  const lossless = await shrink(png, { format: 'webp', lossless: true, keepSmaller: false });
  const visible = async (buf) => {
    const px = await sharp(buf).ensureAlpha().raw().toBuffer();
    for (let i = 0; i < px.length; i += 4) if (px[i + 3] === 0) px.fill(0, i, i + 3);
    return px;
  };
  assert.ok((await visible(png)).equals(await visible(lossless.data)));
});

test('garbage is rejected', async () => {
  await assert.rejects(shrink(Buffer.from('not an image')));
  await assert.rejects(shrink(Buffer.alloc(10), { format: 'bmp' }));
  await assert.rejects(shrink(Buffer.alloc(10), { quality: 0 }), /quality must be/);
  await assert.rejects(shrink(Buffer.alloc(10), { maxBytes: 0 }), /maxBytes must be/);
});
