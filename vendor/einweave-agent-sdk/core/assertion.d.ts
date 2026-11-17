import type { Clock } from "./clock";
import type { Signer } from "./signer";
export declare const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
/** Well inside the 300 s ceiling: a stale assertion is useless to anyone who logs it. */
export declare const ASSERTION_TTL_S = 60;
export declare function clientAssertion(signer: Signer, clock: Clock, installationId: string, issuer: string): Promise<string>;
/** RFC-016 §10: the `typ` of a supersede assertion — never `client-authentication+jwt`, so neither stands in for the other. */
export declare const SUPERSEDE_ASSERTION_TYP = "einweave-supersede+jwt";
/**
 * RFC-016 §10: the OLD installation's key says "the installation whose key is `newJkt`
 * replaces me" — iss = sub = the old installation, `aud` the issuer (the server it is SENT to:
 * the current one, whatever URL the old record was enrolled at), `kid` the old key's jkt, and
 * `new_jkt` binding it to the new key so it serves no other installation. Pure.
 */
export declare function supersedeAssertion(oldSigner: Signer, clock: Clock, oldInstallationId: string, issuer: string, newJkt: string): Promise<string>;
