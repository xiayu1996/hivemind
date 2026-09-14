import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SessionFileError,
  deriveSessionId,
  pinSessionFile,
  sessionFilePath,
  sessionMessageCount,
  type SessionFileRequest,
} from "./session-file.js";

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "hivemind-session-file-"));
  roots.push(path);
  return path;
}

function request(over: Partial<SessionFileRequest> = {}): SessionFileRequest {
  return {
    sessionRoot: over.sessionRoot ?? root(),
    cardId: "S-EPIC1-01",
    phase: "CODE",
    round: 1,
    attempt: 1,
    lane: "build",
    scope: "card",
    ...over,
  };
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("the pinned cache key", () => {
  it("is the same for every phase of one card on one lane, which is what makes the prefix cache hit", () => {
    const build = { scope: "card", group: "S-EPIC1-01", lane: "build" } as const;
    expect(deriveSessionId(build)).toBe(deriveSessionId(build));
  });

  it("separates the two lanes, so the blind verifier never shares a key with the builder", () => {
    expect(deriveSessionId({ scope: "card", group: "S-EPIC1-01", lane: "build" }))
      .not.toBe(deriveSessionId({ scope: "card", group: "S-EPIC1-01", lane: "verify" }));
  });

  it("separates cards, and widens to the repository when the scope says so", () => {
    expect(deriveSessionId({ scope: "card", group: "S-EPIC1-01", lane: "build" }))
      .not.toBe(deriveSessionId({ scope: "card", group: "S-EPIC1-02", lane: "build" }));
    expect(deriveSessionId({ scope: "repo", group: "hivemind", lane: "build" }))
      .toBe(deriveSessionId({ scope: "repo", group: "hivemind", lane: "build" }));
  });

  it("is a well-formed UUID, because pi clamps the value before sending it", () => {
    expect(deriveSessionId({ scope: "card", group: "S-EPIC1-01", lane: "build" }))
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("refuses a repository scope with no repository to group by", async () => {
    await expect(pinSessionFile(request({ scope: "repo" }))).rejects.toThrow(/no repository id/);
  });
});

describe("the session file a spawn is given", () => {
  it("is its own file per attempt, so a failover inside one round cannot continue the last attempt's conversation", () => {
    const base = request();
    expect(sessionFilePath(base)).not.toBe(sessionFilePath({ ...base, attempt: 2 }));
    expect(sessionFilePath(base)).not.toBe(sessionFilePath({ ...base, round: 2 }));
    expect(sessionFilePath(base)).not.toBe(sessionFilePath({ ...base, phase: "VERIFY" }));
    expect(sessionFilePath(base)).not.toBe(sessionFilePath({ ...base, cardId: "S-EPIC1-02" }));
  });

  it("starts as a header and nothing else, with the id pi will route on", async () => {
    const pinned = await pinSessionFile(request());

    const [header, ...rest] = readFileSync(pinned.path, "utf8").split("\n");
    expect(JSON.parse(header!)).toMatchObject({ type: "session", version: 3, id: pinned.id });
    expect(rest).toEqual([""]);
    expect(await sessionMessageCount(pinned.path)).toBe(0);
  });

  it("writes the same bytes twice, so a rebuilt round is the same input", async () => {
    const sessionRoot = root();
    const first = await pinSessionFile(request({ sessionRoot }));
    const second = await pinSessionFile(request({ sessionRoot }));

    expect(readFileSync(second.path, "utf8")).toBe(readFileSync(first.path, "utf8"));
  });

  it("refuses a first spawn into a file that already holds a conversation", async () => {
    const input = request();
    const path = sessionFilePath(input);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `{"type":"session","version":3,"id":"x"}\n{"role":"user"}\n`, "utf8");

    await expect(pinSessionFile(input)).rejects.toThrow(SessionFileError);
  });

  it("lets a crash-restart of the same attempt continue the file it already wrote", async () => {
    const input = request();
    const path = sessionFilePath(input);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `{"type":"session","version":3,"id":"x"}\n{"role":"user"}\n`, "utf8");

    const resumed = await pinSessionFile(input, { resuming: true });
    expect(resumed.path).toBe(path);
    // Untouched: the messages the crashed attempt wrote are what it resumes from.
    expect(await sessionMessageCount(path)).toBe(1);
  });
});
