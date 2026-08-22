/** Pure bounded agent-state transitions and hostile snapshot validation. */

import type { CartridgeAuthoredResponse } from "../cartridge/types.js";
import { readSlice } from "../events/state.js";
import type { SessionState } from "../events/state.js";
import { deepFreeze } from "../freeze.js";
import { countCodePoints } from "../text.js";
import type {
  AgentActivity,
  AgentMessage,
  AgentSlice,
  AgentThinkingBlock,
  AgentTodo,
  AgentToolCall,
  AuthoredResponseRecord,
  ThinkingBlockStatus,
  TodoStatus,
  ToolCallStatus,
} from "./types.js";

export const MAX_AGENT_MESSAGES = 512;
export const MAX_AGENT_TOOL_CALLS = 256;
export const MAX_AGENT_THINKING_BLOCKS = 256;
export const MAX_AGENT_TODOS = 256;
export const MAX_AGENT_RESPONSES = 256;
export const MAX_AGENT_ID_LENGTH = 160;
export const MAX_AGENT_TEXT_LENGTH = 16000;
export const MAX_AGENT_TITLE_LENGTH = 240;
export const MAX_AGENT_ACTIVITY_VERB_LENGTH = 240;

const ID = /^[a-z][a-z0-9-]{0,63}$/;

function record(
  value: unknown,
  where: string,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${where}: must be an object`);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${where}: must be a plain JSON object`);
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new Error(`${where}: must not contain symbol-keyed fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const unknown = Object.keys(descriptors)
    .filter((key) => !fields.includes(key))
    .sort();
  if (unknown.length > 0)
    throw new Error(`${where}: unexpected field(s) ${unknown.join(", ")}`);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.get !== undefined || descriptor.set !== undefined)
      throw new Error(`${where}.${key}: accessors are not inert JSON data`);
    if (!descriptor.enumerable)
      throw new Error(
        `${where}.${key}: non-enumerable fields are not JSON data`,
      );
  }
  return value as Readonly<Record<string, unknown>>;
}

function string(value: unknown, where: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${where}: must be a string`);
  if (countCodePoints(value) > maximum)
    throw new Error(`${where}: must be at most ${String(maximum)} characters`);
  return value;
}

export function validateAgentId(value: unknown, where: string): string {
  const id = string(value, where, MAX_AGENT_ID_LENGTH);
  if (!ID.test(id)) throw new Error(`${where}: must be a lowercase id slug`);
  return id;
}

function artifactId(value: unknown, where: string): string {
  const id = string(value, where, MAX_AGENT_ID_LENGTH);
  if (!/^[a-z][a-z0-9-]{0,63}(?:\/[a-z][a-z0-9-]{0,63}){0,2}$/.test(id))
    throw new Error(`${where}: must be a stable artifact id`);
  return id;
}

function enumValue<T extends string>(
  value: unknown,
  where: string,
  values: readonly T[],
): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new Error(`${where}: must be one of ${values.join(", ")}`);
  return value as T;
}

function array(
  value: unknown,
  where: string,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where}: must be an array`);
  if (Object.getPrototypeOf(value) !== Array.prototype)
    throw new Error(`${where}: must be a plain JSON array`);
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new Error(`${where}: must not contain symbol-keyed fields`);
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    // `map` below reads each item. Reject accessors before doing that so a
    // hostile snapshot cannot run code while its supposedly inert data is
    // being restored. `length` is the one built-in non-enumerable array field.
    if (
      key !== "length" &&
      (descriptor.get !== undefined || descriptor.set !== undefined)
    )
      throw new Error(`${where}.${key}: accessors are not inert JSON data`);
    if (key !== "length" && !descriptor.enumerable)
      throw new Error(
        `${where}.${key}: non-enumerable fields are not JSON data`,
      );
  }
  const keys = Object.keys(value);
  if (
    keys.length !== value.length ||
    !keys.every((key, index) => key === String(index))
  )
    throw new Error(`${where}: must be a dense array without extra fields`);
  if (value.length > maximum)
    throw new Error(`${where}: must contain at most ${String(maximum)} items`);
  return value;
}

function message(value: unknown, where: string): AgentMessage {
  const item = record(value, where, ["id", "role", "text", "responseId"]);
  const responseId = item["responseId"];
  if (responseId !== null && typeof responseId !== "string")
    throw new Error(`${where}.responseId: must be a string or null`);
  const role = enumValue(item["role"], `${where}.role`, ["visitor", "agent"]);
  if ((role === "visitor") !== (responseId === null))
    throw new Error(
      `${where}: visitor messages require a null responseId and agent messages require one`,
    );
  return {
    id: artifactId(item["id"], `${where}.id`),
    role,
    text: string(item["text"], `${where}.text`, MAX_AGENT_TEXT_LENGTH),
    responseId:
      responseId === null
        ? null
        : validateAgentId(responseId, `${where}.responseId`),
  };
}

export function validateAgentToolCall(
  value: unknown,
  where: string,
): AgentToolCall {
  const item = record(value, where, [
    "id",
    "title",
    "input",
    "output",
    "status",
  ]);
  return {
    id: artifactId(item["id"], `${where}.id`),
    title: string(item["title"], `${where}.title`, MAX_AGENT_TITLE_LENGTH),
    input: string(item["input"], `${where}.input`, MAX_AGENT_TEXT_LENGTH),
    output: string(item["output"], `${where}.output`, MAX_AGENT_TEXT_LENGTH),
    status: enumValue(item["status"], `${where}.status`, [
      "pending",
      "running",
      "succeeded",
      "failed",
    ]),
  };
}

export function validateAgentThinkingBlock(
  value: unknown,
  where: string,
): AgentThinkingBlock {
  const item = record(value, where, ["id", "text", "status"]);
  return {
    id: artifactId(item["id"], `${where}.id`),
    text: string(item["text"], `${where}.text`, MAX_AGENT_TEXT_LENGTH),
    status: enumValue(item["status"], `${where}.status`, [
      "active",
      "complete",
    ]),
  };
}

export function validateAgentTodo(value: unknown, where: string): AgentTodo {
  const item = record(value, where, ["id", "text", "status"]);
  return {
    id: artifactId(item["id"], `${where}.id`),
    text: string(item["text"], `${where}.text`, MAX_AGENT_TITLE_LENGTH),
    status: enumValue(item["status"], `${where}.status`, [
      "pending",
      "in-progress",
      "completed",
      "cancelled",
    ]),
  };
}

export function validateAgentActivity(
  value: unknown,
  where: string,
): AgentActivity {
  const item = record(value, where, ["status", "verb"]);
  const status = enumValue(item["status"], `${where}.status`, [
    "idle",
    "working",
  ]);
  const verb = string(
    item["verb"],
    `${where}.verb`,
    MAX_AGENT_ACTIVITY_VERB_LENGTH,
  );
  if ((status === "idle") !== (verb === ""))
    throw new Error(
      `${where}: idle requires an empty verb and working requires a verb`,
    );
  return status === "idle" ? { status, verb: "" } : { status, verb };
}

function responseRecord(value: unknown, where: string): AuthoredResponseRecord {
  const item = record(value, where, ["instanceId", "responseId"]);
  return {
    instanceId: validateAgentId(item["instanceId"], `${where}.instanceId`),
    responseId: validateAgentId(item["responseId"], `${where}.responseId`),
  };
}

function validatedArray<T>(
  value: unknown,
  where: string,
  maximum: number,
  validate: (item: unknown, at: string) => T,
): readonly T[] {
  return array(value, where, maximum).map((item, index) =>
    validate(item, `${where}[${String(index)}]`),
  );
}

function uniqueIds(
  values: readonly { readonly id: string }[],
  where: string,
): void {
  const seen = new Set<string>();
  for (const item of values) {
    if (seen.has(item.id))
      throw new Error(`${where}: duplicate id ${JSON.stringify(item.id)}`);
    seen.add(item.id);
  }
}

/** Validate every nested field without rewriting snapshot bytes. */
export function validateAgentSlice(
  slice: unknown,
  where: string,
  cartridge?: import("../cartridge/types.js").LoadedCartridge,
): AgentSlice {
  const item = record(slice, where, [
    "messages",
    "toolCalls",
    "thinkingBlocks",
    "todos",
    "activity",
    "responses",
  ]);
  const messages = validatedArray(
    item["messages"],
    `${where}.messages`,
    MAX_AGENT_MESSAGES,
    message,
  );
  const toolCalls = validatedArray(
    item["toolCalls"],
    `${where}.toolCalls`,
    MAX_AGENT_TOOL_CALLS,
    validateAgentToolCall,
  );
  const thinkingBlocks = validatedArray(
    item["thinkingBlocks"],
    `${where}.thinkingBlocks`,
    MAX_AGENT_THINKING_BLOCKS,
    validateAgentThinkingBlock,
  );
  const todos = validatedArray(
    item["todos"],
    `${where}.todos`,
    MAX_AGENT_TODOS,
    validateAgentTodo,
  );
  const responses = validatedArray(
    item["responses"],
    `${where}.responses`,
    MAX_AGENT_RESPONSES,
    responseRecord,
  );
  uniqueIds(messages, `${where}.messages`);
  uniqueIds(toolCalls, `${where}.toolCalls`);
  uniqueIds(thinkingBlocks, `${where}.thinkingBlocks`);
  uniqueIds(todos, `${where}.todos`);
  const instances = new Set<string>();
  for (const response of responses) {
    if (instances.has(response.instanceId))
      throw new Error(
        `${where}.responses: duplicate instance id ${JSON.stringify(response.instanceId)}`,
      );
    instances.add(response.instanceId);
    if (
      cartridge !== undefined &&
      !cartridge.story.responses.some(
        (authored) => authored.id === response.responseId,
      )
    )
      throw new Error(
        `${where}.responses: unknown authored response ${JSON.stringify(response.responseId)}`,
      );
    const authored = cartridge?.story.responses.find(
      (candidate) => candidate.id === response.responseId,
    );
    const authoredMessage = messages.find(
      (candidate) => candidate.id === `${response.instanceId}/message`,
    );
    if (
      authoredMessage === undefined ||
      authoredMessage.role !== "agent" ||
      authoredMessage.responseId !== response.responseId ||
      (cartridge !== undefined &&
        authoredMessage.text !==
          cartridge.story.responses.find(
            (authored) => authored.id === response.responseId,
          )?.text)
    )
      throw new Error(
        `${where}.responses: instance ${JSON.stringify(response.instanceId)} has no matching agent message`,
      );
    if (authored !== undefined) {
      for (const expected of authored.toolCalls) {
        const actual = toolCalls.find(
          (candidate) =>
            candidate.id ===
            instanceArtifactId(response.instanceId, "tool", expected.id),
        );
        if (
          actual === undefined ||
          actual.title !== expected.title ||
          actual.input !== expected.input
        )
          throw new Error(
            `${where}.responses: instance ${JSON.stringify(response.instanceId)} has no matching tool call ${JSON.stringify(expected.id)}`,
          );
      }
      for (const expected of authored.thinkingBlocks) {
        const actual = thinkingBlocks.find(
          (candidate) =>
            candidate.id ===
            instanceArtifactId(response.instanceId, "thinking", expected.id),
        );
        if (actual === undefined || actual.text !== expected.text)
          throw new Error(
            `${where}.responses: instance ${JSON.stringify(response.instanceId)} has no matching thinking block ${JSON.stringify(expected.id)}`,
          );
      }
      for (const expected of authored.todos) {
        const actual = todos.find(
          (candidate) =>
            candidate.id ===
            instanceArtifactId(response.instanceId, "todo", expected.id),
        );
        if (actual === undefined || actual.text !== expected.text)
          throw new Error(
            `${where}.responses: instance ${JSON.stringify(response.instanceId)} has no matching todo ${JSON.stringify(expected.id)}`,
          );
      }
    }
  }
  for (const candidate of messages) {
    if (
      candidate.responseId !== null &&
      !responses.some(
        (response) =>
          candidate.id === `${response.instanceId}/message` &&
          candidate.responseId === response.responseId,
      )
    )
      throw new Error(
        `${where}.messages: agent message ${JSON.stringify(candidate.id)} has no response instance`,
      );
  }
  // Return the original after narrowing: snapshot validation must not normalize bytes.
  validateAgentActivity(item["activity"], `${where}.activity`);
  return slice as AgentSlice;
}

export function createAgentSlice(): AgentSlice {
  return deepFreeze({
    messages: [],
    toolCalls: [],
    thinkingBlocks: [],
    todos: [],
    activity: { status: "idle", verb: "" },
    responses: [],
  });
}

export function readAgentSlice(state: SessionState): AgentSlice {
  return validateAgentSlice(
    readSlice(state, "agent"),
    "session state: slices.agent",
  );
}

function append<T>(
  values: readonly T[],
  value: T,
  maximum: number,
  label: string,
): readonly T[] {
  if (values.length >= maximum)
    throw new Error(`agent: ${label} limit ${String(maximum)} reached`);
  return [...values, value];
}

function assertUnused(
  values: readonly { readonly id: string }[],
  id: string,
  label: string,
): void {
  if (values.some((value) => value.id === id))
    throw new Error(`agent: duplicate ${label} id ${JSON.stringify(id)}`);
}

export function addAgentMessage(
  slice: AgentSlice,
  value: AgentMessage,
): AgentSlice {
  const checked = message(value, "agent: message");
  assertUnused(slice.messages, checked.id, "message");
  return deepFreeze({
    ...slice,
    messages: append(slice.messages, checked, MAX_AGENT_MESSAGES, "message"),
  });
}

export function addAgentToolCall(
  slice: AgentSlice,
  value: AgentToolCall,
): AgentSlice {
  const checked = validateAgentToolCall(value, "agent: tool call");
  assertUnused(slice.toolCalls, checked.id, "tool call");
  return deepFreeze({
    ...slice,
    toolCalls: append(
      slice.toolCalls,
      checked,
      MAX_AGENT_TOOL_CALLS,
      "tool call",
    ),
  });
}

const TOOL_TRANSITIONS: Readonly<
  Record<ToolCallStatus, readonly ToolCallStatus[]>
> = {
  pending: ["running", "failed"],
  running: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
};

export function updateAgentToolCall(
  slice: AgentSlice,
  id: string,
  status: ToolCallStatus,
  output: string,
): AgentSlice {
  const checkedId = artifactId(id, "agent: tool call update.id");
  const checkedStatus = enumValue(status, "agent: tool call update.status", [
    "pending",
    "running",
    "succeeded",
    "failed",
  ]);
  const checkedOutput = string(
    output,
    "agent: tool call update.output",
    MAX_AGENT_TEXT_LENGTH,
  );
  const index = slice.toolCalls.findIndex((value) => value.id === checkedId);
  const current = slice.toolCalls[index];
  if (current === undefined)
    throw new Error(`agent: unknown tool call ${JSON.stringify(checkedId)}`);
  if (!TOOL_TRANSITIONS[current.status].includes(checkedStatus))
    throw new Error(
      `agent: tool call cannot transition from ${current.status} to ${checkedStatus}`,
    );
  const toolCalls = [...slice.toolCalls];
  toolCalls[index] = {
    ...current,
    status: checkedStatus,
    output: checkedOutput,
  };
  return deepFreeze({ ...slice, toolCalls });
}

export function addAgentThinkingBlock(
  slice: AgentSlice,
  value: AgentThinkingBlock,
): AgentSlice {
  const checked = validateAgentThinkingBlock(value, "agent: thinking block");
  assertUnused(slice.thinkingBlocks, checked.id, "thinking block");
  return deepFreeze({
    ...slice,
    thinkingBlocks: append(
      slice.thinkingBlocks,
      checked,
      MAX_AGENT_THINKING_BLOCKS,
      "thinking block",
    ),
  });
}

export function updateAgentThinkingBlock(
  slice: AgentSlice,
  id: string,
  status: ThinkingBlockStatus,
): AgentSlice {
  const checkedId = artifactId(id, "agent: thinking update.id");
  const checkedStatus = enumValue(status, "agent: thinking update.status", [
    "active",
    "complete",
  ]);
  const index = slice.thinkingBlocks.findIndex(
    (value) => value.id === checkedId,
  );
  const current = slice.thinkingBlocks[index];
  if (current === undefined)
    throw new Error(
      `agent: unknown thinking block ${JSON.stringify(checkedId)}`,
    );
  if (current.status !== "active" || checkedStatus !== "complete")
    throw new Error(
      `agent: thinking block cannot transition from ${current.status} to ${checkedStatus}`,
    );
  const thinkingBlocks = [...slice.thinkingBlocks];
  thinkingBlocks[index] = { ...current, status: checkedStatus };
  return deepFreeze({ ...slice, thinkingBlocks });
}

const TODO_TRANSITIONS: Readonly<Record<TodoStatus, readonly TodoStatus[]>> = {
  pending: ["in-progress", "completed", "cancelled"],
  "in-progress": ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export function addAgentTodo(slice: AgentSlice, value: AgentTodo): AgentSlice {
  const checked = validateAgentTodo(value, "agent: todo");
  assertUnused(slice.todos, checked.id, "todo");
  return deepFreeze({
    ...slice,
    todos: append(slice.todos, checked, MAX_AGENT_TODOS, "todo"),
  });
}

export function updateAgentTodo(
  slice: AgentSlice,
  id: string,
  status: TodoStatus,
): AgentSlice {
  const checkedId = artifactId(id, "agent: todo update.id");
  const checkedStatus = enumValue(status, "agent: todo update.status", [
    "pending",
    "in-progress",
    "completed",
    "cancelled",
  ]);
  const index = slice.todos.findIndex((value) => value.id === checkedId);
  const current = slice.todos[index];
  if (current === undefined)
    throw new Error(`agent: unknown todo ${JSON.stringify(checkedId)}`);
  if (!TODO_TRANSITIONS[current.status].includes(checkedStatus))
    throw new Error(
      `agent: todo cannot transition from ${current.status} to ${checkedStatus}`,
    );
  const todos = [...slice.todos];
  todos[index] = { ...current, status: checkedStatus };
  return deepFreeze({ ...slice, todos });
}

export function setAgentActivity(
  slice: AgentSlice,
  activity: AgentActivity,
): AgentSlice {
  return deepFreeze({
    ...slice,
    activity: validateAgentActivity(activity, "agent: activity"),
  });
}

function instanceArtifactId(
  instanceId: string,
  kind: string,
  localId?: string,
): string {
  return localId === undefined
    ? `${instanceId}/${kind}`
    : `${instanceId}/${kind}/${localId}`;
}

/** Instantiate cartridge-authored artifacts; no authored behavior is copied into runtime code. */
export function recordAuthoredResponse(
  slice: AgentSlice,
  response: CartridgeAuthoredResponse,
  instanceId: string,
): AgentSlice {
  const checkedInstanceId = validateAgentId(
    instanceId,
    "agent: recorded response instance id",
  );
  if (slice.responses.some((value) => value.instanceId === checkedInstanceId))
    throw new Error(
      `agent: duplicate response instance ${JSON.stringify(checkedInstanceId)}`,
    );
  let next = addAgentMessage(slice, {
    id: instanceArtifactId(checkedInstanceId, "message"),
    role: "agent",
    text: response.text,
    responseId: response.id,
  });
  for (const item of response.toolCalls)
    next = addAgentToolCall(next, {
      ...item,
      id: instanceArtifactId(checkedInstanceId, "tool", item.id),
    });
  for (const item of response.thinkingBlocks)
    next = addAgentThinkingBlock(next, {
      ...item,
      id: instanceArtifactId(checkedInstanceId, "thinking", item.id),
    });
  for (const item of response.todos)
    next = addAgentTodo(next, {
      ...item,
      id: instanceArtifactId(checkedInstanceId, "todo", item.id),
    });
  return deepFreeze({
    ...next,
    responses: append(
      next.responses,
      { instanceId: checkedInstanceId, responseId: response.id },
      MAX_AGENT_RESPONSES,
      "response",
    ),
  });
}
