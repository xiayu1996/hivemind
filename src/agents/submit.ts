import { z } from "zod";
import type { ToolSpec } from "../ports.ts";

export const SUBMIT_TOOL = "submit_result";

export interface Submission<T> {
  tool: ToolSpec;
  /** The last valid submission, or undefined when none was made. */
  value(): T | undefined;
}

/**
 * The only way a session hands its result back. The arguments are checked
 * against the step's schema before they are accepted, and a refusal goes back
 * to the model as the tool's error so it can correct the call in the same
 * session. A later valid call replaces an earlier one, which is how a result
 * rejected by a deterministic check is resubmitted.
 */
export function submissionTool<T>(schema: z.ZodType<T>, description: string): Submission<T> {
  let accepted: { value: T } | undefined;
  const parameters = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete parameters.$schema;
  return {
    tool: {
      name: SUBMIT_TOOL,
      description,
      parameters,
      async execute(args) {
        const parsed = schema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`The result does not match the required shape; fix these and call ${SUBMIT_TOOL} again:\n${z.prettifyError(parsed.error)}`);
        }
        accepted = { value: parsed.data };
        return { text: "Result received.", endsSession: true };
      },
    },
    value: () => accepted?.value,
  };
}
