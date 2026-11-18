/**
 * PR K (work item keys): every tool parameter that names a thread takes a thread id, a thread link
 * of this workspace, or an item key (`EW-112`). This file turns what the model typed into the id the
 * server acts on. A bare id goes through untouched and costs no request (every reply carries one);
 * anything else is the SDK's `threads.resolveRef`, the one parser the api and web use too.
 *
 * Refusals name the parameter and say why, so the model can correct the one value it got wrong.
 */
import type { ResolvedThreadRef } from "./vendor/einweave-agent-sdk/index.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `api.threads.resolveRef` (SDK 0.35.0), injected so the rule runs against a fake. */
export type ResolveRef = (input: string) => Promise<ResolvedThreadRef>;

/** How a thread parameter is described to the model, in every tool schema that has one. */
export const THREAD_REF_DOC = "a thread id, a thread link, or a work item key (like EW-112)";

/** The thread id `raw` names. Throws a refusal that names `param` when it names none. */
export async function resolveThreadArg(raw: unknown, param: string, resolve: ResolveRef): Promise<string> {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) throw new Error(`${param} is required: ${THREAD_REF_DOC}.`);
  if (UUID.test(text)) return text.toLowerCase();
  const r = await resolve(text);
  if (r.ok) return r.threadId;
  // The SDK's `other_workspace` is any link that is no thread link of this workspace (a channel link, another host).
  if (r.reason === "other_workspace") throw new Error(`${param}: ${JSON.stringify(text)} is not a thread link of this workspace.`);
  if (r.reason === "not_found") throw new Error(`${param}: no work item ${text.toUpperCase()} that this agent can read.`);
  throw new Error(`${param}: ${JSON.stringify(text)} is not ${THREAD_REF_DOC}.`);
}

/**
 * As `resolveThreadArg`, for an optional parameter: absent (or `""`, how a model leaves a field out) stays
 * undefined. Whitespace is a value, refused: on `reply` it must never turn into a new root thread.
 */
export async function resolveOptionalThreadArg(raw: unknown, param: string, resolve: ResolveRef): Promise<string | undefined> {
  if (raw === undefined || raw === null || raw === "") return undefined;
  return await resolveThreadArg(raw, param, resolve);
}
