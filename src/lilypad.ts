import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export type Lilypad = {
  hide: string[];
  content: string | null;
};

const dir = join(homedir(), ".toad", "lilypads");

function fileFor(hostname: string): string {
  return join(dir, `${hostname}.json`);
}

function normalize(hostname: string): string {
  return hostname.replace(/^www\./, "").toLowerCase();
}

function empty(): Lilypad {
  return { hide: [], content: null };
}

export async function loadLilypad(hostname: string): Promise<Lilypad> {
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

async function save(hostname: string, pad: Lilypad): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    fileFor(normalize(hostname)),
    JSON.stringify(pad, null, 2) + "\n",
    "utf8",
  );
}

export async function addHide(
  hostname: string,
  selector: string,
): Promise<Lilypad> {
  const pad = await loadLilypad(hostname);
  if (!pad.hide.includes(selector)) pad.hide.push(selector);
  await save(hostname, pad);
  return pad;
}

export async function removeHide(
  hostname: string,
  selector: string,
): Promise<Lilypad> {
  const pad = await loadLilypad(hostname);
  pad.hide = pad.hide.filter((s) => s !== selector);
  await save(hostname, pad);
  return pad;
}

export async function setContent(
  hostname: string,
  selector: string | null,
): Promise<Lilypad> {
  const pad = await loadLilypad(hostname);
  pad.content = selector;
  await save(hostname, pad);
  return pad;
}

export function lilypadPath(hostname: string): string {
  return fileFor(normalize(hostname));
}
