import type { Client } from "@libsql/client";
import type { NotionOutboxDelivery } from "../notion/outbox.js";
import type { ConsoleDataSource, ConsoleServerOptions, createConsoleServer } from "./server.js";

export interface TodoConsoleRuntimeOptions {
  client: Client;
  delivery: NotionOutboxDelivery;
  now?: () => number;
  server?: Omit<ConsoleServerOptions, "todoRead" | "todoCommands">;
}

export async function createTodoConsoleRuntime(
  _data: ConsoleDataSource,
  _options: TodoConsoleRuntimeOptions,
): Promise<Awaited<ReturnType<typeof createConsoleServer>>> {
  throw new Error("the todo console runtime is not implemented yet");
}
