/**
 * The console on its own, for a verification round to open pages against.
 *
 * A scenario declared `ui` or `e2e` is judged on a screen, and a screen needs
 * something serving it. The screens here are rendered by the process that
 * holds the data, so one process is the whole application: this starts it on
 * the loopback interface the round's browser is allowed to reach, and answers
 * `/` with the overview it would land on.
 *
 * It serves the sample data because a verification round starts it with
 * neither a database nor a seed command, and because the central store is not
 * what this branch can read from yet. Every page, every form and the whole
 * submission path are the real routes: only the data behind them is fixed.
 *
 * The access screen is opened at `/access` as well as through the network
 * gate. A round drives a browser from the machine the app runs on, so it can
 * never arrive from outside the allowed range, and the denied screen is the
 * only screen a person could otherwise not be shown.
 */
import Fastify from "fastify";
import { registerOperatorConsoleRoutes, renderOperatorAccessPage } from "../src/console/operator-contract.js";
import { createSampleOperatorConsole } from "../src/console/operator-todo-sample.js";

const DEFAULT_PORT = 4319;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const port = Number(flag("port") ?? process.env.HIVEMIND_CONSOLE_PORT ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`--port must be a port number, got ${flag("port")}`);
}

const host = "127.0.0.1";
const app = Fastify({ logger: false });
await registerOperatorConsoleRoutes(app, createSampleOperatorConsole());
app.get("/access", async (_request, reply) => reply.type("text/html; charset=utf-8").send(renderOperatorAccessPage()));
app.get("/", async (_request, reply) => reply.redirect("/operator/overview", 302));

await app.listen({ host, port });
console.log(`console ready at http://${host}:${port}`);

const close = async (): Promise<void> => {
  await app.close().catch(() => undefined);
};
process.once("SIGINT", () => void close().then(() => process.exit(0)));
process.once("SIGTERM", () => void close().then(() => process.exit(0)));
