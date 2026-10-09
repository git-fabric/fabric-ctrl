/**
 * resolve/matcher.ts — intent → tool candidates (AI-ADR-013 rule 5)
 *
 * Pluggable: the lexical matcher runs until Qdrant is deployed. Everything
 * here is deterministic: same intent and inventory, same ranked matches.
 */

import type { CapabilityRecord } from "./schema.js";

export interface Match {
  record: CapabilityRecord;
  /** 0–1: share of the intent's weighted terms that this tool covers */
  score: number;
}

export interface Selection {
  /** Tools in pick order; each one covers intent terms the earlier picks did not */
  matches: Match[];
  /** 0–1: share of the intent's weighted terms the selected tools cover together */
  coverage: number;
}

export interface Matcher {
  kind: "lexical" | "semantic";
  match(intent: string, records: CapabilityRecord[]): Match[];
  /** Smallest set of tools that together cover the intent (greedy set cover) */
  select(intent: string, records: CapabilityRecord[], maxTools: number): Selection;
  /** Intent terms that no tool in the inventory mentions */
  unknownTerms(intent: string, records: CapabilityRecord[]): string[];
}

const STOPWORDS = new Set(
  ("a an the and or but of to in on onto into for from with by at as is are be was were it its this that " +
   "these those my our your me we us i you can could would should please all any some each every what " +
   "which who whom how when where why do does did done get show give tell find let make sure then there " +
   "via over about up out just also only now new one two").split(" "),
);

/** Small, fixed alias table: intent word → word the tool descriptions use */
const ALIASES: Record<string, string> = {
  restart: "reboot", remove: "delete", rm: "delete", kill: "stop", halt: "stop",
  machine: "vm", vms: "vm", qemu: "vm", lxc: "container",
  kubernetes: "k8s", k3s: "k8s", kube: "k8s",
  vulnerability: "cve", vulnerabilities: "cve", vuln: "cve", vulns: "cve",
  repository: "repo", repositories: "repo", pr: "pull", prs: "pull",
  tailnet: "tailscale",
};

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ied")) return word.slice(0, -3) + "y";
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .map((w) => stem(ALIASES[w] ?? w));
}

/** A marginal pick must cover at least this share of the intent */
const MIN_GAIN = 0.15;

function docTerms(r: CapabilityRecord): Set<string> {
  return new Set([...terms(r.app), ...terms(r.tool), ...terms(r.description)]);
}

/** Tool-name terms without the app prefix: pve_list_vms → [list, vm] */
function nameTerms(r: CapabilityRecord): string[] {
  return terms(r.tool.split("_").slice(1).join(" "));
}

interface Scored {
  record: CapabilityRecord;
  doc: Set<string>;
  /** share of the tool's own name the intent mentions; breaks ties toward the specific tool */
  namePrecision: number;
}

function prepare(intent: string, records: CapabilityRecord[]) {
  const query = [...new Set(terms(intent))];
  const docs = records.map(docTerms);
  const n = docs.length;
  const weights = new Map(
    query.map((t) => {
      const df = docs.reduce((c, d) => c + (d.has(t) ? 1 : 0), 0);
      return [t, Math.log(1 + n / Math.max(df, 1))] as const; // unknown terms weigh as much as the rarest
    }),
  );
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  const scored: Scored[] = records.map((record, i) => {
    const names = nameTerms(record);
    return {
      record,
      doc: docs[i],
      namePrecision: names.length ? names.filter((t) => weights.has(t)).length / names.length : 0,
    };
  });
  return { weights, total, scored };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

function byGain(gain: (s: Scored) => number) {
  return (a: Scored, b: Scored) =>
    gain(b) - gain(a) ||
    b.namePrecision - a.namePrecision ||
    a.doc.size - b.doc.size ||
    a.record.tool.localeCompare(b.record.tool);
}

export const lexicalMatcher: Matcher = {
  kind: "lexical",

  match(intent, records) {
    const { weights, total, scored } = prepare(intent, records);
    if (total === 0) return [];
    const score = (s: Scored) => [...weights].reduce((c, [t, w]) => c + (s.doc.has(t) ? w : 0), 0) / total;
    return scored
      .filter((s) => score(s) > 0)
      .sort(byGain(score))
      .map((s) => ({ record: s.record, score: round(score(s)) }));
  },

  select(intent, records, maxTools) {
    const { weights, total, scored } = prepare(intent, records);
    if (total === 0) return { matches: [], coverage: 0 };
    const remaining = new Map(weights);
    const score = (s: Scored) => [...weights].reduce((c, [t, w]) => c + (s.doc.has(t) ? w : 0), 0) / total;
    const gain = (s: Scored) => [...remaining].reduce((c, [t, w]) => c + (s.doc.has(t) ? w : 0), 0) / total;

    const matches: Match[] = [];
    let pool = scored;
    while (remaining.size > 0 && matches.length < maxTools) {
      const [best] = [...pool].sort(byGain(gain));
      if (!best || gain(best) < (matches.length === 0 ? Number.EPSILON : MIN_GAIN)) break;
      matches.push({ record: best.record, score: round(score(best)) });
      for (const t of [...remaining.keys()]) if (best.doc.has(t)) remaining.delete(t);
      pool = pool.filter((s) => s !== best);
    }
    const uncovered = [...remaining.values()].reduce((a, b) => a + b, 0);
    return { matches, coverage: round(1 - uncovered / total) };
  },

  unknownTerms(intent, records) {
    const vocab = new Set(records.flatMap((r) => [...docTerms(r)]));
    return [...new Set(terms(intent))].filter((t) => !vocab.has(t)).sort();
  },
};
