export type HistoryEntry =
  | { kind: "url"; url: string }
  | { kind: "startpage" };

export class History {
  private stack: HistoryEntry[] = [];
  private cursor = -1;

  push(entry: HistoryEntry): void {
    this.stack = this.stack.slice(0, this.cursor + 1);
    this.stack.push(entry);
    this.cursor = this.stack.length - 1;
  }

  current(): HistoryEntry | null {
    return this.stack[this.cursor] ?? null;
  }

  back(): HistoryEntry | null {
    if (this.cursor <= 0) return null;
    this.cursor -= 1;
    return this.stack[this.cursor] ?? null;
  }

  forward(): HistoryEntry | null {
    if (this.cursor >= this.stack.length - 1) return null;
    this.cursor += 1;
    return this.stack[this.cursor] ?? null;
  }

  canBack(): boolean {
    return this.cursor > 0;
  }

  canForward(): boolean {
    return this.cursor < this.stack.length - 1;
  }
}
