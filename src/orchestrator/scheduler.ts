import type { ConfigStore } from "../config/store.js";
import { directoryOf } from "../util/repository-path.js";

export interface SchedulableStory {
  id: string;
  dependsOn: readonly string[];
  predictedFootprint: readonly string[];
  /**
   * The Epic whose branch this Story's work lands on.
   *
   * Two Stories under one Epic share a branch: the second rebases onto what
   * the first left there, so an overlapping footprint is a race for one tree
   * and they may not run together. Two Stories under different Epics never
   * touch the same tree -- separate worktrees, separate branches, and MERGE
   * rebases each onto its own `epic/<id>` -- so their overlap is a conflict
   * between two Epic branches, which git resolves once at the Epic merge
   * rather than by never running the second card.
   *
   * Reading them as competitors cost this installation the whole requirement:
   * nine cards across six Epics each declared `src/console`, the plan held one
   * batch of one, and two of them had not started after four hours. Absent,
   * the Story is treated as sharing a branch with everything, which is the
   * conservative answer for a Story that has no Epic yet.
   */
  epicId?: string;
}

export interface PlannedStoryExecution {
  kind: "planned";
  batches: readonly (readonly string[])[];
}

export interface DependencyCycle {
  kind: "dependency_cycle";
  cycle: readonly string[];
  batches: readonly [];
}

/** Some Story can never become eligible: it depends on an id outside the set,
 * or on a Story that is itself stranded. Reported rather than dropped, because
 * a plan that silently omits a Story reads as a successful plan. */
export interface UnschedulableStories {
  kind: "unschedulable";
  stranded: readonly string[];
  batches: readonly (readonly string[])[];
}

export type StoryExecutionPlan = PlannedStoryExecution | DependencyCycle | UnschedulableStories;

function findDependencyCycle(stories: readonly SchedulableStory[]): readonly string[] | undefined {
  const storiesById = new Map(stories.map((story) => [story.id, story]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (story: SchedulableStory): readonly string[] | undefined => {
    if (visiting.has(story.id)) {
      const cycleStart = path.indexOf(story.id);
      return [...path.slice(cycleStart), story.id];
    }
    if (visited.has(story.id)) return undefined;
    visiting.add(story.id);
    path.push(story.id);
    for (const dependency of story.dependsOn) {
      const dependencyStory = storiesById.get(dependency);
      if (dependencyStory) {
        const cycle = visit(dependencyStory);
        if (cycle) return cycle;
      }
    }
    path.pop();
    visiting.delete(story.id);
    visited.add(story.id);
    return undefined;
  };

  for (const story of stories) {
    const cycle = visit(story);
    if (cycle) return cycle;
  }
  return undefined;
}

function pathsIntersect(rawLeft: string, rawRight: string): boolean {
  const left = directoryOf(rawLeft);
  const right = directoryOf(rawRight);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function footprintsIntersect(left: SchedulableStory, right: SchedulableStory): boolean {
  return left.predictedFootprint.some((leftPath) => right.predictedFootprint.some((rightPath) => pathsIntersect(leftPath, rightPath)));
}

function coversHotspot(story: SchedulableStory, hotspot: string): boolean {
  return story.predictedFootprint.some((footprint) => pathsIntersect(footprint, hotspot));
}

export function storiesShareHotspot(left: SchedulableStory, right: SchedulableStory, hotspots: readonly string[]): boolean {
  return hotspots.some((hotspot) => coversHotspot(left, hotspot) && coversHotspot(right, hotspot));
}

/** Whether the two Stories' work lands on the same branch. */
function shareBranch(left: SchedulableStory, right: SchedulableStory): boolean {
  return !left.epicId || !right.epicId || left.epicId === right.epicId;
}

function storiesConflict(left: SchedulableStory, right: SchedulableStory, hotspots: readonly string[]): boolean {
  // Hotspots are not scoped to a branch: they are the operator naming a path
  // whose conflicts are not worth having at all, which is a statement about
  // the Epic merge as much as about one tree.
  if (storiesShareHotspot(left, right, hotspots)) return true;
  return shareBranch(left, right) && footprintsIntersect(left, right);
}

export async function planRepositoryStoryExecution(
  config: ConfigStore,
  stories: readonly SchedulableStory[],
  options: StoryExecutionOptions = {},
): Promise<StoryExecutionPlan> {
  await config.reload();
  return planStoryExecution(stories, config.get("schedule.hotspotPaths"), options);
}

/** States a Story can still be dispatched from. A parked or failed Story is
 * not work the scheduler may plan; a delivered one is a dependency that is
 * already satisfied. */
const DISPATCHABLE = new Set(["QUEUED", "SHAPE", "DESIGN", "SPECIFY", "CODE", "VERIFY", "MERGE", "REGRESSION_FIX"]);

export interface RepositoryStory extends SchedulableStory {
  state: string;
}

/**
 * Narrows a repository's Stories to the ones the scheduler may plan, and drops
 * the dependencies they no longer wait on. A dependency that left the set
 * unresolved would otherwise strand its dependents forever.
 */
export function dispatchableStories(stories: readonly RepositoryStory[]): SchedulableStory[] {
  const byId = new Map(stories.map((story) => [story.id, story]));
  const open = new Set(stories.filter((story) => DISPATCHABLE.has(story.state)).map((story) => story.id));
  // A dependency that is neither delivered nor still dispatchable (stopped for
  // a person, parked, failed) holds its dependents back: planning them would
  // only let them claim a batch slot they cannot use, starving the Stories
  // whose footprint overlaps theirs.
  const held = new Set<string>();
  const isHeld = (id: string, trail: Set<string>): boolean => {
    if (held.has(id)) return true;
    if (trail.has(id)) return false;
    trail.add(id);
    const story = byId.get(id);
    const blocked = story !== undefined && story.dependsOn.some((dependency) => {
      const upstream = byId.get(dependency);
      if (!upstream) return false;
      if (upstream.state === "DELIVERED") return false;
      return !open.has(dependency) || isHeld(dependency, trail);
    });
    if (blocked) held.add(id);
    return blocked;
  };
  return stories
    .filter((story) => open.has(story.id) && !isHeld(story.id, new Set()))
    .map((story) => {
      const planned: SchedulableStory = {
        id: story.id,
        dependsOn: story.dependsOn.filter((dependency) => open.has(dependency)),
        predictedFootprint: story.predictedFootprint,
      };
      if (story.epicId) planned.epicId = story.epicId;
      return planned;
    });
}

export interface StoryExecutionOptions {
  /**
   * The most Stories one batch may hold.
   *
   * Used for the one case where independent Stories are not independent: a
   * repository whose interface contract is not on the branch yet. The first
   * card to run is the one that puts it there, and every card dispatched
   * beside it would invent its own -- which is what 14 cards pointing at a
   * front-end directory that did not exist looked like from inside.
   */
  maxPerBatch?: number;
  /**
   * Stories already executing on this installation, by id.
   *
   * They hold their footprint for as long as they run, so they seed the first
   * batch and nothing that conflicts with them joins it. Without this the plan
   * describes a machine on which nothing has started yet, and the caller then
   * dispatches into a directory a live worktree is already writing.
   */
  running?: readonly string[];
}

export function planStoryExecution(
  stories: readonly SchedulableStory[],
  hotspots: readonly string[],
  options: StoryExecutionOptions = {},
): StoryExecutionPlan {
  const cycle = findDependencyCycle(stories);
  if (cycle) return { kind: "dependency_cycle", cycle, batches: [] };

  const remaining = [...stories];
  const completed = new Set<string>();
  const running = new Set(options.running ?? []);
  const batches: string[][] = [];
  while (remaining.length > 0) {
    const batch: SchedulableStory[] = [];
    // A Story that is already executing holds its footprint until it finishes,
    // so the first batch is whatever is running plus whatever may run beside
    // it. Planning from scratch every cycle put a card into batch one while a
    // card sharing its directories sat in batch six and was already in a
    // worktree: S-R237511CO-03 and S-R237511MB-01 both took src/console on
    // 2026-09-19, which is the conflict at merge that footprints exist to
    // prevent. A running Story's dependencies are satisfied by the fact that it
    // is running, so it is seeded before the dependency check rather than
    // through it.
    const seeding = batches.length === 0 && running.size > 0;
    if (seeding) for (const story of remaining) if (running.has(story.id)) batch.push(story);
    for (const story of remaining) {
      if (seeding && running.has(story.id)) continue;
      if (!story.dependsOn.every((dependency) => completed.has(dependency))) continue;
      if (batch.some((candidate) => storiesConflict(story, candidate, hotspots))) continue;
      if (options.maxPerBatch !== undefined && batch.length >= options.maxPerBatch) break;
      batch.push(story);
    }
    if (batch.length === 0) {
      return { kind: "unschedulable", stranded: remaining.map((story) => story.id).toSorted(), batches };
    }
    batches.push(batch.map((story) => story.id));
    for (const story of batch) completed.add(story.id);
    const batchIds = new Set(batch.map((story) => story.id));
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (batchIds.has(remaining[index]!.id)) remaining.splice(index, 1);
    }
  }
  return { kind: "planned", batches };
}
