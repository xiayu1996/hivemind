import { dispatchableStories, planStoryExecution, type RepositoryStory } from "./scheduler.js";

export interface RepositoryDispatchInput {
  slug: string;
  /** Every Story the repository owns, in the priority order it is read in. */
  stories: readonly RepositoryStory[];
  hotspotPaths: readonly string[];
  /** False when the repository has no interface contract on its default branch
   * yet, which makes this cycle dispatch one card for it. */
  hasInterfaceContract?: boolean;
  /** Ids of this repository's Stories that are executing right now. They keep
   * their footprint taken while they run. */
  running?: readonly string[];
}

export interface RepositoryDispatchPlan {
  /** The first batch of each repository, concatenated in repository order. */
  batch: readonly { slug: string; cardId: string }[];
  /** Repositories whose Story graph cannot be planned, with what is wrong. */
  cycles: readonly { slug: string; cycle: readonly string[] }[];
  stranded: readonly { slug: string; cardIds: readonly string[] }[];
}

/**
 * Plans one cycle's dispatch across every repository this installation serves.
 *
 * Planning stays per repository: a Story's dependencies live inside its Epic,
 * and an Epic lives inside one repository, so two repositories can never
 * constrain each other's batch. What crosses the boundary is only the concurrency
 * the caller applies afterwards, and a repository whose graph is broken is
 * reported without holding up the ones that are fine.
 */
export function planDispatchAcrossRepositories(
  repositories: readonly RepositoryDispatchInput[],
): RepositoryDispatchPlan {
  const batch: { slug: string; cardId: string }[] = [];
  const cycles: { slug: string; cycle: readonly string[] }[] = [];
  const stranded: { slug: string; cardIds: readonly string[] }[] = [];
  for (const repository of repositories) {
    const plan = planStoryExecution(
      dispatchableStories(repository.stories),
      repository.hotspotPaths,
      {
        ...(repository.hasInterfaceContract === false ? { maxPerBatch: 1 } : {}),
        ...(repository.running && repository.running.length > 0 ? { running: repository.running } : {}),
      },
    );
    if (plan.kind === "dependency_cycle") {
      cycles.push({ slug: repository.slug, cycle: plan.cycle });
      continue;
    }
    if (plan.kind === "unschedulable") stranded.push({ slug: repository.slug, cardIds: plan.stranded });
    for (const cardId of plan.batches[0] ?? []) batch.push({ slug: repository.slug, cardId });
  }
  return { batch, cycles, stranded };
}
