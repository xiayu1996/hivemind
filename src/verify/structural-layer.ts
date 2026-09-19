import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isWithinRoot } from "../guard/danger-rules.js";
import { describeMissing, missingFromSnapshot, type VisibleRequirement } from "./aria-snapshot.js";

/**
 * The first of the three interface layers (design 08 section 6): did the page
 * actually show what the scenario said a person would see?
 *
 * It can refuse, and the other two cannot refuse for the same reason it can:
 * roles and text are finite and enumerable, so a failing set either shrinks or
 * repeats, and the convergence rule stays meaningful. Taste is neither, which
 * is why the third layer never gets a veto.
 *
 * The same function settles a prototype's structural self-check (08 section
 * 3.2): a prototype eats the criteria the code after it will be judged by, so
 * the page list, the PRD scenarios and `visible[]` are aligned before any
 * implementation exists.
 */

export interface StructuralSubject {
  /** The scenario, or for a prototype, the page. */
  id: string;
  /** Snapshot files, relative to `root`. */
  snapshots: readonly string[];
  required: readonly VisibleRequirement[];
}

export interface StructuralFinding {
  id: string;
  /** For the person reading the card: what was not on the page. */
  reason: string;
  /** For whoever debugs it: which snapshots were read. */
  detail: string;
  /**
   * The snapshot was missing or unreadable, so this finding says nothing about
   * the page: the round has nothing to look at, which is a fact about the run
   * and not about the code. A finding without it names something the page was
   * required to show and did not.
   */
  evidenceMissing?: true;
}

export interface StructuralInput {
  root: string;
  subjects: readonly StructuralSubject[];
}

/**
 * A subject passes when one snapshot satisfies all of its requirements.
 *
 * Deliberately not "the union of every snapshot satisfies them": a scenario
 * that visited three pages and found one required element on each has not seen
 * them together, and together is what a person experiences. The best single
 * snapshot is reported, so the finding names the smallest real gap rather than
 * the first one tried.
 */
export async function checkStructuralLayer(input: StructuralInput): Promise<StructuralFinding[]> {
  const root = resolve(input.root);
  const findings: StructuralFinding[] = [];
  for (const subject of input.subjects) {
    if (subject.required.length === 0) continue;
    if (subject.snapshots.length === 0) {
      findings.push({
        id: subject.id,
        reason: "这个场景要看见的内容无从查证：没有留下任何页面结构记录",
        detail: "no accessibility snapshot was declared",
        evidenceMissing: true,
      });
      continue;
    }
    let best: VisibleRequirement[] | null = null;
    const unreadable: string[] = [];
    for (const name of subject.snapshots) {
      const path = resolve(root, name);
      // Validation already refuses an escaping path for the round as a whole;
      // repeated here because this function is also called on a prototype,
      // where nothing else has looked at these names yet.
      if (!isWithinRoot(path, root)) {
        unreadable.push(name);
        continue;
      }
      let snapshot: string;
      try {
        snapshot = await readFile(path, "utf8");
      } catch {
        unreadable.push(name);
        continue;
      }
      const missing = missingFromSnapshot(snapshot, subject.required);
      if (missing.length === 0) {
        best = [];
        break;
      }
      if (!best || missing.length < best.length) best = missing;
    }
    if (best?.length === 0) continue;
    if (!best) {
      findings.push({
        id: subject.id,
        reason: "这个场景要看见的内容无从查证：留下的页面结构记录读不出来",
        detail: `unreadable snapshots: ${[...unreadable].toSorted().join(", ")}`,
        evidenceMissing: true,
      });
      continue;
    }
    findings.push({
      id: subject.id,
      reason: describeMissing(best),
      detail: `checked ${[...subject.snapshots].toSorted().join(", ")}; missing ${
        best.map((item) => `${item.role}=${item.text}`).join(", ")
      }`,
    });
  }
  return findings;
}
