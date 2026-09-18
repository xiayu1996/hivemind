import { describe, expect, it } from "vitest";
import {
  TODO_COPY,
  initialTodoView,
  reduceTodoView,
} from "../../console-ui/src/pages/todo/contracts.js";

/**
 * The one scenario the frozen contract handed to VERIFY: a read that has not
 * come back yet is a page that is still reading, never a page with nothing to
 * do. The reducer is where that difference is decidable without a browser.
 */
describe("@scenario S-R237511TD-01-loading a read in progress is loading, not an empty ledger", () => {
  it("keeps the reading state while the content is on its way", () => {
    const loading = reduceTodoView(initialTodoView("answer:S-EPIC1-01:q1"), {
      type: "load",
      todoId: "answer:S-EPIC1-01:q1",
    });

    expect(loading.status).toBe("loading");
    expect(loading.todo).toBeNull();
    expect(TODO_COPY.loading).toBe("正在读取待办内容");
    expect(TODO_COPY.none).toBe("目前没有待办");
  });
});
