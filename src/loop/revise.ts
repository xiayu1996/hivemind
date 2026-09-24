import { assembleSystemPrompt } from "../agents/prompt.ts";
import { coverageDigests } from "../domain/contract.ts";
import type { Plan, PlanItem } from "../domain/plan.ts";
import { enforceFence, PRODUCT_FILES } from "../gates/fence.ts";
import type { InputRow, ItemRow, RequirementRow } from "../store/store.ts";
import { authorResultSchema } from "./author.ts";
import { runSession, sessionLimits, worktreeOf, type LoopContext } from "./context.ts";
import { SCRIPTS_DIR } from "./evaluate.ts";
import type { StepOutcome } from "./outcome.ts";
import { checkWrites, PRODUCT_DIR, productDocuments, readProduct } from "./product.ts";
import { commitProductFiles, unavailable } from "./shared.ts";

/**
 * The planner revises the plan during the build: because a person commented
 * (a comment at any time is feedback the plan has to absorb), or because an
 * item did not pass within its attempts. Unfinished attempts are discarded
 * first, so the revised plan starts from the last accepted commit. Items that
 * already passed stay as they are; their scenarios keep being replayed.
 */

export type Revision = { kind: "feedback"; comments: readonly InputRow[] } | { kind: "stuck"; item: PlanItem; findings: readonly string[] };

const PLANNER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

/** Written by the loop from its own records; a revision may not rewrite them. */
const LOOP_OWNED = [`${SCRIPTS_DIR}/**`, `${PRODUCT_DIR}/PROGRESS.md`];

export async function revisePlan(context: LoopContext, requirement: RequirementRow, revision: Revision): Promise<StepOutcome> {
  const worktree = worktreeOf(context, requirement);
  if (revision.kind === "stuck") {
    const streak = await context.store.recordStepFailure(requirement.id, revision.findings);
    if (streak > context.config.limits.maxReplans) {
      return {
        kind: "stop",
        reason: "no_progress",
        detail: `the plan was revised ${streak - 1} times without another item passing; item ${revision.item.id} (${revision.item.title}) still fails:\n${revision.findings.map((line) => `- ${line.split("\n")[0]}`).join("\n")}`,
      };
    }
  }
  const trunk = requirement.trunkSha ?? (await context.git.head(worktree));
  await context.git.reset(worktree, trunk, "hard");
  const before = await readProduct(worktree);
  const passed = (await context.store.items(requirement.id)).filter((row) => row.status === "passed");

  const layers = [
    await context.prompts.layer("base"),
    await context.prompts.layer("roles/planner"),
    await context.prompts.layer("steps/revise"),
    { name: "requirement", text: `# The requirement, as the person wrote it\n\n## ${requirement.title}\n\n${requirement.body.trim()}` },
  ];
  const run = await runSession(context, {
    requirementId: requirement.id,
    itemId: revision.kind === "stuck" ? revision.item.id : null,
    step: "revise",
    session: {
      role: "planner",
      cwd: worktree,
      candidates: context.config.models.roles.planner,
      systemPrompt: assembleSystemPrompt(layers, await productDocuments(worktree)),
      builtinTools: PLANNER_TOOLS,
      tools: [],
      policy: { allowedTools: [...PLANNER_TOOLS, "submit_result"], root: worktree, writable: [PRODUCT_FILES], fenced: LOOP_OWNED },
      env: context.config.childEnv(),
      ...sessionLimits(context, "planner"),
    },
    task: reviseTask(revision, passed),
    result: { schema: authorResultSchema, description: "Submit once plan.yaml (and anything else you changed) is complete and valid." },
    check: async () => {
      const findings = await checkWrites(worktree, ["acceptance.yaml", "plan.yaml", "project.yaml"]);
      const after = await readProduct(worktree);
      if (before.plan !== null && after.plan !== null) findings.push(...passedItemsKept(before.plan, after.plan, passed));
      return findings;
    },
    maxHandbacks: context.config.limits.maxHandbacks,
  });
  await enforceFence(context.git, worktree, trunk, "planner");
  if (!run.ok) {
    if (run.reason === "unavailable" || run.needsHuman) return unavailable(context, run);
    await context.git.reset(worktree, trunk, "hard");
    return { kind: "stop", reason: "no_progress", detail: `the plan could not be revised: ${run.detail}${run.findings.length > 0 ? `\n${run.findings.map((line) => `- ${line}`).join("\n")}` : ""}` };
  }

  const sha = await commitProductFiles(context, worktree, `${PRODUCT_DIR}: revise plan`);
  await context.store.setTrunk(requirement.id, sha);
  if (revision.kind === "feedback") await context.store.consumeInputs(revision.comments.map((input) => input.sourceId));
  const { plan, contract } = await readProduct(worktree);
  if (plan !== null && contract !== null) {
    const reopened = await context.store.syncItems(requirement.id, plan, coverageDigests(contract, plan));
    if (reopened.length > 0) context.log("items.reopened", { requirement: requirement.id, items: reopened });
  }
  if (revision.kind === "stuck" && plan?.items.some((item) => item.id === revision.item.id)) {
    await context.store.markItemReplanned(requirement.id, revision.item.id);
  }
  return { kind: "again" };
}

function passedItemsKept(before: Plan, after: Plan, passed: readonly ItemRow[]): string[] {
  const findings: string[] = [];
  for (const row of passed) {
    const was = before.items.find((item) => item.id === row.id);
    const now = after.items.find((item) => item.id === row.id);
    if (now === undefined) {
      findings.push(`plan item ${row.id} already passed and must stay in plan.yaml; add a new item for any change to it`);
    } else if (was !== undefined && was.covers.join(",") !== now.covers.join(",")) {
      findings.push(`plan item ${row.id} already passed; its covers must stay ${was.covers.join(", ") || "empty"}`);
    }
  }
  return findings;
}

function reviseTask(revision: Revision, passed: readonly ItemRow[]): string {
  const sections: string[] = [];
  if (revision.kind === "feedback") {
    sections.push(
      `A person commented on the work. Revise the product files so the plan absorbs every comment:\n${revision.comments.map((input) => `- ${(input.body ?? "").trim()}`).join("\n")}`,
    );
  } else {
    sections.push(
      `Plan item ${revision.item.id} (${revision.item.title}) did not pass within its attempts. Its last findings:\n${revision.findings.map((line) => `- ${line}`).join("\n")}\n\nRework the plan so this can succeed: split the item, add the enabling item it was missing, or narrow it. Its unfinished work has been discarded.`,
    );
  }
  if (passed.length > 0) sections.push(`These items already passed and stay unchanged in plan.yaml: ${passed.map((row) => row.id).join(", ")}.`);
  return sections.join("\n\n");
}
