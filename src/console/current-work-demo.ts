import type { Client } from "@libsql/client";

/**
 * The sample the current-work screens are judged on.
 *
 * A review opens the console on a temporary store, and the scenarios it judges
 * declare their own sample data. A review that instead read a real deployment's
 * running work would be refused for the work it could not see: the screens ask
 * a requirement to be running round 3 and a task under it to be running round 3
 * too, which is a fact about the sample and not about whoever's card happened
 * to be in flight that afternoon. Only the temporary store gets this.
 *
 * Nothing here is a second source of truth. The rows are written into the same
 * tables the executor writes, in the same shapes, so the projection under test
 * is the production projection and not a fixture reader.
 */

const REQUIREMENT_ID = "R-237511dd5162";
const REQUIREMENT_TITLE = "Hivemind 的 web 管理后台";
const EPIC_ID = "R237511DT";
const CARD_ID = "S-R237511DT-02";
const CARD_TITLE = "费用投影核对";
const REPO = "xiayu1996/hivemind";

/** A plausible hex tree id; the columns only need to be stable strings. */
function hash(seed: string): string {
  return seed.padEnd(64, "0").slice(0, 64).replaceAll(/[^0-9a-f]/g, "a");
}

export async function seedCurrentWorkDemo(client: Client, nowMs: number): Promise<void> {
  const hour = 60 * 60 * 1000;
  const statements = [
    {
      sql: `INSERT INTO requirements
              (id, notion_page_id, title, state, original_request, clarify_rounds, repo, created_at, updated_at)
            VALUES (?, ?, ?, 'SOLUTION', ?, 1, ?, ?, ?)`,
      args: [REQUIREMENT_ID, "demo-requirement", REQUIREMENT_TITLE, "建一个 web 管理后台", REPO, nowMs - 6 * hour, nowMs - hour],
    },
    {
      sql: `INSERT INTO requirement_clarify_rounds (requirement_id, round, questions, asked_at, answered_at, answers)
            VALUES (?, 1, ?, ?, ?, ?)`,
      args: [
        REQUIREMENT_ID,
        JSON.stringify([{ question: "后台需要覆盖哪些管理流程？", options: [] }]),
        nowMs - 6 * hour,
        nowMs - 5 * hour,
        JSON.stringify(["覆盖运行、费用与角色配置。"]),
      ],
    },
    {
      sql: `INSERT INTO requirement_prds (requirement_id, revision, body, status, created_at, confirmed_at)
            VALUES (?, 1, ?, 'confirmed', ?, ?)`,
      args: [
        REQUIREMENT_ID,
        JSON.stringify({
          businessGoal: "一个内网 web 管理后台，覆盖运行、费用与角色配置。",
        }),
        nowMs - 5 * hour,
        nowMs - 4 * hour,
      ],
    },
    {
      sql: `INSERT INTO requirement_solutions (requirement_id, revision, body, status, created_at, confirmed_at)
            VALUES (?, 1, ?, 'confirmed', ?, ?)`,
      args: [
        REQUIREMENT_ID,
        JSON.stringify({
          approach: { summary: "页面清单与浅色运行控制台方向已批准", alternatives: [] },
          stackChanges: [],
          openDecisions: [],
          qualityGates: [],
          interface: { direction: null, pages: [] },
        }),
        nowMs - 4 * hour,
        nowMs - 3 * hour,
      ],
    },
    {
      sql: `INSERT INTO requirement_prototypes (requirement_id, revision, body, mr_url, created_at)
            VALUES (?, 1, ?, ?, ?)`,
      args: [
        REQUIREMENT_ID,
        JSON.stringify({
          pages: [
            { file: "pages/overview.html", scenarios: ["R-237511dd5162-s01"], visible: [{ role: "heading", text: "运行总览" }] },
          ],
          described: [{ file: "pages/overview.html", name: "运行总览｜Hivemind", purpose: "查看运行中的需求与任务。" }],
          concerns: ["等待原型出口检查"],
        }),
        "https://example.invalid/prototype",
        nowMs - 2 * hour,
      ],
    },
    {
      sql: `INSERT INTO requirement_cost_entries
              (usage_event_id, requirement_id, work_item_id, round_id, occurred_at_ms, provider, model_id,
               billing_mode, category, token_count, pricing_status, price_version_id, usd_per_million_tokens,
               amount_usd, price_source_reference, created_at)
            VALUES (?, ?, ?, '3', ?, 'demo', 'demo-model', 'metered', 'output', 1200, 'priced', 'v1', '3.20', '3.84', 'demo', ?)`,
      args: ["demo-usage-3", REQUIREMENT_ID, REQUIREMENT_ID, nowMs - 2 * hour, nowMs - 2 * hour],
    },
    {
      sql: `INSERT INTO epics (id, notion_page_id, title, state, requirement_id, business_goal, repo, created_at, updated_at)
            VALUES (?, ?, ?, 'EXECUTING', ?, ?, ?, ?, ?)`,
      args: [EPIC_ID, "demo-epic", "查看需求与任务的当前进展和历次轮次", REQUIREMENT_ID, "看见当前轮与历史轮次。", REPO, nowMs - 5 * hour, nowMs - hour],
    },
    {
      sql: `INSERT INTO stories
              (id, epic_id, notion_page_id, title, requirement, state, phase, repo, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'CODE', 'CODE', ?, ?, ?)`,
      args: [CARD_ID, EPIC_ID, "demo-card", CARD_TITLE, "让本人打开任务看见当前轮。", REPO, nowMs - 3 * hour, nowMs - 10 * 60 * 1000],
    },
    {
      sql: `INSERT INTO phase_runs (run_id, card_id, phase, round, prompt_sha256, status, started_at, ended_at)
            VALUES (?, ?, 'SHAPE', 1, ?, 'completed', ?, ?)`,
      args: ["demo-run-r1", CARD_ID, hash("r1"), nowMs - 3 * hour, nowMs - 3 * hour + 20 * 60 * 1000],
    },
    {
      sql: `INSERT INTO phase_runs (run_id, card_id, phase, round, prompt_sha256, status, started_at, ended_at)
            VALUES (?, ?, 'CODE', 2, ?, 'completed', ?, ?)`,
      args: ["demo-run-r2", CARD_ID, hash("r2"), nowMs - 80 * 60 * 1000, nowMs - 50 * 60 * 1000],
    },
    {
      sql: `INSERT INTO phase_runs (run_id, card_id, phase, round, prompt_sha256, status, started_at)
            VALUES (?, ?, 'CODE', 3, ?, 'running', ?)`,
      args: ["demo-run-r3", CARD_ID, hash("r3"), nowMs - 40 * 60 * 1000],
    },
    {
      sql: `INSERT INTO story_specs (spec_id, story_id, seq, text, status) VALUES (?, ?, 1, ?, 'passed')`,
      args: ["S-R237511DT-02-cost-range", CARD_ID, "费用范围已核对"],
    },
    {
      sql: `INSERT INTO story_specs (spec_id, story_id, seq, text, status) VALUES (?, ?, 2, ?, 'passed')`,
      args: ["S-R237511DT-02-usd-amount", CARD_ID, "美元金额已核对"],
    },
    {
      sql: `INSERT INTO story_specs (spec_id, story_id, seq, text, status) VALUES (?, ?, 3, ?, 'failed')`,
      args: ["S-R237511DT-02-cost-basis", CARD_ID, "费用口径仍有 1 项待核对"],
    },
    {
      sql: `INSERT INTO verify_scenario_results
              (card_id, scenario_id, round, dod_version, scenario_version, verified_tree_sha, outcome, created_at)
            VALUES (?, ?, 3, ?, ?, ?, ?, ?)`,
      args: [CARD_ID, "S-R237511DT-02-cost-range", hash("dod"), hash("spec1"), hash("tree"), "passed", nowMs - 20 * 60 * 1000],
    },
    {
      sql: `INSERT INTO verify_scenario_results
              (card_id, scenario_id, round, dod_version, scenario_version, verified_tree_sha, outcome, created_at)
            VALUES (?, ?, 3, ?, ?, ?, ?, ?)`,
      args: [CARD_ID, "S-R237511DT-02-usd-amount", hash("dod"), hash("spec2"), hash("tree"), "passed", nowMs - 20 * 60 * 1000],
    },
    {
      sql: `INSERT INTO verify_scenario_results
              (card_id, scenario_id, round, dod_version, scenario_version, verified_tree_sha, outcome, created_at)
            VALUES (?, ?, 3, ?, ?, ?, ?, ?)`,
      args: [CARD_ID, "S-R237511DT-02-cost-basis", hash("dod"), hash("spec3"), hash("tree"), "failed", nowMs - 20 * 60 * 1000],
    },
    {
      sql: `INSERT INTO cost_entries (run_id, card_id, phase, provider, model_id, cost_usd, ts)
            VALUES (?, ?, 'CODE', 'demo', 'demo-model', 1.24, ?)`,
      args: ["demo-run-r3", CARD_ID, nowMs - 30 * 60 * 1000],
    },
  ];

  for (const statement of statements) await client.execute(statement);
}
