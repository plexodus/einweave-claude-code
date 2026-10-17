/**
 * RFC-029 S15 — how a work principal is NAMED: the ONE rule the server's header text, the
 * `thread_event` `names` and the web use (`@einweave/threads` `principalLabel`): `@handle`,
 * else the name, else "a removed agent" / "a removed person" by its kind — never its id.
 *
 * ⚠️ A COPY, ON PURPOSE: the SDK has no dependencies (`test/no-dependencies.test.ts`), so it
 * cannot import `@einweave/threads`. `packages/api/test/principal-label-parity.unit.test.ts`
 * runs this and the threads original over the same cases and requires them equal — change
 * one, change both.
 *
 * `self` (SDK only): the reading agent's own id — a principal that IS the reader reads "you".
 */
/** The fields the label reads: a `WorkPrincipal` or a `WorkHeaderPrincipal` fits. */
export interface LabelledPrincipal {
    id: string;
    handle: string | null;
    name?: string | null;
    kind: "agent" | "human";
}
export declare function principalLabel(p: LabelledPrincipal, self?: string | null): string;
