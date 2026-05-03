import puppeteer, { type Browser, type Page } from "puppeteer";
import { linearizeInPage } from "./linearize-in-page.ts";

let browser: Browser | null = null;
let page: Page | null = null;

async function ensurePage(): Promise<Page> {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
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
  html: string;
  finalUrl: string;
  title: string;
  markdown: string;
  chromeMarkdown: string;
  links: string[];
  actions: Action[];
  consentDismissed: string | null;
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

async function snapshot(p: Page): Promise<LoadResult> {
  const consentDismissed = await dismissConsent(p);
  const linearized = await p.evaluate(linearizeInPage);
  const html = await p.content();
  return {
    html,
    finalUrl: p.url(),
    title: await p.title(),
    markdown: linearized.markdown,
    chromeMarkdown: linearized.chromeMarkdown,
    links: linearized.links,
    actions: linearized.actions,
    consentDismissed,
  };
}

async function clickAndSnapshot(selector: string): Promise<LoadResult> {
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
  await Promise.race([navP, new Promise((r) => setTimeout(r, 1000))]);
  return snapshot(p);
}

export async function loadPage(url: string): Promise<LoadResult> {
  const p = await ensurePage();
  await p.goto(url, { waitUntil: "load", timeout: 15000 });
  return snapshot(p);
}

export async function clickLink(id: number): Promise<LoadResult> {
  return clickAndSnapshot(`[data-toad-link="${id}"]`);
}

export async function clickAction(id: number): Promise<LoadResult> {
  return clickAndSnapshot(`[data-toad-action="${id}"]`);
}

export async function shutdown(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
  }
}
