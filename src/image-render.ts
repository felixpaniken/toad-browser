import { spawn, spawnSync } from "node:child_process";
import sharp from "sharp";

let chafaPath: string | null = null;
let chafaChecked = false;

export function detectChafa(): string | null {
  if (chafaChecked) return chafaPath;
  chafaChecked = true;
  const result = spawnSync("which", ["chafa"], { encoding: "utf8" });
  if (result.status === 0) {
    chafaPath = result.stdout.trim() || null;
  }
  return chafaPath;
}

export async function renderImage(
  bytes: Buffer,
  cols: number,
  rows: number,
): Promise<string> {
  const chafa = detectChafa();
  if (chafa) {
    return renderWithChafa(chafa, bytes, cols, rows);
  }
  return renderHalfBlocks(bytes, cols, rows);
}

function renderWithChafa(
  chafa: string,
  bytes: Buffer,
  cols: number,
  rows: number,
): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(chafa, ["--size", `${cols}x${rows}`, "-"]);
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", () => resolve(""));
    proc.on("close", () => resolve(out.replace(/\r/g, "").replace(/\n$/, "")));
    proc.stdin.end(bytes);
  });
}

async function renderHalfBlocks(
  bytes: Buffer,
  cols: number,
  rows: number,
): Promise<string> {
  // Each terminal cell renders 2 vertical pixels via the upper half-block.
  const targetWidth = cols;
  const targetHeight = rows * 2;
  let raw: { data: Buffer; info: sharp.OutputInfo };
  try {
    raw = await sharp(bytes)
      .resize(targetWidth, targetHeight, {
        fit: "inside",
        withoutEnlargement: false,
      })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    return "";
  }
  const { data, info } = raw;
  const w = info.width;
  const h = info.height;
  const stride = info.channels;
  const lines: string[] = [];
  for (let y = 0; y < h; y += 2) {
    let line = "";
    let lastFg = "";
    let lastBg = "";
    for (let x = 0; x < w; x++) {
      const topIdx = (y * w + x) * stride;
      const r1 = data[topIdx]!;
      const g1 = data[topIdx + 1]!;
      const b1 = data[topIdx + 2]!;
      const hasBottom = y + 1 < h;
      const botIdx = hasBottom ? ((y + 1) * w + x) * stride : topIdx;
      const r2 = hasBottom ? data[botIdx]! : 0;
      const g2 = hasBottom ? data[botIdx + 1]! : 0;
      const b2 = hasBottom ? data[botIdx + 2]! : 0;
      const fg = `${r1};${g1};${b1}`;
      const bg = `${r2};${g2};${b2}`;
      if (fg !== lastFg) {
        line += `\x1b[38;2;${fg}m`;
        lastFg = fg;
      }
      if (hasBottom && bg !== lastBg) {
        line += `\x1b[48;2;${bg}m`;
        lastBg = bg;
      }
      line += "▀";
    }
    line += "\x1b[0m";
    lines.push(line);
  }
  return lines.join("\n");
}
