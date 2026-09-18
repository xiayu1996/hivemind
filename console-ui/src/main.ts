/**
 * The console shell for the todo screen.
 *
 * The screen itself reads no URL: the shell owns "which todo is open" and
 * hands it in, so a phone shell can mount the same screen without either one
 * owning the other's content. The id arrives as `?todoId=`, and without one
 * the screen opens the oldest waiting todo through the same read port.
 */
import { createApp, h } from "vue";
import TodoPage from "./pages/todo/TodoPage.vue";
import { createTodoHttpPort } from "./pages/todo/contracts.js";
import "./styles/tokens.css";

const todoId = new URLSearchParams(window.location.search).get("todoId");

createApp({
  render: () => h(TodoPage, { todoId, port: createTodoHttpPort(), submittedBy: "本人" }),
}).mount("#app");
