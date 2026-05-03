import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export type Bookmark = {
  url: string;
  title: string;
  addedAt: string;
};

const dir = join(homedir(), ".toad");
const file = join(dir, "bookmarks.json");

export async function loadBookmarks(): Promise<Bookmark[]> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (b): b is Bookmark =>
        typeof b?.url === "string" && typeof b?.title === "string",
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function save(bookmarks: Bookmark[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(bookmarks, null, 2) + "\n", "utf8");
}

export async function addBookmark(url: string, title: string): Promise<Bookmark[]> {
  const list = await loadBookmarks();
  if (list.some((b) => b.url === url)) return list;
  list.push({ url, title, addedAt: new Date().toISOString() });
  await save(list);
  return list;
}

export async function removeBookmarkAt(index: number): Promise<Bookmark[]> {
  const list = await loadBookmarks();
  if (index < 0 || index >= list.length) return list;
  list.splice(index, 1);
  await save(list);
  return list;
}
