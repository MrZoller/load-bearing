/** Version-0 event registration for replayable agent transcript artifacts. */

import { defineEventModule } from "../events/module.js";
import type { EventContext } from "../events/module.js";
import { stampEvent } from "../events/log.js";
import { readString, requirePayload } from "../events/payload.js";
import type { EventPayload } from "../events/payload.js";
import type { EngineEvent } from "../events/state.js";
import {
  addAgentMessage,
  addAgentThinkingBlock,
  addAgentTodo,
  addAgentToolCall,
  createAgentSlice,
  recordAuthoredResponse,
  setAgentActivity,
  updateAgentThinkingBlock,
  updateAgentTodo,
  updateAgentToolCall,
  validateAgentActivity,
  validateAgentId,
  validateAgentSlice,
  validateAgentThinkingBlock,
  validateAgentTodo,
  validateAgentToolCall,
} from "./agent.js";
import type {
  AgentActivity,
  AgentSlice,
  AgentThinkingBlock,
  AgentTodo,
  AgentToolCall,
  ThinkingBlockStatus,
  TodoStatus,
  ToolCallStatus,
} from "./types.js";

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

export function createAgentActivityEvent(activity: AgentActivity): EngineEvent {
  return stampEvent(
    { type: "agent.activity-set", payload: { activity } },
    "agent activity",
  );
}

export const AGENT_MODULE = defineEventModule<AgentSlice>({
  namespace: "agent",
  description:
    "Replayable agent messages, authored responses and TUI artifacts.",
  initialSlice: createAgentSlice,
  validateSlice: validateAgentSlice,
  events: {
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
      version: 0,
      apply(context, slice) {
        const data = payload(context, ["activity"]);
        const activity = validateAgentActivity(
          data["activity"],
          `${context.where}: activity`,
        );
        return {
          slice: setAgentActivity(slice, activity),
          summary: `activity=${activity.status}`,
        };
      },
    },
  },
});
