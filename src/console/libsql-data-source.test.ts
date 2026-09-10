import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { LibsqlConsoleDataSource } from "./libsql-data-source.js";

describe("LibsqlConsoleDataSource", () => {
  it("reads task timelines, costs, config and live node snapshots", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    await client.batch([
      "INSERT INTO stories (id, notion_page_id, title, requirement, state, created_at, updated_at) VALUES ('s1','p1','Story','Requirement','CODE',1,2)",
      "INSERT INTO event_log (run_id, seq, card_id, type, ts, data) VALUES ('r1',0,'s1','turn_start',3,'{\"turn\":1}')",
      "INSERT INTO cost_entries (run_id, provider, model_id, cost_usd, ts) VALUES ('r1','mock','mock-1',0.1,4)",
      "INSERT INTO config_entries (key, value_json, updated_by, updated_at) VALUES ('sample','6','test',5)",
    ], "write");
    const source = new LibsqlConsoleDataSource(client, async () => [{ hostId: "host-1" }]);
    await expect(source.nodes()).resolves.toEqual([{ hostId: "host-1" }]);
    await expect(source.tasks()).resolves.toMatchObject([{
      id: "s1",
      events: [{ type: "turn_start", data: { turn: 1 } }],
      traceHtml: expect.stringContaining("turn_start"),
    }]);
    await expect(source.costs()).resolves.toMatchObject([{ run_id: "r1", cost_usd: 0.1 }]);
    await expect(source.config()).resolves.toMatchObject([{ key: "sample", value: 6 }]);
    client.close();
  });
});

describe("S-E3OVERVIEW-01-delivery", () => {
  it("returns only valid delivered transition events tied to a story", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    await client.batch([
      "INSERT INTO stories (id, notion_page_id, title, requirement, state, created_at, updated_at) VALUES ('s-delivered','sp1','Delivered today','Work','DELIVERED',1,1)",
      "INSERT INTO event_log (run_id, seq, card_id, type, ts, data) VALUES ('run-1',0,'s-delivered','story.transition',100,'{\"to\":\"DELIVERED\"}')",
      "INSERT INTO event_log (run_id, seq, card_id, type, ts, data) VALUES ('run-1',1,'s-delivered','story.transition',101,'{\"to\":\"CODE\"}')",
      "INSERT INTO event_log (run_id, seq, card_id, type, ts, data) VALUES ('run-1',2,'s-delivered','story.transition',102,'not json')",
      "INSERT INTO event_log (run_id, seq, card_id, type, ts, data) VALUES ('run-2',0,'missing','story.transition',103,'{\"to\":\"DELIVERED\"}')",
    ], "write");
    const source = new LibsqlConsoleDataSource(client, async () => []);

    await expect(source.overview()).resolves.toMatchObject({ events: [
      { storyId: "s-delivered", title: "Delivered today", state: "DELIVERED", timestamp: 100 },
    ] });
    client.close();
  });
});

describe("S-E3OVERVIEW-01-active", () => {
  it("shows only recently active non-waiting requirements and stories", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    await client.batch([
      "INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at) VALUES ('r-active','rp1','Active requirement','EXECUTING','Work',1,20)",
      "INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at) VALUES ('r-clarify','rp4','Clarification required','EXECUTING','Work',1,35)",
      "INSERT INTO requirement_clarify_rounds (requirement_id, round, questions, asked_at) VALUES ('r-clarify',1,'[{\"question\":\"Choose region\"}]',10)",
      "INSERT INTO requirements (id, notion_page_id, title, state, original_request, stop_reason, created_at, updated_at) VALUES ('r-wait','rp2','Waiting requirement','CLARIFY','Work','blocking_question',1,30)",
      "INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at) VALUES ('r-done','rp3','Done requirement','DONE','Work',1,40)",
      "INSERT INTO stories (id, notion_page_id, title, requirement, state, phase, created_at, updated_at) VALUES ('s-active','sp1','Active story','Work','CODE','CODE',1,25)",
      "INSERT INTO stories (id, notion_page_id, title, requirement, state, created_at, updated_at) VALUES ('s-delivered','sp2','Delivered story','Work','DELIVERED',1,50)",
      "INSERT INTO stories (id, notion_page_id, title, requirement, state, created_at, updated_at) VALUES ('s-parked','sp3','Parked story','Work','HUMAN_PARKED',1,60)",
      "INSERT INTO stories (id, notion_page_id, title, requirement, state, stop_reason, created_at, updated_at) VALUES ('s-wait','sp4','Waiting story','Work','NEEDS_INPUT','blocking_question',1,70)",
    ], "write");
    const source = new LibsqlConsoleDataSource(client, async () => []);

    await expect(source.overview()).resolves.toMatchObject({ active: [
      { id: "s-active", title: "Active story", state: "CODE", summary: "Last updated" },
      { id: "r-active", title: "Active requirement", state: "EXECUTING", summary: "Last updated" },
    ] });
    client.close();
  });
});

describe("S-E3OVERVIEW-01-questions", () => {
  it("lists only unanswered clarification and active blocking questions", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    await client.batch([
      "INSERT INTO requirements (id, notion_page_id, title, state, original_request, stop_reason, created_at, updated_at) VALUES ('r-open','rp1','Open requirement','CLARIFY','Need a decision',NULL,1,20)",
      "INSERT INTO requirements (id, notion_page_id, title, state, original_request, stop_reason, created_at, updated_at) VALUES ('r-blocked','rp2','Blocked requirement','EXECUTING','Need a decision','blocking_question',1,21)",
      "INSERT INTO requirements (id, notion_page_id, title, state, original_request, stop_reason, created_at, updated_at) VALUES ('r-done','rp3','Done requirement','DONE','Need a decision','blocking_question',1,22)",
      "INSERT INTO requirement_clarify_rounds (requirement_id, round, questions, asked_at) VALUES ('r-open',1,'[{\"question\":\"Which region?\"}]',10)",
      "INSERT INTO stories (id, notion_page_id, title, requirement, state, stop_reason, created_at, updated_at) VALUES ('s-blocked','sp1','Blocked story','Requirement','NEEDS_INPUT','blocking_question',1,23)",
      "INSERT INTO stories (id, notion_page_id, title, requirement, state, stop_reason, created_at, updated_at) VALUES ('s-resumed','sp2','Resumed story','Requirement','CODE',NULL,1,24)",
    ], "write");
    const source = new LibsqlConsoleDataSource(client, async () => []);

    await expect(source.overview()).resolves.toMatchObject({
      questions: [
        { id: "r-open:clarify:1", title: "Open requirement", summary: "Which region?" },
        { id: "r-blocked:blocked", title: "Blocked requirement", summary: "blocking_question" },
        { id: "s-blocked:blocked", title: "Blocked story", summary: "blocking_question" },
      ],
    });
    client.close();
  });
});
