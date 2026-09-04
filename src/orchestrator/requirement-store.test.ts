import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { RequirementStore } from "./requirement-store.js";

const REQUIREMENT_ID = "R-abc123def456";

describe("RequirementStore", () => {
  let client: ReturnType<typeof createClient>;
  let store: RequirementStore;
  let time: number;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    time = 1_000;
    store = new RequirementStore(client, () => time++);
    await store.createRequirement({
      id: REQUIREMENT_ID,
      notionPageId: "requirement-page-1",
      title: "Give hivemind a web console",
      originalRequest: "I want to watch what the agents are doing without opening the database.",
    });
  });

  afterEach(() => {
    client.close();
  });

  it("takes a page in once, however many times the poll reads the board", async () => {
    await expect(store.createRequirement({
      id: REQUIREMENT_ID,
      notionPageId: "requirement-page-1",
      title: "Give hivemind a web console",
      originalRequest: "Reworded by a second poll.",
    })).resolves.toBe(false);
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({
      state: "CLARIFY",
      originalRequest: "I want to watch what the agents are doing without opening the database.",
      clarifyRounds: 0,
    });
    const events = await client.execute({
      sql: "SELECT type FROM event_log WHERE card_id = ?",
      args: [REQUIREMENT_ID],
    });
    expect(events.rows).toHaveLength(1);
  });

  it("moves with a compare-and-set transition and records the event atomically", async () => {
    await store.transition(REQUIREMENT_ID, "CLARIFY", "PRD_CONFIRM", "system", "run-1");
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({ state: "PRD_CONFIRM" });
    await expect(
      store.transition(REQUIREMENT_ID, "CLARIFY", "PRD_CONFIRM", "system", "lost-race"),
    ).rejects.toThrow(/lost a race/);
    const events = await client.execute({
      sql: "SELECT type FROM event_log WHERE card_id = ? AND type = 'requirement.transition'",
      args: [REQUIREMENT_ID],
    });
    expect(events.rows).toHaveLength(1);
  });

  it("remembers where a parked requirement has to come back to", async () => {
    await store.transition(REQUIREMENT_ID, "CLARIFY", "HUMAN_PARKED", "human", "run-park");
    const parked = await store.getRequirement(REQUIREMENT_ID);
    expect(parked).toMatchObject({ state: "HUMAN_PARKED", resumeState: "CLARIFY" });
    await store.transition(REQUIREMENT_ID, "HUMAN_PARKED", "CLARIFY", "human", "run-resume", parked.resumeState!);
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({
      state: "CLARIFY",
      resumeState: null,
    });
  });

  it("hides a stopped requirement from the loop until a human answers", async () => {
    await expect(store.listActionable("CLARIFY")).resolves.toHaveLength(1);
    await store.stopForHumanInput(REQUIREMENT_ID, "CLARIFY", "run-stop", "question budget exhausted");
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({
      state: "CLARIFY",
      stopReason: "blocking_question",
    });
    await expect(store.listActionable("CLARIFY")).resolves.toHaveLength(0);
    await expect(store.stopForHumanInput(REQUIREMENT_ID, "CLARIFY", "run-stop-2", "again")).rejects.toThrow(
      /lost a race/,
    );
    await expect(store.clearStop(REQUIREMENT_ID, "run-answer")).resolves.toBe(true);
    await expect(store.clearStop(REQUIREMENT_ID, "run-answer-again")).resolves.toBe(false);
    await expect(store.listActionable("CLARIFY")).resolves.toHaveLength(1);
  });

  it("will not ask a second question batch while the first is unanswered", async () => {
    await expect(store.openClarifyRound(REQUIREMENT_ID, ["Who reads the console?"], "run-ask")).resolves.toBe(1);
    await expect(
      store.openClarifyRound(REQUIREMENT_ID, ["What does it show first?"], "run-ask-2"),
    ).rejects.toThrow(/still waiting for answers/);
    await expect(store.recordClarifyAnswers(REQUIREMENT_ID, 1, ["The person on call."], "run-read")).resolves.toBe(true);
    await expect(store.recordClarifyAnswers(REQUIREMENT_ID, 1, ["A second read."], "run-read-2")).resolves.toBe(false);
    await expect(store.openClarifyRound(REQUIREMENT_ID, ["What does it show first?"], "run-ask-3")).resolves.toBe(2);
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({ clarifyRounds: 2 });
    const history = await store.clarifyHistory(REQUIREMENT_ID);
    expect(history).toMatchObject([
      { round: 1, questions: ["Who reads the console?"], answers: ["The person on call."] },
      { round: 2, questions: ["What does it show first?"], answers: null },
    ]);
  });

  it("supersedes an old PRD instead of editing what a human already read", async () => {
    const first = await store.saveDraftPrd(REQUIREMENT_ID, JSON.stringify({ scenarios: ["one"] }), "run-prd-1");
    const second = await store.saveDraftPrd(REQUIREMENT_ID, JSON.stringify({ scenarios: ["two"] }), "run-prd-2");
    expect([first, second]).toEqual([1, 2]);
    await expect(store.getPrd(REQUIREMENT_ID, 1)).resolves.toMatchObject({ status: "superseded" });
    await expect(store.getPrd(REQUIREMENT_ID)).resolves.toMatchObject({ revision: 2, status: "draft" });
  });

  it("confirms a PRD once even when two deliveries carry the same approval", async () => {
    const revision = await store.saveDraftPrd(REQUIREMENT_ID, JSON.stringify({ scenarios: ["one"] }), "run-prd");
    await expect(
      store.confirmPrd(REQUIREMENT_ID, revision, "comment-77", "comment", "run-confirm"),
    ).resolves.toBe(true);
    await expect(
      store.confirmPrd(REQUIREMENT_ID, revision, "comment-77", "drag", "run-confirm-replay"),
    ).resolves.toBe(false);
    await expect(store.getPrd(REQUIREMENT_ID, revision)).resolves.toMatchObject({ status: "confirmed" });
    const confirmations = await client.execute({
      sql: "SELECT type FROM event_log WHERE card_id = ? AND type = 'requirement.prd_confirmed'",
      args: [REQUIREMENT_ID],
    });
    expect(confirmations.rows).toHaveLength(1);
  });

  it("judges each acceptance scenario once and can reopen the list after a gap is closed", async () => {
    await store.seedAcceptanceItems(REQUIREMENT_ID, [
      { itemId: "A1", prdScenarioId: "S1", text: "The board shows every running Story." },
      { itemId: "A2", prdScenarioId: "S2", text: "A stopped Story names what it is waiting for." },
    ], "run-seed");
    await store.bindAcceptanceBlock(REQUIREMENT_ID, "A1", "block-a1");
    await expect(
      store.decideAcceptanceItem(REQUIREMENT_ID, "A1", "accepted", "check-1", "comment", "run-accept"),
    ).resolves.toBe(true);
    await expect(
      store.decideAcceptanceItem(REQUIREMENT_ID, "A1", "gap", "check-1", "comment", "run-accept-replay"),
    ).resolves.toBe(false);
    await store.decideAcceptanceItem(REQUIREMENT_ID, "A2", "gap", "check-2", "comment", "run-gap", "手机上打不开");
    await expect(store.acceptanceItems(REQUIREMENT_ID)).resolves.toMatchObject([
      { itemId: "A1", status: "accepted", notionBlockId: "block-a1" },
      { itemId: "A2", status: "gap", notionBlockId: null },
    ]);
    await expect(store.acceptanceGapNotes(REQUIREMENT_ID)).resolves.toEqual(new Map([["A2", "手机上打不开"]]));

    await expect(store.reopenAcceptanceGaps(REQUIREMENT_ID, "run-reopen")).resolves.toBe(1);
    await expect(store.acceptanceItems(REQUIREMENT_ID)).resolves.toMatchObject([
      { itemId: "A1", status: "accepted" },
      { itemId: "A2", status: "open" },
    ]);
  });

  it("keeps one anchor per owned page section so a redelivery updates in place", async () => {
    await store.registerNotionSection(REQUIREMENT_ID, "prd", "block-prd-1");
    await store.registerNotionSection(REQUIREMENT_ID, "prd", "block-prd-2");
    await store.registerNotionSection(REQUIREMENT_ID, "acceptance", "block-acceptance");
    await expect(store.notionSections(REQUIREMENT_ID)).resolves.toEqual({
      prd: "block-prd-2",
      acceptance: "block-acceptance",
    });
  });

  it("reports the Epics a requirement is waiting on", async () => {
    await client.execute({
      sql: `INSERT INTO epics (id, notion_page_id, title, state, requirement_id, created_at, updated_at)
            VALUES ('E-1', 'epic-page-1', 'Console shell', 'EXECUTING', ?, 1, 1)`,
      args: [REQUIREMENT_ID],
    });
    await expect(store.linkedEpicStates(REQUIREMENT_ID)).resolves.toEqual([
      { epicId: "E-1", state: "EXECUTING" },
    ]);
  });
});
