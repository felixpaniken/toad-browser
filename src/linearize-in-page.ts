export type LinearizeResult = {
  markdown: string;
  chromeMarkdown: string;
  links: string[];
  actions: { id: number; text: string }[];
};

// Runs inside Puppeteer's page context. Must be self-contained — no imports,
// no closures over outer variables. Walks the DOM and emits markdown-ish text
// with inline [N] link markers and [cN] action markers.
//
// Top-level <nav>/<header>/<footer>/<aside> get demoted to a "Page chrome"
// section after the main content. If <main> exists, it becomes the sole
// source for main content. Identical URLs share one number.
export function linearizeInPage(): LinearizeResult {
  const links: string[] = [];
  const actions: { id: number; text: string }[] = [];
  const linkMap = new Map<string, number>();

  type Section = { lines: string[]; buf: string };
  const main: Section = { lines: [], buf: "" };
  const chrome: Section = { lines: [], buf: "" };
  let active: Section = main;
  let walkMode: "main" | "chrome" = "main";

  const SKIP = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "SVG",
    "HEAD",
    "META",
    "LINK",
    "IFRAME",
    "CANVAS",
    "VIDEO",
    "AUDIO",
    "SOURCE",
    "PICTURE",
    "TEMPLATE",
    "OBJECT",
    "EMBED",
  ]);

  // Loose blocks get a blank line before/after — they're real boundaries
  // (sections, lists, tables, top-level headings).
  const BLOCK_LOOSE = new Set([
    "ARTICLE",
    "SECTION",
    "MAIN",
    "UL",
    "OL",
    "DETAILS",
  ]);
  // Tight blocks just flush the buffer — adjacent lines stay adjacent.
  // This is everything that wraps small bits of content (cards, captions,
  // form rows, paragraphs of summary text).
  const BLOCK_TIGHT = new Set([
    "P",
    "DIV",
    "FIGURE",
    "FIGCAPTION",
    "FORM",
    "FIELDSET",
    "ADDRESS",
    "DL",
    "DT",
    "DD",
  ]);

  const CHROME = new Set(["NAV", "HEADER", "FOOTER", "ASIDE"]);

  function pushBuf(): void {
    const t = active.buf.replace(/[ \t]+/g, " ").trim();
    if (t) active.lines.push(t);
    active.buf = "";
  }

  function blank(): void {
    pushBuf();
    if (active.lines.length > 0 && active.lines[active.lines.length - 1] !== "") {
      active.lines.push("");
    }
  }

  function isHidden(el: Element): boolean {
    if (el.getAttribute("aria-hidden") === "true") return true;
    if ((el as HTMLElement).hidden) return true;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return true;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return true;
    return false;
  }

  function isPageLevelChrome(el: Element): boolean {
    if (!CHROME.has(el.tagName)) return false;
    let p = el.parentElement;
    while (p) {
      const tn = p.tagName;
      if (tn === "ARTICLE" || tn === "MAIN") return false;
      if (CHROME.has(tn)) return false;
      p = p.parentElement;
    }
    return true;
  }

  function isUsableLinkText(text: string): boolean {
    const visible = text.replace(/[​-‍﻿]/g, "").trim();
    if (visible.length === 0) return false;
    if (visible.length === 1 && !/[\p{L}\p{N}]/u.test(visible)) return false;
    if (visible.length > 200) return false;
    return true;
  }

  function readLabel(el: Element): string {
    let text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (text) return text;
    const aria = (el.getAttribute("aria-label") || "").trim();
    if (aria) return aria;
    const title = (el.getAttribute("title") || "").trim();
    if (title) return title;
    const img = el.querySelector("img");
    if (img) {
      const alt = (img.getAttribute("alt") || "").trim();
      if (alt) return alt;
    }
    return "";
  }

  function walkChildren(el: Element): void {
    for (const child of Array.from(el.childNodes)) walk(child);
  }

  function walk(node: Node): void {
    if (node.nodeType === 3) {
      active.buf += (node.textContent || "").replace(/\s+/g, " ");
      return;
    }
    if (node.nodeType !== 1) return;

    const el = node as Element;
    const tag = el.tagName;

    if (SKIP.has(tag)) return;
    if (isHidden(el)) return;

    // In main pass, skip top-level chrome (it'll be rendered in the chrome pass)
    if (walkMode === "main" && isPageLevelChrome(el)) return;

    switch (tag) {
      case "H1":
      case "H2": {
        blank();
        const level = parseInt(tag.charAt(1), 10);
        active.buf = "#".repeat(level) + " ";
        walkChildren(el);
        pushBuf();
        blank();
        return;
      }
      case "H3":
      case "H4":
      case "H5":
      case "H6": {
        pushBuf();
        const level = parseInt(tag.charAt(1), 10);
        active.buf = "#".repeat(level) + " ";
        walkChildren(el);
        pushBuf();
        return;
      }
      case "A": {
        const href = el.getAttribute("href");
        if (
          !href ||
          href.startsWith("#") ||
          href.startsWith("javascript:") ||
          href.startsWith("mailto:") ||
          href.startsWith("tel:")
        ) {
          walkChildren(el);
          return;
        }
        let url: string;
        try {
          url = new URL(href, document.baseURI).toString();
        } catch {
          walkChildren(el);
          return;
        }
        const text = readLabel(el);
        if (!isUsableLinkText(text)) return;

        let n = linkMap.get(url);
        if (n === undefined) {
          links.push(url);
          n = links.length;
          linkMap.set(url, n);
        }
        el.setAttribute("data-toad-link", String(n));
        if (active.buf && !/\s$/.test(active.buf)) active.buf += " ";
        active.buf += text + " [" + n + "] ";
        return;
      }
      case "BUTTON":
      case "SUMMARY": {
        const text = readLabel(el);
        if (!text || text.length > 100) return;
        actions.push({ id: actions.length + 1, text });
        const n = actions.length;
        el.setAttribute("data-toad-action", String(n));
        if (active.buf && !/\s$/.test(active.buf)) active.buf += " ";
        active.buf += "[c" + n + "] " + text + " ";
        return;
      }
      case "INPUT": {
        const type = ((el as HTMLInputElement).type || "").toLowerCase();
        if (type === "submit" || type === "button") {
          let text = (el as HTMLInputElement).value || "";
          if (!text) text = el.getAttribute("aria-label") || "Submit";
          text = text.trim();
          if (!text || text.length > 100) return;
          actions.push({ id: actions.length + 1, text });
          const n = actions.length;
          el.setAttribute("data-toad-action", String(n));
          if (active.buf && !/\s$/.test(active.buf)) active.buf += " ";
          active.buf += "[c" + n + "] " + text + " ";
        }
        return;
      }
      case "STRONG":
      case "B": {
        active.buf += "**";
        walkChildren(el);
        active.buf += "**";
        return;
      }
      case "EM":
      case "I": {
        active.buf += "_";
        walkChildren(el);
        active.buf += "_";
        return;
      }
      case "CODE": {
        if (el.parentElement && el.parentElement.tagName === "PRE") {
          walkChildren(el);
          return;
        }
        active.buf += "`" + (el.textContent || "") + "`";
        return;
      }
      case "PRE": {
        blank();
        active.lines.push("```");
        const txt = el.textContent || "";
        for (const line of txt.split("\n")) active.lines.push(line);
        active.lines.push("```");
        blank();
        return;
      }
      case "BR": {
        pushBuf();
        return;
      }
      case "HR": {
        blank();
        active.lines.push("---");
        blank();
        return;
      }
      case "LI": {
        pushBuf();
        active.buf = "- ";
        walkChildren(el);
        pushBuf();
        return;
      }
      case "BLOCKQUOTE": {
        blank();
        const startIdx = active.lines.length;
        walkChildren(el);
        pushBuf();
        for (let i = startIdx; i < active.lines.length; i++) {
          if (active.lines[i] !== "") active.lines[i] = "> " + active.lines[i];
        }
        blank();
        return;
      }
      case "TABLE": {
        blank();
        const rows = el.querySelectorAll("tr");
        for (const row of Array.from(rows)) {
          const cells = Array.from(row.querySelectorAll("th, td"))
            .map((c) => (c.textContent || "").replace(/\s+/g, " ").trim())
            .filter(Boolean);
          if (cells.length) active.lines.push(cells.join(" | "));
        }
        blank();
        return;
      }
      case "IMG": {
        const alt = el.getAttribute("alt");
        if (alt && alt.trim()) {
          active.buf += "[image: " + alt.trim() + "]";
        }
        return;
      }
      default: {
        if (BLOCK_LOOSE.has(tag) || CHROME.has(tag)) {
          blank();
          walkChildren(el);
          blank();
        } else if (BLOCK_TIGHT.has(tag)) {
          pushBuf();
          walkChildren(el);
          pushBuf();
        } else {
          walkChildren(el);
        }
      }
    }
  }

  // Clear previous tags in case the page was already linearized
  document
    .querySelectorAll("[data-toad-link], [data-toad-action]")
    .forEach((el) => {
      el.removeAttribute("data-toad-link");
      el.removeAttribute("data-toad-action");
    });

  // Main pass: prefer <main> if present; otherwise walk body excluding top-level chrome
  const mainEl = document.querySelector("main");
  active = main;
  walkMode = "main";
  if (mainEl) {
    walk(mainEl);
  } else {
    walk(document.body);
  }
  pushBuf();

  // Chrome pass: collect clickables per top-level chrome element, render compact
  active = chrome;
  const CHROME_LABELS: Record<string, string> = {
    NAV: "Nav",
    HEADER: "Header",
    FOOTER: "Footer",
    ASIDE: "Aside",
  };

  function compactItems(root: Element): string[] {
    const items: string[] = [];
    function visit(node: Node): void {
      if (node.nodeType !== 1) return;
      const e = node as Element;
      const tag = e.tagName;
      if (SKIP.has(tag)) return;
      if (isHidden(e)) return;

      if (tag === "A") {
        const href = e.getAttribute("href");
        if (
          !href ||
          href.startsWith("#") ||
          href.startsWith("javascript:") ||
          href.startsWith("mailto:") ||
          href.startsWith("tel:")
        ) {
          for (const c of Array.from(e.childNodes)) visit(c);
          return;
        }
        let url: string;
        try {
          url = new URL(href, document.baseURI).toString();
        } catch {
          for (const c of Array.from(e.childNodes)) visit(c);
          return;
        }
        const text = readLabel(e);
        if (!isUsableLinkText(text)) return;

        let n = linkMap.get(url);
        if (n === undefined) {
          links.push(url);
          n = links.length;
          linkMap.set(url, n);
        }
        e.setAttribute("data-toad-link", String(n));
        items.push(`${text} [${n}]`);
        return;
      }

      if (tag === "BUTTON" || tag === "SUMMARY") {
        const text = readLabel(e);
        if (!text || text.length > 100) return;
        actions.push({ id: actions.length + 1, text });
        const n = actions.length;
        e.setAttribute("data-toad-action", String(n));
        items.push(`[c${n}] ${text}`);
        return;
      }

      if (tag === "INPUT") {
        const type = ((e as HTMLInputElement).type || "").toLowerCase();
        if (type === "submit" || type === "button") {
          let text = (e as HTMLInputElement).value || "";
          if (!text) text = e.getAttribute("aria-label") || "Submit";
          text = text.trim();
          if (!text || text.length > 100) return;
          actions.push({ id: actions.length + 1, text });
          const n = actions.length;
          e.setAttribute("data-toad-action", String(n));
          items.push(`[c${n}] ${text}`);
        }
        return;
      }

      for (const c of Array.from(e.childNodes)) visit(c);
    }
    visit(root);
    return items;
  }

  const allChromeRoots = Array.from(
    document.querySelectorAll("nav, header, footer, aside"),
  ).filter((el) => {
    if (mainEl && mainEl.contains(el)) return false;
    return isPageLevelChrome(el);
  });
  // Drop chrome elements nested inside another chrome root (will be rolled into the outer one)
  const chromeRoots = allChromeRoots.filter((el) => {
    return !allChromeRoots.some((other) => other !== el && other.contains(el));
  });

  for (const root of chromeRoots) {
    const items = compactItems(root);
    if (items.length === 0) continue;
    const label = CHROME_LABELS[root.tagName] || "Chrome";
    chrome.lines.push(`**${label}:** ${items.join(" · ")}`);
    chrome.lines.push("");
  }

  function clean(lines: string[]): string[] {
    const out: string[] = [];
    let prevBlank = false;
    for (const line of lines) {
      const isBlank = line === "";
      if (isBlank && prevBlank) continue;
      out.push(line);
      prevBlank = isBlank;
    }
    while (out.length && out[0] === "") out.shift();
    while (out.length && out[out.length - 1] === "") out.pop();
    return out;
  }

  const mainLines = clean(main.lines);
  const chromeLines = clean(chrome.lines);

  return {
    markdown: mainLines.join("\n"),
    chromeMarkdown: chromeLines.join("\n"),
    links,
    actions,
  };
}
