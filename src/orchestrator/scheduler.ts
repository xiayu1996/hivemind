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

function pathsIntersect(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function footprintsIntersect(left: SchedulableStory, right: SchedulableStory): boolean {
  return left.predictedFootprint.some((leftPath) => right.predictedFootprint.some((rightPath) => pathsIntersect(leftPath, rightPath)));
}

export function planStoryExecution(stories: readonly SchedulableStory[], _hotspots: readonly string[]): StoryExecutionPlan {
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
