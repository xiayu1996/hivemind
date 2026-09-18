<script setup lang="ts">
/**
 * The todo screen: what a person has to decide, and the one place they decide
 * it.
 *
 * It owns three things and nothing else -- which todo it is showing, the read
 * state, and the refresh timer. It creates nothing: the ledger decides what
 * waits, this screen shows it and answers it, and a failure here can never
 * move a card.
 *
 * The shell mounts it and passes the id in; the screen never reads the URL, so
 * the same screen can be mounted by a desktop or a phone shell without either
 * owning its content.
 *
 * Regions in reading order. Design 08 section 6 checks these roles against the
 * accessibility tree, so the roles are part of the contract, not decoration:
 *
 *   1. title bar   -- the page heading (`待办处理`), the way back to the
 *                     overview, and the handling status beside it: `未处理`
 *                     while undecided, `已处理` only once the result is
 *                     confirmed kept. A read that failed shows no handling
 *                     status at all.
 *   2. decision    -- `需要你决定` as the heading, the blocks of ledger text
 *                     that say what is being decided (`question` for an
 *                     answer, the draft's own summary for an approval, the
 *                     round's questions for a choice), then the controls of
 *                     the todo's kind:
 *                       answer  a labelled reply box (`答复`)
 *                       approve two labelled conclusions (`批准并继续`,
 *                               `要求返工`, one radio group) and the optional
 *                               `处理说明`
 *                       choose  one labelled option group per question
 *                     Every control has its own direct label; nothing is
 *                     preselected, including a recommended option.
 *   3. summary     -- `待办摘要`: type, the requirement it belongs to, how
 *                     long it has waited, and where the result will be kept
 *                     (`对应的 Notion 需求` / `对应的 Notion 任务`).
 *   4. actions     -- one primary action whose label is the kind's own submit
 *                     word. It is disabled for the whole request, so a
 *                     submission in flight cannot be triggered twice; a
 *                     validation issue is announced next to the control it is
 *                     about and never replaces the primary action.
 *   5. save state  -- after submitting: `已处理` with the line that says the
 *                     result is kept and where, or `正在等待 Notion 确认保存`
 *                     with `检查保存结果` while it is not confirmed. The todo
 *                     is still `未处理` in that state, and the work has not
 *                     continued from it.
 *
 * The four page states are the shell's shared views: `正在读取待办内容` (never
 * the empty state: a read that has not finished is not "nothing to do"),
 * `无法读取这件待办` with `重新读取`, `目前没有待办` with the way back to the
 * overview, and `这项待办已不再等待处理` for an id that is no longer there.
 *
 * There are no controls for creating a requirement, editing a task or moving
 * work on. Not hidden, not disabled: absent, because the console offers no
 * request that could answer them.
 *
 * On phone widths the content is one column in the order above and the primary
 * action sits in the fixed bottom bar (`layer.navigation`), which the content
 * column reserves room for. Copy, formatting and the state machine live in
 * ./contracts.ts.
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import {
  TODO_COPY,
  TODO_REFRESH_INTERVAL_MS,
  initialTodoView,
  type TodoPagePort,
  type TodoSubmissionDto,
  type TodoViewState,
} from "./contracts.js";

const props = withDefaults(
  defineProps<{
    /** The todo to show. Null asks for the oldest waiting one, which is how
     * the page behaves when it was opened without naming a todo. */
    todoId?: string | null;
    /** Where the todo comes from and where a decision goes. The shell passes
     * the HTTP port; a test passes a fake, which is what keeps this screen
     * testable without a server. */
    port: TodoPagePort;
    /** The name a recorded decision carries. One operator uses this console,
     * so the shell fills it in and the screen only passes it through. */
    submittedBy?: string;
    /** Overridden only to make a test's refresh deterministic. */
    refreshIntervalMs?: number;
  }>(),
  { todoId: null, submittedBy: "本人", refreshIntervalMs: TODO_REFRESH_INTERVAL_MS },
);

const view = ref<TodoViewState>(initialTodoView(props.todoId));
let timer: ReturnType<typeof setInterval> | null = null;

function read(): void {
  // Each read and each submission goes through reduceTodoView; the port's
  // answer alone never replaces the state, so a stale response cannot.
  throw new Error("the todo screen read loop is not implemented yet");
}

function submit(submission: TodoSubmissionDto): void {
  throw new Error(`the todo screen submission is not implemented yet: ${submission.kind}`);
}

function checkSave(): void {
  throw new Error("the todo screen save check is not implemented yet");
}

onMounted(() => {
  read();
  timer = setInterval(read, props.refreshIntervalMs);
});

onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer);
});
</script>

<template>
  <!-- Regions 1-5 and the state views above are declared in ./contracts.ts and
       measured against the accessibility tree; the page markup is written by
       the implementation phase. -->
  <section class="todo-page" :data-todo-id="props.todoId ?? ''">
    <header class="page-head">
      <h1>{{ TODO_COPY.heading }}</h1>
    </header>
  </section>
</template>
