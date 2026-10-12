// Category detection: an LLM interprets the facts collected from the company's own website.
//
// Guards, all deterministic:
//  - too little website text → fail before calling the model (nothing to ground on). The text is the
//    homepage facts plus, when those are too thin, a few more pages of the same site (category-pages.ts);
//  - the model must quote supporting phrases; each quote is checked on its own (evidenceQuoteSchema,
//    then found in the collected text) and dropped if it fails, so one over-long or extra quote can't
//    discard an otherwise valid category; with none left the category is rejected as unsupported;
//    at most MAX_EVIDENCE verified quotes are kept, however many the model returned;
//  - single-word generic categories ("Internet", "Technology") are rejected as too broad;
//  - confidence below MIN_CONFIDENCE fails rather than steering discovery the wrong way.

import { z } from "zod";
import { StepFailure } from "../utils/errors.js";
import { getLlmProvider, type LlmProvider } from "./llm.service.js";
import type { WebsiteResearch } from "../types/website.js";
import type { CategoryResult } from "../types/discovery.js";

export type CategoryErrorKind = "insufficient_evidence" | "low_confidence" | "unsupported" | "too_broad";
export class CategoryError extends StepFailure<CategoryErrorKind> {}

export const MIN_CONFIDENCE = 0.5;
export const MIN_WORDS = 40;
/** Visible text shown to the model: the homepage's, then any extra pages' in what's left. */
const MAX_CONTENT_CHARS = 6_000;
const MAX_HEADINGS = 40;

const BROAD = new Set([
  "agency", "business", "company", "consulting", "digital", "ecommerce", "internet", "it", "marketing",
  "media", "online", "services", "software", "startup", "tech", "technology", "web", "website",
]);

/** Verified quotes kept in the result: the stored limit. */
export const MAX_EVIDENCE = 5;
/**
 * Quotes read from a response. Strict decoding can't enforce array lengths (toStrictJsonSchema drops
 * maxItems), and Kittl's feature-heavy homepage drew 6–7 quotes against the limit of 5, which used to
 * fail the whole response. Extra quotes are ignored, never an error; only the first
 * MAX_EVIDENCE_CHECKED are checked against the page.
 */
export const MAX_EVIDENCE_CHECKED = 10;

/** One stored evidence quote. */
export const evidenceQuoteSchema = z.string().trim().min(3).max(200);

export const categorySchema = z.object({
  category: z.string().trim().min(3).max(80),
  subcategory: z.string().trim().min(3).max(100).nullable(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().trim().min(10).max(400),
  // Each quote is validated individually in detectCategory; extra quotes are ignored there.
  evidence: z.array(z.string()).min(1),
});

const SYSTEM = `You identify the market category a company competes in, using ONLY facts collected from its own website.
Do not use outside knowledge about the company. Do not score SEO, AEO or GEO.

Return:
- category: the market the company competes in, as buyers or analysts would name it, 2–5 words, e.g. "Digital Marketing Agency", "Project Management Software", "B2B Payments Platform". Not a single generic word ("Internet", "Technology", "Services"), and not a single feature or keyword from one sentence.
- subcategory: a more specific positioning supported by the website, e.g. "Technical Content Marketing Agency", or null if the website doesn't support one.
- confidence: 0–1, how clearly the website content supports the category.
- rationale: one short factual sentence (at most 40 words) tying the category to the evidence. No speculation.
- evidence: 1–5 short phrases (3–15 words each) copied VERBATIM from the website data below that support the category. Each phrase is one continuous piece of text from a single place: do not join phrases or use "…", and do not add more than 5.`;

// Dash variants the model writes for the page's "-": hyphen, non-breaking hyphen, figure dash, en/em
// dash, horizontal bar (U+2010–U+2015), minus sign, small/full-width hyphen-minus. gpt-oss often writes
// "AI‑Powered" with a non-breaking hyphen.
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;

/** Same text, consistent punctuation: dash variants → "-", curly → straight quotes, no soft hyphens, single spaces. */
export const cleanText = (s: string) =>
  s
    .normalize("NFC")
    .replace(/\u00AD/g, "")
    .replace(DASHES, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** For comparisons only. */
const normalizeText = (s: string) => cleanText(s).toLowerCase();

/** A quote as stored: cleaned, without wrapping quote marks or trailing punctuation. */
const cleanQuote = (s: string) => cleanText(s).replace(/^[\s"'.,…]+|[\s"'.,…]+$/g, "");

/** JSON-LD items worth showing the model: their type, name and description. */
function structuredSummary(website: WebsiteResearch) {
  return website.structuredData.items
    .flatMap((i) => (Array.isArray((i as { "@graph"?: unknown })["@graph"]) ? ((i as { "@graph": unknown[] })["@graph"]) : [i]))
    .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
    .map((i) => ({
      type: i["@type"],
      name: typeof i.name === "string" ? i.name : undefined,
      description: typeof i.description === "string" ? i.description.slice(0, 400) : undefined,
    }))
    .filter((i) => i.name || i.description)
    .slice(0, 8);
}

/** Visible text of another page of the company's own site (or of the homepage as rendered). */
export interface CategoryPage {
  url: string;
  text: string;
}

/** Everything the model is shown, which is also the text its quotes are checked against. */
export function categoryEvidence(companyName: string, domain: string, website: WebsiteResearch, pages: CategoryPage[] = []) {
  const visibleText = website.content.slice(0, MAX_CONTENT_CHARS);
  let budget = MAX_CONTENT_CHARS - visibleText.length;
  const extra: CategoryPage[] = [];
  for (const p of pages) {
    const text = cleanText(p.text).slice(0, budget);
    if (text) extra.push({ url: p.url, text });
    budget -= text.length;
  }
  return {
    companyName,
    domain,
    title: website.title,
    metaDescription: website.description,
    openGraph: { title: website.openGraph["og:title"] ?? null, description: website.openGraph["og:description"] ?? null },
    headings: website.headings.slice(0, MAX_HEADINGS).map((h) => `h${h.level}: ${h.text}`),
    structuredData: structuredSummary(website),
    visibleText,
    // Only present when used, so a normal homepage's request is unchanged.
    ...(extra.length ? { otherPages: extra } : {}),
  };
}

/** The normalized text quotes are checked against, and its word count (MIN_WORDS applies to it). */
export function categoryCorpus(evidence: ReturnType<typeof categoryEvidence>) {
  const corpus = normalizeText(
    [evidence.title, evidence.metaDescription, evidence.openGraph.title, evidence.openGraph.description, ...evidence.headings, ...evidence.structuredData.map((s) => `${s.name ?? ""} ${s.description ?? ""}`), evidence.visibleText, ...(evidence.otherPages ?? []).map((p) => p.text)]
      .filter(Boolean)
      .join("\n"),
  );
  return { corpus, words: corpus.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)).length };
}

export interface DetectCategoryInput {
  companyName: string;
  domain: string;
  website: WebsiteResearch;
  /** Extra same-site text, collected only when the homepage alone is too thin (category-pages.ts). */
  pages?: CategoryPage[];
}

export async function detectCategory({ companyName, domain, website, pages }: DetectCategoryInput, llm?: LlmProvider): Promise<CategoryResult> {
  const evidence = categoryEvidence(companyName, domain, website, pages);
  const { corpus, words } = categoryCorpus(evidence);
  if (words < MIN_WORDS) throw new CategoryError("insufficient_evidence", `Only ${words} words of website text`);

  const provider = llm ?? getLlmProvider();
  const out = await provider.generateObject({
    name: "company_category",
    system: SYSTEM,
    user: `Website data (JSON):\n${JSON.stringify(evidence)}`,
    schema: categorySchema,
    // Structured extraction: low reasoning suffices (~0.2k output tokens measured); the cap counts against Groq TPM.
    reasoningEffort: "low",
    maxCompletionTokens: 1024,
  });

  const verified = new Map<string, string>(); // normalized → stored, first occurrence wins
  for (const q of out.evidence.slice(0, MAX_EVIDENCE_CHECKED).map(cleanQuote)) {
    const key = normalizeText(q);
    if (!verified.has(key) && evidenceQuoteSchema.safeParse(q).success && corpus.includes(key)) verified.set(key, q);
  }
  if (!verified.size) throw new CategoryError("unsupported", `None of ${out.evidence.length} evidence quotes are valid and occur in the website text`);

  const categoryWords = normalizeText(out.category).split(/[^a-z0-9]+/).filter(Boolean);
  if (categoryWords.length <= 1 && BROAD.has(categoryWords[0] ?? "")) throw new CategoryError("too_broad", `Category "${out.category}" is too broad`);

  if (out.confidence < MIN_CONFIDENCE) throw new CategoryError("low_confidence", `Confidence ${out.confidence} below ${MIN_CONFIDENCE}`);

  return {
    category: out.category,
    subcategory: out.subcategory && normalizeText(out.subcategory) !== normalizeText(out.category) ? out.subcategory : null,
    confidence: out.confidence,
    rationale: out.rationale,
    evidence: [...verified.values()].slice(0, MAX_EVIDENCE),
    model: `${provider.name}:${provider.model}`,
    detectedAt: new Date().toISOString(),
  };
}
