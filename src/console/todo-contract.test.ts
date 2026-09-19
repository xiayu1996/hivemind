import { describe, expect, it } from "vitest";
import {
  CONSOLE_WRITE_ROUTES,
  isConsoleWriteRequest,
  todoDecisionPath,
  todoSaveCheckPath,
} from "./todo-contract.js";

const TODO_ID = "answer:S-EPIC1-01:q1";

describe("the console's write surface", () => {
  it("offers exactly the config writes, the requirement limit and the two todo writes, and nothing else", () => {
    expect(CONSOLE_WRITE_ROUTES.map((route) => `${route.method} ${route.path}`)).toEqual([
      "POST /api/config/value",
      "POST /api/config/rollback",
      "POST /costs/requirement-limit",
      "POST /api/todos/:todoId/decision",
      "POST /api/todos/:todoId/save-check",
    ]);
  });

  it("admits those five routes", () => {
    expect(isConsoleWriteRequest("POST", "/api/config/value")).toBe(true);
    expect(isConsoleWriteRequest("POST", "/api/config/rollback")).toBe(true);
    expect(isConsoleWriteRequest("POST", "/costs/requirement-limit")).toBe(true);
    expect(isConsoleWriteRequest("POST", todoDecisionPath(TODO_ID))).toBe(true);
    expect(isConsoleWriteRequest("POST", todoSaveCheckPath(TODO_ID))).toBe(true);
  });

  it("@scenario S-R237511TD-01-existing refuses creating, editing and advancing work", () => {
    const refused = [
      "/api/todos",
      `/api/todos/${encodeURIComponent(TODO_ID)}`,
      "/api/requirements",
      "/api/requirements/R-1",
      "/api/stories/S-EPIC1-01",
      "/api/epics/EPIC1/approve",
      `${todoDecisionPath(TODO_ID)}/again`,
      "/api/todos/a/b/decision",
      "/api/config/value/extra",
      "/api/todos/../config/value",
    ];
    for (const path of refused) expect(isConsoleWriteRequest("POST", path)).toBe(false);
  });

  it("is a write only for POST", () => {
    expect(isConsoleWriteRequest("GET", todoDecisionPath(TODO_ID))).toBe(false);
    expect(isConsoleWriteRequest("DELETE", todoDecisionPath(TODO_ID))).toBe(false);
    expect(isConsoleWriteRequest("HEAD", "/api/config/value")).toBe(false);
  });

  it("reads the path without its query string", () => {
    expect(isConsoleWriteRequest("POST", `${todoDecisionPath(TODO_ID)}?retry=1`)).toBe(true);
    expect(isConsoleWriteRequest("POST", "/api/requirements?kind=answer")).toBe(false);
  });
});
