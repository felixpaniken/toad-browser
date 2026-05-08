import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export type Burrow = {
  hide: string[];
  content: string | null;
};

const dir = join(homedir(), ".toad", "burrows");

function fileFor(hostname: string): string {
  return join(dir, `${hostname}.json`);
}

function normalize(hostname: string): string {
  return hostname.replace(/^www\./, "").toLowerCase();
}

function empty(): Burrow {
  return { hide: [], content: null };
}

export async function loadBurrow(hostname: string): Promise<Burrow> {
  const candidates = [hostname.toLowerCase(), normalize(hostname)];
  for (const name of candidates) {
    try {
      const raw = await readFile(fileFor(name), "utf8");
      const parsed = JSON.parse(raw);
      return {
        hide: Array.isArray(parsed.hide)
          ? parsed.hide.filter((s: unknown): s is string => typeof s === "string")
          : [],
        content: typeof parsed.content === "string" ? parsed.content : null,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return empty();
}

async function save(hostname: string, burrow: Burrow): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    fileFor(normalize(hostname)),
    JSON.stringify(burrow, null, 2) + "\n",
    "utf8",
  );
}

export async function addHide(
  hostname: string,
  selector: string,
): Promise<Burrow> {
  const burrow = await loadBurrow(hostname);
  if (!burrow.hide.includes(selector)) burrow.hide.push(selector);
  await save(hostname, burrow);
  return burrow;
}

export async function removeHide(
  hostname: string,
  selector: string,
): Promise<Burrow> {
  const burrow = await loadBurrow(hostname);
  burrow.hide = burrow.hide.filter((s) => s !== selector);
  await save(hostname, burrow);
  return burrow;
}

export async function setContent(
  hostname: string,
  selector: string | null,
): Promise<Burrow> {
  const burrow = await loadBurrow(hostname);
  burrow.content = selector;
  await save(hostname, burrow);
  return burrow;
}

export function burrowPath(hostname: string): string {
  return fileFor(normalize(hostname));
}
