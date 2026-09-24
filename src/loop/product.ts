import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import type { ProductDocument } from "../agents/prompt.ts";
import { checkContract, contractSchema, hasWebSurface, type Contract } from "../domain/contract.ts";
import { checkPlan, planSchema, type Plan } from "../domain/plan.ts";
import { checkProject, projectSchema, type Project } from "../domain/project.ts";

/**
 * The product files under `.hivemind/` in the target repository: what the
 * product is (PRODUCT.md, acceptance.yaml), how it is built (ARCHITECTURE.md,
 * project.yaml, DESIGN.md, prototype/), in which order (plan.yaml) and how far
 * it got (PROGRESS.md). They live in the repository, next to the code they
 * describe, so every session reads the same version of them that the code
 * was written against, and a person reviews them as a diff.
 */

export const PRODUCT_DIR = ".hivemind";

/** Recorded by the loop, not by a session, and too bulky to put in front of a model. */
const NOT_FOR_PROMPTS = ["scratch/", "acceptance/"];
/** Named in the prompt but read on demand: pages and notes matter to one step at a time, not to every turn. */
const ON_DEMAND = ["prototype/", "research/"];
const MAX_DOCUMENT_BYTES = 100_000;
const MAX_TOTAL_BYTES = 400_000;

export interface Product {
  contract: Contract | null;
  plan: Plan | null;
  project: Project | null;
  hasArchitecture: boolean;
  /** Parse and cross-file problems, by file name relative to `.hivemind/`. */
  problems: ReadonlyMap<string, readonly string[]>;
}

export async function readProduct(worktree: string): Promise<Product> {
  const problems = new Map<string, string[]>();
  const contract = await readYaml(worktree, "acceptance.yaml", contractSchema, problems);
  const plan = await readYaml(worktree, "plan.yaml", planSchema, problems);
  const project = await readYaml(worktree, "project.yaml", projectSchema, problems);
  if (contract !== null) addProblems(problems, "acceptance.yaml", checkContract(contract));
  if (contract !== null && plan !== null) addProblems(problems, "plan.yaml", checkPlan(plan, contract));
  if (project !== null) addProblems(problems, "project.yaml", checkProject(project, contract !== null && hasWebSurface(contract)));
  const hasArchitecture = (await readText(worktree, "ARCHITECTURE.md")) !== null;
  return { contract, plan, project, hasArchitecture, problems };
}

/**
 * Findings for the files an author step must leave behind: each must exist,
 * and every structured one must parse and agree with the others.
 */
export async function checkWrites(worktree: string, writes: readonly string[]): Promise<string[]> {
  const product = await readProduct(worktree);
  const findings: string[] = [];
  for (const file of writes) {
    const text = await readText(worktree, file);
    if (text === null || text.trim() === "") {
      findings.push(`${PRODUCT_DIR}/${file} is missing or empty; this step has to write it`);
      continue;
    }
    for (const problem of product.problems.get(file) ?? []) findings.push(`${PRODUCT_DIR}/${file}: ${problem}`);
  }
  return findings;
}

/**
 * The product documents in a stable order, for a session's system prompt.
 * Paths are repository-relative so a session can open the same file itself.
 */
export async function productDocuments(worktree: string): Promise<ProductDocument[]> {
  const root = join(worktree, PRODUCT_DIR);
  const files = (await listFiles(root)).filter((file) => !NOT_FOR_PROMPTS.some((prefix) => file.startsWith(prefix))).toSorted();
  const documents: ProductDocument[] = [];
  let total = 0;
  for (const file of files) {
    const path = join(root, file);
    const size = (await stat(path)).size;
    if (ON_DEMAND.some((prefix) => file.startsWith(prefix))) {
      documents.push({ path: `${PRODUCT_DIR}/${file}`, content: "(not included here; read the file when you need it)" });
      continue;
    }
    if (size > MAX_DOCUMENT_BYTES || total + size > MAX_TOTAL_BYTES) {
      documents.push({ path: `${PRODUCT_DIR}/${file}`, content: `(${size} bytes, not included here; read the file when you need it)` });
      continue;
    }
    total += size;
    documents.push({ path: `${PRODUCT_DIR}/${file}`, content: await readFile(path, "utf8") });
  }
  return documents;
}

export async function readText(worktree: string, file: string): Promise<string | null> {
  try {
    return await readFile(join(worktree, PRODUCT_DIR, file), "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function readYaml<T>(worktree: string, file: string, schema: z.ZodType<T>, problems: Map<string, string[]>): Promise<T | null> {
  const text = await readText(worktree, file);
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    addProblems(problems, file, [`is not valid YAML: ${error instanceof Error ? error.message : String(error)}`]);
    return null;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    addProblems(
      problems,
      file,
      parsed.error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(top level)"}: ${issue.message}`),
    );
    return null;
  }
  return parsed.data;
}

function addProblems(problems: Map<string, string[]>, file: string, found: readonly string[]): void {
  if (found.length === 0) return;
  problems.set(file, [...(problems.get(file) ?? []), ...found]);
}

async function listFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(root, join(entry.parentPath, entry.name)).split("\\").join("/"));
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
