import { describe, expect, it } from "vitest";
import {
  STORY_DETAIL_COPY,
  formatRoundBlockerLine,
  formatRoundCostValue,
  formatRoundPanelHeading,
  formatRoundResultLine,
  storyDetailMobileNavigation,
  type StoryRoundDto,
} from "../../console-ui/src/pages/detail/contracts.js";

/**
 * The mobile scenario is a layout fact the UI acceptance walkthrough judges on
 * a narrow viewport (design 08 section 6). CODE is fenced out of `*.test.ts`
 * for the scenarios SPECIFY froze, and SPECIFY downgraded this one to `ui`
 * because there is no CODE-layer boundary to assert. What CODE can fix down
 * here is the part that layout is built from: the single bottom entry labelled
 * `当前`, and the labels the narrow single column must show. The page renders
 * from exactly these, and the walkthrough checks the rendered order and that
 * the entry covers nothing.
 */
function currentRound(): StoryRoundDto {
  return {
    round: 3,
    trigger: "restart",
    triggerNote: null,
    phase: "CODE",
    startedAt: 1_700_000_000_000,
    endedAt: null,
    resultPending: false,
    acceptance: [
      { scenarioId: "S-R237511DT-02-gamma", text: "当前轮验收一", outcome: "passed" },
      { scenarioId: "S-R237511DT-02-delta", text: "当前轮验收二", outcome: "passed" },
      { scenarioId: "S-R237511DT-02-epsilon", text: "当前轮验收三", outcome: "failed" },
    ],
    costUsd: 1.24,
  };
}

describe("mobile layout contract", () => {
  it("@scenario S-R237511DT-02-mobile 手机底部只有一个回到当前轮的入口", () => {
    const navigation = storyDetailMobileNavigation();

    expect(navigation).toHaveLength(1);
    expect(navigation[0]?.label).toBe("当前");
    expect(navigation[0]?.current).toBe(true);
  });

  it("@scenario S-R237511DT-02-mobile 手机单列要看到的阶段、结果、卡点与费用标签都在冻结文案里", () => {
    const round = currentRound();

    expect(formatRoundPanelHeading(round.round, round.round)).toBe("当前轮阶段与结果");
    expect(formatRoundResultLine(round)).toBe("已取得的结果：2 项验收已通过");
    expect(formatRoundBlockerLine(round)).toBe("卡点：1 项验收未通过");
    expect(formatRoundCostValue(round, round.round)).toBe("$1.24（本任务当前轮）");
    expect(STORY_DETAIL_COPY.roundCostHeading).toBe("本轮费用");
    expect(STORY_DETAIL_COPY.historyHeading).toBe("历史轮次");
    expect(STORY_DETAIL_COPY.currentRunEntry).toBe("当前");
  });
});
