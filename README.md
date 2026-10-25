# shrinkpix

An open-source image converter for making large image collections smaller. It turns still images into AVIF by default and preserves animations as WebP. Set a maximum byte size per image and shrinkpix lowers quality, then dimensions, until it fits.

The same converter is available as a Node.js library and a command-line tool. It uses [Sharp](https://sharp.pixelplumbing.com/) and its libvips codecs.

## Install

```sh
npm install github:XFlexDev/shrinkpix
```

Requires Node.js 20.9 or newer.

## CLI

Convert a directory to AVIF, leaving the originals untouched:

```sh
npx shrinkpix ./stickers -o ./optimized
```

For 500,000 images, a hard cap of 24 KB per output reserves at most 12 GB for the main images:

```sh
npx shrinkpix ./stickers -o ./optimized --max-size 24kb --max-width 512
```

`--max-size` is a per-image cap. Shrinkpix tries lower quality first, then smaller dimensions. If it cannot meet a cap, it reports that file as failed rather than silently exceeding the cap. A smaller input is kept unchanged when it already uses the selected output format and meets the requested limits; pass `--force` to always re-encode.

```text
usage: shrinkpix <files or folders...> [options]

  -o, --out <dir>        output folder (default: next to each input)
  -f, --format <fmt>     auto | avif | webp | jpeg | png (default auto)
  -q, --quality <1-100>  encoder quality
  -s, --max-size <size>  hard cap per image, e.g. 24kb, 1.5mb
  -w, --max-width <px>   shrink to fit this width
  -h, --max-height <px>  shrink to fit this height
      --lossless         lossless encoding where supported
      --effort <n>       encoder effort, higher is smaller and slower
      --keep-metadata    retain EXIF, ICC and XMP
      --still            keep only the first animation frame
      --force            re-encode even if input is already smaller
      --overwrite        replace existing output files
  -j, --jobs <n>         parallel images (default: CPU count)
```

Examples:

```sh
# Explicit WebP at quality 82
shrinkpix photo.png -f webp -q 82 -o ./out

# Resize and keep animation, writing AVIF for stills and WebP for animations
shrinkpix ./uploads -o ./converted --max-width 512 --max-height 512

# Lossless WebP, no metadata
shrinkpix art.png -f webp --lossless -o ./out
```

Animations are written as WebP so frames, delays, and looping are retained. If an animation is explicitly requested in another format, WebP is still used rather than silently flattening it. `--still` opts into converting just the first frame.

## Library

```js
import { readFile, writeFile } from 'node:fs/promises';
import { shrink } from 'shrinkpix';

const input = await readFile('sticker.png');
const result = await shrink(input, {
  format: 'avif',
  maxBytes: 24 * 1024,
  maxWidth: 512,
  maxHeight: 512,
});

await writeFile(`sticker.${result.format}`, result.data);
console.log(`${result.width}x${result.height}, ${result.data.length} bytes`);
```

`shrink(input, options)` accepts a `Buffer` or `Uint8Array`. Options:

| option | default | meaning |
|---|---|---|
| `format` | `auto` | `auto`, `avif`, `webp`, `jpeg`, or `png`; `auto` selects AVIF for stills and WebP for animations |
| `quality` | format-dependent | lossy quality from 1 to 100; with `maxBytes`, this is the highest quality the search will try |
| `maxBytes` | unset | hard upper bound for the output file |
| `maxWidth`, `maxHeight` | unset | maximum output dimensions; aspect ratio is preserved |
| `lossless` | `false` | request lossless encoding where supported |
| `effort` | `2` | encoder effort; higher is slower and may reduce size |
| `keepMetadata` | `false` | retain EXIF, ICC and XMP metadata |
| `animated` | `true` | keep animation frames; set `false` to use only the first frame |
| `keepSmaller` | `true` | keep a smaller input when it already matches the chosen format and meets limits |

The result contains `data`, `format`, `width`, `height`, `frames`, `quality`, and `kept`.

### Supported inputs

PNG, JPEG, WebP, GIF, AVIF, HEIC/HEIF, TIFF, BMP, and SVG, subject to the codecs in the installed Sharp/libvips build. Animated inputs stay animated as WebP. Unsupported or malformed files reject with an error.

JPEG output flattens transparency against white. PNG output with a quality value uses palette quantization and is lossy; use `--lossless` for lossless PNG. Metadata is stripped by default. `maxBytes` can require visibly smaller dimensions or quality, and no converter can guarantee a specific byte cap at unchanged visual quality.

## Development

```sh
npm ci
npm test
```

## License

MIT. See [LICENSE](LICENSE).
