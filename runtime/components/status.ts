import { deriveEngineMetrics } from "../../engine/index.js";
import type { SessionState } from "../../engine/index.js";

export function groupedInteger(value: number): string {
  const digits = String(value);
  const first = digits.length % 3 || 3;
  const groups = [digits.slice(0, first)];
  for (let index = first; index < digits.length; index += 3) {
    groups.push(digits.slice(index, index + 3));
  }
  return groups.join(",");
}

function currencyFromMicros(value: number): string {
  const units = Math.floor(value / 1_000_000);
  const micros = String(value % 1_000_000).padStart(6, "0");
  return `$${groupedInteger(units)}.${micros}`;
}

function item(
  document: Document,
  label: string,
  value: string,
): HTMLParagraphElement {
  const element = document.createElement("p");
  element.className = "session-status__item";
  element.textContent = `${label} ${value}`;
  return element;
}

/** Render a fresh projection; the DOM never owns or increments metric state. */
export function renderStatus(
  document: Document,
  state: SessionState,
  incidentNumber: number,
): HTMLElement {
  const metrics = deriveEngineMetrics(state);
  const status = document.createElement("section");
  status.className = "session-status";
  status.setAttribute("aria-label", "Session status");

  status.append(
    item(document, "model", metrics.modelName),
    item(document, "tokens", groupedInteger(metrics.tokenCount)),
    item(document, "cost", currencyFromMicros(metrics.costMicros)),
    item(document, "context", `${String(metrics.contextPercent)}%`),
    item(document, "integrity", groupedInteger(metrics.structuralIntegrity)),
    item(
      document,
      "",
      `loadbearing.cc · Incident #${String(incidentNumber).padStart(3, "0")}`,
    ),
  );
  return status;
}
