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

export function planStoryExecution(stories: readonly SchedulableStory[], _hotspots: readonly string[]): StoryExecutionPlan {
  return { kind: "planned", batches: [stories.map((story) => story.id)] };
}
