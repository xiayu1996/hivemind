import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { loadCardDossier, renderCardDossier } from "./card-dossier.js";

let client: Client;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
  await client.batch([
    {
      sql: `INSERT INTO stories (id, notion_page_id, title, requirement, state, phase, inner_loop_rounds,
                                 mr_url, created_at, updated_at)
            VALUES ('S-E1-01', 'page-1', 'Show the queue', 'A person wants to see what is running', 'DELIVERED',
                    NULL, 2, 'https://example.test/pull/1', 1, 9)`,
      args: [],
    },
    {
      sql: `INSERT INTO phase_runs (run_id, card_id, phase, round, prompt_sha256, status, started_at, ended_at)
            VALUES ('shape-1', 'S-E1-01', 'SHAPE', 1, ?, 'completed', 2, 3)`,
      args: ["a".repeat(64)],
    },
    {
      sql: `INSERT INTO phase_runs (run_id, card_id, phase, round, prompt_sha256, status, failure, started_at, ended_at)
            VALUES ('code-1', 'S-E1-01', 'CODE', 1, ?, 'failed', 'invalidated: frozen tests were modified', 4, 5)`,
      args: ["b".repeat(64)],
    },
    {
      sql: `INSERT INTO phase_artifacts (run_id, card_id, phase, round, kind, body, created_at)
            VALUES ('shape-1', 'S-E1-01', 'SHAPE', 1, 'dod', 'the acceptance contract', 3)`,
      args: [],
    },
    {
      sql: `INSERT INTO open_questions (card_id, question_key, question, suggestion, blocking, answer, answered_at, created_at)
            VALUES ('S-E1-01', 'scope', 'Does it include the archive?', 'No, only live cards', 1, 'Correct', 4, 3)`,
      args: [],
    },
    {
      sql: `INSERT INTO verify_scenario_results
              (card_id, scenario_id, round, dod_version, scenario_version, verified_tree_sha, outcome, created_at)
            VALUES ('S-E1-01', 'S-E1-01-live', 1, 'v1', 's1', 'tree-1', 'passed', 6)`,
      args: [],
    },
    {
      sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
            VALUES ('code-1', 0, 'S-E1-01', 'CODE', 'phase.invalidated', 5, ?)`,
      args: [JSON.stringify({ round: 1, reason: "frozen tests were modified" })],
    },
    {
      sql: `INSERT INTO cost_entries (run_id, card_id, phase, purpose, tier, provider, model_id,
                                      uncached_input_tokens, output_tokens, cache_read_tokens,
                                      cache_write_tokens, reasoning_tokens, cost_usd, is_subscription, ts)
            VALUES ('code-1', 'S-E1-01', 'CODE', 'code', 'standard', 'mock', 'mock-1', 10, 1, 0, 0, 0, 0.25, 0, 5)`,
      args: [],
    },
  ], "write");
});

describe("card dossier", () => {
  it("joins the tables a reader would otherwise join by hand", async () => {
    const dossier = await loadCardDossier(client, "S-E1-01");
    const text = renderCardDossier(dossier!);
    expect(text).toContain("# S-E1-01 — Show the queue");
    expect(text).toContain("spend: $0.2500");
    expect(text).toContain("[blocking] scope: Does it include the archive?");
    expect(text).toContain("answer: Correct");
    expect(text).toContain("### SHAPE round 1 — completed");
    expect(text).toContain("the acceptance contract");
    expect(text).toContain("- round 1 S-E1-01-live: passed");
    expect(text).toContain("- CODE round 1: frozen tests were modified");
  });

  it("renders the same bytes twice, so two readings can be diffed", async () => {
    const first = renderCardDossier((await loadCardDossier(client, "S-E1-01"))!);
    const second = renderCardDossier((await loadCardDossier(client, "S-E1-01"))!);
    expect(first).toBe(second);
  });

  it("says nothing rather than inventing a card", async () => {
    expect(await loadCardDossier(client, "missing")).toBeNull();
  });
});
