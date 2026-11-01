/**
 * "About you" — a small, local fact store, and the masking that makes it safe
 * to put in a prompt.
 *
 * Atticus keeps `me.json` with categories, sources and a sensitive-value mask.
 * This is the same idea with a narrower surface: facts are typed, each one
 * records where it came from, and anything that looks like an identifier is
 * stored **masked** — the raw value never lands on disk, so it can never be
 * shipped to a model in a later turn by accident.
 *
 * Only the name and answer-style preferences travel with every request. Every
 * other category is attached only when the request (or the current screen)
 * mentions a matching word, so a birthday does not ride along with "what's my
 * battery".
 */

import { mutateJson, readJson } from "./automation/store";

export const PROFILE_FILE = "profile.json";
export const MAX_FACTS = 200;
export const MAX_VALUE_CHARS = 400;

export type FactCategory =
  "basics" | "contact" | "places" | "school_work" | "links" | "preferences" | "people" | "notes";

export const FACT_CATEGORIES: FactCategory[] = [
  "basics",
  "contact",
  "places",
  "school_work",
  "links",
  "preferences",
  "people",
  "notes",
];

/** Where a fact came from. "you" is the only source that can set a name. */
export type FactSource = "you" | "contacts" | "mail" | "learned";

export interface Fact {
  id: string;
  category: FactCategory;
  kind: string;
  /** Masked when sensitive — the raw value is never written. */
  value: string;
  source: FactSource;
  date: string;
  sensitive: boolean;
}

interface ProfileFile {
  version: 1;
  facts: Fact[];
}

const EMPTY: ProfileFile = { version: 1, facts: [] };

// ── Sensitive detection + masking ─────────────────────────────────────────

const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
const CARD = /\b(?:\d[ -]?){13,19}\b/;
const CVV = /\bcvv\s*:?\s*\d{3,4}\b/i;
const PASSWORD = /\b(password|passcode|api[ _-]?key|secret|token)\b\s*[:=]?\s*\S+/i;
const BANK = /\b(routing|account)\s*(?:number|#)?\s*:?\s*\d{4,}\b/i;

/**
 * True when a value must be masked. Deliberately broad: a false positive costs
 * one unhelpful fact, a false negative leaks an identifier into a prompt.
 */
export function isSensitive(value: string): boolean {
  return (
    SSN.test(value) ||
    CARD.test(value) ||
    CVV.test(value) ||
    PASSWORD.test(value) ||
    BANK.test(value)
  );
}

/** Keep the last four characters, hide the rest. */
export function maskValue(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length >= 4) {
    const last4 = digits.slice(-4);
    // Preserve a short readable prefix so the fact is still identifiable:
    // "visa ending 4242", "SSN ending 6789".
    const label = /visa|mastercard|amex/i.exec(trimmed)?.[0]?.toLowerCase();
    const kind = label ? `${label} ` : SSN.test(trimmed) ? "SSN " : "";
    return `•••• ${kind}ending ${last4}`.replace(/\s+/g, " ").trim();
  }
  return "•••• (hidden)";
}

// ── Store ─────────────────────────────────────────────────────────────────

function normalizeCategory(input: string): FactCategory {
  const value = input.trim().toLowerCase();
  const direct = FACT_CATEGORIES.find((category) => category === value);
  if (direct) return direct;
  if (value === "note") return "notes";
  if (value === "preference" || value === "answer_style") return "preferences";
  if (value === "work" || value === "school") return "school_work";
  throw new Error(`unknown category "${input}". Use one of: ${FACT_CATEGORIES.join(", ")}`);
}

export async function listFacts(root: string): Promise<Fact[]> {
  const file = await readJson<ProfileFile>(root, PROFILE_FILE, EMPTY);
  return file.version === 1 && Array.isArray(file.facts) ? file.facts : [];
}

/** Add a fact. Sensitive values are masked before they are stored. */
export async function addFact(params: {
  root: string;
  category: string;
  value: string;
  kind?: string;
  source?: FactSource;
  now?: Date;
}): Promise<Fact> {
  const raw = params.value.trim();
  if (!raw) throw new Error("a fact needs a value");
  if (raw.length > MAX_VALUE_CHARS) {
    throw new Error(`the fact is too long (max ${MAX_VALUE_CHARS} characters)`);
  }

  const category = normalizeCategory(params.category);
  const sensitive = isSensitive(raw);
  const now = params.now ?? new Date();

  const fact: Fact = {
    id: `pf_${now.getTime().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    category,
    kind: (params.kind ?? "").trim() || category,
    value: sensitive ? maskValue(raw) : raw,
    source: params.source ?? "you",
    date: now.toISOString().slice(0, 10),
    sensitive,
  };

  await mutateJson<ProfileFile>(params.root, PROFILE_FILE, EMPTY, (file) => {
    const facts = file.version === 1 && Array.isArray(file.facts) ? file.facts : [];
    if (facts.length >= MAX_FACTS) {
      throw new Error(`the profile already has ${MAX_FACTS} facts; forget one first`);
    }
    // Same category + same value is a duplicate, not a new fact.
    if (facts.some((entry) => entry.category === category && entry.value === fact.value)) {
      return file;
    }
    return { version: 1, facts: [...facts, fact] };
  });

  return fact;
}

export async function forgetFact(root: string, id: string): Promise<boolean> {
  let removed = false;
  await mutateJson<ProfileFile>(root, PROFILE_FILE, EMPTY, (file) => {
    const facts = file.version === 1 && Array.isArray(file.facts) ? file.facts : [];
    const kept = facts.filter((fact) => fact.id !== id);
    removed = kept.length !== facts.length;
    return { version: 1, facts: kept };
  });
  return removed;
}

/** Remove every fact from one source (e.g. everything imported from Contacts). */
export async function forgetSource(root: string, source: FactSource): Promise<number> {
  let removed = 0;
  await mutateJson<ProfileFile>(root, PROFILE_FILE, EMPTY, (file) => {
    const facts = file.version === 1 && Array.isArray(file.facts) ? file.facts : [];
    const kept = facts.filter((fact) => fact.source !== source);
    removed = facts.length - kept.length;
    return { version: 1, facts: kept };
  });
  return removed;
}

// ── Prompt context ────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "my",
  "me",
  "i",
  "you",
  "what",
  "whats",
  "who",
  "how",
  "do",
  "does",
  "can",
  "please",
  "please",
  "to",
  "of",
  "for",
  "and",
  "on",
  "in",
  "it",
  "this",
  "that",
  "with",
  "about",
  "tell",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

/**
 * The facts worth putting in this turn's prompt: name and answer-style always,
 * everything else only when the request or the on-screen text mentions it.
 */
export function profileContext(facts: Fact[], request = "", screen = ""): string {
  if (facts.length === 0) return "";
  const haystack = new Set([...words(request), ...words(screen)]);

  const always = facts.filter(
    (fact) =>
      (fact.category === "basics" &&
        (fact.kind === "name" || /answer|style|preference/i.test(fact.kind))) ||
      (fact.category === "preferences" && /answer|style/i.test(fact.kind)),
  );
  const matched = facts.filter(
    (fact) =>
      !always.includes(fact) &&
      [...words(`${fact.kind} ${fact.value} ${fact.category}`)].some((word) => haystack.has(word)),
  );

  const chosen = [...new Set([...always, ...matched])].slice(0, 12);
  if (chosen.length === 0) return "";
  return chosen
    .map(
      (fact) =>
        `- [${fact.category}${fact.sensitive ? ", masked" : ""}] ${fact.kind}: ${fact.value}`,
    )
    .join("\n");
}
