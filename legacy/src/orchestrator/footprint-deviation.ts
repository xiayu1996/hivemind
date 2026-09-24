export interface FootprintPrediction {
  storyId: string;
  predictedFootprint: readonly string[];
  actualFootprint: readonly string[];
}

export interface StoryFootprintDeviation {
  storyId: string;
  /** Touched without being covered by the prediction: the scheduler assumed these were free. */
  unpredicted: readonly string[];
  /** Predicted but never touched: parallelism paid for nothing. */
  unused: readonly string[];
  deviationRate: number;
}

export interface FootprintDeviationSummary {
  stories: number;
  deviationRate: number;
  unpredictedStoryRate: number;
  perStory: readonly StoryFootprintDeviation[];
}

/** A predicted module covers everything beneath it; predictions are directory granularity. */
function covers(predicted: string, actual: string): boolean {
  return actual === predicted || actual.startsWith(`${predicted}/`);
}

function rate(deviating: number, total: number): number {
  return total === 0 ? 0 : deviating / total;
}

/**
 * Directories a Story touched that its prediction does not cover.
 *
 * The scheduler treats an unpredicted directory as free ground while the Story
 * runs, so this is the set that made the parallelism claim untrue. It is also
 * the set worth telling somebody about: one card reached outside console-ui and
 * src/console into src/verify, src/runner and the repository root, which is to
 * say it rewrote the verifier that judges it and the build configuration every
 * other card shares.
 */
export function unpredictedDirectories(
  predictedFootprint: readonly string[],
  actualFootprint: readonly string[],
): string[] {
  const predicted = [...new Set(predictedFootprint)].toSorted();
  return [...new Set(actualFootprint)].toSorted()
    .filter((directory) => !predicted.some((candidate) => covers(candidate, directory)));
}

function deviationOf(prediction: FootprintPrediction): StoryFootprintDeviation {
  const predicted = [...new Set(prediction.predictedFootprint)].toSorted();
  const actual = [...new Set(prediction.actualFootprint)].toSorted();
  const unpredicted = unpredictedDirectories(predicted, actual);
  const unused = predicted.filter((directory) => !actual.some((candidate) => covers(directory, candidate)));
  return {
    storyId: prediction.storyId,
    unpredicted,
    unused,
    deviationRate: rate(unpredicted.length + unused.length, actual.length + predicted.length),
  };
}

/**
 * DECOMPOSE quality metric: how far a Story's predicted footprint sat from the diff it
 * actually produced. Pure and stably ordered so the projection is reproducible.
 */
export function summarizeFootprintDeviation(
  predictions: readonly FootprintPrediction[],
): FootprintDeviationSummary {
  const perStory = predictions
    .map(deviationOf)
    .toSorted((left, right) => left.storyId.localeCompare(right.storyId));
  const deviating = perStory.reduce((total, story) => total + story.unpredicted.length + story.unused.length, 0);
  const observed = predictions.reduce(
    (total, story) => total + new Set(story.actualFootprint).size + new Set(story.predictedFootprint).size,
    0,
  );
  return {
    stories: perStory.length,
    deviationRate: rate(deviating, observed),
    unpredictedStoryRate: rate(perStory.filter((story) => story.unpredicted.length > 0).length, perStory.length),
    perStory,
  };
}
