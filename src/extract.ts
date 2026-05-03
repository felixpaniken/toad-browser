import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { Action } from "./browser.ts";

export type Extracted = {
  title: string;
  byline: string | null;
  url: string;
  content: string;
  links: string[];
  actions: Action[];
  isReaderMode: boolean;
  consentDismissed: string | null;
};

export type ExtractInput = {
  html: string;
  baseUrl: string;
  actions: Action[];
  consentDismissed: string | null;
};

export function extract(input: ExtractInput): Extracted {
  const { html, baseUrl, actions, consentDismissed } = input;
  const dom = new JSDOM(html, { url: baseUrl });
  const doc = dom.window.document;

  const reader = new Readability(doc.cloneNode(true) as Document);
  const article = reader.parse();

  if (article && article.content) {
    const { content, links } = articleToMarkdown(article.content, baseUrl);
    return {
      title: article.title || doc.title || baseUrl,
      byline: article.byline ?? null,
      url: baseUrl,
      content,
      links,
      actions,
      isReaderMode: true,
      consentDismissed,
    };
  }

  const fallback = fallbackExtract(doc, baseUrl);
  return { ...fallback, actions, consentDismissed };
}

function articleToMarkdown(
  contentHtml: string,
  baseUrl: string,
): { content: string; links: string[] } {
  const links: string[] = [];
  const dom = new JSDOM(contentHtml, { url: baseUrl });
  const doc = dom.window.document;

  for (const img of Array.from(doc.querySelectorAll("img"))) {
    img.remove();
  }

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  const MEDIA_EXT = /\.(jpe?g|png|gif|svg|webp|wav|mp3|mp4|webm|ogg|pdf)(\?|#|$)/i;
  turndown.addRule("link", {
    filter: "a",
    replacement: (content, node) => {
      const el = node as unknown as HTMLAnchorElement;
      const href = el.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) {
        return content;
      }
      const text = content.trim();
      if (!text) return "";
      let resolved: string;
      try {
        resolved = new URL(href, baseUrl).toString();
      } catch {
        return text;
      }
      if (MEDIA_EXT.test(resolved)) return text;
      links.push(resolved);
      return `${text} [${links.length}]`;
    },
  });
  turndown.addRule("img", {
    filter: "img",
    replacement: () => "",
  });

  let md = turndown.turndown(doc.body.innerHTML);
  md = md.replace(/\\([\[\]_*`])/g, "$1");
  return { content: md.trim(), links };
}

function fallbackExtract(
  doc: Document,
  baseUrl: string,
): Omit<Extracted, "actions" | "consentDismissed"> {
  const links: string[] = [];
  const lines: string[] = [];
  const seen = new Set<string>();

  const anchors = Array.from(doc.querySelectorAll("a"));
  for (const a of anchors) {
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
    let resolved: string;
    try {
      resolved = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(resolved)) continue;
    const text = (a.textContent || "").trim().replace(/\s+/g, " ");
    if (!text || text.length > 200) continue;
    seen.add(resolved);
    links.push(resolved);
    lines.push(`- ${text} [${links.length}]`);
  }

  const heading = doc.querySelector("h1")?.textContent?.trim() || doc.title || baseUrl;
  const content =
    `_(no readable article found — showing links from page)_\n\n` +
    `# ${heading}\n\n` +
    (lines.length ? lines.join("\n") : "_no links on this page_");

  return {
    title: doc.title || baseUrl,
    byline: null,
    url: baseUrl,
    content,
    links,
    isReaderMode: false,
  };
}
