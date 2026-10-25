import sharp from 'sharp';

const LIMIT_PIXELS = 100_000_000;
const QUALITY = { avif: 50, webp: 75, jpeg: 78, png: 90 };
const FORMATS = new Set(['auto', 'avif', 'webp', 'jpeg', 'png']);
const MIN_QUALITY = 20;
const SCALES = [1, 0.8, 0.65, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05];

/**
 * @typedef {object} ShrinkOptions
 * @property {'auto'|'avif'|'webp'|'jpeg'|'png'} [format] output format; auto is AVIF for stills and WebP for animations
 * @property {number} [quality] 1-100; the upper quality bound when maxBytes is set
 * @property {number} [maxBytes] hard cap; quality and then dimensions drop until the output fits
 * @property {number} [maxWidth]
 * @property {number} [maxHeight]
 * @property {boolean} [lossless]
 * @property {number} [effort] encoder effort, 0-9 for AVIF, 0-6 for WebP
 * @property {boolean} [keepMetadata] keep EXIF, ICC and XMP
 * @property {boolean} [animated] keep animation frames (default true)
 * @property {boolean} [keepSmaller] return the input untouched when it is already smaller and fits every limit (default true)
 */

/**
 * @typedef {object} ShrinkResult
 * @property {Buffer} data
 * @property {string} format
 * @property {number} width
 * @property {number} height
 * @property {number} frames
 * @property {number|null} quality
 * @property {boolean} kept true when the input was returned unchanged
 */

/**
 * @param {Buffer|Uint8Array} input
 * @param {ShrinkOptions} [options]
 * @returns {Promise<ShrinkResult>}
 */
export async function shrink(input, options = {}) {
  const o = { format: 'auto', animated: true, keepSmaller: true, ...options };
  if (!FORMATS.has(o.format)) throw new Error(`unknown format "${o.format}"`);
  for (const name of ['maxBytes', 'maxWidth', 'maxHeight']) {
    const value = o[name];
    if (value != null && (!Number.isFinite(value) || value <= 0)) throw new RangeError(`${name} must be a positive number`);
  }
  if (o.quality != null && (!Number.isInteger(o.quality) || o.quality < 1 || o.quality > 100)) {
    throw new RangeError('quality must be an integer from 1 to 100');
  }
  input = Buffer.from(input.buffer ?? input, input.byteOffset ?? 0, input.byteLength ?? input.length);

  const meta = await open(input, o.animated).metadata();
  if (!meta.format) throw new Error('unsupported image');
  const frames = o.animated ? (meta.pages ?? 1) : 1;
  const animated = frames > 1;
  const width = meta.autoOrient?.width ?? meta.width;
  const height = animated ? (meta.pageHeight ?? meta.height) : (meta.autoOrient?.height ?? meta.height);

  const format = o.format === 'auto' ? (animated ? 'webp' : 'avif') : animated ? 'webp' : o.format;
  if (o.lossless && format === 'jpeg') throw new Error('JPEG does not support lossless encoding');
  if (o.effort != null) {
    const maxEffort = format === 'webp' ? 6 : format === 'avif' ? 9 : 10;
    if (!Number.isInteger(o.effort) || o.effort < 0 || o.effort > maxEffort) {
      throw new RangeError(`effort must be an integer from 0 to ${maxEffort} for ${format}`);
    }
  }
  const sourceFormat = normalizeFormat(meta);

  const opaque = meta.hasAlpha ? (await open(input, false).stats()).isOpaque : true;
  const fit = boxScale(width, height, o.maxWidth, o.maxHeight);

  const encode = (scale, quality) => {
    let img = open(input, o.animated).autoOrient();
    const s = fit * scale;
    if (s < 1) img = img.resize(Math.max(1, Math.round(width * s)), Math.max(1, Math.round(height * s)), { fit: 'fill' });
    if (meta.hasAlpha && opaque && !animated) img = img.removeAlpha();
    if (o.keepMetadata) img = img.keepMetadata();
    return encoder(img, format, quality, o, meta, animated).toBuffer({ resolveWithObject: true });
  };

  let out;
  let quality = o.lossless ? null : (o.quality ?? QUALITY[format]);
  if (o.maxBytes) {
    out = await fitBytes(encode, o.maxBytes, o.lossless ? [null] : qualities(o.quality ?? QUALITY[format]));
    if (!out && canKeepInput(o, input, sourceFormat, format, fit)) {
      return { data: input, format: sourceFormat, width, height, frames, quality: null, kept: true };
    }
    if (!out) throw new Error(`cannot fit ${o.maxBytes} bytes`);
    quality = out.quality;
  } else {
    out = { ...(await encode(1, quality)), quality };
  }

  if (canKeepInput(o, input, sourceFormat, format, fit) && input.length <= out.data.length) {
    return { data: input, format: sourceFormat, width, height, frames, quality: null, kept: true };
  }
  return {
    data: out.data,
    format,
    width: out.info.width,
    height: animated ? (out.info.pageHeight ?? out.info.height / frames) : out.info.height,
    frames,
    quality,
    kept: false,
  };
}

function open(input, animated) {
  return sharp(input, { animated, limitInputPixels: LIMIT_PIXELS, failOn: 'error' });
}

function boxScale(w, h, maxW, maxH) {
  return Math.min(1, maxW ? maxW / w : 1, maxH ? maxH / h : 1);
}

function encoder(img, format, quality, o, meta, animated) {
  const lossless = !!o.lossless;
  switch (format) {
    case 'avif':
      return img.avif({ quality: quality ?? 50, lossless, effort: o.effort ?? 2, chromaSubsampling: lossless ? '4:4:4' : '4:2:0' });
    case 'webp':
      return img.webp({
        quality: quality ?? 75,
        lossless,
        effort: o.effort ?? 2,
        smartSubsample: true,
        ...(animated ? { loop: meta.loop ?? 0, delay: meta.delay } : {}),
      });
    case 'jpeg':
      return img.flatten({ background: '#ffffff' }).jpeg({ quality: quality ?? 78, mozjpeg: true });
    case 'png':
      return lossless || quality == null
        ? img.png({ compressionLevel: 9, effort: 10, adaptiveFiltering: true })
        : img.png({ palette: true, quality, effort: 10, compressionLevel: 9 });
  }
}

function qualities(start) {
  const list = [];
  for (let q = MIN_QUALITY; q <= start; q += 2) list.push(q);
  if (list.at(-1) !== start) list.push(start);
  return list;
}

async function fitBytes(encode, max, qs) {
  for (const scale of SCALES) {
    const first = await encode(scale, qs[0]);
    if (first.data.length > max) continue;
    let best = { ...first, quality: qs[0] };
    let lo = 1;
    let hi = qs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const out = await encode(scale, qs[mid]);
      if (out.data.length <= max) {
        best = { ...out, quality: qs[mid] };
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best) return best;
  }
  return null;
}

function normalizeFormat(meta) {
  if (meta.format === 'heif') return meta.compression === 'av1' ? 'avif' : 'heic';
  if (meta.format === 'tiff') return 'tiff';
  return meta.format;
}

function canKeepInput(o, input, sourceFormat, targetFormat, fit) {
  return o.keepSmaller && sourceFormat === targetFormat && fit === 1 &&
    (!o.maxBytes || input.length <= o.maxBytes) && !o.keepMetadata;
}

export const extensions = { avif: 'avif', heic: 'heic', webp: 'webp', jpeg: 'jpg', png: 'png', gif: 'gif', svg: 'svg', tiff: 'tif' };
