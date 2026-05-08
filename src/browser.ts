import puppeteer, { type Browser, type Page } from "puppeteer";
import {
  linearizeInPage,
  type LinearizeOptions,
} from "./linearize-in-page.ts";

let browser: Browser | null = null;
let page: Page | null = null;

async function ensurePage(): Promise<Page> {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-domain-reliability",
        "--disable-sync",
        "--no-default-browser-check",
        "--no-first-run",
        "--no-pings",
        "--safebrowsing-disable-auto-update",
        "--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider",
        "--metrics-recording-only",
      ],
    });
  }
  if (!page) {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    );
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (type === "font" || type === "media") {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });
  }
  return page;
}

export type Action = { id: number; text: string };
export type Image = { id: number; src: string; alt: string };
export type Field = {
  id: number;
  kind: "text" | "textarea" | "checkbox";
  label: string;
  value: string;
  checked: boolean;
  isPassword: boolean;
};

export type LoadResult = {
  finalUrl: string;
  title: string;
  markdown: string;
  chromeMarkdown: string;
  links: string[];
  actions: Action[];
  images: Image[];
  fields: Field[];
  consentDismissed: string | null;
  httpStatus: number | null;
};

export type Diagnostics = {
  url: string;
  title: string;
  htmlBytes: number;
  bodyTextLength: number;
  totalElements: number;
  visibleElements: number;
  hiddenByDisplay: number;
  hiddenByVisibility: number;
  hiddenByOpacity: number;
  hiddenByZeroSize: number;
  hiddenByAria: number;
  iframeCount: number;
  iframeUrls: string[];
  shadowRootHosts: number;
  tagCounts: Record<string, number>;
};

const REJECT_PATTERNS: string[] = [
  // English
  "^(reject|decline|refuse|deny)( all| cookies)?$",
  "^(only|just) (necessary|essential|required)( cookies)?$",
  "^(necessary|essential)( cookies)? only$",
  "^continue without accepting$",
  // Swedish
  "^(avvisa|neka)( alla)?$",
  "^endast (tekniskt )?nödvändiga$",
  "^godkänn endast nödvändiga$",
  // German
  "^(alle )?ablehnen$",
  "^nur( technisch)? notwendige( cookies)?$",
  "^auswahl bestätigen$",
  // French
  "^tout refuser$",
  "^refuser( tout)?$",
  "^(uniquement|seulement) essentiels$",
  // Spanish
  "^rechazar( todo| todas)?$",
  "^solo (necesarias|esenciales)$",
  // Italian
  "^rifiuta( tutto)?$",
  "^solo (necessari|essenziali)$",
  // Norwegian / Danish
  "^(avvis|nei takk)( alle| alt)?$",
  "^kun nødvendige$",
  // Dutch
  "^(alles )?weigeren$",
  "^alleen noodzakelijke$",
];

async function dismissConsent(p: Page): Promise<string | null> {
  const result = await p
    .evaluate((patternSources) => {
      const regexes = patternSources.map((s: string) => new RegExp(s, "i"));
      const candidates = Array.from(
        document.querySelectorAll(
          'button, a, [role="button"], input[type="submit"], input[type="button"]',
        ),
      ) as HTMLElement[];
      for (const el of candidates) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") continue;
        const raw =
          el.textContent ||
          el.getAttribute("aria-label") ||
          (el as HTMLInputElement).value ||
          "";
        const text = raw.trim().replace(/\s+/g, " ");
        if (!text || text.length > 80) continue;
        if (regexes.some((r: RegExp) => r.test(text))) {
          el.click();
          return text;
        }
      }
      return null;
    }, REJECT_PATTERNS)
    .catch(() => null);

  if (result) {
    await new Promise((r) => setTimeout(r, 500));
  }
  return result;
}

async function unlazyImages(p: Page): Promise<void> {
  await p
    .evaluate(() => {
      // Flip lazy images to eager and copy any deferred URL into src.
      const candidates = ["data-src", "data-original", "data-lazy-src", "data-srcset"];
      for (const img of Array.from(document.querySelectorAll("img"))) {
        const el = img as HTMLImageElement;
        try {
          el.loading = "eager";
        } catch {
          /* readonly in some envs */
        }
        if (!el.src || el.src.startsWith("data:")) {
          for (const a of candidates) {
            const v = el.getAttribute(a);
            if (v && !v.startsWith("data:")) {
              if (a === "data-srcset") el.setAttribute("srcset", v);
              else el.setAttribute("src", v);
              break;
            }
          }
        }
      }
      // Nudge IntersectionObserver-based lazy loaders.
      const h = document.documentElement.scrollHeight;
      window.scrollTo(0, h);
      window.scrollTo(0, 0);
    })
    .catch(() => {});
  // Tiny grace period for lazy loaders to fire.
  await new Promise((r) => setTimeout(r, 300));
}

async function snapshot(
  p: Page,
  httpStatus: number | null,
  opts: LinearizeOptions = {},
): Promise<LoadResult> {
  const consentDismissed = await dismissConsent(p);
  await unlazyImages(p);
  const linearized = await p.evaluate(linearizeInPage, opts);
  return {
    finalUrl: p.url(),
    title: await p.title(),
    markdown: linearized.markdown,
    chromeMarkdown: linearized.chromeMarkdown,
    links: linearized.links,
    actions: linearized.actions,
    images: linearized.images,
    fields: linearized.fields,
    consentDismissed,
    httpStatus,
  };
}

export type LoadOpts = {
  resolveOptions?: (
    hostname: string,
  ) => Promise<LinearizeOptions> | LinearizeOptions;
};

async function resolveOpts(
  url: string,
  resolver: LoadOpts["resolveOptions"],
): Promise<LinearizeOptions> {
  if (!resolver) return {};
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* ignore */
  }
  return resolver(host);
}

async function clickAndSnapshot(
  selector: string,
  opts: LoadOpts = {},
): Promise<LoadResult> {
  const p = await ensurePage();
  const el = await p.$(selector);
  if (!el) throw new Error(`Element ${selector} no longer exists on page`);
  const navP = p
    .waitForNavigation({ waitUntil: "load", timeout: 10000 })
    .catch(() => null);
  try {
    await el.click();
  } catch {
    // Fall back to a DOM-level click for elements that Puppeteer's
    // real-mouse-click can't reach (offscreen, occluded, non-standard).
    await el.evaluate((e) => (e as HTMLElement).click());
  }
  const response = await Promise.race([
    navP,
    new Promise<null>((r) => setTimeout(() => r(null), 1000)),
  ]);
  const linOpts = await resolveOpts(p.url(), opts.resolveOptions);
  return snapshot(p, response?.status() ?? null, linOpts);
}

export async function loadPage(
  url: string,
  opts: LoadOpts = {},
): Promise<LoadResult> {
  const p = await ensurePage();
  const response = await p.goto(url, { waitUntil: "load", timeout: 15000 });
  const linOpts = await resolveOpts(p.url(), opts.resolveOptions);
  return snapshot(p, response?.status() ?? null, linOpts);
}

export async function clickAction(
  id: number,
  opts: LoadOpts = {},
): Promise<LoadResult> {
  return clickAndSnapshot(`[data-toad-action="${id}"]`, opts);
}

export async function fillField(id: number, value: string): Promise<boolean> {
  const p = await ensurePage();
  const selector = `[data-toad-field="${id}"]`;
  const el = await p.$(selector);
  if (!el) return false;
  try {
    await el.click({ clickCount: 3 }).catch(() => {});
    await p.keyboard.press("Backspace").catch(() => {});
    await el.type(value, { delay: 0 });
    return true;
  } catch {
    return false;
  }
}

export async function toggleField(id: number): Promise<boolean> {
  const p = await ensurePage();
  const selector = `[data-toad-field="${id}"]`;
  const el = await p.$(selector);
  if (!el) return false;
  try {
    await el.click();
    return true;
  } catch {
    return false;
  }
}

export type InspectResult = {
  found: true;
  text: string;
  self: { tag: string; selector: string };
  ancestors: {
    tag: string;
    selector: string;
    classes: string[];
    id: string | null;
    linkCount: number;
    actionCount: number;
  }[];
} | {
  found: false;
};

export async function inspect(targetSelector: string): Promise<InspectResult> {
  const p = await ensurePage();
  return p.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false } as const;

    function shortSelector(e: Element): string {
      const tag = e.tagName.toLowerCase();
      if (e.id) return `${tag}#${e.id}`;
      const classes = (e.className && typeof e.className === "string"
        ? e.className.trim().split(/\s+/).filter(Boolean)
        : []
      ).slice(0, 2);
      if (classes.length > 0) return `${tag}.${classes.join(".")}`;
      return tag;
    }

    function countWithin(
      e: Element,
    ): { linkCount: number; actionCount: number } {
      return {
        linkCount: e.querySelectorAll("[data-toad-link]").length,
        actionCount: e.querySelectorAll("[data-toad-action]").length,
      };
    }

    const text = (el.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);

    const ancestors: InspectResult extends infer R
      ? R extends { ancestors: infer A }
        ? A
        : never
      : never = [];
    let cur: Element | null = el.parentElement;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const counts = countWithin(cur);
      const classes =
        cur.className && typeof cur.className === "string"
          ? cur.className.trim().split(/\s+/).filter(Boolean)
          : [];
      ancestors.push({
        tag: cur.tagName.toLowerCase(),
        selector: shortSelector(cur),
        classes,
        id: cur.id || null,
        linkCount: counts.linkCount,
        actionCount: counts.actionCount,
      });
      cur = cur.parentElement;
    }

    return {
      found: true,
      text,
      self: { tag: el.tagName.toLowerCase(), selector: shortSelector(el) },
      ancestors,
    } as const;
  }, targetSelector);
}

export async function getImage(url: string): Promise<Buffer | null> {
  const p = await ensurePage();
  try {
    // Fetch from Node (no CORS rules), forwarding the page's cookies and a
    // matching User-Agent + Referer so we look like the same client.
    const cookies = await p.cookies(url);
    const cookieHeader = cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    const userAgent = await p
      .evaluate(() => navigator.userAgent)
      .catch(() => "");
    const headers: Record<string, string> = {
      Referer: p.url(),
    };
    if (cookieHeader) headers.Cookie = cookieHeader;
    if (userAgent) headers["User-Agent"] = userAgent;
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return Buffer.from(buf);
  } catch {
    return null;
  }
}

export async function scopedHideSelector(selector: string): Promise<string> {
  const p = await ensurePage();
  return p.evaluate((sel) => {
    let target: Element | null = null;
    try {
      target = document.querySelector(sel);
    } catch {
      return sel;
    }
    if (!target) return sel;

    const SEMANTIC_TAGS = new Set([
      "MAIN",
      "NAV",
      "ARTICLE",
      "SECTION",
      "ASIDE",
      "HEADER",
      "FOOTER",
    ]);

    function isUtilityClass(c: string): boolean {
      if (c.length <= 2) return true;
      // Tailwind-ish prefixes: text-, bg-, p-, m-, w-, gap-, flex-, etc.
      if (
        /^(text|bg|border|ring|shadow|opacity|p|m|w|h|gap|space|inset|top|left|right|bottom|max|min|grid|flex|col|row|items|justify|self|content|place|object|order|z|leading|tracking|font|whitespace|break|cursor|pointer|select|resize|scroll|overflow|overscroll|aspect|columns|divide|fill|stroke|backdrop|filter)-/.test(
          c,
        )
      )
        return true;
      // State variants: hover:, focus:, md:, dark:, etc.
      if (
        /^(hover|focus|active|disabled|group|peer|dark|light|md|sm|lg|xl|2xl|first|last|odd|even|empty|checked|visited|target):/.test(
          c,
        )
      )
        return true;
      // Layout primitives by exact match
      if (
        /^(flex|grid|block|inline|inline-block|inline-flex|hidden|relative|absolute|fixed|sticky|static|truncate|rounded|underline|overline|italic|uppercase|lowercase|capitalize|antialiased|visible|invisible|isolate|group|peer)$/.test(
          c,
        )
      )
        return true;
      // Numeric suffix (gap-05, mb-1, pl-4)
      if (/-\d+$/.test(c)) return true;
      // Auto-generated CSS-in-JS hashes
      if (/^(css|sc|jsx|emotion|styled)-[a-z0-9]{4,}$/i.test(c)) return true;
      if (/^_[a-zA-Z0-9]{5,}$/.test(c)) return true;
      return false;
    }

    function semanticClasses(el: Element): string[] {
      const raw =
        el.className && typeof el.className === "string"
          ? el.className.trim().split(/\s+/).filter(Boolean)
          : [];
      return raw.filter((c) => !isUtilityClass(c));
    }

    function ancestorSelector(el: Element): string | null {
      if (el.id) return "#" + CSS.escape(el.id);
      const semantic = semanticClasses(el);
      if (semantic.length > 0) {
        return "." + semantic.map((c) => CSS.escape(c)).join(".");
      }
      if (SEMANTIC_TAGS.has(el.tagName)) {
        return el.tagName.toLowerCase();
      }
      return null;
    }

    let cur: Element | null = target.parentElement;
    let depth = 0;
    while (
      cur &&
      cur !== document.body &&
      cur !== document.documentElement &&
      depth < 6
    ) {
      const ancestorSel = ancestorSelector(cur);
      if (ancestorSel) return `${ancestorSel} ${sel}`;
      cur = cur.parentElement;
      depth++;
    }
    return sel;
  }, selector);
}

export async function getDiagnostics(): Promise<Diagnostics> {
  const p = await ensurePage();
  return p.evaluate(() => {
    const all = Array.from(document.querySelectorAll("*"));
    const counts: Record<string, number> = {};
    let hiddenByDisplay = 0;
    let hiddenByVisibility = 0;
    let hiddenByOpacity = 0;
    let hiddenByZeroSize = 0;
    let hiddenByAria = 0;
    let visible = 0;
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      counts[tag] = (counts[tag] || 0) + 1;
      let isHidden = false;
      if (el.getAttribute("aria-hidden") === "true") {
        hiddenByAria++;
        isHidden = true;
      }
      const s = getComputedStyle(el);
      if (s.display === "none") {
        if (!isHidden) hiddenByDisplay++;
        isHidden = true;
      }
      if (s.visibility === "hidden") {
        if (!isHidden) hiddenByVisibility++;
        isHidden = true;
      }
      if (parseFloat(s.opacity || "1") < 0.05) {
        if (!isHidden) hiddenByOpacity++;
        isHidden = true;
      }
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        if (!isHidden) hiddenByZeroSize++;
        isHidden = true;
      }
      if (!isHidden) visible++;
    }
    const interesting = [
      "html",
      "body",
      "main",
      "article",
      "section",
      "header",
      "footer",
      "nav",
      "aside",
      "div",
      "p",
      "h1",
      "h2",
      "h3",
      "a",
      "button",
      "input",
      "img",
      "iframe",
      "form",
      "ul",
      "ol",
      "li",
      "table",
    ];
    const tagBreakdown: Record<string, number> = {};
    for (const t of interesting) {
      if (counts[t]) tagBreakdown[t] = counts[t];
    }
    const iframes = Array.from(
      document.querySelectorAll("iframe"),
    ) as HTMLIFrameElement[];
    const iframeUrls = iframes.map((f) => f.src).filter(Boolean).slice(0, 10);
    let shadowHosts = 0;
    for (const el of all) {
      if ((el as Element & { shadowRoot?: ShadowRoot }).shadowRoot) shadowHosts++;
    }
    return {
      url: location.href,
      title: document.title,
      htmlBytes: document.documentElement.outerHTML.length,
      bodyTextLength: (document.body?.innerText || "").length,
      totalElements: all.length,
      visibleElements: visible,
      hiddenByDisplay,
      hiddenByVisibility,
      hiddenByOpacity,
      hiddenByZeroSize,
      hiddenByAria,
      iframeCount: iframes.length,
      iframeUrls,
      shadowRootHosts: shadowHosts,
      tagCounts: tagBreakdown,
    };
  });
}

export async function shutdown(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
  }
}
