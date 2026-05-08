#!/usr/bin/env node
import readline from "node:readline";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import {
  loadPage,
  clickAction,
  getDiagnostics,
  inspect,
  scopedHideSelector,
  shutdown,
  type LoadResult,
} from "./browser.ts";
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
import {
  loadBurrow,
  addHide,
  removeHide,
  setContent,
  burrowPath,
} from "./burrow.ts";

type View =
  | { kind: "startpage"; bookmarks: Bookmark[]; links: string[] }
  | { kind: "page"; load: LoadResult; data: Extracted };

let current: View | null = null;
const history = new History();

type Pager = {
  lines: string[];
  cursor: number;
  chromeLines: string[];
  helpLine: string;
  width: number;
};
let pager: Pager | null = null;

function chunkSize(): number {
  return Math.max(15, (stdout.rows || 30) - 8);
}

function printFooterBlock(p: Pager, isLast: boolean): void {
  if (isLast && p.chromeLines.length > 0) {
    console.log();
    console.log(chalk.dim("─".repeat(p.width)));
    console.log(chalk.bold.green("Page chrome"));
    for (const line of p.chromeLines) console.log(line);
  }
  console.log();
  console.log(chalk.dim("─".repeat(p.width)));
  console.log(p.helpLine);
  if (isLast) {
    console.log(chalk.dim(`(end · ${p.lines.length} lines)`));
  } else {
    console.log(
      chalk.dim(
        `(showing 1-${p.cursor} of ${p.lines.length} · type \`m\` for more)`,
      ),
    );
  }
}

function showNextChunk(): void {
  if (!pager) return;
  if (!stdout.isTTY) {
    for (let i = pager.cursor; i < pager.lines.length; i++) {
      console.log(pager.lines[i]);
    }
    pager.cursor = pager.lines.length;
    printFooterBlock(pager, true);
    pager = null;
    return;
  }
  const size = chunkSize();
  const end = Math.min(pager.cursor + size, pager.lines.length);
  for (let i = pager.cursor; i < end; i++) console.log(pager.lines[i]);
  pager.cursor = end;
  const isLast = end >= pager.lines.length;
  printFooterBlock(pager, isLast);
  if (isLast) pager = null;
}

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

function viewFromLoad(load: LoadResult): View {
  const data = extract(load);
  return { kind: "page", load, data };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function burrowOptionsFor(host: string): Promise<{
  hide: string[];
  content: string | null;
}> {
  if (!host) return { hide: [], content: null };
  const burrow = await loadBurrow(host);
  return { hide: burrow.hide, content: burrow.content };
}

async function buildPage(url: string): Promise<View> {
  const norm = normalizeUrl(url);
  const stop = startSpinner("Toading");
  try {
    const load = await loadPage(norm, {
      resolveOptions: (host) => burrowOptionsFor(host),
    });
    return viewFromLoad(load);
  } finally {
    stop();
  }
}

async function performClickAction(actionId: number): Promise<View> {
  const stop = startSpinner("Toading");
  try {
    const load = await clickAction(actionId, {
      resolveOptions: (host) => burrowOptionsFor(host),
    });
    return viewFromLoad(load);
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
  console.log(renderHeader(data.title, data.url, w));
  if (data.consentDismissed) {
    console.log(
      chalk.dim(`(auto-dismissed cookie banner: "${data.consentDismissed}")`),
    );
  }
  console.log();

  const bodyLines = render(data.content, w).split("\n");
  const actionsBlock = renderActions(data.actions, w);
  const lines = actionsBlock
    ? bodyLines.concat([""], actionsBlock.split("\n"))
    : bodyLines;
  const chromeLines = data.chrome ? render(data.chrome, w).split("\n") : [];
  const helpLine = renderFooter(data.links.length, data.actions.length, w);
  pager = { lines, cursor: 0, chromeLines, helpLine, width: w };
  showNextChunk();
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function printDebug(
  view: Extract<View, { kind: "page" }>,
): Promise<void> {
  const diag = await getDiagnostics();
  const status = view.load.httpStatus;
  console.log();
  console.log(chalk.bold.cyan("Debug"));
  console.log(chalk.dim("─".repeat(termWidth())));
  console.log(`  URL:           ${diag.url}`);
  console.log(`  Title:         ${diag.title || chalk.dim("(none)")}`);
  console.log(
    `  HTTP status:   ${
      status === null
        ? chalk.dim("(unknown)")
        : status >= 200 && status < 300
          ? chalk.green(String(status))
          : chalk.yellow(String(status))
    }`,
  );
  console.log(`  HTML size:     ${formatBytes(diag.htmlBytes)}`);
  console.log(`  Body text:     ${diag.bodyTextLength} chars`);
  console.log(
    `  DOM elements:  ${diag.totalElements} total · ${chalk.green(
      String(diag.visibleElements),
    )} visible · ${chalk.dim(
      String(diag.totalElements - diag.visibleElements),
    )} hidden`,
  );
  if (diag.totalElements - diag.visibleElements > 0) {
    const parts: string[] = [];
    if (diag.hiddenByDisplay) parts.push(`display:none ${diag.hiddenByDisplay}`);
    if (diag.hiddenByVisibility)
      parts.push(`visibility:hidden ${diag.hiddenByVisibility}`);
    if (diag.hiddenByOpacity) parts.push(`opacity<.05 ${diag.hiddenByOpacity}`);
    if (diag.hiddenByZeroSize)
      parts.push(`zero-size ${diag.hiddenByZeroSize}`);
    if (diag.hiddenByAria) parts.push(`aria-hidden ${diag.hiddenByAria}`);
    console.log(chalk.dim(`                 ${parts.join(" · ")}`));
  }
  if (diag.iframeCount > 0) {
    console.log(
      `  ${chalk.yellow("Iframes:")}      ${diag.iframeCount} (skipped by Toad)`,
    );
    for (const u of diag.iframeUrls.slice(0, 3)) {
      console.log(chalk.dim(`                 ${u}`));
    }
  }
  if (diag.shadowRootHosts > 0) {
    console.log(
      `  ${chalk.yellow("Shadow roots:")} ${diag.shadowRootHosts} (not traversed)`,
    );
  }
  console.log(`  Tags:`);
  const entries = Object.entries(diag.tagCounts);
  const lines: string[] = [];
  let cur = "    ";
  for (const [tag, count] of entries) {
    const item = `<${tag}>:${count}`;
    if (cur.length + item.length + 2 > termWidth()) {
      lines.push(cur);
      cur = "    ";
    }
    if (cur === "    ") cur += item;
    else cur += "  " + item;
  }
  if (cur.trim()) lines.push(cur);
  for (const l of lines) console.log(chalk.dim(l));
  console.log(
    `  Linearized:    ${view.data.links.length} links · ${view.data.actions.length} actions`,
  );
  if (view.data.consentDismissed) {
    console.log(
      `  Cookie banner: ${chalk.green("dismissed")} ("${view.data.consentDismissed}")`,
    );
  }
  console.log();
}

function printHelp(): void {
  console.log();
  console.log(chalk.bold("Commands:"));
  console.log("  N         follow link/bookmark number N");
  console.log("  cN        click action (button) number N");
  console.log("  m         next page of long output");
  console.log("  mm        rest of long output, all at once");
  console.log("  i N      inspect link N (or i cN for action N)");
  console.log("  :hide S  add selector S to this site's burrow");
  console.log("  :unhide S  remove selector S from this site's burrow");
  console.log("  :content S  set content root selector for this site");
  console.log("  :burrow  show this site's burrow rules");
  console.log("  :debug    show DOM/HTTP diagnostics for current page");
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

async function printInspect(token: string): Promise<void> {
  if (current?.kind !== "page") {
    console.log(chalk.dim("(no page to inspect)"));
    return;
  }
  let selector: string;
  let label: string;
  if (token.toLowerCase().startsWith("c")) {
    const id = parseInt(token.slice(1), 10);
    if (!Number.isFinite(id)) {
      console.log(chalk.dim(`(unknown target ${token})`));
      return;
    }
    selector = `[data-toad-action="${id}"]`;
    label = `action c${id}`;
  } else {
    const id = parseInt(token, 10);
    if (!Number.isFinite(id)) {
      console.log(chalk.dim(`(unknown target ${token})`));
      return;
    }
    selector = `[data-toad-link="${id}"]`;
    label = `link [${id}]`;
  }
  const result = await inspect(selector);
  if (!result.found) {
    console.log(chalk.dim(`(${label} no longer on page)`));
    return;
  }
  console.log();
  console.log(chalk.bold(`Inspect ${label}`));
  console.log(chalk.dim("─".repeat(termWidth())));
  console.log(`  Text:     "${result.text}"`);
  console.log(`  Element:  ${chalk.cyan(result.self.selector)}`);
  if (result.ancestors.length === 0) {
    console.log(chalk.dim("  (no ancestors above body)"));
  } else {
    console.log(`  Ancestors (closest first):`);
    for (const a of result.ancestors) {
      const counts: string[] = [];
      if (a.linkCount > 0)
        counts.push(`${a.linkCount} link${a.linkCount === 1 ? "" : "s"}`);
      if (a.actionCount > 0)
        counts.push(
          `${a.actionCount} action${a.actionCount === 1 ? "" : "s"}`,
        );
      const summary = counts.length > 0 ? chalk.dim(` — ${counts.join(", ")}`) : "";
      console.log(`    ${chalk.cyan(a.selector)}${summary}`);
    }
  }
  console.log(
    chalk.dim(`  type \`:hide <selector>\` to add a hide rule for this site`),
  );
  console.log();
}

function currentHostname(): string | null {
  if (current?.kind !== "page") return null;
  return hostnameOf(current.data.url);
}

async function printBurrow(): Promise<void> {
  const host = currentHostname();
  if (!host) {
    console.log(chalk.dim("(no page loaded)"));
    return;
  }
  const burrow = await loadBurrow(host);
  console.log();
  console.log(chalk.bold(`Burrow for ${host}`));
  console.log(chalk.dim(burrowPath(host)));
  if (burrow.hide.length === 0 && !burrow.content) {
    console.log(chalk.dim("  (no rules — add some with :hide or :content)"));
  } else {
    if (burrow.content) console.log(`  content: ${chalk.cyan(burrow.content)}`);
    if (burrow.hide.length > 0) {
      console.log(`  hide:`);
      for (const s of burrow.hide) console.log(`    ${chalk.cyan(s)}`);
    }
  }
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

  if (cmd === ":debug" || cmd === "debug") {
    if (current?.kind !== "page") {
      console.log(chalk.dim("(no page loaded — go somewhere first)"));
      return "continue";
    }
    try {
      await printDebug(current);
    } catch (err) {
      console.log(chalk.red((err as Error).message));
    }
    return "continue";
  }

  const inspectMatch = cmd.match(/^i\s+([cC]?\d+)$/);
  if (inspectMatch) {
    try {
      await printInspect(inspectMatch[1]!);
    } catch (err) {
      console.log(chalk.red((err as Error).message));
    }
    return "continue";
  }

  if (cmd === ":burrow" || cmd === "burrow") {
    await printBurrow();
    return "continue";
  }

  if (cmd.startsWith(":hide ")) {
    const host = currentHostname();
    if (!host) {
      console.log(chalk.dim("(no page loaded)"));
      return "continue";
    }
    const selector = cmd.slice(":hide ".length).trim();
    if (!selector) {
      console.log(chalk.dim("(usage: :hide <selector>)"));
      return "continue";
    }
    const scoped = await scopedHideSelector(selector);
    await addHide(host, scoped);
    console.log(
      chalk.green(`Added "${scoped}" to ${host}'s burrow. Reload (r) to apply.`),
    );
    return "continue";
  }

  if (cmd.startsWith(":unhide ")) {
    const host = currentHostname();
    if (!host) {
      console.log(chalk.dim("(no page loaded)"));
      return "continue";
    }
    const selector = cmd.slice(":unhide ".length).trim();
    if (!selector) {
      console.log(chalk.dim("(usage: :unhide <selector>)"));
      return "continue";
    }
    await removeHide(host, selector);
    console.log(
      chalk.green(`Removed "${selector}" from ${host}'s burrow. Reload (r) to apply.`),
    );
    return "continue";
  }

  if (cmd.startsWith(":content")) {
    const host = currentHostname();
    if (!host) {
      console.log(chalk.dim("(no page loaded)"));
      return "continue";
    }
    const rest = cmd.slice(":content".length).trim();
    if (!rest) {
      await setContent(host, null);
      console.log(
        chalk.green(`Cleared content selector for ${host}. Reload (r) to apply.`),
      );
    } else {
      await setContent(host, rest);
      console.log(
        chalk.green(`Set content selector for ${host} to "${rest}". Reload (r) to apply.`),
      );
    }
    return "continue";
  }

  if (cmd === "m" || cmd === "more") {
    if (!pager) {
      console.log(chalk.dim("(nothing more to show)"));
    } else {
      showNextChunk();
    }
    return "continue";
  }

  if (cmd === "mm" || cmd === "all") {
    if (!pager) {
      console.log(chalk.dim("(nothing more to show)"));
    } else {
      while (pager) showNextChunk();
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
      const newView = await performClickAction(id);
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

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: stdout.isTTY,
  });

  const queued: string[] = [];
  const waiters: ((line: string | null) => void)[] = [];
  let closed = false;

  rl.on("line", (line) => {
    if (waiters.length) waiters.shift()!(line);
    else queued.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()!(null);
  });

  function readLine(prompt: string): Promise<string | null> {
    if (queued.length) return Promise.resolve(queued.shift()!);
    if (closed) return Promise.resolve(null);
    if (stdout.isTTY) stdout.write(prompt);
    return new Promise((resolve) => waiters.push(resolve));
  }

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
    const input = await readLine(`🐸  ${chalk.green("toad>")} `);
    if (input === null) break;
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
