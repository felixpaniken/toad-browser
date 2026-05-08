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
      if (type === "image" || type === "font" || type === "media") {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });
  }
  return page;
}

export type Action = { id: number; text: string };

export type LoadResult = {
  finalUrl: string;
  title: string;
  markdown: string;
  chromeMarkdown: string;
  links: string[];
  actions: Action[];
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

async function snapshot(
  p: Page,
  httpStatus: number | null,
  opts: LinearizeOptions = {},
): Promise<LoadResult> {
  const consentDismissed = await dismissConsent(p);
  const linearized = await p.evaluate(linearizeInPage, opts);
  return {
    finalUrl: p.url(),
    title: await p.title(),
    markdown: linearized.markdown,
    chromeMarkdown: linearized.chromeMarkdown,
    links: linearized.links,
    actions: linearized.actions,
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
