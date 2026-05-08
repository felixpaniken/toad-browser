export type LinearizeResult = {
  markdown: string;
  chromeMarkdown: string;
  links: string[];
  actions: { id: number; text: string }[];
  images: { id: number; src: string; alt: string }[];
  fields: {
    id: number;
    kind: "text" | "textarea" | "checkbox";
    label: string;
    value: string;
    checked: boolean;
    isPassword: boolean;
  }[];
};

export type LinearizeOptions = {
  hide?: string[];
  content?: string | null;
};

// Runs inside Puppeteer's page context. Must be self-contained — no imports,
// no closures over outer variables. Walks the DOM and emits markdown-ish text
// with inline [N] link markers and [cN] action markers.
//
// Top-level <nav>/<header>/<footer>/<aside> get demoted to a "Page chrome"
// section after the main content. If <main> exists, it becomes the sole
// source for main content. Identical URLs share one number.
export function linearizeInPage(opts: LinearizeOptions = {}): LinearizeResult {
  const hideSelectors = (opts.hide || []).filter(Boolean);
  const contentSelector = opts.content || null;
  let hideMatcher: ((el: Element) => boolean) | null = null;
  if (hideSelectors.length > 0) {
    const combined = hideSelectors.join(", ");
    hideMatcher = (el: Element) => {
      try {
        return el.matches(combined);
      } catch {
        return false;
      }
    };
  }
  const links: string[] = [];
  const actions: { id: number; text: string }[] = [];
  const images: { id: number; src: string; alt: string }[] = [];
  const fields: {
    id: number;
    kind: "text" | "textarea" | "checkbox";
    label: string;
    value: string;
    checked: boolean;
    isPassword: boolean;
  }[] = [];
  const linkMap = new Map<string, number>();
  const imageMap = new Map<string, number>();

  function fieldLabel(el: Element): string {
    const id = el.getAttribute("id");
    if (id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      const text = lbl?.textContent?.replace(/\s+/g, " ").trim();
      if (text) return text;
    }
    let p: Element | null = el.parentElement;
    while (p) {
      if (p.tagName === "LABEL") {
        const own = (p.textContent || "").replace(/\s+/g, " ").trim();
        const inputText = (el.textContent || "").replace(/\s+/g, " ").trim();
        const stripped = own.replace(inputText, "").trim();
        if (stripped) return stripped;
        if (own) return own;
        break;
      }
      p = p.parentElement;
    }
    const aria = (el.getAttribute("aria-label") || "").trim();
    if (aria) return aria;
    const placeholder = (el.getAttribute("placeholder") || "").trim();
    if (placeholder) return placeholder;
    const name = (el.getAttribute("name") || "").trim();
    if (name) return name;
    return "";
  }

  function addField(
    el: Element,
    kind: "text" | "textarea" | "checkbox",
  ): number {
    const n = fields.length + 1;
    const isPassword =
      kind === "text" &&
      (el as HTMLInputElement).type?.toLowerCase() === "password";
    const value =
      kind === "checkbox"
        ? ""
        : ((el as HTMLInputElement | HTMLTextAreaElement).value || "");
    const checked =
      kind === "checkbox" && (el as HTMLInputElement).checked === true;
    fields.push({
      id: n,
      kind,
      label: fieldLabel(el),
      value,
      checked,
      isPassword,
    });
    el.setAttribute("data-toad-field", String(n));
    return n;
  }

  function addImage(el: Element): number | null {
    const src = el.getAttribute("src") || "";
    if (!src) return null;
    if (src.startsWith("data:")) return null; // skip inline base64 (icons, spacers)
    let resolved: string;
    try {
      resolved = new URL(src, document.baseURI).toString();
    } catch {
      return null;
    }
    // Skip tiny tracker pixels and decorative spacers by intrinsic size if known.
    const w = parseInt(el.getAttribute("width") || "", 10);
    const h = parseInt(el.getAttribute("height") || "", 10);
    if (
      Number.isFinite(w) &&
      Number.isFinite(h) &&
      w > 0 &&
      h > 0 &&
      (w < 32 || h < 32)
    ) {
      return null;
    }
    let n = imageMap.get(resolved);
    if (n === undefined) {
      const alt = (el.getAttribute("alt") || "").trim();
      n = images.length + 1;
      images.push({ id: n, src: resolved, alt });
      imageMap.set(resolved, n);
    }
    return n;
  }

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
    if (hideMatcher && hideMatcher(el)) return true;
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

  // Actions (buttons) prefer aria-label over text content. Many sites use
  // text-light buttons (icons, durations, prices) where aria-label carries
  // the real semantic meaning ("Listen to article 0:49 min" vs. "0:49").
  function readActionLabel(el: Element): string {
    const aria = (el.getAttribute("aria-label") || "").trim();
    if (aria) return aria;
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (text) return text;
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
    // <img> is allowed even if "hidden" — many sites lazy-load with zero size
    // until in viewport, but the URL is still there and we want it.
    if (tag !== "IMG" && isHidden(el)) return;

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
        const text = readActionLabel(el);
        if (!text || text.length > 100) return;
        actions.push({ id: actions.length + 1, text });
        const n = actions.length;
        el.setAttribute("data-toad-action", String(n));
        if (active.buf && !/\s$/.test(active.buf)) active.buf += " ";
        active.buf += "[c" + n + "] " + text + " ";
        return;
      }
      case "INPUT": {
        const input = el as HTMLInputElement;
        const type = (input.type || "text").toLowerCase();
        if (type === "submit" || type === "button") {
          const aria = (el.getAttribute("aria-label") || "").trim();
          let text = aria || input.value || "Submit";
          text = text.trim();
          if (!text || text.length > 100) return;
          actions.push({ id: actions.length + 1, text });
          const n = actions.length;
          el.setAttribute("data-toad-action", String(n));
          if (active.buf && !/\s$/.test(active.buf)) active.buf += " ";
          active.buf += "[c" + n + "] " + text + " ";
          return;
        }
        if (type === "hidden" || type === "file" || type === "image") return;
        if (input.disabled) return;
        if (type === "checkbox") {
          const n = addField(el, "checkbox");
          const f = fields[n - 1]!;
          const box = f.checked ? "☑" : "☐";
          if (active.buf && !/\s$/.test(active.buf)) active.buf += " ";
          active.buf += `[f${n}] ${box} ${f.label || ""} `.trimEnd() + " ";
          return;
        }
        if (type === "radio") return; // skip for now
        // text-like: text, search, email, url, tel, number, password, date...
        const n = addField(el, "text");
        const f = fields[n - 1]!;
        const display = f.isPassword
          ? f.value
            ? "•".repeat(Math.min(f.value.length, 12))
            : "(empty)"
          : f.value
            ? `"${f.value}"`
            : "(empty)";
        pushBuf();
        active.buf = f.label
          ? `${f.label}: [f${n}] ${display}`
          : `[f${n}] ${display}`;
        pushBuf();
        return;
      }
      case "TEXTAREA": {
        const ta = el as HTMLTextAreaElement;
        if (ta.disabled) return;
        const n = addField(el, "textarea");
        const f = fields[n - 1]!;
        const preview = f.value
          ? `"${f.value.replace(/\s+/g, " ").slice(0, 60)}${f.value.length > 60 ? "…" : ""}"`
          : "(empty)";
        pushBuf();
        active.buf = f.label
          ? `${f.label}: [f${n}] ${preview}`
          : `[f${n}] ${preview}`;
        pushBuf();
        return;
      }
      case "SELECT":
      case "OPTION":
        return; // not supported yet
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
        const n = addImage(el);
        if (n === null) return;
        const alt = (el.getAttribute("alt") || "").trim();
        pushBuf();
        active.buf = alt
          ? `[image: ${alt}] [i${n}]`
          : `[image] [i${n}]`;
        pushBuf();
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

  // Main pass: burrow's `content` selector overrides; else <main>; else body.
  let mainEl: Element | null = null;
  if (contentSelector) {
    try {
      mainEl = document.querySelector(contentSelector);
    } catch {
      mainEl = null;
    }
  }
  if (!mainEl) mainEl = document.querySelector("main");
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
        const text = readActionLabel(e);
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
          const aria = (e.getAttribute("aria-label") || "").trim();
          let text = aria || (e as HTMLInputElement).value || "Submit";
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
    images,
    fields,
  };
}
