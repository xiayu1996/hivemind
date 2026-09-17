import schema from "./notion-schema.json" with { type: "json" };

/**
 * The board's Story column, named by what each option means to the person
 * reading it. Nothing indexes the schema list directly: the options are what a
 * person sees, so they get reordered and retired, and a positional read would
 * silently start meaning something else.
 */
export const STORY_BOARD_STATUS = {
  queued: schema.options.aiStatus[0]!,
  running: schema.options.aiStatus[1]!,
  /** The card stopped and only a person can move it on. */
  needsInput: schema.options.aiStatus[2]!,
  parked: schema.options.aiStatus[3]!,
  done: schema.options.aiStatus[4]!,
  failed: schema.options.aiStatus[5]!,
  dropped: schema.options.aiStatus[6]!,
} as const;
