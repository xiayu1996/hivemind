import { describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { migrate } from "../persistence/migrate.js";
import { StoryExecutionStore } from "../orchestrator/story-execution-store.js";
import type { EpicState, StoryState, StoryStopReason } from "../orchestrator/state-machine.js";
import type { RequirementState } from "../orchestrator/requirement-machine.js";
import { renderEpicPage } from "../orchestrator/epic-page-projection.js";
import { buildRequirementPage } from "./requirement-projection.js";
import { NotionStoryProjection } from "./story-projection.js";

const STORY_STATES: StoryState[] = [
  "QUEUED", "SHAPE", "DESIGN", "SPECIFY", "CODE", "VERIFY", "MERGE",
  "DELIVERED", "REGRESSION_FIX", "NEEDS_INPUT", "HUMAN_PARKED", "FAILED",
];
const EPIC_STATES: EpicState[] = [
  "INTAKE", "DECOMPOSE", "PLAN_APPROVAL", "EXECUTING", "EPIC_ACCEPT", "DONE", "BLOCKED", "FAILED",
];
const REQUIREMENT_STATES: RequirementState[] = [
  "CLARIFY", "PRD_CONFIRM", "SOLUTION", "DECOMPOSING", "EXECUTING", "ACCEPTANCE", "DONE", "HUMAN_PARKED", "FAILED",
];
const STOP_REASONS: StoryStopReason[] = [
  "blocking_question", "verify_loop_exceeded", "retry_limit_exceeded", "cost_ceiling_exceeded",
];

/** An id is a handle a person quotes back, not a word they read, so it is the
 * one thing allowed to reach a page in the machine's own spelling. */
const IDS = /\b(?:S|R|E)-[A-Za-z0-9-]+\b/g;

const FORBIDDEN = [
  ...STORY_STATES,
  ...EPIC_STATES.filter((state) => !STORY_STATES.includes(state as StoryState)),
  ...REQUIREMENT_STATES.filter((state) => !STORY_STATES.includes(state as StoryState)),
  ...STOP_REASONS,
  "Task ", "State ", "Round ", "Budget", "Cost ", "Execution stopped", "Design is pending",
  "Image unavailable", "Story stopped",
];

function assertReadable(where: string, values: string[]): void {
  for (const value of values) {
    const scanned = value.replaceAll(IDS, "");
    for (const word of FORBIDDEN) {
      expect(scanned, `${where}: ${value}`).not.toContain(word);
    }
  }
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

describe("what Notion is written with", () => {
  it("would notice a leak, so its silence means something", () => {
    expect(() => assertReadable("probe", ["Execution stopped: verify_loop_exceeded"])).toThrow();
    expect(() => assertReadable("probe", ["这张卡停在 HUMAN_PARKED"])).toThrow();
    // An id is not a leak: a person quotes it back in a comment.
    expect(() => assertReadable("probe", ["场景 1 · 保存规则 S-E1-01-a"])).not.toThrow();
  });

  it("says what an Epic carries without naming a state the machine uses", () => {
    for (const state of EPIC_STATES) {
      const rendered = renderEpicPage({
        epicId: "E-1",
        state,
        status: "\u8fdb\u884c\u4e2d",
        mrUrl: "https://example.test/pull/1",
        targetBranch: "main",
        integrationBranch: "epic/E-1",
        businessGoal: "\u8ba9\u4eba\u80fd\u4fdd\u5b58\u4e00\u6761\u89c4\u5219",
        prdScenarios: [{ id: "s01", text: "\u6253\u5f00\u9875\u9762\uff0c\u4fdd\u5b58\u89c4\u5219\uff0c\u5217\u8868\u91cc\u51fa\u73b0\u5b83" }],
        stories: [{ id: "S-E1-01", title: "\u4fdd\u5b58\u89c4\u5219", pageId: null, dependsOn: [] }],
        acceptance: [{
          prdScenarioId: "s01",
          text: "\u6253\u5f00\u9875\u9762\uff0c\u4fdd\u5b58\u89c4\u5219\uff0c\u5217\u8868\u91cc\u51fa\u73b0\u5b83",
          status: "gap",
          note: "\u4fdd\u5b58\u540e\u5217\u8868\u6ca1\u5237\u65b0",
        }],
      });
      assertReadable(`epic page ${state}`, rendered.lines);
    }
  });

  it("says where a requirement stands without naming a state the machine uses", () => {
    for (const state of REQUIREMENT_STATES) {
      for (const stopReason of [null, ...STOP_REASONS]) {
        const page = buildRequirementPage({
          requirement: {
            id: "R-1",
            notionPageId: "page-1",
            title: "管理后台",
            originalRequest: "我要一个管理后台",
            state,
            clarifyRounds: 2,
            stopReason,
            resumeState: null,
          },
          clarify: [],
          prd: null,
          acceptance: [],
          stop: stopReason ? { state, detail: "有个问题等你回答", stoppedAt: 10 } : null,
        });
        assertReadable(`requirement page ${state}/${stopReason}`, strings(page));
      }
    }
  });

  it("says where a Story stands without naming a state the machine uses", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 10);
    await store.createStory({
      id: "S-E1-01",
      notionPageId: "page-1",
      title: "保存规则",
      requirement: "让人能保存一条规则",
    });
    const projection = new NotionStoryProjection(client, () => 20);
    for (const state of STORY_STATES) {
      for (const stopReason of [null, ...STOP_REASONS]) {
        await client.execute({
          sql: "UPDATE stories SET state = ?, stop_reason = ? WHERE id = 'S-E1-01'",
          args: [state, stopReason],
        });
        await projection.enqueue("S-E1-01");
      }
    }
    const rows = (await client.execute("SELECT payload FROM notion_outbox WHERE operation = 'sync_story_page'")).rows;
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      // Everything but the fold: the technical section is where an engineering
      // word is allowed to land, and it is closed until someone opens it.
      const { technical, ...desired } = (JSON.parse(String(row.payload)) as {
        desired: Record<string, unknown>;
      }).desired;
      expect(technical === undefined || Array.isArray(technical)).toBe(true);
      assertReadable("story page", strings(desired));
    }
    client.close();
  });
});
