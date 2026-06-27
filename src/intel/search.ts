/**
 * search.ts — find things by meaning, not by ID.
 *
 * The structured index answers "what references switch 5?"; this answers
 * "where is the blacksmith?" / "the dark forest" / "the sad dialogue" by
 * ranking the project's human-readable text — map names, NPC names, dialogue,
 * item/skill descriptions and notes — against a free-text query.
 *
 * It is a lexical ranker (offline, no embeddings, no extra deps): field-weighted
 * token + phrase matching. It is the structured/search split the roadmap asks
 * for (#5) and can later be backed by real embeddings without changing callers.
 */

import { readJson } from "../utils/fileHandler.js";
import type { RawCommand } from "./eventAst.js";

export interface SearchDoc {
  type: string;
  id: number;
  label: string;
  text: string;
  mapId?: number;
}

export interface SearchHit {
  type: string;
  id: number;
  label: string;
  score: number;
  snippet: string;
  mapId?: number;
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "and", "or", "is", "it",
  "el", "la", "los", "las", "un", "una", "de", "del", "y", "o", "en",
]);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9áéíóúñü]+/gi) ?? []).map((t) => t.toLowerCase());
}

function queryTerms(q: string): string[] {
  return [...new Set(tokenize(q).filter((t) => t.length > 1 && !STOPWORDS.has(t)))];
}

/** Rank docs against a query. Label matches weigh more than body matches; an
 *  exact phrase occurrence is a strong boost. Pure and deterministic. */
export function rankDocuments(docs: SearchDoc[], query: string, limit = 20): SearchHit[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const phrase = query.trim().toLowerCase();

  const hits: SearchHit[] = [];
  for (const doc of docs) {
    const label = doc.label.toLowerCase();
    const text = doc.text.toLowerCase();
    const labelTokens = tokenize(doc.label);
    const bodyTokens = tokenize(doc.text);
    let score = 0;
    for (const term of terms) {
      for (const tok of labelTokens) {
        if (tok === term) score += 6;
        else if (tok.startsWith(term) || term.startsWith(tok)) score += 2;
      }
      for (const tok of bodyTokens) {
        if (tok === term) score += 1.5;
        else if (tok.startsWith(term)) score += 0.3;
      }
    }
    if (phrase.length > 2) {
      if (label.includes(phrase)) score += 10;
      else if (text.includes(phrase)) score += 4;
    }
    if (score <= 0) continue;
    hits.push({ type: doc.type, id: doc.id, label: doc.label, mapId: doc.mapId, score: Math.round(score * 10) / 10, snippet: snippet(doc.text, terms) });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

function snippet(text: string, terms: string[]): string {
  if (!text) return "";
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) { const i = lower.indexOf(term); if (i !== -1 && (at === -1 || i < at)) at = i; }
  const start = at === -1 ? 0 : Math.max(0, at - 25);
  return (start > 0 ? "…" : "") + text.slice(start, start + 90).replace(/\s+/g, " ").trim() + (text.length > start + 90 ? "…" : "");
}

// ─── Document gathering from a real project ───

function dialogueOf(pages: unknown): string {
  if (!Array.isArray(pages)) return "";
  const parts: string[] = [];
  for (const page of pages) {
    const list = (page as Record<string, unknown>)?.list as RawCommand[] | undefined;
    if (!Array.isArray(list)) continue;
    for (const cmd of list) {
      const code = Number(cmd?.code);
      if (code === 401 || code === 405 || code === 108 || code === 408) {
        const v = (cmd.parameters ?? [])[0];
        if (typeof v === "string") parts.push(v);
      }
    }
  }
  return parts.join(" ");
}

function entityDocs(arr: unknown, type: string, textFields: string[]): SearchDoc[] {
  if (!Array.isArray(arr)) return [];
  const out: SearchDoc[] = [];
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    const text = textFields.map((f) => String(r[f] ?? "")).filter(Boolean).join(" ");
    out.push({ type, id: Number(r.id), label: String(r.name ?? ""), text });
  }
  return out;
}

/** Read the project and build the searchable document set. */
export async function gatherDocuments(projectPath: string): Promise<SearchDoc[]> {
  const docs: SearchDoc[] = [];
  const safe = async (f: string) => { try { return await readJson(projectPath, f); } catch { return null; } };

  docs.push(...entityDocs(await safe("Items.json"), "item", ["description", "note"]));
  docs.push(...entityDocs(await safe("Weapons.json"), "weapon", ["description", "note"]));
  docs.push(...entityDocs(await safe("Armors.json"), "armor", ["description", "note"]));
  docs.push(...entityDocs(await safe("Skills.json"), "skill", ["description", "note"]));
  docs.push(...entityDocs(await safe("Actors.json"), "actor", ["nickname", "profile", "note"]));
  docs.push(...entityDocs(await safe("Enemies.json"), "enemy", ["note"]));
  docs.push(...entityDocs(await safe("States.json"), "state", ["note"]));

  const commons = await safe("CommonEvents.json");
  if (Array.isArray(commons)) {
    for (const ce of commons) {
      if (!ce || typeof ce !== "object") continue;
      const c = ce as Record<string, unknown>;
      const list = Array.isArray(c.list) ? [{ list: c.list }] : [];
      docs.push({ type: "common_event", id: Number(c.id), label: String(c.name ?? ""), text: dialogueOf(list) });
    }
  }

  const infos = await safe("MapInfos.json");
  if (Array.isArray(infos)) {
    for (const info of infos) {
      if (!info || typeof info !== "object") continue;
      const id = Number((info as Record<string, unknown>).id);
      const name = String((info as Record<string, unknown>).name ?? "");
      const map = await safe(`Map${String(id).padStart(3, "0")}.json`) as Record<string, unknown> | null;
      if (!map) continue;
      docs.push({ type: "map", id, label: name, text: String(map.displayName ?? ""), mapId: id });
      const events = Array.isArray(map.events) ? map.events : [];
      for (const ev of events) {
        if (!ev || typeof ev !== "object") continue;
        const e = ev as Record<string, unknown>;
        docs.push({ type: "event", id: Number(e.id), label: String(e.name ?? ""), text: dialogueOf(e.pages), mapId: id });
      }
    }
  }

  return docs;
}
