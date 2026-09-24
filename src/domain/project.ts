import { z } from "zod";

/**
 * How the target repository is set up, checked and started
 * (`.hivemind/project.yaml`). The planner declares it while designing the
 * architecture and the builder makes it true; the builder cannot edit it, so
 * it cannot redefine what "green" means. Commands are shell strings run from
 * the repository root.
 */

const checkSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    run: z.string().min(1),
    /** Names of checks that must pass first; this one is skipped when one of them fails. */
    requires: z.array(z.string()).default([]),
    timeoutSeconds: z.number().int().positive().max(3600).default(900),
  })
  .strict();

const appSchema = z
  .object({
    /**
     * Starts the real product, the same entry a person uses; a separate demo
     * script would let a screen pass that the product never mounts. The port
     * arrives as `{port}` in the command and as PORT in the environment.
     */
    start: z.string().min(1),
    /** Path polled until the app answers below 400. */
    ready: z.string().startsWith("/").default("/"),
    /** Prepares data for a scenario; `{seed}` is replaced with the scenario's seed name. */
    seed: z.string().min(1).optional(),
    timeoutSeconds: z.number().int().positive().max(600).default(120),
  })
  .strict();

export const projectSchema = z
  .object({
    /** Run in every fresh worktree before anything else, e.g. installing dependencies. */
    setup: z.array(z.string().min(1)).default([]),
    checks: z.array(checkSchema).min(1, "declare at least one check; a repository with no checks can never be green"),
    app: appSchema.optional(),
  })
  .strict();

export type Project = z.infer<typeof projectSchema>;
export type ProjectCheck = Project["checks"][number];

export function checkProject(project: Project, needsApp: boolean): string[] {
  const findings: string[] = [];
  const names = new Set<string>();
  for (const check of project.checks) {
    if (names.has(check.name)) findings.push(`check ${check.name} is declared twice`);
    names.add(check.name);
  }
  for (const check of project.checks) {
    for (const required of check.requires) {
      if (!names.has(required)) findings.push(`check ${check.name} requires ${required}, which is not declared`);
    }
  }
  if (needsApp && project.app === undefined) {
    findings.push("the acceptance contract has web scenarios, so project.yaml needs an app section saying how to start the product");
  }
  return findings;
}
