import { createApp, onMounted, ref } from "vue";
import { loadTaskExecutionDetail, taskExecutionDetailPath, taskExecutionDetailRequestPath } from "./task-detail.js";

/** How a round's outcome is written on the page. Colour never carries the
 * meaning on its own; every status is also a word. */
const STATUS_LABELS = { completed: "已完成", running: "正在进行", failed: "执行失败" };

/** Reads one task's execution detail from the console's own read endpoint. */
const detailApi = {
  async get(taskId, signal) {
    const response = await fetch(taskExecutionDetailRequestPath(taskId), {
      signal,
      headers: { accept: "application/json" },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("HTTP " + response.status);
    return await response.json();
  },
};

function routeOf(pathname) {
  const detail = /^\/tasks\/([^/]+)\/?$/.exec(pathname);
  if (detail) return { kind: "detail", taskId: decodeURIComponent(detail[1]) };
  if (pathname === "/" || pathname === "/tasks" || pathname === "/tasks/") return { kind: "list" };
  return { kind: "pending" };
}

async function listTasks() {
  const response = await fetch("/api/tasks", { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("HTTP " + response.status);
  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

/**
 * The pages this Story delivers: the task list, and one task's execution detail
 * read round by round.
 *
 * The template is exported so the rendering can be exercised without a browser;
 * the page itself mounts only where there is a document.
 */
export const TEMPLATE = `
  <header class="topbar">
    <a class="brand" href="/tasks">hivemind</a>
    <span class="sub">运行控制台</span>
  </header>
  <main class="content">
    <template v-if="route.kind === 'list'">
      <h1>任务</h1>
      <p class="hint">选择一项任务，查看它每一轮执行的过程、产出和结果。</p>
      <p v-if="listError" class="notice error">任务列表暂时打不开（{{ listError }}）。</p>
      <ul v-else class="task-list">
        <li v-for="task in tasks" :key="task.id">
          <a :href="detailPath(task.id)">
            <span class="task-id">{{ task.id }}</span>
            <span class="task-title">{{ task.title }}</span>
          </a>
        </li>
      </ul>
    </template>

    <template v-else-if="route.kind === 'detail'">
      <a class="back" href="/tasks">← 返回任务列表</a>
      <template v-if="pageState.kind === 'ready'">
        <h1 class="task-heading">{{ pageState.detail.taskId }}｜{{ pageState.detail.taskName }}</h1>
        <ol class="rounds">
          <li v-for="round in pageState.detail.rounds" :key="round.round" class="round">
            <div class="round-head">
              <h2>第 {{ round.round }} 轮</h2>
              <span v-if="statusLabels[round.status]" class="status" :class="'status-' + round.status">{{ statusLabels[round.status] }}</span>
            </div>
            <section class="block">
              <h3>执行过程</h3>
              <ul v-if="round.process.length > 0" class="records">
                <li v-for="(step, index) in round.process" :key="index"><span class="phase">{{ step.phase }}</span>{{ step.summary }}</li>
              </ul>
              <p v-else class="muted">这一轮还没有执行过程。</p>
            </section>
            <section class="block">
              <h3>产出</h3>
              <ul v-if="round.outputs.length > 0" class="records">
                <li v-for="(output, index) in round.outputs" :key="index"><span class="phase">{{ output.phase }}</span>{{ output.content }}</li>
              </ul>
              <p v-else class="muted">这一轮还没有产出。</p>
            </section>
            <section class="block">
              <h3>当前结果</h3>
              <p>{{ round.currentResult || "这一轮还没有结果。" }}</p>
            </section>
            <p v-if="round.status === 'failed'" class="failure">失败原因：{{ round.failureReason }}</p>
          </li>
        </ol>
      </template>
      <p v-else-if="pageState.kind === 'not_found'" class="notice">找不到这个任务：{{ route.taskId }}</p>
      <p v-else-if="pageState.kind === 'error'" class="notice error">这个任务的执行详情暂时打不开（{{ pageState.message }}）。</p>
      <p v-else class="muted">正在加载……</p>
    </template>

    <template v-else>
      <h1>这个页面还没有做</h1>
      <p class="pending">当前只有任务列表和任务执行详情。</p>
    </template>
  </main>
`;

export const App = {
  setup() {
    const route = routeOf(location.pathname);
    const tasks = ref([]);
    const listError = ref("");
    const pageState = ref({ kind: "loading", taskId: "" });

    onMounted(async () => {
      if (route.kind === "list") {
        try {
          tasks.value = await listTasks();
        } catch (cause) {
          listError.value = cause instanceof Error ? cause.message : String(cause);
        }
        return;
      }
      if (route.kind === "detail") {
        pageState.value = await loadTaskExecutionDetail(detailApi, route.taskId);
      }
    });

    return { route, tasks, listError, pageState, statusLabels: STATUS_LABELS, detailPath: taskExecutionDetailPath };
  },
  template: TEMPLATE,
};

if (typeof document !== "undefined") createApp(App).mount("#app");
