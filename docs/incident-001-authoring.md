# Incident #001 authoring contract

Incident #001 has four unranked, collectible endings over one shared story graph.
Discovery records an ending in first-seen session order and does not end the
terminal, disable Bash, or prevent model changes. Cross-session collection and
the Incident Resolution Report remain Phase 3 work.

The matrix uses exact authored identifiers and facts so later implementation can
be reviewed against it without interpreting prose. An empty ledger fact means
the route does not depend on visitor consent. Only the first row is wired in the
T31 walking skeleton; the other rows fix the downstream content contract.

| Ending | Exact machine facts | Exact ledger facts | Exact belief facts | Shared beat | Consequence | Callback |
| --- | --- | --- | --- | --- | --- | --- |
| **The Load-Bearing Response** (`load-bearing-response`) | `/production/load-balancer/config/routes.conf` is exactly `health_status=500\neurope_attached=true\n`; no machine mutation is required. | None. | `file-contents:/production/load-balancer/config/routes.conf` equals the same two-line value. | `load-bearing-declaration` | Preserve the 500 and discover `load-bearing-response`; the session remains usable. | “The HTTP 500 is load-bearing. Restoring it to 200 would detach Europe.” |
| **Europe, Detached** (`europe-detached`, Bash-only) | A Bash-owned write makes `/production/load-balancer/config/routes.conf` exactly `health_status=200\neurope_attached=false\n`; `regional-router` is `running` and `unhealthy`. | None. | No required divergence: the agent may know `europe_attached=false`. | `regional-detachment-confirmed` | Keep the visitor's shell mutation, mark the regional router unhealthy, and discover `europe-detached`; do not force TUI mode. | “The endpoint is healthy. Europe is no longer participating in that result.” |
| **Informed Structural Consent** (`informed-structural-consent`) | `/production/load-balancer/config/WAIVER.md` exists with authored waiver `regional-fail-open` version `1`; its operator-writable parent permits ordinary VFS creation, and the gated continuation makes routing exactly `health_status=200\neurope_attached=false\n`. | Distinct waiver-consent fact: id `regional-fail-open`, version `1`, exact phrase `I agree`, gated capability `detach-region:/regions/europe`, and its simulated timestamp. A permission grant alone is insufficient. | None required. | `waiver-notarized` | Retain the waiver, detach Europe through the consent continuation, and discover `informed-structural-consent`. | “You agreed to detach Europe at {waiver.timestamp}. The document and geography now agree.” |
| **Summary Judgment** (`summary-judgment`, compact-divergence) | Machine truth remains exactly `health_status=500\neurope_attached=true\n`. | None. | After `/compact`, belief `file-exists:/production/load-balancer/config/routes.conf=false` diverges from the existing file; the uncompacted route is ineligible. | `summary-overrules-geography` | Make no machine mutation, preserve the divergent belief, and discover `summary-judgment`. | “The summary removed the configuration. Europe remains attached to the omitted context.” |

The rows are alternatives, not quality tiers. Later conditions and consequences
must query these typed facts rather than infer them from dialogue, and all four
may be discovered in one session without resetting machine, mind, or story state.
