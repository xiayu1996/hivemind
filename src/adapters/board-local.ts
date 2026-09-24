import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { ApprovalRequest, Board, BoardStatus, Gate, HumanInput, Question, Report, Submission } from "../ports.ts";

/**
 * A board made of plain files, for running without Notion and for tests. A
 * person works it with an editor or with `hivemind submit / approve /
 * comment`:
 *
 *   inbox/<ref>.md                         a submission (YAML front matter + body)
 *   <ref>/status.json                      what hivemind says about it
 *   <ref>/approvals/<gate>-<revision>.md   what is waiting for approval
 *   <ref>/approvals/<gate>-<revision>.approved   a person's approval
 *   <ref>/questions/<id>.md, <ref>/reports/<id>.md
 *   <ref>/comments/<name>.md               a person's comment or answer
 *
 * Every write replaces its file, so writing the same thing twice is harmless.
 */

const frontMatterSchema = z
  .object({
    title: z.string().min(1),
    repo: z.string().min(1),
    recipe: z.string().min(1).optional(),
    author: z.string().min(1).optional(),
  })
  .strict();

const REF = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const APPROVAL_FILE = /^(product|architecture|milestone)-([0-9a-f]{7,64})\.approved$/;

export function createLocalBoard(root: string): Board {
  const dir = (ref: string, ...parts: string[]) => {
    if (!REF.test(ref)) throw new Error(`board ref ${JSON.stringify(ref)} cannot be a directory name`);
    return join(root, ref, ...parts);
  };

  return {
    async pollSubmissions(): Promise<readonly Submission[]> {
      const submissions: Submission[] = [];
      for (const file of await list(join(root, "inbox"))) {
        if (!file.endsWith(".md")) continue;
        const ref = file.slice(0, -3);
        if (!REF.test(ref) || (await exists(dir(ref, "status.json")))) continue;
        const path = join(root, "inbox", file);
        const parsed = parseSubmission(await readFile(path, "utf8"));
        if (parsed === null) continue;
        submissions.push({ ref, ...parsed, submittedAt: (await stat(path)).mtime.toISOString() });
      }
      return submissions.toSorted((left, right) => (left.submittedAt < right.submittedAt ? -1 : 1));
    },

    async requestApproval(ref: string, request: ApprovalRequest): Promise<void> {
      const documents = request.documents.map((document) => `## ${document.name}\n\n${document.content.trim()}`).join("\n\n");
      await write(dir(ref, "approvals", `${request.gate}-${request.revision}.md`), `# ${request.title}\n\n${request.summary}\n\n${documents}`);
    },

    async ask(ref: string, question: Question): Promise<void> {
      const options = question.options.length > 0 ? `\n\n${question.options.map((option) => `- ${option}`).join("\n")}` : "";
      await write(dir(ref, "questions", `${question.id}.md`), `${question.body}${options}`);
    },

    async report(ref: string, report: Report): Promise<void> {
      await write(dir(ref, "reports", `${report.id}.md`), report.body);
    },

    async pollInputs(ref: string): Promise<{ inputs: readonly HumanInput[]; cursor: string | null }> {
      const inputs: HumanInput[] = [];
      for (const file of await list(dir(ref, "approvals"))) {
        const match = APPROVAL_FILE.exec(file);
        if (match === null) continue;
        const path = dir(ref, "approvals", file);
        const author = (await readFile(path, "utf8")).trim();
        inputs.push({
          kind: "approval",
          sourceId: `${ref}/approvals/${file}`,
          gate: match[1] as Gate,
          revision: match[2] ?? "",
          author: author === "" ? null : author,
          at: (await stat(path)).mtime.toISOString(),
        });
      }
      for (const file of await list(dir(ref, "comments"))) {
        if (!file.endsWith(".md")) continue;
        const path = dir(ref, "comments", file);
        const body = (await readFile(path, "utf8")).trim();
        if (body === "") continue;
        inputs.push({ kind: "comment", sourceId: `${ref}/comments/${file}`, body, author: null, at: (await stat(path)).mtime.toISOString() });
      }
      return { inputs, cursor: null };
    },

    async setStatus(ref: string, status: BoardStatus, note: string | null): Promise<void> {
      await write(dir(ref, "status.json"), JSON.stringify({ status, note }, null, 2));
    },
  };
}

/** Writes a submission into the inbox and returns its ref. */
export async function submitLocal(root: string, input: { title: string; body: string; repo: string; recipe?: string; now: Date }): Promise<string> {
  const ref = `${input.now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-")}-${Math.random().toString(36).slice(2, 6)}`;
  const front: Record<string, string> = { title: input.title, repo: input.repo };
  if (input.recipe !== undefined) front.recipe = input.recipe;
  await mkdir(join(root, "inbox"), { recursive: true });
  await writeFile(join(root, "inbox", `${ref}.md`), `---\n${stringifyYaml(front)}---\n\n${input.body.trim()}\n`);
  return ref;
}

/** Approves the given gate and revision on behalf of `author`. */
export async function approveLocal(root: string, ref: string, gate: Gate, revision: string, author: string): Promise<void> {
  if (!REF.test(ref)) throw new Error(`board ref ${JSON.stringify(ref)} cannot be a directory name`);
  await mkdir(join(root, ref, "approvals"), { recursive: true });
  await writeFile(join(root, ref, "approvals", `${gate}-${revision}.approved`), `${author}\n`);
}

export async function commentLocal(root: string, ref: string, body: string, now: Date): Promise<void> {
  if (!REF.test(ref)) throw new Error(`board ref ${JSON.stringify(ref)} cannot be a directory name`);
  await mkdir(join(root, ref, "comments"), { recursive: true });
  await writeFile(join(root, ref, "comments", `${now.getTime()}.md`), `${body.trim()}\n`);
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content.endsWith("\n") ? content : `${content}\n`);
}

function parseSubmission(text: string): Omit<Submission, "ref" | "submittedAt"> | null {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (match === null) return null;
  const front = frontMatterSchema.safeParse(parseYaml(match[1] ?? ""));
  if (!front.success) return null;
  return { title: front.data.title, repo: front.data.repo, recipe: front.data.recipe ?? null, author: front.data.author ?? null, body: (match[2] ?? "").trim() };
}

async function list(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).toSorted();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    // A missing file is the only expected failure; anything else surfaces on the read that follows.
    return false;
  }
}
