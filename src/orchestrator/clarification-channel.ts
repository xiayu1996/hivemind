export interface ClarificationQuestionBatch {
  requirementId: string;
  round: number;
  questions: readonly string[];
}

export interface ClarificationAnswer {
  /** Stable within its channel; the loop dedupes replays by it. */
  id: string;
  author: string;
  body: string;
  receivedAt: number;
}

/**
 * One human-facing conversation channel. Day one has a single implementation,
 * the requirement page's comments, but the boundary exists so a chat tool can
 * be added later without the state machine learning about it.
 */
export interface ClarificationChannel {
  readonly name: string;
  /** Exactly one channel is the record; see ClarificationChannelSet. */
  readonly isSourceOfTruth: boolean;
  ask(batch: ClarificationQuestionBatch): Promise<void>;
  collect(requirementId: string, round: number): Promise<ClarificationAnswer[]>;
  /** Writes answers that arrived somewhere else into this channel's own record.
   * Required of the source of truth, meaningless elsewhere. */
  record?(requirementId: string, round: number, answers: readonly ClarificationAnswer[]): Promise<void>;
}

/**
 * Holds the invariant that makes a second channel safe: Notion is the only
 * record. A side channel may carry the question out and the answer back, but
 * until that answer is written into the requirement page it has not happened
 * as far as the state machine is concerned. Without this, two people reading
 * two channels would each believe they had the requirement's real history.
 */
export class ClarificationChannelSet {
  readonly sourceOfTruth: ClarificationChannel;

  constructor(private readonly channels: readonly ClarificationChannel[]) {
    const records = channels.filter((channel) => channel.isSourceOfTruth);
    if (records.length !== 1) {
      throw new Error(`clarification needs exactly one source of truth, found ${records.length}`);
    }
    if (!records[0]!.record) {
      throw new Error(`the source of truth ${records[0]!.name} cannot write answers back`);
    }
    const names = new Set(channels.map((channel) => channel.name));
    if (names.size !== channels.length) throw new Error("clarification channel names must be unique");
    this.sourceOfTruth = records[0]!;
  }

  /** Asks everywhere: a side channel is there to reach the person faster. */
  async ask(batch: ClarificationQuestionBatch): Promise<void> {
    for (const channel of this.channels) await channel.ask(batch);
  }

  /** Reads only the record, so an answer that never reached Notion cannot move
   * the requirement forward. */
  collect(requirementId: string, round: number): Promise<ClarificationAnswer[]> {
    return this.sourceOfTruth.collect(requirementId, round);
  }

  /**
   * Copies what a side channel heard into the record. This is the only way a
   * side-channel answer becomes real, and it is deliberately explicit: the
   * requirement page ends up carrying the whole conversation.
   */
  async mirrorToRecord(requirementId: string, round: number, channelName: string): Promise<number> {
    const channel = this.channels.find((candidate) => candidate.name === channelName);
    if (!channel) throw new Error(`unknown clarification channel: ${channelName}`);
    if (channel.isSourceOfTruth) return 0;
    const answers = await channel.collect(requirementId, round);
    if (answers.length === 0) return 0;
    await this.sourceOfTruth.record!(requirementId, round, answers);
    return answers.length;
  }
}
