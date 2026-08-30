export interface SchedulableStory {
  id: string;
  dependsOn: readonly string[];
  predictedFootprint: readonly string[];
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

export type StoryExecutionPlan = PlannedStoryExecution | DependencyCycle;

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

function pathsIntersect(left: string, right: string): boolean {
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

function storiesConflict(left: SchedulableStory, right: SchedulableStory, hotspots: readonly string[]): boolean {
  return footprintsIntersect(left, right) || storiesShareHotspot(left, right, hotspots);
}

export function planStoryExecution(stories: readonly SchedulableStory[], hotspots: readonly string[]): StoryExecutionPlan {
  const cycle = findDependencyCycle(stories);
  if (cycle) return { kind: "dependency_cycle", cycle, batches: [] };

  const remaining = [...stories];
  const completed = new Set<string>();
  const batches: string[][] = [];
  while (remaining.length > 0) {
    const batch: SchedulableStory[] = [];
    for (const story of remaining) {
      if (!story.dependsOn.every((dependency) => completed.has(dependency))) continue;
      if (batch.some((candidate) => storiesConflict(story, candidate, hotspots))) continue;
      batch.push(story);
    }
    if (batch.length === 0) break;
    batches.push(batch.map((story) => story.id));
    for (const story of batch) completed.add(story.id);
    const batchIds = new Set(batch.map((story) => story.id));
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (batchIds.has(remaining[index]!.id)) remaining.splice(index, 1);
    }
  }
  return { kind: "planned", batches };
}
