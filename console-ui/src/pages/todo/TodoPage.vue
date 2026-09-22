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
 *                     overview, and the handling status beside it (`role`
 *                     `status`): `未处理` while undecided, `已处理` only once
 *                     the result is confirmed kept. A read that failed shows
 *                     no handling status at all.
 *   2. decision    -- `需要你决定` as the heading, the blocks of ledger text
 *                     that say what is being decided, then the controls of the
 *                     todo's kind. Every control has its own direct label;
 *                     nothing is preselected, including a recommended option.
 *                     A refused submission says so in an `alert` that itself
 *                     carries `答复未提交，请重试`, so the sentence a scenario
 *                     requires is on the node that has the role.
 *   3. summary     -- `待办摘要`: type, the requirement it belongs to, how
 *                     long it has waited, and where the result will be kept.
 *   4. actions     -- one primary action whose label is the kind's own submit
 *                     word. It is disabled for the whole request, so a
 *                     submission in flight cannot be triggered twice.
 *   5. save state  -- after submitting: `已处理` with a `status` line that says
 *                     the result is kept and where, or `正在等待 Notion 确认保存`
 *                     with `检查保存结果` while it is not confirmed. The empty
 *                     state's `所有事项都已处理` is also a `status`.
 *
 * There are no controls for creating a requirement, editing a task or moving
 * work on. Not hidden, not disabled: absent, because the console offers no
 * request that could answer them.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  TODO_COPY,
  TODO_REFRESH_INTERVAL_MS,
  formatNotionTargetLine,
  formatSavedConfirmation,
  formatWaiting,
  initialTodoView,
  reduceTodoView,
  sectionHeading,
  todoKindLabel,
  validationMessage,
  type TodoDetailDto,
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

// The form is the screen's own state: the reducer holds what the ledger said,
// not what a person has typed. Nothing here starts selected.
const answerText = ref("");
const noteText = ref("");
const conclusion = ref<"approve" | "rework" | null>(null);
const choiceLetters = ref<Record<number, string | null>>({});
const choiceTexts = ref<Record<number, string>>({});
let formTodoId: string | null = null;

const todo = computed(() => view.value.todo);
const submitting = computed(() => view.value.status === "submitting");
const canSubmit = computed(() => todo.value !== null && !submitting.value);
const waiting = computed(() => (todo.value ? formatWaiting(todo.value.waitingSince, Date.now()) : ""));

function resetForm(loaded: TodoDetailDto): void {
  // A periodic refresh re-reads the same todo; it must not wipe what the
  // person is halfway through typing.
  if (formTodoId === loaded.todoId) return;
  formTodoId = loaded.todoId;
  answerText.value = "";
  noteText.value = "";
  conclusion.value = null;
  const letters: Record<number, string | null> = {};
  const texts: Record<number, string> = {};
  for (const question of loaded.questions) {
    letters[question.index] = null;
    texts[question.index] = "";
  }
  choiceLetters.value = letters;
  choiceTexts.value = texts;
}

function buildSubmission(loaded: TodoDetailDto): TodoSubmissionDto {
  if (loaded.kind === "answer") {
    return { kind: "answer", answer: answerText.value, submittedBy: props.submittedBy };
  }
  if (loaded.kind === "approve") {
    // Nothing chosen yet sends an empty conclusion on purpose: the server
    // answers `unknown_conclusion`, which is the same refusal a missing pick
    // gets, and the screen turns it into "请选择…".
    return { kind: "approve", conclusion: (conclusion.value ?? "") as "approve" | "rework", note: noteText.value, submittedBy: props.submittedBy };
  }
  return {
    kind: "choose",
    answers: loaded.questions.map((question) => ({
      questionIndex: question.index,
      optionLetter: choiceLetters.value[question.index] ?? null,
      text: choiceTexts.value[question.index] ?? "",
    })),
    note: noteText.value,
    submittedBy: props.submittedBy,
  };
}

function currentTodoId(): string | null {
  return view.value.todoId ?? props.todoId ?? null;
}

function read(): void {
  // Each read and each submission goes through reduceTodoView; the port's
  // answer alone never replaces the state, so a stale response cannot.
  const target = currentTodoId();
  view.value = reduceTodoView(view.value, { type: "load", todoId: target });
  const requestId = view.value.requestId;
  void props.port.read(target).then((result) => {
    view.value = reduceTodoView(view.value, { type: "loaded", requestId, result });
    if (view.value.status === "ready" && view.value.todo) resetForm(view.value.todo);
  }, () => {
    view.value = reduceTodoView(view.value, { type: "loaded", requestId, result: { kind: "failed" } });
  });
}

function submit(): void {
  const loaded = view.value.todo;
  if (!loaded || submitting.value) return;
  const submission = buildSubmission(loaded);
  view.value = reduceTodoView(view.value, { type: "submit", requestId: view.value.requestId + 1, submission });
  const requestId = view.value.requestId;
  void props.port.submit(loaded.todoId, submission).then((result) => {
    view.value = reduceTodoView(view.value, { type: "submitted", requestId, result });
  }, () => {
    view.value = reduceTodoView(view.value, { type: "submitted", requestId, result: { kind: "failed" } });
  });
}

function checkSave(): void {
  const loaded = view.value.todo;
  if (!loaded || submitting.value) return;
  view.value = reduceTodoView(view.value, { type: "check", requestId: view.value.requestId + 1 });
  const requestId = view.value.requestId;
  void props.port.checkSave(loaded.todoId).then((result) => {
    view.value = reduceTodoView(view.value, { type: "submitted", requestId, result });
  }, () => {
    view.value = reduceTodoView(view.value, { type: "submitted", requestId, result: { kind: "failed" } });
  });
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
  <section class="todo-page" :data-todo-id="props.todoId ?? ''">
    <header class="page-head">
      <a class="back-link" href="/">{{ TODO_COPY.back }}</a>
      <h1>{{ TODO_COPY.heading }}</h1>
      <span v-if="todo && view.status !== 'error'" class="status" role="status" :class="view.status === 'processed' ? 'status-done' : 'status-open'">
        {{ view.status === "processed" ? TODO_COPY.statusProcessed : TODO_COPY.statusUnhandled }}
      </span>
    </header>

    <div v-if="view.status === 'loading' && !todo" class="state-card" aria-live="polite">
      <h2>{{ TODO_COPY.loading }}</h2>
      <p>{{ TODO_COPY.loadingBody }}</p>
    </div>

    <div v-else-if="view.status === 'none'" class="state-card">
      <h2>{{ TODO_COPY.none }}</h2>
      <p role="status">{{ TODO_COPY.noneBody }}</p>
      <a class="button" href="/">{{ TODO_COPY.back }}</a>
    </div>

    <div v-else-if="view.status === 'error'" class="state-card">
      <h2>{{ TODO_COPY.failed }}</h2>
      <p>{{ TODO_COPY.failedBody }}</p>
      <button type="button" class="button" @click="read">{{ TODO_COPY.retry }}</button>
    </div>

    <div v-else-if="todo" class="todo-body">
      <div class="todo-main">
        <section class="panel" aria-labelledby="decision-heading">
          <h2 id="decision-heading">{{ TODO_COPY.decisionHeading }}</h2>

          <div v-for="section in todo.sections" :key="section.id" class="section">
            <h3 v-if="sectionHeading(section.id)">{{ sectionHeading(section.id) }}</h3>
            <p class="ledger-text">{{ section.text }}</p>
          </div>

          <form @submit.prevent="submit">
            <div v-if="todo.kind === 'answer'" class="section">
              <p v-for="question in todo.questions" :key="question.index" class="ledger-text">
                {{ question.question }}
              </p>
              <p v-if="todo.questions[0]?.context" class="meta">{{ todo.questions[0]!.context }}</p>
              <label for="answer-text">{{ TODO_COPY.replyLabel }}</label>
              <textarea id="answer-text" v-model="answerText" />
            </div>

            <fieldset v-if="todo.kind === 'approve'" class="section">
              <legend>{{ TODO_COPY.approveLegend }}</legend>
              <label class="choice">
                <input v-model="conclusion" type="radio" value="approve" />
                <span>{{ TODO_COPY.conclusionLabels.approve }}</span>
              </label>
              <label class="choice">
                <input v-model="conclusion" type="radio" value="rework" />
                <span>{{ TODO_COPY.conclusionLabels.rework }}</span>
              </label>
            </fieldset>

            <template v-if="todo.kind === 'choose'">
              <fieldset v-for="question in todo.questions" :key="question.index" class="section">
                <legend>{{ TODO_COPY.choiceLegend }}</legend>
                <p class="ledger-text">{{ question.question }}</p>
                <p v-if="question.context" class="meta">{{ question.context }}</p>
                <label v-for="option in question.options" :key="option.id" class="choice">
                  <input v-model="choiceLetters[question.index]" type="radio" :name="`question-${question.index}`" :value="option.id" />
                  <span>{{ option.id }}. {{ option.label }}<template v-if="option.recommended">（推荐）</template></span>
                </label>
                <label v-if="question.options.length === 0" :for="`choice-text-${question.index}`">{{ TODO_COPY.replyLabel }}</label>
                <input v-if="question.options.length === 0" :id="`choice-text-${question.index}`" v-model="choiceTexts[question.index]" type="text" />
              </fieldset>
            </template>

            <div v-if="todo.kind !== 'answer'" class="section">
              <label for="todo-note">{{ TODO_COPY.noteLabel }}</label>
              <textarea id="todo-note" v-model="noteText" />
              <p class="field-help">{{ TODO_COPY.noteHelp }}</p>
            </div>

            <ul v-if="view.issues.length > 0" class="validation">
              <li v-for="issue in view.issues" :key="issue">{{ validationMessage(issue) }}</li>
            </ul>

            <div v-if="view.status === 'submission_rejected'" class="submission-rejected">
              <p class="submission-rejected-title" role="alert">{{ TODO_COPY.answerNotSubmitted }}</p>
              <p class="field-help">{{ TODO_COPY.submissionRejectedBody }}</p>
            </div>

            <div class="actions">
              <button type="submit" class="button primary" :disabled="!canSubmit">
                {{ submitting ? TODO_COPY.submitting : TODO_COPY.submitLabels[todo.kind] }}
              </button>
            </div>
          </form>
        </section>

        <section v-if="view.status === 'processed'" class="panel" aria-live="polite">
          <h2>{{ TODO_COPY.statusProcessed }}</h2>
          <p role="status">{{ formatSavedConfirmation(todo) }}</p>
          <p>{{ TODO_COPY.processedBody }}</p>
          <a class="button" href="/">{{ TODO_COPY.back }}</a>
        </section>

        <section v-if="view.status === 'awaiting_notion'" class="panel" aria-live="polite">
          <h2>{{ TODO_COPY.awaitingHeading }}</h2>
          <p>{{ TODO_COPY.awaitingBody }}</p>
          <button type="button" class="button" :disabled="submitting" @click="checkSave">{{ TODO_COPY.checkSave }}</button>
        </section>
      </div>

      <aside class="todo-side panel">
        <h2>{{ TODO_COPY.summaryHeading }}</h2>
        <div class="row"><span>{{ TODO_COPY.summaryKind }}</span><strong>{{ todoKindLabel(todo.kind) }}</strong></div>
        <div class="row"><span>{{ TODO_COPY.summaryRequirement }}</span><strong>{{ todo.subject.requirementTitle ?? todo.subject.title }}</strong></div>
        <div class="row"><span>{{ TODO_COPY.summaryWaiting }}</span><strong>{{ waiting }}</strong></div>
        <div class="row"><span>{{ TODO_COPY.summaryDestination }}</span><strong>{{ formatNotionTargetLine(todo) }}</strong></div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.todo-page {
  padding: var(--space-page-gutter);
  font-family: var(--font-interface);
  color: var(--color-text);
}
.page-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--space-control-gap);
  margin-bottom: var(--space-section-gap);
}
h1 {
  font-size: var(--size-heading-page);
  font-weight: var(--weight-strong);
  margin: 0;
}
h2 {
  font-size: var(--size-heading-small);
  font-weight: var(--weight-medium);
  margin: 0 0 var(--space-content-gap);
}
h3 {
  font-size: var(--size-body-large);
  font-weight: var(--weight-medium);
  margin: 0 0 var(--space-inline-tight);
}
.back-link {
  color: var(--color-action);
}
.status {
  border-radius: var(--radius-pill);
  border: 1px solid var(--color-border);
  font-size: var(--size-caption);
  padding: var(--space-inline-tight) var(--space-control-gap);
}
.status-open {
  background: var(--color-surface-attention);
  color: var(--color-attention);
}
.status-done {
  background: var(--color-surface-success);
  color: var(--color-success);
}
.todo-body {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: var(--space-section-gap);
  align-items: start;
}
.panel {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel);
  padding: var(--space-section-gap);
  margin-bottom: var(--space-section-gap);
}
.state-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel);
  padding: var(--space-section-gap);
  max-width: 640px;
}
.section {
  margin-bottom: var(--space-content-gap);
}
.ledger-text {
  margin: 0 0 var(--space-control-gap);
  line-height: 1.6;
  max-width: 80ch;
  white-space: pre-wrap;
}
.meta,
.field-help {
  color: var(--color-text-muted);
  font-size: var(--size-caption);
}
.choice {
  display: block;
  padding: var(--space-control-gap);
  border-radius: var(--radius-control);
}
input[type="radio"]:checked + span {
  font-weight: var(--weight-medium);
}
label,
legend {
  font-weight: var(--weight-medium);
}
textarea,
input[type="text"] {
  display: block;
  width: 100%;
  box-sizing: border-box;
  min-height: 44px;
  margin: var(--space-inline-tight) 0 var(--space-control-gap);
  padding: var(--space-control-gap);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  font: inherit;
  color: inherit;
  background: var(--color-surface);
}
textarea:focus,
input[type="text"]:focus,
button:focus,
a:focus {
  outline: 2px solid var(--color-focus);
  outline-offset: 1px;
}
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0 var(--space-content-gap);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-surface);
  color: var(--color-action);
  font: inherit;
  text-decoration: none;
  cursor: pointer;
}
.button.primary {
  background: var(--color-action);
  border-color: var(--color-action);
  color: var(--color-surface);
}
.button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.validation {
  color: var(--color-danger);
  background: var(--color-surface-danger);
  border-radius: var(--radius-control);
  padding: var(--space-control-gap);
  list-style: none;
  margin: 0 0 var(--space-content-gap);
}
.submission-rejected {
  color: var(--color-danger);
  background: var(--color-surface-danger);
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-control);
  padding: var(--space-control-gap) var(--space-content-gap);
  margin: 0 0 var(--space-content-gap);
}
.submission-rejected-title {
  font-weight: var(--weight-medium);
  margin: 0 0 var(--space-inline-tight);
}
.submission-rejected .field-help {
  margin: 0;
}
.row {
  display: flex;
  justify-content: space-between;
  gap: var(--space-control-gap);
  border-bottom: 1px solid var(--color-border);
  padding: var(--space-control-gap) 0;
}
.row strong {
  text-align: right;
}
@media (max-width: 720px) {
  .todo-page {
    padding: var(--space-page-gutter-mobile);
  }
  .todo-body {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
