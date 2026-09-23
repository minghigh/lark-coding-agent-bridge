import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PREVIEW_DIMENSION = 1600;

export interface LinkedImage {
  path: string;
  preview: Buffer;
  originalSvg?: Buffer;
  fileName?: string;
}

/** Only explicitly linked images inside the run's workspace may be uploaded. */
export async function readLinkedImages(
  markdown: string,
  cwd: string,
): Promise<{ images: LinkedImage[]; skipped: number }> {
  const visible = markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const links = [...visible.matchAll(/!?\[[^\]\n]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)];
  if (links.length === 0) return { images: [], skipped: 0 };

  const root = await realpath(cwd);
  const images: LinkedImage[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const link of links) {
    const raw = link[1] ?? link[2] ?? '';
    let target: string;
    try {
      if (raw.startsWith('file://')) target = fileURLToPath(raw);
      else if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
      else target = decodeURIComponent(raw);
    } catch {
      skipped++;
      continue;
    }
    if (!IMAGE_EXTENSIONS.has(extname(target).toLowerCase())) continue;
    // ponytail: four inline previews per reply; raise this only if users need image galleries.
    if (images.length >= 4) { skipped++; continue; }

    try {
      const path = await realpath(resolve(root, target));
      if (!path.startsWith(`${root}${sep}`)) { skipped++; continue; }
      if (seen.has(path)) continue;
      seen.add(path);
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) { skipped++; continue; }
      const bytes = await readFile(path);
      if (extname(path).toLowerCase() !== '.svg') {
        images.push({ path, preview: bytes });
        continue;
      }

      const { Resvg } = await import('@resvg/resvg-js');
      const svg = new Resvg(bytes);
      const dimension = Math.max(svg.width, svg.height);
      if (!Number.isFinite(dimension) || dimension <= 0 || dimension > 100_000) {
        skipped++;
        continue;
      }
      const renderer = dimension > MAX_PREVIEW_DIMENSION
        ? new Resvg(bytes, { fitTo: { mode: 'zoom', value: MAX_PREVIEW_DIMENSION / dimension } })
        : svg;
      const preview = renderer.render().asPng();
      if (preview.length > MAX_IMAGE_BYTES) { skipped++; continue; }
      images.push({ path, preview, originalSvg: bytes, fileName: basename(path) });
    } catch {
      skipped++;
    }
  }
  return { images, skipped };
}
