/**
 * The console shell for the todo screen.
 *
 * The screen itself reads no URL: the shell owns "which todo is open" and
 * hands it in, so a phone shell can mount the same screen without either one
 * owning the other's content. The id arrives as `?todoId=`, and without one
 * the screen opens the oldest waiting todo through the same read port.
 *
 * A waiting todo is carried in the served document (server.ts), because the
 * fetch below only answers after the page has already painted the loading
 * placeholder; reading it here lets the first paint be the todo itself. The
 * screen still fetches on mount, so a later change is picked up as before.
 */
import { createApp, h } from "vue";
import TodoPage from "./pages/todo/TodoPage.vue";
import { createTodoHttpPort, type TodoReadResultDto } from "./pages/todo/contracts.js";
import "./styles/tokens.css";

const INITIAL_TODO_ELEMENT_ID = "hivemind-initial-todo";

function readInitialTodo(): TodoReadResultDto | null {
  const element = document.getElementById(INITIAL_TODO_ELEMENT_ID);
  if (element === null || element.textContent === null) return null;
  try {
    return JSON.parse(element.textContent) as TodoReadResultDto;
  } catch {
    // A payload the shell cannot read is not a page state: the screen reads the
    // todo itself on mount and shows the loading state until that read answers.
    return null;
  }
}

const todoId = new URLSearchParams(window.location.search).get("todoId");

createApp({
  render: () => h(TodoPage, {
    todoId,
    port: createTodoHttpPort(),
    submittedBy: "本人",
    initial: readInitialTodo(),
  }),
}).mount("#app");
