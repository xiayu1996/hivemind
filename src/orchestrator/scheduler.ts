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

export function planStoryExecution(stories: readonly SchedulableStory[], _hotspots: readonly string[]): StoryExecutionPlan {
  const cycle = findDependencyCycle(stories);
  if (cycle) return { kind: "dependency_cycle", cycle, batches: [] };

  const batches: string[][] = [];
  const scheduled: SchedulableStory[] = [];
  for (const story of stories) {
    if (scheduled.some((candidate) => footprintsIntersect(story, candidate))) {
      batches.push([story.id]);
    } else if (batches.length === 0) {
      batches.push([story.id]);
    } else {
      batches[0]!.push(story.id);
    }
    scheduled.push(story);
  }
  return { kind: "planned", batches };
}
