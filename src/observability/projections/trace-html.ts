import type { TraceProjection } from "./units.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderTraceHtml(trace: TraceProjection): string {
  const rows = trace.nodes.map((node) => {
    const coordinate = [node.turn === undefined ? "" : `turn ${node.turn}`, node.step === undefined ? "" : `step ${node.step}`]
      .filter(Boolean)
      .join(" / ");
    return `<li><strong>${escapeHtml(node.type)}</strong><span>${escapeHtml(coordinate)}</span><time>${node.time}</time></li>`;
  }).join("");
  return `<ol class="hivemind-trace">${rows}</ol>`;
}
