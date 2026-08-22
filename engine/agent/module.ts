/** Version-0 event registration for replayable agent transcript artifacts. */

import { defineEventModule } from "../events/module.js";
import type { EventContext } from "../events/module.js";
import { stampEvent } from "../events/log.js";
import { readInteger, readString, requirePayload } from "../events/payload.js";
import type { EventPayload } from "../events/payload.js";
import type { EngineEvent } from "../events/state.js";
import {
  addAgentMessage,
  addAgentThinkingBlock,
  addAgentTodo,
  addAgentToolCall,
  createAgentSlice,
  MAX_AGENT_MESSAGES,
  MAX_AGENT_RESPONSES,
  MAX_AGENT_THINKING_BLOCKS,
  MAX_AGENT_TODOS,
  MAX_AGENT_TOOL_CALLS,
  recordAuthoredResponse,
  setAgentActivity,
  updateAgentThinkingBlock,
  updateAgentTodo,
  updateAgentToolCall,
  validateAgentId,
  validateAgentSlice,
  validateAgentThinkingBlock,
  validateAgentTodo,
  validateAgentToolCall,
} from "./agent.js";
import type {
  AgentActivity,
  AgentActivityRequest,
  AgentSlice,
  AgentThinkingBlock,
  AgentTodo,
  AgentToolCall,
  ThinkingBlockStatus,
  TodoStatus,
  ToolCallStatus,
} from "./types.js";
import { forkModelStream, readTerminalSlice } from "../terminal/terminal.js";

function payload(
  context: EventContext,
  fields: readonly string[],
): EventPayload {
  const value = requirePayload(context);
  const unknown = Object.keys(value)
    .filter((key) => !fields.includes(key))
    .sort();
  if (unknown.length > 0)
    throw new Error(
      `${context.where}: unexpected payload field(s) ${unknown.join(", ")}; expected ${fields.join(", ")}`,
    );
  return value;
}

function authoredResponse(context: EventContext, id: string) {
  const response = context.cartridge.story.responses.find(
    (value) => value.id === id,
  );
  if (response === undefined)
    throw new Error(
      `${context.where}: unknown authored response ${JSON.stringify(id)}`,
    );
  return response;
}

export function createAgentMessageEvent(id: string, text: string): EngineEvent {
  return stampEvent(
    { type: "agent.message-added", payload: { id, text } },
    "agent message",
  );
}

export function createAgentResponseEvent(
  responseId: string,
  instanceId: string,
): EngineEvent {
  return stampEvent(
    { type: "agent.response-recorded", payload: { responseId, instanceId } },
    "agent response",
  );
}

/** Record the cartridge's one replayable idle teaching response. */
export function createAgentIdleNudgeEvent(): EngineEvent {
  return stampEvent({ type: "agent.idle-nudged" }, "agent idle nudge");
}

/** Record an authored refusal when bounded message history has no room. */
export function createAgentCapacityEvent(responseId: string): EngineEvent {
  return stampEvent(
    { type: "agent.capacity-reached", payload: { responseId } },
    "agent capacity",
  );
}

export function createAgentToolCallAddedEvent(
  toolCall: AgentToolCall,
): EngineEvent {
  return stampEvent(
    { type: "agent.tool-call-added", payload: { toolCall } },
    "agent tool call",
  );
}

export function createAgentToolCallUpdatedEvent(
  id: string,
  status: ToolCallStatus,
  output: string,
): EngineEvent {
  return stampEvent(
    { type: "agent.tool-call-updated", payload: { id, status, output } },
    "agent tool call update",
  );
}

export function createAgentThinkingAddedEvent(
  thinking: AgentThinkingBlock,
): EngineEvent {
  return stampEvent(
    { type: "agent.thinking-added", payload: { thinking } },
    "agent thinking",
  );
}

export function createAgentThinkingUpdatedEvent(
  id: string,
  status: ThinkingBlockStatus,
): EngineEvent {
  return stampEvent(
    { type: "agent.thinking-updated", payload: { id, status } },
    "agent thinking update",
  );
}

export function createAgentTodoAddedEvent(todo: AgentTodo): EngineEvent {
  return stampEvent(
    { type: "agent.todo-added", payload: { todo } },
    "agent todo",
  );
}

export function createAgentTodoUpdatedEvent(
  id: string,
  status: TodoStatus,
): EngineEvent {
  return stampEvent(
    { type: "agent.todo-updated", payload: { id, status } },
    "agent todo update",
  );
}

export function createAgentActivityEvent(
  activity: AgentActivityRequest,
): EngineEvent {
  return stampEvent(
    {
      type: "agent.activity-set",
      payload:
        activity.status === "idle"
          ? { status: "idle" }
          : { status: "working", stage: activity.stage },
    },
    "agent activity",
  );
}

function selectActivity(context: EventContext, stage: number): AgentActivity {
  const activeModel = readTerminalSlice(context.state).activeModel;
  const model = context.cartridge.models.find(
    (candidate) => candidate.id === activeModel,
  );
  if (model === undefined)
    throw new Error(
      `${context.where}: active model ${JSON.stringify(activeModel)} is not in the cartridge`,
    );
  const pool = context.cartridge.presentation.spinnerPools.find(
    (candidate) =>
      candidate.archetype === model.archetype && candidate.stage === stage,
  );
  if (pool === undefined)
    throw new Error(
      `${context.where}: no spinner pool for archetype ${JSON.stringify(model.archetype)} at stage ${String(stage)}`,
    );
  const verb = forkModelStream(context.random, activeModel)
    .fork("spinner.verbs")
    .pick(pool.verbs);
  return { status: "working", verb };
}

export const AGENT_MODULE = defineEventModule<AgentSlice>({
  namespace: "agent",
  description:
    "Replayable agent messages, authored responses and TUI artifacts.",
  initialSlice: createAgentSlice,
  validateSlice: validateAgentSlice,
  events: {
    "agent.idle-nudged": {
      version: 0,
      apply(context, slice) {
        if (context.cartridge.story.idleNudgeResponse === "")
          throw new Error(`${context.where}: cartridge has no idle nudge`);
        // The capacity fallback cannot record an authored-response instance,
        // so the transcript is the durable one-shot record for both paths.
        if (
          context.state.transcript.some(
            (entry) => entry.type === "agent.idle-nudged",
          )
        )
          throw new Error(`${context.where}: duplicate idle-nudge`);
        const response = authoredResponse(
          context,
          context.cartridge.story.idleNudgeResponse,
        );
        if (
          slice.messages.length + 1 > MAX_AGENT_MESSAGES ||
          slice.responses.length + 1 > MAX_AGENT_RESPONSES ||
          slice.toolCalls.length + response.toolCalls.length >
            MAX_AGENT_TOOL_CALLS ||
          slice.thinkingBlocks.length + response.thinkingBlocks.length >
            MAX_AGENT_THINKING_BLOCKS ||
          slice.todos.length + response.todos.length > MAX_AGENT_TODOS
        )
          return {
            slice,
            summary: `capacity response=${response.id}`,
          };
        return {
          slice: recordAuthoredResponse(slice, response, "idle-nudge"),
          summary: `response=${context.cartridge.story.idleNudgeResponse} instance=idle-nudge`,
        };
      },
    },
    "agent.message-added": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["id", "text"]);
        const id = validateAgentId(data["id"], `${context.where}: id`);
        const text = readString(data, "text", context.where);
        return {
          slice: addAgentMessage(slice, {
            id,
            role: "visitor",
            text,
            responseId: null,
          }),
          summary: `message=${id}`,
        };
      },
    },
    "agent.response-recorded": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["responseId", "instanceId"]);
        const responseId = validateAgentId(
          data["responseId"],
          `${context.where}: responseId`,
        );
        const instanceId = validateAgentId(
          data["instanceId"],
          `${context.where}: instanceId`,
        );
        return {
          slice: recordAuthoredResponse(
            slice,
            authoredResponse(context, responseId),
            instanceId,
          ),
          summary: `response=${responseId} instance=${instanceId}`,
        };
      },
    },
    "agent.capacity-reached": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["responseId"]);
        const responseId = validateAgentId(
          data["responseId"],
          `${context.where}: responseId`,
        );
        authoredResponse(context, responseId);
        return {
          slice,
          summary: `capacity response=${responseId}`,
        };
      },
    },
    "agent.tool-call-added": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["toolCall"]);
        const value = validateAgentToolCall(
          data["toolCall"],
          `${context.where}: toolCall`,
        );
        return {
          slice: addAgentToolCall(slice, value),
          summary: `tool=${value.id}`,
        };
      },
    },
    "agent.tool-call-updated": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["id", "status", "output"]);
        const id = readString(data, "id", context.where);
        const status = readString(
          data,
          "status",
          context.where,
        ) as ToolCallStatus;
        validateAgentToolCall(
          { id, title: "", input: "", output: data["output"], status },
          `${context.where}: update`,
        );
        return {
          slice: updateAgentToolCall(
            slice,
            id,
            status,
            readString(data, "output", context.where),
          ),
          summary: `tool=${id} status=${status}`,
        };
      },
    },
    "agent.thinking-added": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["thinking"]);
        const value = validateAgentThinkingBlock(
          data["thinking"],
          `${context.where}: thinking`,
        );
        return {
          slice: addAgentThinkingBlock(slice, value),
          summary: `thinking=${value.id}`,
        };
      },
    },
    "agent.thinking-updated": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["id", "status"]);
        const id = readString(data, "id", context.where);
        const status = readString(
          data,
          "status",
          context.where,
        ) as ThinkingBlockStatus;
        validateAgentThinkingBlock(
          { id, text: "", status },
          `${context.where}: update`,
        );
        return {
          slice: updateAgentThinkingBlock(slice, id, status),
          summary: `thinking=${id} status=${status}`,
        };
      },
    },
    "agent.todo-added": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["todo"]);
        const value = validateAgentTodo(data["todo"], `${context.where}: todo`);
        return {
          slice: addAgentTodo(slice, value),
          summary: `todo=${value.id}`,
        };
      },
    },
    "agent.todo-updated": {
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["id", "status"]);
        const id = readString(data, "id", context.where);
        const status = readString(data, "status", context.where) as TodoStatus;
        validateAgentTodo({ id, text: "", status }, `${context.where}: update`);
        return {
          slice: updateAgentTodo(slice, id, status),
          summary: `todo=${id} status=${status}`,
        };
      },
    },
    "agent.activity-set": {
      version: 1,
      apply(context, slice) {
        const initial = requirePayload(context);
        const status = readString(initial, "status", context.where);
        const data = payload(
          context,
          status === "idle" ? ["status"] : ["status", "stage"],
        );
        if (status !== "idle" && status !== "working")
          throw new Error(`${context.where}: status must be idle or working`);
        const activity =
          status === "idle"
            ? ({ status: "idle", verb: "" } as const)
            : selectActivity(
                context,
                readInteger(data, "stage", 0, 4, context.where),
              );
        return {
          slice: setAgentActivity(slice, activity),
          summary:
            activity.status === "idle"
              ? "activity=idle"
              : `activity=working verb=${JSON.stringify(activity.verb)}`,
        };
      },
    },
  },
});
