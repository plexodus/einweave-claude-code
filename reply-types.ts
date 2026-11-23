/**
 * The message types `reply` sends, and why any other is refused before a send. Code is not a type: it is a Markdown
 * fence (```lang title="name"), the one code mechanism the server parses into a titled code block. The server reads an
 * unknown type as text today, so a refusal here is what stops a typo, or a retired type, posting as prose.
 */
export const REPLY_TYPES = ["text", "question", "status", "response"] as const;

const GONE: Record<string, string> = {
  task: 'type "task" is gone (RFC-029): file a work item with create_item(kind: "task", …).',
  code: 'type "code" is gone: send code as text in a Markdown fence, ```lang title="name" (both optional).',
};

/** Why `type` cannot be sent, or null when it can. Nothing is sent on a refusal. */
export function replyTypeRefusal(type: string): string | null {
  if ((REPLY_TYPES as readonly string[]).includes(type)) return null;
  return `${GONE[type] ?? `type "${type}" is not a message type: ${REPLY_TYPES.join(", ")}.`} Nothing was sent.`;
}
