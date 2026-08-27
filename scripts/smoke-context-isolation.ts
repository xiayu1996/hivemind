// Verifies the mitigation for the context-file contamination found in M0:
// pi walks up from cwd and will load an unrelated personal CLAUDE.md. Running
// under a directory that has one as an ancestor must NOT pick it up when
// contextFiles is "explicit".
import { RpcPiRunner } from "../src/runner/rpc-runner.js";

const CONTAMINATED_CWD = `${process.env.HOME}/.claude/jobs`;
const PROBE = "Reply with exactly the word: ping";

async function run(contextFiles: "explicit" | "inherit"): Promise<string> {
  const runner = new RpcPiRunner({
    binary: `${process.env.HOME}/.hivemind/pi/0.84.3/pi/pi`,
    provider: "openai-codex",
    model: "gpt-5.4-mini",
    cwd: CONTAMINATED_CWD,
    tools: [],
    contextFiles,
  });
  await runner.start();
  await runner.setAutoRetry(false);
  await runner.prompt(PROBE, 120_000);
  const messages = await runner.getMessages();
  await runner.stop();
  return JSON.stringify(messages.at(-1));
}

const inherit = await run("inherit");
const explicit = await run("explicit");

const leaked = (s: string) => /Mr\.?Ryan/i.test(s);
console.log("cwd:", CONTAMINATED_CWD);
console.log("inherit  -> personal instruction leaked:", leaked(inherit));
console.log("explicit -> personal instruction leaked:", leaked(explicit));
console.log(leaked(inherit) && !leaked(explicit)
  ? "PASS: isolation works and the hazard is real"
  : "INCONCLUSIVE: see raw output below");
if (!(leaked(inherit) && !leaked(explicit))) {
  console.log("inherit :", inherit.slice(0, 300));
  console.log("explicit:", explicit.slice(0, 300));
}
