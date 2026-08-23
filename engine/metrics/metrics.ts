/** Pure status projections from replay state; no counter exists beside the fold. */

import type {
  CartridgeModel,
  CartridgeMetricParameters,
} from "../cartridge/types.js";
import type { SessionState } from "../events/state.js";
import { readTerminalSlice } from "../terminal/terminal.js";
import { readStorySlice } from "../story/story.js";
import type { EngineMetrics } from "./types.js";

export const MAX_METRIC_VALUE = Number.MAX_SAFE_INTEGER;

function boundedInteger(value: number, where: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `metrics: ${where} must be a non-negative safe integer, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function saturatingAdd(left: number, right: number): number {
  if (left > MAX_METRIC_VALUE - right) return MAX_METRIC_VALUE;
  return left + right;
}

function saturatingMultiply(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  if (left > Math.floor(MAX_METRIC_VALUE / right)) return MAX_METRIC_VALUE;
  return left * right;
}

function checkedParameters(
  value: CartridgeMetricParameters,
): CartridgeMetricParameters {
  boundedInteger(value.baseTokens, "baseTokens");
  boundedInteger(value.tokensPerEvent, "tokensPerEvent");
  boundedInteger(value.contextWindowTokens, "contextWindowTokens");
  if (value.contextWindowTokens === 0)
    throw new Error("metrics: contextWindowTokens must be greater than zero");
  boundedInteger(value.costMicrosPerToken, "costMicrosPerToken");
  boundedInteger(value.integrityStart, "integrityStart");
  boundedInteger(value.integrityLossPerEvent, "integrityLossPerEvent");
  return value;
}

function activeModel(state: SessionState, modelId: string): CartridgeModel {
  const model = state.cartridge.models.find(
    (candidate) => candidate.id === modelId,
  );
  if (model === undefined) {
    throw new Error(
      `metrics: active model ${JSON.stringify(modelId)} is not in the cartridge`,
    );
  }
  boundedInteger(model.costMultiplier, "model costMultiplier");
  return model;
}

/**
 * Derive the bounded current estimate from facts already validated into state.
 *
 * Cost uses the active model's multiplier for the complete estimate. A model
 * switch therefore reprices the current session instead of pretending the
 * cartridge's event-count estimate is an itemized historical bill. The event
 * log remains the only counter and snapshot restoration revalidates every input
 * this query reads.
 */
export function deriveEngineMetrics(state: SessionState): EngineMetrics {
  const eventCount = boundedInteger(state.eventCount, "eventCount");
  const terminal = readTerminalSlice(state);
  const model = activeModel(state, terminal.activeModel);
  const parameters = checkedParameters(state.cartridge.presentation.metrics);
  const stage = readStorySlice(state).stage;
  const display = state.cartridge.presentation.phase2.statusCurves.find(
    (row) => row.model === model.id && row.stage === stage,
  );
  if (display === undefined)
    throw new Error(
      `metrics: no authored status curve for model ${JSON.stringify(model.id)} at stage ${String(stage)}`,
    );

  const eventTokens = saturatingMultiply(parameters.tokensPerEvent, eventCount);
  const tokenCount = saturatingAdd(parameters.baseTokens, eventTokens);
  const baseCost = saturatingMultiply(
    tokenCount,
    parameters.costMicrosPerToken,
  );
  const costMicros = saturatingMultiply(baseCost, model.costMultiplier);

  // If capacity is met, the clamp decides the result before `tokens * 100`
  // could overflow. Below capacity the schema's one-billion-token window keeps
  // that multiplication exactly representable.
  const contextPercent =
    tokenCount >= parameters.contextWindowTokens
      ? 100
      : Math.floor((tokenCount * 100) / parameters.contextWindowTokens);
  const integrityLoss = saturatingMultiply(
    parameters.integrityLossPerEvent,
    eventCount,
  );
  const structuralIntegrity = Math.max(
    0,
    parameters.integrityStart - integrityLoss,
  );

  return Object.freeze({
    modelId: model.id,
    modelName: model.name,
    tokenCount,
    costMicros,
    contextPercent,
    structuralIntegrity,
    stage,
    display: Object.freeze({
      tokens: display.tokens,
      cost: display.cost,
      context: display.context,
      structuralIntegrity: display.structuralIntegrity,
      notOkayRatio: display.notOkayRatio,
    }),
  });
}
