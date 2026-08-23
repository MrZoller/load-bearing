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

## Authored Bash investigation inventory

Incident #001 supports the following restrained inventory of useful shell
investigations. These are bounded command forms over cartridge-owned state, not
promises of a general host shell. Variations listed separately have a distinct
investigative use; paths and operands are deliberately tied to authored files,
services, history, manual pages, and static output.

| # | Command form | Investigative use |
| ---: | --- | --- |
| 1 | `pwd` | Confirm the incident opens at `/production/load-balancer`. |
| 2 | `ls` | Survey the repository root without exposing hidden evidence. |
| 3 | `ls -lah config` | Inspect config ownership, modes, and the two bounded replacement files. |
| 4 | `ls -la /var/lib/regional-router` | Deliberately include the hidden regional policy file. |
| 5 | `cat config/routes.conf` | Read the live endpoint and regional attachment request. |
| 6 | `cat src/config.ts` | Read the implementation's success-means-detach rule. |
| 7 | `head -n 4 test/routes.test.ts` | Identify the test module and its configuration import. |
| 8 | `tail -n 2 /var/log/load-balancer/health.log` | Read the latest bounded file-log evidence. |
| 9 | `wc package.json test/routes.test.ts` | Compare the small authored package and test surfaces. |
| 10 | `grep -n expectedHealthStatus src/config.ts` | Locate the health-success hinge with a line number. |
| 11 | `grep -ir europe config src test` | Trace Europe through config, implementation, and tests. |
| 12 | `find config` | Enumerate the live config and both replacement candidates. |
| 13 | `stat config/routes.conf` | Inspect the live file's owner, group, mode, and timestamp. |
| 14 | `env` | Expose the authored fail-mode, policy-owner, and archive hints. |
| 15 | `man 8 regional-router` | Read policy revision 3 and its ownership-transfer reference. |
| 16 | `man 5 routes.conf` | Distinguish requested attachment from a health claim. |
| 17 | `history` | Recover the departed maintainer's bounded investigation and replacement sequence. |
| 18 | `ops-archive` | Read the static, cartridge-authored OPS-1842 and OPS-1911 summary. |
| 19 | `ps` | Compare the stopped endpoint responder with the running regional router. |
| 20 | `systemctl status endpoint-responder` | Confirm why the health endpoint currently returns 500. |
| 21 | `systemctl status regional-router` | Confirm the router is running and initially healthy. |
| 22 | `curl http://load-balancer.internal/health` | Probe the single authored endpoint before or after a replacement. |
| 23 | `npm test` | Run the two cartridge-authored routing predicates against live VFS state. |
| 24 | `git status --short` | Compare the live tree with the current authored commit. |
| 25 | `git branch` | Discover the baseline, repair, and current branch names. |
| 26 | `git log --oneline` | Survey the baseline, attempted repair, and rollback. |
| 27 | `git show greg/healthcheck-repair` | Inspect the exact prior 200/detachment change and its rationale. |
| 28 | `git blame src/config.ts` | Tie the success-means-detach comment to the departed maintainer. |
| 29 | `git checkout greg/healthcheck-repair` (then `git checkout main`) | Compare the coherent repair and rollback snapshots through the bounded ref form. |
| 30 | `git restore config/routes.conf` | Return a visitor-mutated live config to the current authored revision. |

These forms do not imply arbitrary Git or host command execution.

### Bash-only ending route boundary

The complete clue is intentionally available only through the bounded shell
layer (the Bash view or its TUI `!` passthrough). The
visitor can expose `/var/lib/regional-router/.regional-policy` with
`ls -la /var/lib/regional-router` and read it with
`cat /var/lib/regional-router/.regional-policy`; the file states that a health
success detaches Europe. `history` then supplies the exact bounded replacement
sequence, corroborated by `routes.conf(5)` and the two authored snapshots:

```sh
rm config/routes.conf
cp -p config/routes.200.conf config/routes.conf
```

The removal is required because bounded `cp` and `mv` refuse to overwrite an
existing destination, and no shell command writes new contents into an existing
file. The operator-writable `config` directory permits replacement. `cp -p` is
the supported metadata-preserving form, so the replacement retains the authored
root ownership and mode rather than inventing visitor-owned production config.
The existing VFS/world reactions make the endpoint responder healthy and the
running regional router unhealthy, coherently completing the machine side of
**Europe, Detached**. The reverse pair using `routes.500.conf` restores the
initial machine state.

T45 authors only this hidden clue and executable shell action. T55 remains the
owner of reaching `regional-detachment-confirmed`, recording the reveal and
ending, and presenting its callback. No story reaction, ending-discovery
machinery, pipeline, redirection, editor, PTY, or host-command capability is
implied here.
