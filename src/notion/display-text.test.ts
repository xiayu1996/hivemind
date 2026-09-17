import { describe, expect, it } from "vitest";
import { STORY_BOARD_STATUS } from "./board-status.js";
import {
  displayTime,
  sectionForTitle,
  sectionTitle,
  stopReasonWord,
  storyStateWord,
  waitingText,
} from "./display-text.js";
import type { StoryStopReason } from "../orchestrator/state-machine.js";

// The four the DB CHECK allows; a fifth would not compile here.
const STOP_REASONS: StoryStopReason[] = [
  "blocking_question",
  "verify_loop_exceeded",
  "retry_limit_exceeded",
  "cost_ceiling_exceeded",
];

describe("display text", () => {
  it("names every stop reason the state machine can produce", () => {
    for (const reason of STOP_REASONS) {
      expect(stopReasonWord(reason), reason).not.toBe(reason);
      expect(/[一-龥]/.test(stopReasonWord(reason)), reason).toBe(true);
    }
  });

  it("recognises a heading written by an older page so the rename is an edit, not a new anchor", () => {
    expect(sectionForTitle("需求规格")).toBe("specification");
    expect(sectionForTitle("验收场景")).toBe("specification");
    expect(sectionForTitle("待人回答")).toBe("questions");
    expect(sectionTitle("questions")).toBe("需要你处理");
    expect(sectionForTitle("交付结果")).toBeUndefined();
  });

  it("speaks of a stopped card in the board's own words", () => {
    expect(storyStateWord("HUMAN_PARKED")).toBe(STORY_BOARD_STATUS.parked);
    expect(storyStateWord("DELIVERED")).toBe("已交付");
  });

  it("has something to say only when it is the person's turn", () => {
    expect(waitingText("story", "blocking_question")?.action).toContain("评论");
    expect(waitingText("story", "CODE")).toBeUndefined();
    expect(waitingText("epic", "EXECUTING")).toBeUndefined();
  });

  it("stamps a time in the reader's day, not the machine's", () => {
    // 2026-09-15T09:28:00Z is the evening of the 15th in Asia/Shanghai.
    expect(displayTime(Date.UTC(2026, 8, 15, 9, 28))).toBe("09-15 17:28");
  });
});
