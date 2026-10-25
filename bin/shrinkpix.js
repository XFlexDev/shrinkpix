#!/usr/bin/env node
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { extensions, shrink } from '../src/index.js';

const HELP = `shrinkpix: make images as small as possible

usage: shrinkpix <files or folders...> [options]

  -o, --out <dir>        output folder (default: next to each input)
  -f, --format <fmt>     auto | avif | webp | jpeg | png (default auto)
  -q, --quality <1-100>  encoder quality
  -s, --max-size <size>  hard size cap per image, e.g. 30kb, 1.5mb
  -w, --max-width <px>   shrink to fit this width
  -h, --max-height <px>  shrink to fit this height
      --lossless         lossless encoding
      --effort <n>       encoder effort, higher is smaller and slower
      --keep-metadata    keep EXIF, ICC and XMP
      --still            only keep the first frame of animations
      --force            always re-encode, even when the input is smaller
      --overwrite        replace existing output files
  -j, --jobs <n>         parallel images (default: CPU count)
`;

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    format: { type: 'string', short: 'f', default: 'auto' },
    quality: { type: 'string', short: 'q' },
    'max-size': { type: 'string', short: 's' },
    'max-width': { type: 'string', short: 'w' },
    'max-height': { type: 'string', short: 'h' },
    lossless: { type: 'boolean' },
    effort: { type: 'string' },
    'keep-metadata': { type: 'boolean' },
    still: { type: 'boolean' },
    force: { type: 'boolean' },
    overwrite: { type: 'boolean' },
    jobs: { type: 'string', short: 'j' },
    help: { type: 'boolean' },
  },
});

if (a.help || !positionals.length) {
  process.stdout.write(HELP);
  process.exit(a.help ? 0 : 2);
}

function bytes(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|k|mb|m)?$/i.exec(s.trim());
  if (!m) throw new Error(`bad size "${s}"`);
  const unit = { b: 1, k: 1000, kb: 1000, m: 1e6, mb: 1e6 }[(m[2] ?? 'b').toLowerCase()];
  return Math.floor(Number(m[1]) * unit);
}
const num = (v) => (v == null ? undefined : Number(v));

const opts = {
  format: a.format,
  quality: num(a.quality),
  maxBytes: a['max-size'] ? bytes(a['max-size']) : undefined,
  maxWidth: num(a['max-width']),
  maxHeight: num(a['max-height']),
  lossless: a.lossless,
  effort: num(a.effort),
  keepMetadata: a['keep-metadata'],
  animated: !a.still,
  keepSmaller: !a.force,
};
const jobsCount = num(a.jobs) ?? availableParallelism();
if (!Number.isInteger(jobsCount) || jobsCount < 1) throw new Error('--jobs must be a positive integer');

const INPUT = new Set(['.png', '.jpg', '.jpeg', '.jfif', '.webp', '.gif', '.avif', '.heic', '.heif', '.tif', '.tiff', '.svg', '.bmp']);
const jobs = [];
for (const p of positionals) {
  const root = resolve(p);
  if ((await stat(root)).isDirectory()) {
    for (const e of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (e.isFile() && INPUT.has(extname(e.name).toLowerCase())) {
        const file = join(e.parentPath, e.name);
        jobs.push({ file, rel: relative(root, file) });
      }
    }
  } else {
    jobs.push({ file: root, rel: basename(root) });
  }
}

const total = { files: 0, in: 0, out: 0, kept: 0, skipped: 0, failed: 0 };
const t0 = Date.now();
let next = 0;

async function exists(p) {
  return stat(p).then(() => true, () => false);
}

async function work() {
  while (next < jobs.length) {
    const { file, rel } = jobs[next++];
    try {
      const input = await readFile(file);
      const r = await shrink(input, opts);
      const ext = extensions[r.format] ?? r.format;
      const stem = rel.slice(0, rel.length - extname(rel).length);
      const target = a.out ? join(resolve(a.out), `${stem}.${ext}`) : join(dirname(file), `${basename(stem)}.${ext}`);
      if (target === file || (!a.overwrite && (await exists(target)))) {
        total.skipped++;
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, r.data);
      total.files++;
      total.in += input.length;
      total.out += r.data.length;
      if (r.kept) total.kept++;
      const pct = ((r.data.length / input.length) * 100).toFixed(0);
      console.log(`${rel}  ${fmt(input.length)} -> ${fmt(r.data.length)} (${pct}%) ${r.kept ? 'kept' : `${r.format}${r.quality ? ` q${r.quality}` : ''}`}`);
    } catch (e) {
      total.failed++;
      console.error(`${rel}: ${e.message}`);
    }
  }
}

function fmt(b) {
  return b >= 1e6 ? `${(b / 1e6).toFixed(2)} MB` : `${(b / 1e3).toFixed(1)} KB`;
}

await Promise.all(Array.from({ length: Math.min(jobsCount, jobs.length) }, work));
const pct = total.in ? ((total.out / total.in) * 100).toFixed(1) : '0';
console.log(
  `\n${total.files} images, ${fmt(total.in)} -> ${fmt(total.out)} (${pct}%) in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
    (total.kept ? `, ${total.kept} already smaller` : '') +
    (total.skipped ? `, ${total.skipped} skipped (exists, use --overwrite)` : '') +
    (total.failed ? `, ${total.failed} failed` : ''),
);
process.exitCode = total.failed ? 1 : 0;
