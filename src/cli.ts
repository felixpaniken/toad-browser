#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import { loadPage, clickAction, shutdown } from "./browser.ts";
import { extract, type Extracted } from "./extract.ts";
import { render, renderHeader, renderFooter, renderActions } from "./render.ts";
import {
  loadBookmarks,
  addBookmark,
  removeBookmarkAt,
  type Bookmark,
} from "./bookmarks.ts";
import { History, type HistoryEntry } from "./history.ts";
import { startSpinner } from "./spinner.ts";

type View =
  | { kind: "startpage"; bookmarks: Bookmark[]; links: string[] }
  | { kind: "page"; data: Extracted };

let current: View | null = null;
const history = new History();

function termWidth(): number {
  return Math.min(stdout.columns || 80, 100);
}

function normalizeUrl(input: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) return input;
  return "https://" + input;
}

async function buildStartpage(): Promise<View> {
  const bookmarks = await loadBookmarks();
  return { kind: "startpage", bookmarks, links: bookmarks.map((b) => b.url) };
}

async function buildPage(url: string): Promise<View> {
  const norm = normalizeUrl(url);
  const stop = startSpinner("Toading");
  try {
    const result = await loadPage(norm);
    const data = extract({
      html: result.html,
      baseUrl: result.finalUrl,
      actions: result.actions,
      consentDismissed: result.consentDismissed,
    });
    return { kind: "page", data };
  } finally {
    stop();
  }
}

async function performClick(actionId: number): Promise<View> {
  const stop = startSpinner("Toading");
  try {
    const result = await clickAction(actionId);
    const data = extract({
      html: result.html,
      baseUrl: result.finalUrl,
      actions: result.actions,
      consentDismissed: result.consentDismissed,
    });
    return { kind: "page", data };
  } finally {
    stop();
  }
}

function printStartpage(view: Extract<View, { kind: "startpage" }>): void {
  const w = termWidth();
  console.log();
  console.log(chalk.bold.cyan("🐸  Toad"));
  console.log(chalk.dim("─".repeat(w)));
  console.log();
  if (view.bookmarks.length === 0) {
    console.log(chalk.dim("  No bookmarks yet."));
    console.log(
      chalk.dim("  Try `:news.ycombinator.com` then `+` to bookmark it."),
    );
  } else {
    view.bookmarks.forEach((b, i) => {
      console.log(`  ${chalk.cyan(`[${i + 1}]`)} ${chalk.bold(b.title)}`);
      console.log(`      ${chalk.dim(b.url)}`);
    });
  }
  console.log();
  console.log(chalk.dim("─".repeat(w)));
  const count = view.bookmarks.length;
  console.log(
    chalk.dim(
      `${count} bookmark${count === 1 ? "" : "s"} · type a number · [-N] remove · [:]url · [?]help · [q]uit`,
    ),
  );
}

function printPage(view: Extract<View, { kind: "page" }>): void {
  const w = termWidth();
  const { data } = view;
  console.log();
  console.log(
    renderHeader(data.title, data.url, data.byline, data.isReaderMode, w),
  );
  if (data.consentDismissed) {
    console.log(chalk.dim(`(auto-dismissed cookie banner: "${data.consentDismissed}")`));
  }
  console.log();
  console.log(render(data.content, w));
  const actionsBlock = renderActions(data.actions, w);
  if (actionsBlock) console.log(actionsBlock);
  console.log();
  console.log(renderFooter(data.links.length, data.actions.length, w));
}

function printCurrent(): void {
  if (!current) return;
  if (current.kind === "startpage") printStartpage(current);
  else printPage(current);
}

async function navigate(entry: HistoryEntry, push: boolean): Promise<void> {
  if (entry.kind === "startpage") {
    current = await buildStartpage();
  } else {
    current = await buildPage(entry.url);
  }
  if (push) history.push(entry);
  printCurrent();
}

async function follow(n: number): Promise<void> {
  if (!current) return;
  const links =
    current.kind === "startpage" ? current.links : current.data.links;
  const url = links[n - 1];
  if (!url) {
    console.log(chalk.dim(`(no link ${n})`));
    return;
  }
  try {
    await navigate({ kind: "url", url }, true);
  } catch (err) {
    console.log(chalk.red(`Failed to load: ${(err as Error).message}`));
  }
}

function printHelp(): void {
  console.log();
  console.log(chalk.bold("Commands:"));
  console.log("  N         follow link/bookmark number N");
  console.log("  cN        click action (button) number N");
  console.log("  :URL      go to URL");
  console.log("  b         back");
  console.log("  f         forward");
  console.log("  r         reload current page");
  console.log("  +         bookmark current page");
  console.log("  -N        remove bookmark N (on startpage)");
  console.log("  s         go to startpage");
  console.log("  ?         this help");
  console.log("  q         quit");
  console.log();
}

async function dispatch(input: string): Promise<"continue" | "quit"> {
  const cmd = input.trim();
  if (!cmd) {
    printCurrent();
    return "continue";
  }

  if (cmd === "q" || cmd === "quit" || cmd === "exit") return "quit";
  if (cmd === "?" || cmd === "h" || cmd === "help") {
    printHelp();
    return "continue";
  }

  if (cmd === "b" || cmd === "back") {
    const e = history.back();
    if (!e) {
      console.log(chalk.dim("(no history)"));
      return "continue";
    }
    await navigate(e, false);
    return "continue";
  }

  if (cmd === "f" || cmd === "forward" || cmd === "fwd") {
    const e = history.forward();
    if (!e) {
      console.log(chalk.dim("(no forward history)"));
      return "continue";
    }
    await navigate(e, false);
    return "continue";
  }

  if (cmd === "r" || cmd === "reload") {
    const e = history.current();
    if (!e) return "continue";
    try {
      await navigate(e, false);
    } catch (err) {
      console.log(chalk.red(`Failed to reload: ${(err as Error).message}`));
    }
    return "continue";
  }

  if (cmd === "s" || cmd === "start") {
    await navigate({ kind: "startpage" }, true);
    return "continue";
  }

  if (cmd === "+") {
    if (current?.kind !== "page") {
      console.log(chalk.dim("(can only bookmark a real page)"));
      return "continue";
    }
    await addBookmark(current.data.url, current.data.title);
    console.log(chalk.green("Bookmarked."));
    return "continue";
  }

  const remove = cmd.match(/^-(\d+)$/);
  if (remove) {
    if (current?.kind !== "startpage") {
      console.log(chalk.dim("(only on startpage — type `s` to go there)"));
      return "continue";
    }
    const n = parseInt(remove[1]!, 10);
    await removeBookmarkAt(n - 1);
    await navigate({ kind: "startpage" }, false);
    return "continue";
  }

  if (cmd.startsWith(":")) {
    const url = cmd.slice(1).trim();
    if (!url) return "continue";
    try {
      await navigate({ kind: "url", url }, true);
    } catch (err) {
      console.log(chalk.red(`Failed to load: ${(err as Error).message}`));
    }
    return "continue";
  }

  if (/^\d+$/.test(cmd)) {
    await follow(parseInt(cmd, 10));
    return "continue";
  }

  const click = cmd.match(/^c(\d+)$/i);
  if (click) {
    if (current?.kind !== "page") {
      console.log(chalk.dim("(no page to click on)"));
      return "continue";
    }
    const id = parseInt(click[1]!, 10);
    const action = current.data.actions.find((a) => a.id === id);
    if (!action) {
      console.log(chalk.dim(`(no action c${id})`));
      return "continue";
    }
    const previousUrl = current.data.url;
    try {
      const newView = await performClick(id);
      current = newView;
      if (newView.kind === "page" && newView.data.url !== previousUrl) {
        history.push({ kind: "url", url: newView.data.url });
      }
      printCurrent();
    } catch (err) {
      console.log(chalk.red((err as Error).message));
    }
    return "continue";
  }

  if (cmd.includes(".") || cmd.includes("/")) {
    try {
      await navigate({ kind: "url", url: cmd }, true);
    } catch (err) {
      console.log(chalk.red(`Failed to load: ${(err as Error).message}`));
    }
    return "continue";
  }

  console.log(chalk.dim(`Unknown command: ${cmd}. Type ? for help.`));
  return "continue";
}

async function main(): Promise<void> {
  const arg = process.argv[2];

  try {
    if (arg) {
      await navigate({ kind: "url", url: arg }, true);
    } else {
      await navigate({ kind: "startpage" }, true);
    }
  } catch (err) {
    console.error(chalk.red(`Failed to load: ${(err as Error).message}`));
    console.log(chalk.dim("Falling back to startpage."));
    await navigate({ kind: "startpage" }, true);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });

  let quitting = false;
  const cleanExit = async (code = 0) => {
    if (quitting) return;
    quitting = true;
    rl.close();
    await shutdown();
    process.exit(code);
  };

  process.on("SIGINT", () => {
    console.log();
    void cleanExit(0);
  });

  while (true) {
    let input: string;
    try {
      input = await rl.question(chalk.green("toad> "));
    } catch {
      break;
    }
    let result: "continue" | "quit";
    try {
      result = await dispatch(input);
    } catch (err) {
      console.log(chalk.red((err as Error).message));
      result = "continue";
    }
    if (result === "quit") break;
  }

  await cleanExit(0);
}

main().catch(async (err) => {
  console.error(chalk.red(err.stack || err.message));
  await shutdown();
  process.exit(1);
});
