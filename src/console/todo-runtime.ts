import type { Client } from "@libsql/client";
import { canonicalPayload, NotionOutbox, type NotionOutboxDelivery, type NotionOutboxRecord } from "../notion/outbox.js";
import { listPendingTodos, readPendingTodo } from "../orchestrator/pending-todo.js";
import { createTodoDecisionDrain, createTodoDecisionStore } from "../orchestrator/todo-decision.js";
import {
  type ConsoleDataSource,
  type ConsoleServerOptions,
  createConsoleServer,
} from "./server.js";
import type { ConsoleTodoCommandPort, ConsoleTodoReadPort } from "./todo-contract.js";

export interface TodoConsoleRuntimeOptions {
  client: Client;
  delivery: NotionOutboxDelivery;
  now?: () => number;
  server?: Omit<ConsoleServerOptions, "todoRead" | "todoCommands">;
}

/**
 * Hands a delivery the payload as the exact text the outbox row carries.
 *
 * `NotionOutboxRecord.payload` is the parsed value, which is what a delivery
 * that understands the shape (`todo-decision-delivery.ts`) reads. A delivery
 * that judges the decision by the bytes it sent needs the stored form instead,
 * and `canonicalPayload` is the serialisation `enqueue` wrote: same bytes,
 * same content, only the read-back form differs. `isApplied` gets the same
 * form as `send`, so a delivery never sees two shapes of one record.
 */
function asStoredPayload(record: NotionOutboxRecord): NotionOutboxRecord {
  return { ...record, payload: canonicalPayload(record.payload) };
}

function deliveryReadingStoredPayload(delivery: NotionOutboxDelivery): NotionOutboxDelivery {
  return {
    isApplied: (record) => delivery.isApplied(asStoredPayload(record)),
    send: (record) => delivery.send(asStoredPayload(record)),
  };
}

/**
 * The console a running process serves for the todo surface.
 *
 * The ledger is the only source of what waits (`pending-todo.ts`) and the only
 * place a decision is kept (`todo-decision.ts`); this assembles the two ports
 * the HTTP layer declares and hands them to `createConsoleServer`, which keeps
 * every other write refused. A caller with no Notion delivery still gets the
 * read side and a write that stays queued, so the wiring does not depend on a
 * gateway being reachable at startup.
 */
export async function createTodoConsoleRuntime(
  data: ConsoleDataSource,
  options: TodoConsoleRuntimeOptions,
): Promise<Awaited<ReturnType<typeof createConsoleServer>>> {
  const { client, delivery, now, server } = options;
  const outbox = new NotionOutbox(client, now);
  const drain = createTodoDecisionDrain({
    client,
    outbox,
    delivery: deliveryReadingStoredPayload(delivery),
    ...(now ? { now } : {}),
  });
  const store = createTodoDecisionStore({ client, outbox, drain, ...(now ? { now } : {}) });
  const todoRead: ConsoleTodoReadPort = {
    listTodos: async () => {
      const todos = await listPendingTodos(client);
      return { todos, openTodoId: todos[0]?.todoId ?? null };
    },
    readTodo: (todoId) => readPendingTodo(client, todoId),
  };
  const todoCommands: ConsoleTodoCommandPort = store;
  return createConsoleServer(data, { ...server, todoRead, todoCommands });
}
