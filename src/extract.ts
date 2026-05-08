import type { Action, Field, Image, LoadResult } from "./browser.ts";

export type Extracted = {
  title: string;
  url: string;
  content: string;
  chrome: string;
  links: string[];
  actions: Action[];
  images: Image[];
  fields: Field[];
  consentDismissed: string | null;
};

export function extract(load: LoadResult): Extracted {
  return {
    title: load.title || load.finalUrl,
    url: load.finalUrl,
    content: load.markdown,
    chrome: load.chromeMarkdown,
    links: load.links,
    actions: load.actions,
    images: load.images,
    fields: load.fields,
    consentDismissed: load.consentDismissed,
  };
}
