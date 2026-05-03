import chalk from "chalk";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visualLength(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

function wrapLine(text: string, width: number, indent = ""): string[] {
  if (!text.trim()) return [""];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = indent;
  const indentWidth = indent.length;
  for (const word of words) {
    if (visualLength(current) === indentWidth) {
      current += word;
    } else if (visualLength(current) + 1 + visualLength(word) <= width) {
      current += " " + word;
    } else {
      lines.push(current);
      current = indent + word;
    }
  }
  if (current.trim()) lines.push(current);
  return lines;
}

function styleInline(text: string): string {
  return text
    .replace(/`([^`\n]+)`/g, (_, c) => chalk.yellow(c))
    .replace(/\*\*([^*\n]+)\*\*/g, (_, c) => chalk.bold(c))
    .replace(/__([^_\n]+)__/g, (_, c) => chalk.bold(c))
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_, c) => chalk.italic(c))
    .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, (_, c) => chalk.italic(c))
    .replace(/\[(\d+)\]/g, (_, n) => chalk.cyan(`[${n}]`));
}

export function render(markdown: string, width: number): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let i = 0;
  let inCode = false;

  while (i < lines.length) {
    const raw = lines[i] ?? "";

    if (raw.startsWith("```")) {
      inCode = !inCode;
      i++;
      continue;
    }

    if (inCode) {
      out.push(chalk.dim("    " + raw));
      i++;
      continue;
    }

    if (!raw.trim()) {
      out.push("");
      i++;
      continue;
    }

    const heading = raw.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      if (level === 1) {
        out.push("");
        out.push(chalk.bold.cyan(text));
        out.push(chalk.cyan("─".repeat(Math.min(text.length, width))));
      } else if (level === 2) {
        out.push("");
        out.push(chalk.bold.green("## " + text));
      } else {
        out.push("");
        out.push(chalk.bold(text));
      }
      i++;
      continue;
    }

    if (/^[-*]\s+/.test(raw) || /^\d+\.\s+/.test(raw)) {
      const m = raw.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/)!;
      const baseIndent = m[1] ?? "";
      const marker = m[2] ?? "-";
      const body = m[3] ?? "";
      const prefix = `${baseIndent}${chalk.dim(marker)} `;
      const wrapped = wrapLine(
        styleInline(body),
        width,
        " ".repeat(prefix.length),
      );
      wrapped[0] = prefix + (wrapped[0] ?? "").trimStart();
      out.push(...wrapped);
      i++;
      continue;
    }

    if (raw.startsWith("> ")) {
      const body = raw.slice(2);
      const wrapped = wrapLine(styleInline(body), width - 2, "  ");
      for (const line of wrapped) {
        out.push(chalk.dim("│ ") + line.replace(/^ {2}/, ""));
      }
      i++;
      continue;
    }

    if (/^[-*_]{3,}\s*$/.test(raw)) {
      out.push(chalk.dim("─".repeat(width)));
      i++;
      continue;
    }

    let para = raw;
    while (
      i + 1 < lines.length &&
      lines[i + 1]?.trim() &&
      !lines[i + 1]!.match(/^(#{1,6}\s|>|[-*]\s|\d+\.\s|```|[-*_]{3,}$)/)
    ) {
      i++;
      para += " " + lines[i]!.trim();
    }
    out.push(...wrapLine(styleInline(para), width));
    i++;
  }

  return out.join("\n");
}

export function renderHeader(
  title: string,
  url: string,
  byline: string | null,
  isReader: boolean,
  width: number,
): string {
  const lines: string[] = [];
  lines.push(chalk.bold.cyan(title));
  const meta = [byline, new URL(url).hostname, isReader ? "reader" : "raw"]
    .filter(Boolean)
    .join(" · ");
  if (meta) lines.push(chalk.dim(meta));
  lines.push(chalk.dim("─".repeat(width)));
  return lines.join("\n");
}

import type { Action } from "./browser.ts";

export function renderActions(actions: Action[], width: number): string {
  if (actions.length === 0) return "";
  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.dim("─".repeat(width)));
  lines.push(chalk.bold("Actions"));
  for (const a of actions) {
    lines.push(`  ${chalk.magenta(`[c${a.id}]`)} ${a.text}`);
  }
  return lines.join("\n");
}

export function renderFooter(
  linkCount: number,
  actionCount: number,
  width: number,
  extra?: string,
): string {
  const parts = [
    `${linkCount} link${linkCount === 1 ? "" : "s"}`,
  ];
  if (actionCount > 0) {
    parts.push(`${actionCount} action${actionCount === 1 ? "" : "s"}`);
  }
  const counts = parts.join(" · ");
  const help = `${counts} · type N to follow${actionCount > 0 ? " · cN to click" : ""} · [b]ack [f]wd [r]eload [+]bookmark [:]url [?]help [q]uit`;
  return chalk.dim("─".repeat(width)) + "\n" + chalk.dim(help) +
    (extra ? "\n" + chalk.dim(extra) : "");
}
