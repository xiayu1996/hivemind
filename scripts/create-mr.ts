import { discoverMRPort } from "../src/vcs/mr/adapters.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const adapter = await discoverMRPort();
  const result = await adapter.create({
    repository: required("HIVEMIND_MR_REPOSITORY"),
    sourceBranch: required("HIVEMIND_MR_SOURCE"),
    targetBranch: process.env.HIVEMIND_MR_TARGET ?? "main",
    title: required("HIVEMIND_MR_TITLE"),
    body: required("HIVEMIND_MR_BODY"),
    draft: process.env.HIVEMIND_MR_DRAFT === "1",
  });
  console.log(`${result.provider}: ${result.url}`);
}

main().catch((error: unknown) => {
  console.error("FAILED:", error instanceof Error ? error.message : "MR creation failed");
  process.exit(1);
});
