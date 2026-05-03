import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { Action, LoadResult } from "./browser.ts";

export type Mode = "page" | "reader";

export type Extracted = {
  title: string;
  byline: string | null;
  url: string;
  content: string;
  chrome: string;
  links: string[];
  actions: Action[];
  mode: Mode;
  consentDismissed: string | null;
  readerAvailable: boolean;
};

export function extract(load: LoadResult, mode: Mode): Extracted {
  if (mode === "reader") {
    const reader = readerView(load);
    if (reader) return reader;
    return { ...pageView(load), mode: "reader", readerAvailable: false };
  }
  return pageView(load);
}

function pageView(load: LoadResult): Extracted {
  return {
    title: load.title || load.finalUrl,
    byline: null,
    url: load.finalUrl,
    content: load.markdown,
    chrome: load.chromeMarkdown,
    links: load.links,
    actions: load.actions,
    mode: "page",
    consentDismissed: load.consentDismissed,
    readerAvailable: true,
  };
}

function readerView(load: LoadResult): Extracted | null {
  const dom = new JSDOM(load.html, { url: load.finalUrl });
  const reader = new Readability(dom.window.document.cloneNode(true) as Document);
  const article = reader.parse();
  if (!article || !article.content) return null;

  const links: string[] = [];
  const sub = new JSDOM(article.content, { url: load.finalUrl });
  const subDoc = sub.window.document;
  for (const img of Array.from(subDoc.querySelectorAll("img"))) img.remove();

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
        resolved = new URL(href, load.finalUrl).toString();
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

  let md = turndown.turndown(subDoc.body.innerHTML);
  md = md.replace(/\\([\[\]_*`.\-+!#])/g, "$1");

  return {
    title: article.title || load.title || load.finalUrl,
    byline: article.byline ?? null,
    url: load.finalUrl,
    content: md.trim(),
    chrome: "",
    links,
    actions: [],
    mode: "reader",
    consentDismissed: load.consentDismissed,
    readerAvailable: true,
  };
}
