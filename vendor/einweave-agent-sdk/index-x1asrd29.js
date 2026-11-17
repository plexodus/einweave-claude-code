// ../protocol/src/v2/vocab.ts
var PROTOCOL_VERSION = 2;
var MAX_ACK_IDS = 500;
var CONTROL_FRAME_TYPES = ["authenticated", "reauthenticated", "error", "auth_required", "ping", "pong", "invalid_session", "drain"];
var ADDRESSED_REASONS = ["target", "assignee", "mention", "thread", "reply"];
var BROADCAST_REASONS = ["channel", "member", "type", "tag"];
var DELIVERY_REASONS = [...ADDRESSED_REASONS, ...BROADCAST_REASONS];
var ADDRESSED = new Set(ADDRESSED_REASONS);
function isAddressed(reasons) {
  if (!reasons)
    return false;
  for (const r of reasons)
    if (ADDRESSED.has(r))
      return true;
  return false;
}
var CONNECTION_KINDS = ["gateway", "session", "observer"];
var TURN_STATES = ["working", "needs_you", "idle"];
var ENTRY_KINDS = ["message", "action_request", "thread_event"];
var SESSION_DETAIL_KEYS = ["repoName", "worktreeName", "branchName", "headShortSha"];

// ../protocol/src/v2/close.ts
var CLOSE_CODES = {
  authTimeout: 4006,
  invalidToken: 4001,
  deregisteredOrArchived: 4003,
  tooManySessions: 4007,
  policy: 4008,
  tokenExpired: 4009,
  grantCheckFailed: 1011,
  membershipRevoked: 4004,
  tenantSwitched: 4005,
  goingAway: 1001,
  policyViolation: 1008
};
var CLOSE_REASONS = {
  tooManySessions: "Too many sessions",
  invalidToken: "Invalid token",
  authTimeout: "Authentication timeout",
  tokenExpired: "token expired",
  grantCheckFailed: "grant check failed",
  sessionEvicted: "session evicted",
  deregistered: "deregistered",
  workspaceArchived: "workspace archived",
  heartbeatMissed: "heartbeat missed",
  sessionInUse: "session already connected",
  gatewayTakenOver: "gateway taken over",
  gatewayInUse: "gateway in use",
  kindNotAllowed: "kind not allowed",
  invalidScope: "invalid scope",
  invalidReplaces: "invalid replaces",
  invalidAuth: "invalid auth",
  conversationReplaced: "conversation replaced",
  sessionStopped: "session stopped",
  sessionRevoked: "session revoked",
  installationRevoked: "installation revoked",
  installationLocked: "installation locked",
  sessionSuperseded: "session superseded",
  clientTooOld: "client too old",
  clientBlocked: "client version withdrawn",
  protocolUnsupported: "protocol unsupported",
  membershipRevoked: "membership revoked",
  tenantSwitched: "tenant switched",
  serverShuttingDown: "server shutting down",
  slowConsumer: "slow consumer"
};
var CLOSE_CODE_OF = {
  tooManySessions: CLOSE_CODES.tooManySessions,
  invalidToken: CLOSE_CODES.invalidToken,
  authTimeout: CLOSE_CODES.authTimeout,
  tokenExpired: CLOSE_CODES.tokenExpired,
  grantCheckFailed: CLOSE_CODES.grantCheckFailed,
  sessionEvicted: CLOSE_CODES.policy,
  deregistered: CLOSE_CODES.deregisteredOrArchived,
  workspaceArchived: CLOSE_CODES.deregisteredOrArchived,
  heartbeatMissed: CLOSE_CODES.policy,
  sessionInUse: CLOSE_CODES.policy,
  gatewayTakenOver: CLOSE_CODES.policy,
  gatewayInUse: CLOSE_CODES.policy,
  kindNotAllowed: CLOSE_CODES.policy,
  invalidScope: CLOSE_CODES.policy,
  invalidReplaces: CLOSE_CODES.policy,
  invalidAuth: CLOSE_CODES.policy,
  conversationReplaced: CLOSE_CODES.policy,
  sessionStopped: CLOSE_CODES.policy,
  sessionRevoked: CLOSE_CODES.policy,
  installationRevoked: CLOSE_CODES.policy,
  installationLocked: CLOSE_CODES.policy,
  sessionSuperseded: CLOSE_CODES.policy,
  clientTooOld: CLOSE_CODES.policy,
  clientBlocked: CLOSE_CODES.policy,
  protocolUnsupported: CLOSE_CODES.policy,
  membershipRevoked: CLOSE_CODES.membershipRevoked,
  tenantSwitched: CLOSE_CODES.tenantSwitched,
  serverShuttingDown: CLOSE_CODES.goingAway,
  slowConsumer: CLOSE_CODES.policyViolation
};

// src/core/wire.ts
var ADDRESSED_REASONS2 = ADDRESSED_REASONS;
var BROADCAST_REASONS2 = BROADCAST_REASONS;
var isAddressed2 = isAddressed;
var PROTOCOL_VERSION2 = PROTOCOL_VERSION;
var CONTROL_FRAME_TYPES2 = CONTROL_FRAME_TYPES;
var CONNECTION_KINDS2 = CONNECTION_KINDS;
var TURN_STATES2 = TURN_STATES;
var SESSION_DETAIL_KEYS2 = SESSION_DETAIL_KEYS;
var MAX_ACK_IDS2 = MAX_ACK_IDS;
var ENTRY_KINDS2 = ENTRY_KINDS;
var WS_CLOSE_CODES = CLOSE_CODES;
var WS_CLOSE_REASONS = CLOSE_REASONS;
function shape() {
  return;
}
var WIRE = shape();

// src/core/reconnect-policy.ts
var TERMINAL = new Set([
  "revoked",
  "superseded",
  "too-old",
  "session-in-use",
  "gateway-taken-over",
  "kind-not-allowed",
  "conversation-replaced",
  "protocol-unsupported"
]);
function isTerminal(cls) {
  return TERMINAL.has(cls);
}
var SCHEDULE = {
  transient: { baseMs: 1000, capMs: 30000 },
  expired: { baseMs: 1000, capMs: 30000 },
  evicted: { baseMs: 1000, capMs: 30000 },
  "session-cap": { baseMs: 30000, capMs: 300000 },
  credential: { baseMs: 60000, capMs: 300000 },
  "gateway-in-use": { baseMs: 5000, capMs: 60000 }
};
function reasonPrefix(reason) {
  if (!reason)
    return "";
  const i = reason.indexOf(":");
  return i === -1 ? reason : reason.slice(0, i);
}
function classifyClose(code, reason) {
  switch (code) {
    case WS_CLOSE_CODES.tooManySessions:
      return "session-cap";
    case WS_CLOSE_CODES.invalidToken:
    case WS_CLOSE_CODES.deregisteredOrArchived:
      return "credential";
    case WS_CLOSE_CODES.policy: {
      if (reason === WS_CLOSE_REASONS.sessionEvicted)
        return "evicted";
      if (reason === WS_CLOSE_REASONS.heartbeatMissed)
        return "transient";
      if (reason === WS_CLOSE_REASONS.sessionInUse)
        return "session-in-use";
      if (reason === WS_CLOSE_REASONS.conversationReplaced)
        return "conversation-replaced";
      const prefix = reasonPrefix(reason);
      if (prefix === WS_CLOSE_REASONS.sessionSuperseded)
        return "superseded";
      if (prefix === WS_CLOSE_REASONS.clientTooOld || prefix === WS_CLOSE_REASONS.clientBlocked)
        return "too-old";
      if (prefix === WS_CLOSE_REASONS.gatewayInUse)
        return "gateway-in-use";
      if (prefix === WS_CLOSE_REASONS.gatewayTakenOver)
        return "gateway-taken-over";
      if (prefix === WS_CLOSE_REASONS.kindNotAllowed)
        return "kind-not-allowed";
      if (prefix === WS_CLOSE_REASONS.protocolUnsupported)
        return "protocol-unsupported";
      return "revoked";
    }
    case WS_CLOSE_CODES.tokenExpired:
      return "expired";
    default:
      return "transient";
  }
}
function reconnectDelay(attempt, cls, rand = Math.random) {
  if (isTerminal(cls))
    return null;
  const { baseMs, capMs } = SCHEDULE[cls];
  const n = Math.max(1, Math.floor(attempt));
  const backoff = Math.min(capMs, baseMs * 2 ** (n - 1));
  return Math.round(backoff / 2 + rand() * (backoff / 2));
}
var SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
function parseSemver(v) {
  if (v === undefined)
    return null;
  const m = SEMVER_RE.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function isNewerThan(other, mine) {
  const o = parseSemver(other);
  const m = parseSemver(mine);
  if (!o || !m)
    return false;
  for (let i = 0;i < 3; i++)
    if (o[i] !== m[i])
      return o[i] > m[i];
  return false;
}
var REVOKED_STOP = {
  [WS_CLOSE_REASONS.sessionRevoked]: "session-revoked",
  [WS_CLOSE_REASONS.installationRevoked]: "installation-revoked",
  [WS_CLOSE_REASONS.installationLocked]: "installation-locked"
};
function detailOf(reason) {
  const i = reason?.indexOf(": ") ?? -1;
  return i !== -1 ? { detail: reason.slice(i + 2) } : {};
}
function closeOutcome(cls, code, reason, opts = {}) {
  const base = { class: cls, code, reason, retry: !isTerminal(cls) };
  switch (cls) {
    case "revoked":
      return { ...base, stop: reason && REVOKED_STOP[reason] || "policy-unknown", ...opts.keyDeleted ? { keyDeleted: true } : {} };
    case "superseded":
      return {
        ...base,
        stop: "superseded",
        ...opts.holder ? { holder: opts.holder } : {},
        holderIsNewer: !!opts.myVersion && isNewerThan(opts.holder?.version, opts.myVersion)
      };
    case "session-in-use":
      return { ...base, stop: "session-in-use" };
    case "gateway-in-use":
      return { ...base, ...detailOf(reason) };
    case "gateway-taken-over":
      return { ...base, stop: "gateway-taken-over", ...detailOf(reason) };
    case "kind-not-allowed":
      return { ...base, stop: "kind-not-allowed", ...detailOf(reason) };
    case "conversation-replaced":
      return { ...base, stop: "conversation-replaced" };
    case "protocol-unsupported":
      return { ...base, stop: "protocol-unsupported", ...detailOf(reason) };
    case "too-old": {
      const i = reason?.indexOf(": ") ?? -1;
      return { ...base, stop: "too-old", ...i !== -1 ? { remedy: reason.slice(i + 2) } : {} };
    }
    default:
      return base;
  }
}
// src/core/lock-decision.ts
var DEFAULT_HOLDER_VERSION = "0.25.0";
var VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
function parse(v) {
  const m = VERSION_RE.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function normalize(v) {
  return (v !== undefined ? parse(v) : null) ?? parse(DEFAULT_HOLDER_VERSION);
}
function compare(a, b) {
  const [am, an, ap] = normalize(a);
  const [bm, bn, bp] = normalize(b);
  if (am !== bm)
    return am - bm;
  if (an !== bn)
    return an - bn;
  return ap - bp;
}
function decideLock(holder, me, opts = {}) {
  if (!holder)
    return "acquire";
  if (opts.takeover)
    return "takeover";
  if (holder.version !== undefined && parse(holder.version) === null)
    return "standby";
  return compare(me.version, holder.version) > 0 ? "takeover" : "standby";
}
// src/core/format-guard.ts
var KNOWN_FORMAT = 0;
function classifyVersioned(parsed, knownMax = KNOWN_FORMAT) {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { kind: "absent" };
  const rawFormat = parsed.format;
  const format = typeof rawFormat === "number" && Number.isInteger(rawFormat) && rawFormat >= 0 ? rawFormat : 0;
  if (format > knownMax)
    return { kind: "newer", format };
  return { kind: "ok", format, data: parsed };
}
function isNewerFormat(parsed, knownMax = KNOWN_FORMAT) {
  return classifyVersioned(parsed, knownMax).kind === "newer";
}
// src/core/software.ts
function userAgent(sdkVersion, id) {
  return `einweave-agent-sdk/${sdkVersion} (${id.runtimeName}/${id.runtimeVersion}; ${id.os}/${id.arch}) ${id.softwareId}/${id.softwareVersion}`;
}
function identityTokenClientOptions(id) {
  return { clientId: id.softwareId, softwareId: id.softwareId, softwareVersion: id.softwareVersion };
}
// ../protocol/src/v2/doc.ts
var DOC_V = 1;
var LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
var IMG_PROTOCOLS = new Set(["https:"]);
function protocolOf(u) {
  if (typeof u !== "string")
    return null;
  try {
    return new URL(u).protocol;
  } catch {
    return null;
  }
}
function allowedLink(u) {
  const p = protocolOf(u);
  return p !== null && LINK_PROTOCOLS.has(p);
}
function allowedImage(u) {
  const p = protocolOf(u);
  return p !== null && IMG_PROTOCOLS.has(p);
}
var BLOCK = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "table", "thead", "tbody", "tr", "hr"]);
function docText(doc, nameOf) {
  const walk = (nodes) => nodes.map(node).join("");
  const node = (n) => {
    if (typeof n === "string")
      return n;
    if (!Array.isArray(n))
      return "";
    const [tag, a, ...kids] = n;
    switch (tag) {
      case "br":
        return `
`;
      case "img":
        return a && a.alt || "";
      case "@":
        return "@" + (a && (a.h ?? (a.p ? nameOf?.(a.p) : undefined)) || "");
      case "td":
      case "th":
        return walk(kids) + " ";
    }
    const text = walk(kids);
    return BLOCK.has(tag) ? `
${text}
` : text;
  };
  return walk(doc).split(`
`).map((line) => line.trim()).filter(Boolean).join(`
`);
}
function docToRender(m) {
  return m.docV != null && m.docV >= 1 && m.docV <= DOC_V && Array.isArray(m.doc) ? m.doc : null;
}
function messageText(m, nameOf) {
  const doc = docToRender(m);
  return doc ? docText(doc, nameOf) : m.content;
}

// ../protocol/src/v2/doc-corpus.ts
var DOC_CORPUS = [
  {
    name: "ref: a bare message link into this workspace",
    content: "Same as https://app.example/w/01a1b2c7-546f-7000-ab08-cabf380e53ae/c/01a1b2c7-547b-7000-a54a-67fd1444703e/t/01a1b2c7-6fd2-7001-aa85-f1ec2ec906dc/m/01a1b2c7-7060-7000-a5ee-9e016da97563 still open?",
    refs: {
      origin: "https://app.example",
      workspaceId: "01a1b2c7-546f-7000-ab08-cabf380e53ae"
    },
    doc: [
      [
        "p",
        0,
        "Same as ",
        [
          "ref",
          {
            m: "01a1b2c7-7060-7000-a5ee-9e016da97563",
            bare: true
          },
          "https://app.example/w/01a1b2c7-546f-7000-ab08-cabf380e53ae/c/01a1b2c7-547b-7000-a54a-67fd1444703e/t/01a1b2c7-6fd2-7001-aa85-f1ec2ec906dc/m/01a1b2c7-7060-7000-a5ee-9e016da97563"
        ],
        " still open?"
      ]
    ],
    text: "Same as https://app.example/w/01a1b2c7-546f-7000-ab08-cabf380e53ae/c/01a1b2c7-547b-7000-a54a-67fd1444703e/t/01a1b2c7-6fd2-7001-aa85-f1ec2ec906dc/m/01a1b2c7-7060-7000-a5ee-9e016da97563 still open?"
  },
  {
    name: "ref: a labelled message link keeps its words; another workspace stays a link",
    content: "See [the port discussion](https://app.example/w/01a1b2c7-546f-7000-ab08-cabf380e53ae/recent/t/01a1b2c7-6fd2-7001-aa85-f1ec2ec906dc/m/01a1b2c7-7060-7000-a5ee-9e016da97563) and [theirs](https://app.example/w/01a1b2c7-0000-7000-8000-00000000000f/c/01a1b2c7-547b-7000-a54a-67fd1444703e/t/01a1b2c7-6fd2-7001-aa85-f1ec2ec906dc/m/01a1b2c7-7060-7000-a5ee-9e016da97563).",
    refs: {
      origin: "https://app.example",
      workspaceId: "01a1b2c7-546f-7000-ab08-cabf380e53ae"
    },
    doc: [
      [
        "p",
        0,
        "See ",
        [
          "ref",
          {
            m: "01a1b2c7-7060-7000-a5ee-9e016da97563"
          },
          "the port discussion"
        ],
        " and ",
        [
          "a",
          {
            href: "https://app.example/w/01a1b2c7-0000-7000-8000-00000000000f/c/01a1b2c7-547b-7000-a54a-67fd1444703e/t/01a1b2c7-6fd2-7001-aa85-f1ec2ec906dc/m/01a1b2c7-7060-7000-a5ee-9e016da97563"
          },
          "theirs"
        ],
        "."
      ]
    ],
    text: "See the port discussion and theirs."
  },
  {
    name: "inline",
    content: "Hello **bold** _em_ ~~gone~~ `code`",
    doc: [
      [
        "p",
        0,
        "Hello ",
        [
          "strong",
          0,
          "bold"
        ],
        " ",
        [
          "em",
          0,
          "em"
        ],
        " ",
        [
          "s",
          0,
          "gone"
        ],
        " ",
        [
          "code",
          0,
          "code"
        ]
      ]
    ],
    text: "Hello bold em gone code"
  },
  {
    name: "headings",
    content: `# One

###### Six`,
    doc: [
      [
        "h1",
        0,
        "One"
      ],
      [
        "h6",
        0,
        "Six"
      ]
    ],
    text: `One
Six`
  },
  {
    name: "lists",
    content: `- a
- b

3. three
4. four`,
    doc: [
      [
        "ul",
        0,
        [
          "li",
          0,
          "a"
        ],
        [
          "li",
          0,
          "b"
        ]
      ],
      [
        "ol",
        {
          start: 3
        },
        [
          "li",
          0,
          "three"
        ],
        [
          "li",
          0,
          "four"
        ]
      ]
    ],
    text: `a
b
three
four`
  },
  {
    name: "task list",
    content: `- [x] done
- [ ] todo`,
    doc: [
      [
        "ul",
        0,
        [
          "li",
          {
            checked: true
          },
          "done"
        ],
        [
          "li",
          {
            checked: false
          },
          "todo"
        ]
      ]
    ],
    text: `done
todo`
  },
  {
    name: "fence",
    content: "```ts\nconst a = 1;\n```",
    doc: [
      [
        "pre",
        {
          lang: "ts"
        },
        `const a = 1;
`
      ]
    ],
    text: "const a = 1;"
  },
  {
    name: "unclosed fence",
    content: "before\n```ts\nconst secret = 1;\nmore lines",
    doc: [
      [
        "p",
        0,
        "before"
      ],
      [
        "pre",
        {
          lang: "ts"
        },
        `const secret = 1;
more lines`
      ]
    ],
    text: `before
const secret = 1;
more lines`
  },
  {
    name: "table",
    content: `| a | b |
|---|---|
| 1 | 2 |`,
    doc: [
      [
        "table",
        0,
        [
          "thead",
          0,
          [
            "tr",
            0,
            [
              "th",
              0,
              "a"
            ],
            [
              "th",
              0,
              "b"
            ]
          ]
        ],
        [
          "tbody",
          0,
          [
            "tr",
            0,
            [
              "td",
              0,
              "1"
            ],
            [
              "td",
              0,
              "2"
            ]
          ]
        ]
      ]
    ],
    text: `a b
1 2`
  },
  {
    name: "links",
    content: "[site](https://example.com) <mailto:x@example.com> https://auto.example",
    doc: [
      [
        "p",
        0,
        [
          "a",
          {
            href: "https://example.com"
          },
          "site"
        ],
        " ",
        [
          "a",
          {
            href: "mailto:x@example.com"
          },
          "mailto:x@example.com"
        ],
        " ",
        [
          "a",
          {
            href: "https://auto.example"
          },
          "https://auto.example"
        ]
      ]
    ],
    text: "site mailto:x@example.com https://auto.example"
  },
  {
    name: "image",
    content: "![alt](https://example.com/i.png)",
    doc: [
      [
        "p",
        0,
        [
          "img",
          {
            src: "https://example.com/i.png",
            alt: "alt"
          }
        ]
      ]
    ],
    text: "alt"
  },
  {
    name: "breaks",
    content: `line one  
line two

---`,
    doc: [
      [
        "p",
        0,
        "line one",
        [
          "br",
          0
        ],
        "line two"
      ],
      [
        "hr",
        0
      ]
    ],
    text: `line one
line two`
  },
  {
    name: "unsafe urls",
    content: "[x](javascript:alert(1)) [y](data:text/html,hi) ![z](data:image/png;base64,AA) [r](/relative) [f](ftp://h/x)",
    doc: [
      [
        "p",
        0,
        "[x](javascript:alert(1)) [y](data:text/html,hi) z r f"
      ]
    ],
    text: "[x](javascript:alert(1)) [y](data:text/html,hi) z r f"
  },
  {
    name: "raw html",
    content: "<b>raw</b>",
    doc: [
      [
        "p",
        0,
        "<b>raw</b>"
      ]
    ],
    text: "<b>raw</b>"
  },
  {
    name: "mentions",
    content: "hi @aio, not `@aio`, not [@aio](https://x.example), not @nobody\n\n> nor @aio",
    resolved: {
      aio: {
        p: "019a0000-0000-7000-8000-00000000a110",
        h: "aio"
      }
    },
    doc: [
      [
        "p",
        0,
        "hi ",
        [
          "@",
          {
            p: "019a0000-0000-7000-8000-00000000a110",
            h: "aio"
          }
        ],
        ", not ",
        [
          "code",
          0,
          "@aio"
        ],
        ", not ",
        [
          "a",
          {
            href: "https://x.example"
          },
          "@aio"
        ],
        ", not @nobody"
      ],
      [
        "blockquote",
        0,
        [
          "p",
          0,
          "nor @aio"
        ]
      ]
    ],
    text: `hi @aio, not @aio, not @aio, not @nobody
nor @aio`
  },
  {
    name: "code message",
    content: "**not** @aio markdown",
    type: "code",
    doc: [
      [
        "pre",
        0,
        "**not** @aio markdown"
      ]
    ],
    text: "**not** @aio markdown"
  }
];
var DOC_FORWARD_CASES = [
  { name: "unknown tag renders its children", content: "x", doc: [["p", 0, "before ", ["mark", 0, "kept"], " after"]], docV: 1, render: "doc", text: "before kept after" },
  { name: "docV above the known one", content: "plain **content**", doc: [["p", 0, "newer"]], docV: 2, render: "content", text: "plain **content**" },
  { name: "docV 0: not parsed", content: "plain **content**", docV: 0, render: "content", text: "plain **content**" },
  { name: "docV 0 with a doc left set: docV decides", content: "plain **content**", doc: [["p", 0, "stale"]], docV: 0, render: "content", text: "plain **content**" },
  { name: "no docV: an old server or row", content: "plain **content**", render: "content", text: "plain **content**" }
];

// src/core/doc.ts
var DOC_V2 = DOC_V;
var docText2 = docText;
var docToRender2 = docToRender;
var allowedLink2 = allowedLink;
var allowedImage2 = allowedImage;
var messageText2 = messageText;
var DOC_CORPUS2 = DOC_CORPUS;
var DOC_FORWARD_CASES2 = DOC_FORWARD_CASES;
// src/core/dedupe.ts
class Dedupe {
  ttlMs;
  maxSize;
  now;
  seenAt = new Map;
  constructor(opts) {
    if (!(opts.ttlMs > 0))
      throw new RangeError("Dedupe: ttlMs must be > 0");
    if (!(opts.maxSize > 0))
      throw new RangeError("Dedupe: maxSize must be > 0");
    this.ttlMs = opts.ttlMs;
    this.maxSize = opts.maxSize;
    this.now = opts.now ?? Date.now;
  }
  seen(id) {
    const t = this.now();
    this.evictExpired(t);
    if (this.seenAt.has(id)) {
      this.seenAt.delete(id);
      this.seenAt.set(id, t);
      return false;
    }
    this.seenAt.set(id, t);
    while (this.seenAt.size > this.maxSize) {
      const oldest = this.seenAt.keys().next().value;
      if (oldest === undefined)
        break;
      this.seenAt.delete(oldest);
    }
    return true;
  }
  forget(id) {
    this.seenAt.delete(id);
  }
  evictExpired(t) {
    for (const [id, at] of this.seenAt) {
      if (t - at < this.ttlMs)
        break;
      this.seenAt.delete(id);
    }
  }
  get size() {
    return this.seenAt.size;
  }
}
// src/core/control-chars.ts
var ANSI_SEQUENCE = /(?:\x1B\[|\x9B)[0-?]*[ -\/]*[@-~]|(?:\x1B\]|\x9D)[^\x07\x1B\x9C\n]*(?:\x07|\x1B\\|\x9C)?|(?:\x1B[PX^_]|[\x90\x98\x9E\x9F])[^\x1B\x9C\n]*(?:\x1B\\|\x9C)?|\x1B[ -\/]*[0-~]/g;
var CONTROL_CHARS = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;
function stripControlChars(text) {
  return text.replace(/\r\n?/g, `
`).replace(ANSI_SEQUENCE, "").replace(CONTROL_CHARS, "");
}
// src/core/principal-label.ts
function principalLabel(p, self) {
  if (self && p.id === self)
    return "you";
  return p.handle ? `@${p.handle}` : p.name ?? (p.kind === "agent" ? "a removed agent" : "a removed person");
}
// src/core/links.ts
function expandLink(template, values) {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name) => {
    const v = values[name];
    if (typeof v !== "string")
      throw new Error(`einweave link template needs {${name}}`);
    return encodeURIComponent(v);
  });
}
function threadUrl(links, t) {
  return expandLink(links.thread, { channelId: t.channelId, threadId: t.threadId });
}
function messageUrl(links, m) {
  return expandLink(links.message, { channelId: m.channelId, threadId: m.threadId, id: m.id });
}
// src/core/search.ts
var SEARCH_MARK_START = "";
var SEARCH_MARK_END = "";
function snippetParts(s) {
  const out = [];
  let hit = false;
  let run = "";
  const flush = () => {
    if (run)
      out.push({ text: run, hit });
    run = "";
  };
  for (const ch of s) {
    if (ch === SEARCH_MARK_START) {
      flush();
      hit = true;
    } else if (ch === SEARCH_MARK_END) {
      flush();
      hit = false;
    } else
      run += ch;
  }
  flush();
  return out;
}
// src/core/b64url.ts
function b64url(bytes) {
  let bin = "";
  for (const b of bytes)
    bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJson(value) {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

class B64urlError extends Error {
  name = "B64urlError";
}
var B64URL = /^[A-Za-z0-9_-]*$/;
function b64urlDecode(s) {
  if (!B64URL.test(s))
    throw new B64urlError("not base64url: characters outside [A-Za-z0-9_-]");
  if (s.length % 4 === 1)
    throw new B64urlError(`not base64url: impossible length ${s.length}`);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0;i < bin.length; i++)
    out[i] = bin.charCodeAt(i);
  return out;
}
function randomB64url(nBytes) {
  return b64url(crypto.getRandomValues(new Uint8Array(nBytes)));
}
async function sha256B64url(text) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

// src/core/jwk.ts
var B64URL_32 = /^[A-Za-z0-9_-]{43}$/;
function isB64url32(v) {
  return typeof v === "string" && B64URL_32.test(v) && b64url(b64urlDecode(v)) === v;
}
function isP256PublicJwk(j) {
  const o = j;
  return !!o && o.kty === "EC" && o.crv === "P-256" && isB64url32(o.x) && isB64url32(o.y);
}
function isP256PrivateJwk(j) {
  return isP256PublicJwk(j) && isB64url32(j.d);
}
function publicPart(j) {
  return { kty: "EC", crv: "P-256", x: j.x, y: j.y };
}
function jwkThumbprint(j) {
  return sha256B64url(JSON.stringify({ crv: j.crv, kty: j.kty, x: j.x, y: j.y }));
}

// src/core/signer.ts
var KEY_ALG = { name: "ECDSA", namedCurve: "P-256" };
var SIGN_ALG = { name: "ECDSA", hash: "SHA-256" };
async function softwareSigner(jwk) {
  if (!isP256PrivateJwk(jwk))
    throw new Error("not a P-256 private JWK");
  const key = await crypto.subtle.importKey("jwk", { ...publicPart(jwk), d: jwk.d }, KEY_ALG, false, ["sign"]);
  const publicJwk = publicPart(jwk);
  return {
    alg: "ES256",
    keyStorage: "software",
    publicJwk,
    jkt: await jwkThumbprint(publicJwk),
    async sign(data) {
      const sig = new Uint8Array(await crypto.subtle.sign(SIGN_ALG, key, new Uint8Array(data)));
      if (sig.length !== 64)
        throw new Error(`ES256 signature must be 64 bytes r||s, got ${sig.length}`);
      return sig;
    }
  };
}
async function generateSoftwareKey() {
  const kp = await crypto.subtle.generateKey(KEY_ALG, true, ["sign", "verify"]);
  const j = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const privateJwk = { kty: "EC", crv: "P-256", x: j.x, y: j.y, d: j.d };
  return { privateJwk, signer: await softwareSigner(privateJwk) };
}
// src/core/deadline.ts
function deadline(ms, ...parents) {
  const ac = new AbortController;
  const already = parents.find((p) => p?.aborted);
  if (already) {
    ac.abort(already.reason);
    return { signal: ac.signal, clear() {} };
  }
  const timer = setTimeout(() => ac.abort(new DOMException(`deadline timed out after ${ms} ms`, "TimeoutError")), ms);
  timer.unref?.();
  const listeners = [];
  for (const p of parents) {
    if (!p)
      continue;
    const fn = () => ac.abort(p.reason);
    p.addEventListener("abort", fn, { once: true });
    listeners.push({ p, fn });
  }
  return {
    signal: ac.signal,
    clear() {
      clearTimeout(timer);
      for (const { p, fn } of listeners)
        p.removeEventListener("abort", fn);
    }
  };
}
// src/core/jws.ts
async function signJwt(signer, header, claims) {
  const input = `${b64urlJson({ ...header, alg: signer.alg })}.${b64urlJson(claims)}`;
  const sig = await signer.sign(new TextEncoder().encode(input));
  return `${input}.${b64url(sig)}`;
}
var newJti = () => randomB64url(16);

// src/core/dpop.ts
function normalizeHtu(url) {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error(`DPoP htu must be http(s), got ${u.protocol}`);
  return `${u.protocol}//${u.host}${u.pathname}`;
}
var HTTP_FORM = { "ws:": "http:", "wss:": "https:", "http:": "http:", "https:": "https:" };
function apiOrigin(apiUrl, allowWsPath = false) {
  const u = new URL(apiUrl);
  const scheme = HTTP_FORM[u.protocol];
  if (!scheme)
    throw new Error(`the einweave API URL must be http(s) or ws(s), got ${u.protocol}`);
  const pathOk = /^\/*$/.test(u.pathname) || allowWsPath && u.pathname === "/ws";
  if (!pathOk || u.search || u.hash || u.username || u.password) {
    throw new Error(`the einweave API URL must be an origin like https://api.einweave.com — got ${JSON.stringify(apiUrl)}`);
  }
  return new URL(`${scheme}//${u.host}`).origin;
}
function httpHtu(apiUrl, path) {
  const pathname = "/" + path.split(/[?#]/, 1)[0].replace(/^\/+/, "");
  return normalizeHtu(`${apiOrigin(apiUrl)}${pathname}`);
}
function wsHtu(apiUrl) {
  return normalizeHtu(`${apiOrigin(apiUrl, true)}/ws`);
}
var accessTokenHash = (accessToken) => sha256B64url(accessToken);
async function dpopProof(signer, clock, p) {
  if (p.accessToken === "")
    throw new Error("DPoP proof: empty access token");
  if (p.nonce === "")
    throw new Error("DPoP proof: empty nonce");
  return signJwt(signer, { typ: "dpop+jwt", jwk: signer.publicJwk }, {
    jti: newJti(),
    htm: p.htm.toUpperCase(),
    htu: normalizeHtu(p.htu),
    iat: clock.nowS(),
    ...p.accessToken !== undefined ? { ath: await accessTokenHash(p.accessToken) } : {},
    ...p.nonce !== undefined ? { nonce: p.nonce } : {}
  });
}
// src/core/assertion.ts
var CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
var ASSERTION_TTL_S = 60;
function clientAssertion(signer, clock, installationId, issuer) {
  const iat = clock.nowS();
  return signJwt(signer, { typ: "client-authentication+jwt", kid: signer.jkt }, { iss: installationId, sub: installationId, aud: issuer, jti: newJti(), iat, exp: iat + ASSERTION_TTL_S });
}
var SUPERSEDE_ASSERTION_TYP = "einweave-supersede+jwt";
function supersedeAssertion(oldSigner, clock, oldInstallationId, issuer, newJkt) {
  const iat = clock.nowS();
  return signJwt(oldSigner, { typ: SUPERSEDE_ASSERTION_TYP, kid: oldSigner.jkt }, { iss: oldInstallationId, sub: oldInstallationId, aud: issuer, jti: newJti(), iat, exp: iat + ASSERTION_TTL_S, new_jkt: newJkt });
}
// src/core/clock.ts
var IMF_FIXDATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
var MAX_CLOCK_OFFSET_MS = 24 * 60 * 60 * 1000;

class Clock {
  now;
  offsetMs = 0;
  constructor(now = Date.now) {
    this.now = now;
  }
  nowS() {
    return Math.floor((this.now() + this.offsetMs) / 1000);
  }
  observe(dateHeader) {
    if (typeof dateHeader !== "string" || !IMF_FIXDATE.test(dateHeader))
      return;
    const t = Date.parse(dateHeader);
    if (!Number.isFinite(t))
      return;
    const offset = t - this.now();
    if (Math.abs(offset) > MAX_CLOCK_OFFSET_MS)
      return;
    this.offsetMs = offset;
  }
  offset() {
    return this.offsetMs;
  }
}
// src/core/join-state.ts
var JOIN_STATE = /^ew_js_(0|[1-9][0-9]{0,14})_[0-9A-Za-z]{49}$/;
function isJoinState(s) {
  return typeof s === "string" && JOIN_STATE.test(s);
}
function joinStateSeq(s) {
  const m = JOIN_STATE.exec(s);
  return m ? Number(m[1]) : null;
}
// src/core/token-errors.ts
class OAuthError extends Error {
  name = "OAuthError";
  error;
  status;
  description;
  retryAfterS;
  dpopNonce;
  constructor(i) {
    super(`agent-auth: ${i.error}${i.description ? ` ${i.description}` : ""} (${i.status})`);
    this.error = i.error;
    this.status = i.status;
    this.description = i.description;
    this.retryAfterS = i.retryAfterS;
    this.dpopNonce = i.dpopNonce;
  }
}
function isOAuthError(e) {
  const o = e;
  return typeof o === "object" && o !== null && o.name === "OAuthError" && typeof o.error === "string" && typeof o.status === "number";
}

class TransportError extends Error {
  name = "TransportError";
}

class DiscoveryError extends Error {
  name = "DiscoveryError";
}

class AbortedError extends Error {
  name = "AbortedError";
}
function isTransportFailure(e) {
  const name = e?.name;
  return name === "TimeoutError" || name === "TransportError";
}
function isCallerAbort(e) {
  const name = e?.name;
  return name === "AbortedError" || name === "AbortError";
}
var GONE_REASONS = ["installation_locked", "installation_revoked", "installation_expired", "installation_unknown", "agent_deactivated"];
function isGoneReason(d) {
  return GONE_REASONS.includes(d);
}
function assertNever(x) {
  throw new Error(`unhandled case: ${JSON.stringify(x)}`);
}
var DEFAULT_RETRY_AFTER_S = 30;
function retryAfter(s) {
  return typeof s === "number" && Number.isFinite(s) && s >= 0 ? Math.max(1, Math.ceil(s)) : DEFAULT_RETRY_AFTER_S;
}
function classifyTokenError(e) {
  if (!isOAuthError(e))
    return isTransportFailure(e) ? { kind: "transient" } : isCallerAbort(e) ? { kind: "aborted" } : { kind: "refused" };
  if (e.status === 429)
    return { kind: "rate_limited", retryAfterS: retryAfter(e.retryAfterS) };
  if (e.status >= 500)
    return { kind: "transient" };
  switch (e.error) {
    case "unauthorized_client":
      if (e.description?.startsWith("client_too_old:") || e.description?.startsWith("client_blocked:"))
        return { kind: "too_old" };
      return { kind: "refused" };
    case "invalid_client":
      if (isGoneReason(e.description))
        return { kind: "installation_gone", reason: e.description };
      if (e.description === "assertion_invalid")
        return { kind: "clock" };
      return { kind: "refused" };
    case "invalid_grant":
      if (e.description?.startsWith("rfc014_retired:"))
        return { kind: "update_required" };
      if (e.description === "session_revoked")
        return { kind: "session_revoked" };
      if (e.description === "session_limit")
        return { kind: "session_limit" };
      return { kind: "refused" };
    case "invalid_request":
      return e.description === "corrupt_state" ? { kind: "corrupt_state" } : { kind: "refused" };
    case "invalid_dpop_proof":
      if (e.description?.startsWith("dpop_proof_required:"))
        return { kind: "update_required" };
      return e.description === "key_already_enrolled" ? { kind: "refused" } : { kind: "new_proof" };
    case "use_dpop_nonce":
      return { kind: "new_proof" };
    case "unsupported_grant_type":
      return { kind: "update_required" };
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow_down" };
    default:
      return { kind: "refused" };
  }
}
// src/core/protocol.ts
var GRANT_ENROLMENT_KEY = "urn:einweave:params:oauth:grant-type:enrolment-key";
var GRANT_DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";
var GRANT_CLIENT_CREDENTIALS = "client_credentials";
var MINT_TIMEOUT_MS = 30000;
var MINT_BUDGET_MS = 90000;
var DISCOVERY_TIMEOUT_MS = 1e4;
var METADATA_TTL_MS = 60 * 60000;
function callerCancelled(signal) {
  return !!signal?.aborted && signal.reason?.name !== "TimeoutError";
}
function abortable(p, signal) {
  if (!signal)
    return p;
  const why = () => callerCancelled(signal) ? new AbortedError("cancelled by the caller", { cause: signal.reason }) : signal.reason;
  if (signal.aborted)
    return Promise.reject(why());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(why());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => (signal.removeEventListener("abort", onAbort), resolve(v)), (e) => (signal.removeEventListener("abort", onAbort), reject(e)));
  });
}
async function exchange(f, url, init, callerSignal) {
  let res;
  let text;
  try {
    res = await f(url, init);
    text = await res.text();
  } catch (e) {
    if (callerCancelled(callerSignal))
      throw new AbortedError("cancelled by the caller", { cause: callerSignal.reason });
    throw new TransportError(`einweave agent-auth ${new URL(url).pathname}: no answer (${e?.message ?? e})`, { cause: e });
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { res, json };
}
function retryAfterS(ra, now = Date.now()) {
  if (ra === null || ra.trim() === "")
    return;
  if (/^\s*\d+(\.\d+)?\s*$/.test(ra))
    return Number(ra);
  const t = Date.parse(ra);
  return Number.isFinite(t) ? Math.max(0, (t - now) / 1000) : undefined;
}
function toOAuthError(res, json) {
  const o = json !== null && typeof json === "object" && !Array.isArray(json) ? json : {};
  const retry = retryAfterS(res.headers.get("retry-after"));
  return new OAuthError({
    error: typeof o.error === "string" && o.error !== "" ? o.error : res.status === 429 ? "rate_limited" : `http_${res.status}`,
    status: res.status,
    description: typeof o.error_description === "string" ? o.error_description : undefined,
    retryAfterS: retry,
    dpopNonce: res.headers.get("dpop-nonce") ?? undefined
  });
}
function assertSameAuthority(apiUrl, m) {
  const origin = apiOrigin(apiUrl);
  if (m.issuer !== `${origin}/api/agent-auth`) {
    throw new DiscoveryError(`einweave agent-auth discovery issuer ${JSON.stringify(m.issuer)} does not match ${origin} — refusing it`);
  }
  for (const k of ["token_endpoint", "revocation_endpoint", "authorization_endpoint", "device_authorization_endpoint", "einweave_supersede_endpoint"]) {
    const v = m[k];
    if (v === undefined)
      continue;
    let o;
    try {
      o = new URL(v).origin;
    } catch {
      throw new DiscoveryError(`einweave agent-auth discovery ${k} is not a URL — refusing it`);
    }
    if (o !== origin)
      throw new DiscoveryError(`einweave agent-auth discovery ${k} points at ${o}, not ${origin} — refusing it`);
  }
}
function supportsKeyCredentials(m) {
  return Array.isArray(m.grant_types_supported) && m.grant_types_supported.includes(GRANT_CLIENT_CREDENTIALS);
}

class TokenClient {
  nonces = new Map;
  metadata = new Map;
  clock;
  clientId;
  f;
  ttlMs;
  softwareId;
  softwareVersion;
  discoveryMs;
  mintMs;
  mintBudgetMs;
  constructor(o) {
    if (typeof o.clientId !== "string" || o.clientId === "")
      throw new Error("TokenClient needs the runtime's public clientId");
    this.clock = o.clock;
    this.clientId = o.clientId;
    this.f = o.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.ttlMs = o.metadataTtlMs ?? METADATA_TTL_MS;
    this.softwareId = o.softwareId;
    this.softwareVersion = o.softwareVersion;
    this.discoveryMs = o.timeouts?.discoveryMs ?? DISCOVERY_TIMEOUT_MS;
    this.mintMs = o.timeouts?.mintMs ?? MINT_TIMEOUT_MS;
    this.mintBudgetMs = o.timeouts?.mintBudgetMs ?? MINT_BUDGET_MS;
  }
  identityFields() {
    return {
      ...this.softwareId ? { software_id: this.softwareId } : {},
      ...this.softwareVersion ? { software_version: this.softwareVersion } : {}
    };
  }
  discover(apiUrl, signal) {
    const origin = apiOrigin(apiUrl);
    const hit = this.metadata.get(origin);
    if (hit && Date.now() - hit.at < this.ttlMs)
      return abortable(hit.p, signal);
    const p = (async () => {
      const dl = deadline(this.discoveryMs);
      try {
        const { res, json } = await exchange(this.f, `${origin}/.well-known/oauth-authorization-server/api/agent-auth`, {
          headers: { Accept: "application/json" },
          signal: dl.signal
        });
        if (!res.ok)
          throw toOAuthError(res, json);
        const m = json;
        if (!m || typeof m.token_endpoint !== "string" || typeof m.issuer !== "string") {
          throw new DiscoveryError(`einweave agent-auth discovery returned no token endpoint — is ${origin} an einweave API?`);
        }
        assertSameAuthority(origin, m);
        return m;
      } finally {
        dl.clear();
      }
    })();
    this.metadata.set(origin, { at: Date.now(), p });
    p.catch(() => {
      if (this.metadata.get(origin)?.p === p)
        this.metadata.delete(origin);
    });
    return abortable(p, signal);
  }
  async deviceAuthorization(m, installationName, o = {}) {
    const dl = deadline(this.mintMs, o.signal);
    let res, json;
    try {
      ({ res, json } = await exchange(this.f, m.device_authorization_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: this.clientId, installation_name: installationName }),
        signal: dl.signal
      }, o.signal));
    } finally {
      dl.clear();
    }
    if (!res.ok)
      throw toOAuthError(res, json);
    const d = json;
    if (typeof d?.device_code !== "string" || typeof d?.user_code !== "string" || typeof d?.verification_uri !== "string") {
      throw new OAuthError({ error: "invalid_response", status: res.status, description: "device authorization answered without device_code + user_code + verification_uri" });
    }
    return d;
  }
  async postDpop(url, signer, build, hasAssertion, signal) {
    const origin = new URL(url).origin;
    const budget = deadline(this.mintBudgetMs, signal);
    try {
      let nonceRetried = false;
      let proofRetried = false;
      let assertionRetried = false;
      for (;; ) {
        const body = await build();
        const proof = await dpopProof(signer, this.clock, { htm: "POST", htu: url, nonce: this.nonces.get(origin) });
        const attempt = deadline(this.mintMs, budget.signal);
        let res, json;
        try {
          ({ res, json } = await exchange(this.f, url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json", DPoP: proof },
            body: JSON.stringify(body),
            signal: attempt.signal
          }, signal));
        } finally {
          attempt.clear();
        }
        this.clock.observe(res.headers.get("date"));
        const nonce = res.headers.get("dpop-nonce");
        if (nonce)
          this.nonces.set(origin, nonce);
        if (res.ok)
          return json;
        const err = toOAuthError(res, json);
        if (err.error === "use_dpop_nonce" && nonce && !nonceRetried) {
          nonceRetried = true;
          continue;
        }
        if (err.error === "invalid_dpop_proof" && err.description !== "key_already_enrolled" && !err.description?.startsWith("dpop_proof_required:") && !proofRetried) {
          proofRetried = true;
          continue;
        }
        if (hasAssertion && err.error === "invalid_client" && err.description === "assertion_invalid" && !assertionRetried) {
          assertionRetried = true;
          continue;
        }
        throw err;
      }
    } finally {
      budget.clear();
    }
  }
  static enrolled(json) {
    const j = json;
    if (typeof j?.installation_id !== "string" || !isJoinState(j?.join_state)) {
      throw new OAuthError({ error: "invalid_response", status: 200, description: "enrolment answered without installation_id + join_state" });
    }
    return j;
  }
  async enrolWithKey(m, signer, p, o = {}) {
    return TokenClient.enrolled(await this.postDpop(m.token_endpoint, signer, async () => ({
      grant_type: GRANT_ENROLMENT_KEY,
      enrolment_key: p.enrolmentKey,
      installation_name: p.installationName,
      key_storage: signer.keyStorage,
      ...this.identityFields()
    }), false, o.signal));
  }
  async exchangeCode(m, signer, p, o = {}) {
    return TokenClient.enrolled(await this.postDpop(m.token_endpoint, signer, async () => ({
      grant_type: "authorization_code",
      code: p.code,
      code_verifier: p.verifier,
      redirect_uri: p.redirectUri,
      client_id: this.clientId,
      key_storage: signer.keyStorage,
      ...this.identityFields()
    }), false, o.signal));
  }
  async pollDeviceCode(m, signer, deviceCode, o = {}) {
    return TokenClient.enrolled(await this.postDpop(m.token_endpoint, signer, async () => ({ grant_type: GRANT_DEVICE_CODE, device_code: deviceCode, client_id: this.clientId, key_storage: signer.keyStorage, ...this.identityFields() }), false, o.signal));
  }
  async mint(m, signer, p, o = {}) {
    const json = await this.postDpop(m.token_endpoint, signer, async () => ({
      grant_type: GRANT_CLIENT_CREDENTIALS,
      client_id: p.installationId,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion(signer, this.clock, p.installationId, m.issuer),
      join_state: p.joinState,
      attempt: p.attempt,
      session_key: p.sessionKey,
      ...p.reconnect ? { reconnect: "true" } : {},
      ...p.platform ? { platform: p.platform } : {},
      ...p.clientVersion ? { client_version: p.clientVersion } : {},
      ...this.identityFields()
    }), true, o.signal);
    if (json?.token_type !== "DPoP" || typeof json?.access_token !== "string" || !isJoinState(json?.join_state) || typeof json?.session_id !== "string") {
      throw new OAuthError({ error: "invalid_response", status: 200, description: "mint answered without a DPoP token + join_state + session_id" });
    }
    return json;
  }
  async revoke(m, signer, p, o = {}) {
    const json = await this.postDpop(m.revocation_endpoint, signer, async () => ({
      client_id: p.installationId,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion(signer, this.clock, p.installationId, m.issuer),
      join_state: p.joinState,
      ...p.attempt ? { attempt: p.attempt } : {},
      scope: p.scope,
      ...p.sessionKey ? { session_key: p.sessionKey } : {}
    }), true, o.signal);
    if (json?.ok !== true)
      throw new OAuthError({ error: "invalid_response", status: 200, description: 'revoke answered without {"ok":true}' });
  }
  async supersede(m, signer, p, o = {}) {
    const url = m.einweave_supersede_endpoint;
    if (!url)
      throw new OAuthError({ error: "invalid_request", status: 0, description: "supersede_unsupported" });
    const json = await this.postDpop(url, signer, async () => ({
      client_id: p.installationId,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion(signer, this.clock, p.installationId, m.issuer),
      join_state: p.joinState,
      ...p.attempt ? { attempt: p.attempt } : {},
      supersedes: {
        client_id: p.old.installationId,
        client_assertion: await supersedeAssertion(p.old.signer, this.clock, p.old.installationId, m.issuer, signer.jkt),
        join_state: p.old.joinState,
        ...p.old.attempt ? { attempt: p.old.attempt } : {}
      }
    }), true, o.signal);
    const s = json?.superseded;
    if (s !== null && typeof s !== "string")
      throw new OAuthError({ error: "invalid_response", status: 200, description: "supersede answered without superseded" });
    return s;
  }
}
function isKeyAlreadyEnrolled(e) {
  return isOAuthError(e) && e.error === "invalid_dpop_proof" && e.description === "key_already_enrolled";
}
export { ADDRESSED_REASONS2 as ADDRESSED_REASONS, BROADCAST_REASONS2 as BROADCAST_REASONS, isAddressed2 as isAddressed, PROTOCOL_VERSION2 as PROTOCOL_VERSION, CONTROL_FRAME_TYPES2 as CONTROL_FRAME_TYPES, CONNECTION_KINDS2 as CONNECTION_KINDS, TURN_STATES2 as TURN_STATES, SESSION_DETAIL_KEYS2 as SESSION_DETAIL_KEYS, MAX_ACK_IDS2 as MAX_ACK_IDS, ENTRY_KINDS2 as ENTRY_KINDS, WS_CLOSE_CODES, WS_CLOSE_REASONS, classifyClose, reconnectDelay, closeOutcome, DEFAULT_HOLDER_VERSION, decideLock, KNOWN_FORMAT, classifyVersioned, isNewerFormat, userAgent, identityTokenClientOptions, DOC_V2 as DOC_V, docText2 as docText, docToRender2 as docToRender, allowedLink2 as allowedLink, allowedImage2 as allowedImage, messageText2 as messageText, DOC_CORPUS2 as DOC_CORPUS, DOC_FORWARD_CASES2 as DOC_FORWARD_CASES, Dedupe, stripControlChars, principalLabel, expandLink, threadUrl, messageUrl, SEARCH_MARK_START, SEARCH_MARK_END, snippetParts, randomB64url, isP256PublicJwk, isP256PrivateJwk, jwkThumbprint, softwareSigner, generateSoftwareKey, deadline, normalizeHtu, apiOrigin, httpHtu, wsHtu, dpopProof, CLIENT_ASSERTION_TYPE, ASSERTION_TTL_S, clientAssertion, SUPERSEDE_ASSERTION_TYP, supersedeAssertion, MAX_CLOCK_OFFSET_MS, Clock, isJoinState, joinStateSeq, OAuthError, isOAuthError, TransportError, DiscoveryError, AbortedError, GONE_REASONS, assertNever, classifyTokenError, MINT_TIMEOUT_MS, MINT_BUDGET_MS, METADATA_TTL_MS, supportsKeyCredentials, TokenClient, isKeyAlreadyEnrolled };
