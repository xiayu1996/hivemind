import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * The frames the loop puts around what sessions write, loaded from
 * `config/messages.yaml`. People read them, so they are data in the language
 * people use, not strings in code.
 */

const text = z.string().min(1);

export const messagesSchema = z
  .object({
    gates: z.object({ product: text, architecture: text, milestone: text }).strict(),
    status: z
      .object({
        working: text,
        waitingApproval: text,
        waitingAnswer: text,
        waitingProvider: text,
        waitingProviderHuman: text,
        stoppedNoProgress: text,
        stoppedBudget: text,
        done: text,
      })
      .strict(),
    approval: z.object({ title: text, body: text }).strict(),
    questions: z.object({ authorStuck: text, evaluatorStuck: text, builderBlocked: text }).strict(),
    reports: z.object({ done: text, stopped: text, milestone: text }).strict(),
    /** The words of the Notion board; property names can be overridden per instance. */
    notion: z
      .object({
        properties: z.object({ title: text, repository: text, status: text, recipe: text.optional(), note: text.optional() }).strict(),
        status: z.object({ queued: text, working: text, needs_input: text, stopped: text, done: text }).strict(),
        version: text,
        approve: text,
        replyWithOption: text,
        reply: text,
        truncated: text,
      })
      .strict(),
  })
  .strict();

export type Messages = z.infer<typeof messagesSchema>;

export async function loadMessages(path: string): Promise<Messages> {
  return messagesSchema.parse(parseYaml(await readFile(path, "utf8")));
}

/** Fills `{name}` placeholders. A placeholder without a value is a bug in the caller, so it throws. */
export function render(template: string, values: Readonly<Record<string, string | number>>): string {
  return template
    .replace(/\{([a-zA-Z]+)\}/g, (_match, name: string) => {
      const value = values[name];
      if (value === undefined) throw new Error(`message placeholder {${name}} has no value`);
      return String(value);
    })
    .trim();
}
