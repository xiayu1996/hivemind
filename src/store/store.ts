import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import type { Plan } from "../domain/plan.ts";
import type { Gate, HumanInput } from "../ports.ts";
import type { Database } from "./db.ts";
import { approvals, events, inputs, items, leases, providerHealth, questions, requirements, runs } from "./schema.ts";

export type RequirementRow = typeof requirements.$inferSelect;
export type ItemRow = typeof items.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type InputRow = typeof inputs.$inferSelect;
export type QuestionRow = typeof questions.$inferSelect;

export type Waiting =
  /** `onApproval` says where an approval leads: on to the next step, or back into the same one (a milestone during the build). */
  | { kind: "approval"; gate: Gate; revision: string; onApproval: "next_step" | "same_step" }
  | { kind: "answer"; questionId: string }
  /** `until` is null when only a person can make a model usable again (credentials, billing). */
  | { kind: "provider"; until: number | null; detail: string };

export interface NewRequirement {
  id: string;
  boardRef: string;
  repo: string;
  title: string;
  body: string;
  recipe: string;
  budgetUsd: number;
  branch: string;
}

export interface NewRun {
  id: string;
  requirementId: string;
  itemId: string | null;
  step: string;
  role: "planner" | "builder" | "evaluator";
  provider: string;
  model: string;
  effort: string;
  promptSha256: string;
  billing: "subscription" | "metered";
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  turns: number;
}

export interface FinishedRun extends RunUsage {
  outcome: "submitted" | "no_submit" | "error" | "timeout";
  errorClass: string | null;
  errorMessage: string | null;
  /** The model that finished the run; it differs from the one that started it after a failover. */
  provider?: string;
  model?: string;
}

/** Same shape as `ProviderHealth` in `src/resilience/breaker.ts`. */
export interface ProviderHealthRecord {
  provider: string;
  state: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  openedAt: number | null;
  retryAt: number | null;
  needsHuman: boolean;
  lastErrorClass: string | null;
  lastError: string | null;
  updatedAt: number;
}

/**
 * Typed access to the execution state. Every state change of a requirement is
 * written together with its event in one batch, so there is never a moment
 * where the state moved and the record of why did not.
 *
 * Grouped writes go through `db.batch`, never `db.transaction`: the libsql
 * client hands its connection to an interactive transaction and opens a fresh
 * one afterwards, which carries none of the pragmas set in `openDatabase`
 * (foreign keys, busy timeout) and, for an in-memory database, is an empty
 * database.
 */
export class Store {
  readonly #db: Database;
  readonly #now: () => Date;

  constructor(db: Database, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
  }

  #stamp(): string {
    return this.#now().toISOString();
  }

  // -- requirements ---------------------------------------------------------

  async createRequirement(input: NewRequirement): Promise<RequirementRow> {
    const at = this.#stamp();
    await this.#db.batch([
      this.#db.insert(requirements).values({ ...input, stepIndex: 0, status: "active", createdAt: at, updatedAt: at }),
      this.#eventInsert(at, input.id, "requirement.accepted", { recipe: input.recipe, repo: input.repo }),
    ]);
    const created = await this.requirement(input.id);
    if (created === undefined) throw new Error(`requirement ${input.id} was not written`);
    return created;
  }

  async requirement(id: string): Promise<RequirementRow | undefined> {
    return this.#db.query.requirements.findFirst({ where: eq(requirements.id, id) });
  }

  async requirementByRef(boardRef: string): Promise<RequirementRow | undefined> {
    return this.#db.query.requirements.findFirst({ where: eq(requirements.boardRef, boardRef) });
  }

  /** Requirements the loop still has to look at, oldest first. */
  async openRequirements(): Promise<RequirementRow[]> {
    return this.#db.select().from(requirements).where(inArray(requirements.status, ["active", "waiting"])).orderBy(asc(requirements.createdAt));
  }

  async allRequirements(): Promise<RequirementRow[]> {
    return this.#db.select().from(requirements).orderBy(asc(requirements.createdAt));
  }

  #eventInsert(at: string, requirementId: string, type: string, data: object) {
    return this.#db.insert(events).values({ at, requirementId, type, data: JSON.stringify(data) });
  }

  async #transition(id: string, patch: Partial<RequirementRow>, type: string, data: object): Promise<void> {
    const at = this.#stamp();
    await this.#db.batch([
      this.#db.update(requirements).set({ ...patch, updatedAt: at }).where(eq(requirements.id, id)),
      this.#eventInsert(at, id, type, data),
    ]);
  }

  async setStep(id: string, stepIndex: number, stepId: string): Promise<void> {
    await this.#transition(id, { stepIndex, stepAttempts: 0, stepFindings: null, status: "active", waiting: null }, "requirement.step", { stepIndex, step: stepId });
  }

  /** A session of the current step did not produce an accepted result. Returns the new count. */
  async recordStepFailure(id: string, findings: readonly string[]): Promise<number> {
    const at = this.#stamp();
    await this.#db.batch([
      this.#db
        .update(requirements)
        .set({ stepAttempts: sql`${requirements.stepAttempts} + 1`, stepFindings: JSON.stringify(findings), updatedAt: at })
        .where(eq(requirements.id, id)),
      this.#eventInsert(at, id, "step.failed", { findings }),
    ]);
    return (await this.requirement(id))?.stepAttempts ?? 0;
  }

  async clearStepFailures(id: string): Promise<void> {
    await this.#db.update(requirements).set({ stepAttempts: 0, stepFindings: null }).where(eq(requirements.id, id));
  }

  async setWaiting(id: string, waiting: Waiting): Promise<void> {
    await this.#transition(id, { status: "waiting", waiting: JSON.stringify(waiting) }, "requirement.waiting", waiting);
  }

  async resume(id: string, why: string): Promise<void> {
    await this.#transition(id, { status: "active", waiting: null, stopReason: null, stopDetail: null }, "requirement.resumed", { why });
  }

  async stop(id: string, reason: "no_progress" | "budget", detail: string): Promise<void> {
    await this.#transition(id, { status: "stopped", waiting: null, stopReason: reason, stopDetail: detail }, "requirement.stopped", { reason, detail });
  }

  async finish(id: string): Promise<void> {
    await this.#transition(id, { status: "done", waiting: null }, "requirement.done", {});
  }

  async setBudget(id: string, budgetUsd: number): Promise<void> {
    await this.#transition(id, { budgetUsd }, "requirement.budget", { budgetUsd });
  }

  async setTrunk(id: string, sha: string): Promise<void> {
    await this.#db.update(requirements).set({ trunkSha: sha, updatedAt: this.#stamp() }).where(eq(requirements.id, id));
  }

  async setInputCursor(id: string, cursor: string | null): Promise<void> {
    await this.#db.update(requirements).set({ inputCursor: cursor }).where(eq(requirements.id, id));
  }

  // -- items ----------------------------------------------------------------

  /**
   * Mirrors the plan into item rows. Passed items keep their state even when
   * the planner rewrote their text, unless what they cover in the contract
   * changed (`digests` holds each plan item's current digest): then they are
   * reopened, because what they passed is no longer what is asked for.
   * Pending items the plan no longer names are removed; new items start
   * pending. Returns the ids of reopened items.
   */
  async syncItems(requirementId: string, plan: Plan, digests: ReadonlyMap<string, string>): Promise<string[]> {
    const at = this.#stamp();
    const wanted = new Set(plan.items.map((item) => item.id));
    const rows = await this.items(requirementId);
    const stale = rows.filter((row) => !wanted.has(row.id) && row.status !== "passed");
    const reopened = rows.filter((row) => row.status === "passed" && wanted.has(row.id) && digests.get(row.id) !== row.contractDigest).map((row) => row.id);
    const upserts = plan.items.map((item, position) =>
      this.#db
        .insert(items)
        .values({ requirementId, id: item.id, kind: item.kind, title: item.title, position, status: "pending", updatedAt: at })
        .onConflictDoUpdate({ target: [items.requirementId, items.id], set: { kind: item.kind, title: item.title, position, updatedAt: at } }),
    );
    const deletes = stale.map((row) => this.#db.delete(items).where(and(eq(items.requirementId, requirementId), eq(items.id, row.id))));
    const reopens = reopened.map((id) =>
      this.#itemUpdate(requirementId, id, { status: "pending", passedSha: null, contractDigest: null, attempts: 0, replans: 0, feedback: null, updatedAt: at }),
    );
    await this.#db.batch([this.#eventInsert(at, requirementId, "plan.synced", { items: [...wanted], reopened }), ...upserts, ...deletes, ...reopens]);
    return reopened;
  }

  async items(requirementId: string): Promise<ItemRow[]> {
    return this.#db.select().from(items).where(eq(items.requirementId, requirementId)).orderBy(asc(items.position));
  }

  async item(requirementId: string, itemId: string): Promise<ItemRow | undefined> {
    return this.#db.query.items.findFirst({ where: and(eq(items.requirementId, requirementId), eq(items.id, itemId)) });
  }

  #itemUpdate(requirementId: string, itemId: string, patch: SQLiteUpdateSetSource<typeof items>) {
    return this.#db.update(items).set(patch).where(and(eq(items.requirementId, requirementId), eq(items.id, itemId)));
  }

  async recordItemFailure(requirementId: string, itemId: string, findings: readonly string[]): Promise<ItemRow> {
    const at = this.#stamp();
    await this.#db.batch([
      this.#itemUpdate(requirementId, itemId, { attempts: sql`${items.attempts} + 1`, feedback: JSON.stringify(findings), updatedAt: at }),
      this.#eventInsert(at, requirementId, "item.failed", { item: itemId, findings }),
    ]);
    const row = await this.item(requirementId, itemId);
    if (row === undefined) throw new Error(`item ${itemId} of ${requirementId} disappeared`);
    return row;
  }

  async markItemPassed(requirementId: string, itemId: string, sha: string, contractDigest: string): Promise<void> {
    const at = this.#stamp();
    await this.#db.batch([
      this.#itemUpdate(requirementId, itemId, { status: "passed", passedSha: sha, contractDigest, feedback: null, updatedAt: at }),
      this.#eventInsert(at, requirementId, "item.passed", { item: itemId, sha }),
    ]);
  }

  /** A reworked item gets a fresh set of attempts; the findings stay for the planner and the next builder. */
  async markItemReplanned(requirementId: string, itemId: string): Promise<void> {
    const at = this.#stamp();
    await this.#db.batch([
      this.#itemUpdate(requirementId, itemId, { attempts: 0, replans: sql`${items.replans} + 1`, status: "pending", updatedAt: at }),
      this.#eventInsert(at, requirementId, "item.replanned", { item: itemId }),
    ]);
  }

  /** A person answered or resumed: the item gets its attempts back. */
  async resetItemAttempts(requirementId: string, itemId: string): Promise<void> {
    await this.#itemUpdate(requirementId, itemId, { attempts: 0, status: "pending", updatedAt: this.#stamp() });
  }

  // -- runs -----------------------------------------------------------------

  async startRun(run: NewRun): Promise<void> {
    await this.#db.insert(runs).values({ ...run, outcome: "running", startedAt: this.#stamp() });
  }

  async finishRun(id: string, result: FinishedRun): Promise<void> {
    await this.#db.update(runs).set({ ...result, endedAt: this.#stamp() }).where(eq(runs.id, id));
  }

  /** Runs a previous process left open when it ended. Their usage is lost with that process. */
  async interruptRunningRuns(): Promise<number> {
    const result = await this.#db.update(runs).set({ outcome: "interrupted", endedAt: this.#stamp() }).where(eq(runs.outcome, "running"));
    return result.rowsAffected;
  }

  async runsOf(requirementId: string): Promise<RunRow[]> {
    return this.#db.select().from(runs).where(eq(runs.requirementId, requirementId)).orderBy(asc(runs.startedAt));
  }

  async spentUsd(requirementId: string): Promise<number> {
    const [row] = await this.#db
      .select({ total: sql<number>`coalesce(sum(${runs.costUsd}), 0)` })
      .from(runs)
      .where(eq(runs.requirementId, requirementId));
    return Number(row?.total ?? 0);
  }

  // -- events ---------------------------------------------------------------

  async event(type: string, data: Record<string, unknown>, refs: { requirementId?: string; runId?: string } = {}): Promise<void> {
    await this.#db.insert(events).values({
      at: this.#stamp(),
      requirementId: refs.requirementId ?? null,
      runId: refs.runId ?? null,
      type,
      data: JSON.stringify(data),
    });
  }

  async countEvents(requirementId: string, type: string): Promise<number> {
    const [row] = await this.#db
      .select({ count: sql<number>`count(*)` })
      .from(events)
      .where(and(eq(events.requirementId, requirementId), eq(events.type, type)));
    return Number(row?.count ?? 0);
  }

  async lastEvent(requirementId: string, type: string): Promise<Record<string, unknown> | null> {
    const [row] = await this.#db
      .select({ data: events.data })
      .from(events)
      .where(and(eq(events.requirementId, requirementId), eq(events.type, type)))
      .orderBy(desc(events.id))
      .limit(1);
    return row === undefined ? null : (JSON.parse(row.data) as Record<string, unknown>);
  }

  async eventsOf(requirementId: string): Promise<(typeof events.$inferSelect)[]> {
    return this.#db.select().from(events).where(eq(events.requirementId, requirementId)).orderBy(asc(events.id));
  }

  // -- human inputs ---------------------------------------------------------

  /** Stores inputs not seen before; the board may return the same input on several polls. */
  async addInputs(requirementId: string, incoming: readonly HumanInput[]): Promise<number> {
    let added = 0;
    for (const input of incoming) {
      const result = await this.#db
        .insert(inputs)
        .values({
          sourceId: input.sourceId,
          requirementId,
          kind: input.kind,
          gate: input.kind === "approval" ? input.gate : null,
          revision: input.kind === "approval" ? input.revision : null,
          author: input.author,
          body: input.kind === "comment" ? input.body : null,
          at: input.at,
        })
        .onConflictDoNothing();
      added += result.rowsAffected;
    }
    return added;
  }

  async unconsumedInputs(requirementId: string): Promise<InputRow[]> {
    return this.#db
      .select()
      .from(inputs)
      .where(and(eq(inputs.requirementId, requirementId), isNull(inputs.consumedAt)))
      .orderBy(asc(inputs.at), asc(inputs.sourceId));
  }

  async consumeInputs(sourceIds: readonly string[]): Promise<void> {
    if (sourceIds.length === 0) return;
    await this.#db.update(inputs).set({ consumedAt: this.#stamp() }).where(inArray(inputs.sourceId, [...sourceIds]));
  }

  // -- questions and approvals ----------------------------------------------

  async addQuestion(requirementId: string, question: { id: string; body: string; options: readonly string[] }): Promise<void> {
    await this.#db
      .insert(questions)
      .values({ id: question.id, requirementId, body: question.body, options: JSON.stringify(question.options), askedAt: this.#stamp() })
      .onConflictDoNothing();
  }

  async question(id: string): Promise<QuestionRow | undefined> {
    return this.#db.query.questions.findFirst({ where: eq(questions.id, id) });
  }

  async answerQuestion(id: string, answer: string): Promise<void> {
    await this.#db.update(questions).set({ answer, answeredAt: this.#stamp() }).where(eq(questions.id, id));
  }

  async answeredQuestions(requirementId: string): Promise<QuestionRow[]> {
    return this.#db
      .select()
      .from(questions)
      .where(and(eq(questions.requirementId, requirementId), sql`${questions.answer} IS NOT NULL`))
      .orderBy(asc(questions.askedAt));
  }

  async requestApproval(requirementId: string, gate: Gate, revision: string): Promise<void> {
    await this.#db.insert(approvals).values({ requirementId, gate, revision, requestedAt: this.#stamp() }).onConflictDoNothing();
  }

  async decideApproval(requirementId: string, gate: Gate, revision: string, decision: "approved" | "revise"): Promise<void> {
    const at = this.#stamp();
    await this.#db.batch([
      this.#db
        .update(approvals)
        .set({ decision, decidedAt: at })
        .where(and(eq(approvals.requirementId, requirementId), eq(approvals.gate, gate), eq(approvals.revision, revision))),
      this.#eventInsert(at, requirementId, "approval.decided", { gate, revision, decision }),
    ]);
  }

  async approvalDecision(requirementId: string, gate: Gate, revision: string): Promise<"approved" | "revise" | null> {
    const row = await this.#db.query.approvals.findFirst({
      where: and(eq(approvals.requirementId, requirementId), eq(approvals.gate, gate), eq(approvals.revision, revision)),
    });
    return row?.decision ?? null;
  }

  /** The revision a person approved most recently, on any gate, or null before the first approval. */
  async lastApprovedRevision(requirementId: string): Promise<string | null> {
    const [row] = await this.#db
      .select({ revision: approvals.revision })
      .from(approvals)
      .where(and(eq(approvals.requirementId, requirementId), eq(approvals.decision, "approved")))
      .orderBy(desc(approvals.decidedAt))
      .limit(1);
    return row?.revision ?? null;
  }

  // -- provider health ------------------------------------------------------

  async providerHealth(): Promise<Map<string, ProviderHealthRecord>> {
    const rows = await this.#db.select().from(providerHealth);
    return new Map(rows.map((row) => [row.provider, row]));
  }

  async putProviderHealth(health: ProviderHealthRecord): Promise<void> {
    await this.#db
      .insert(providerHealth)
      .values(health)
      .onConflictDoUpdate({ target: providerHealth.provider, set: { ...health } });
  }

  // -- singleton lease ------------------------------------------------------

  /**
   * Takes the named lease when it is free, expired or already ours, and
   * returns the new fence. The fence only grows, so a holder that lost the
   * lease cannot keep acting on it.
   */
  async acquireLease(name: string, holder: string, ttlMs: number): Promise<number | null> {
    const now = this.#now().getTime();
    // One statement, so two processes racing for the lease cannot both win.
    const [row] = await this.#db
      .insert(leases)
      .values({ name, holder, fence: 1, expiresAt: now + ttlMs })
      .onConflictDoUpdate({
        target: leases.name,
        set: { holder, fence: sql`${leases.fence} + 1`, expiresAt: now + ttlMs },
        setWhere: sql`${leases.holder} = ${holder} OR ${leases.expiresAt} <= ${now}`,
      })
      .returning({ fence: leases.fence });
    return row?.fence ?? null;
  }

  async renewLease(name: string, holder: string, fence: number, ttlMs: number): Promise<boolean> {
    const result = await this.#db
      .update(leases)
      .set({ expiresAt: this.#now().getTime() + ttlMs })
      .where(and(eq(leases.name, name), eq(leases.holder, holder), eq(leases.fence, fence)));
    return result.rowsAffected === 1;
  }

  async releaseLease(name: string, holder: string, fence: number): Promise<void> {
    await this.#db
      .update(leases)
      .set({ expiresAt: 0 })
      .where(and(eq(leases.name, name), eq(leases.holder, holder), eq(leases.fence, fence)));
  }
}
