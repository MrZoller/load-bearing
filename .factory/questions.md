# Questions

Open blockers for the human. Agents append per the `factory-protocol` skill;
answers go inline under each question after `**A:**` (or answer in chat via
`/blocked`). Entries are never deleted — reconciliation marks an applied or
forwarded answer `consumed` in the same bookkeeping commit.

---

## Q1 (task T1, consumed) — What identity and implicit-directory policy should the VFS use?

Context: The cartridge declares file owners/groups but no acting user, groups,
home directory, umask, or directory metadata. T1 requires permission denials,
`~` resolution, and recursive mutations, so inventing defaults would define a
public cartridge policy; the approved plan explicitly identifies this as a
design blocker. Parked branch: `factory/t1-virtual-filesystem`.
Options considered: A — add cartridge identity plus authored directory metadata
and documented defaults for undeclared ancestors; B — add one global implicit
directory/identity defaults object, which is simpler but cannot author directory
ownership; C — defer permission enforcement, which does not meet issue #5.
Please also specify root bypass, creation owner/group and umask, whether bare
`~` is the only tilde form, chmod authorization, copy metadata behavior, and
whether successful child mutations update parent-directory mtimes.
**A:** Option A, with directory metadata optional.

Schema changes:

- `repository.identity` (REQUIRED): `user`, `group`, `home`, `umask` (default `0022`). This is the acting identity; without it permission denial and `~` have no subject.
- `repository.directories` (OPTIONAL): map keyed by absolute path, same shape as a file entry minus `contents` (`owner`, `group`, `mode`, `mtime`). Cartridges declare only the directories that carry authored meaning.
- Undeclared ancestor directories: inherit `owner`/`group` from the nearest declared ancestor directory, else `root:root`; default mode `0755`; default `mtime` = `meta.startedAt`, matching the existing file rule.

Sub-questions — take standard POSIX behavior for all of these:

- Root bypass: user `root` bypasses permission checks.
- Creation: new files and directories take the acting identity from `repository.identity`; mode `0666 & ~umask` for files, `0777 & ~umask` for directories.
- Tilde: bare `~` and `~/path` only. `~user` is unsupported and stays a literal path segment — there is no user database to resolve it against.
- chmod: authorized for the file's owner or root only.
- Copy: `cp` creates the destination with the acting identity and umask; `cp -p` preserves owner, group, mode, and mtime.
- Parent mtime: create, delete, and rename inside a directory update that directory's mtime; writing to an existing file does not.

This is public cartridge policy, not incident-specific: document it in the cartridge schema descriptions and record the decision in `docs/DESIGN.md` as part of this task.

## Q2 (task T4, consumed) — How should shell execution coordinate cross-slice mutations?

Context: An event module may return only its own namespace slice, but T5–T7
commands must atomically mutate VFS, git, process, service, and environment
slices while recording one ordered shell result. The approved plan names this
as an orchestration blocker; T4 also needs a cartridge-command schema and a
structured stdout/stderr transcript contract that do not yet exist. Parked
branch: `factory/t4-command-interpreter`.
Options considered: A — add reducer-supported ordered event expansion, with one
visitor command expanding into owning-subsystem events plus a shell-result
event; B — add a privileged orchestration module allowed to return multiple
slices, weakening the current isolation invariant; C — have each mutating
command be an owning-subsystem event and keep `shell.execute` only for pure
commands, complicating the single shell API and transcript ordering.
Please select the orchestration model and confirm whether cartridge commands
should be static `{stdout, stderr, exitCode}` records under `repository.commands`,
and whether transcript entries should gain structured stream-tagged output plus
an exit code.
**A:** Option A — reducer-supported ordered event expansion.

One visitor command expands into owning-subsystem events plus a shell-result
event. Rejected B because a privileged multi-slice module trades away the
one-module-one-slice isolation invariant (ARCHITECTURE.md:97), and CLAUDE.md
holds that weakening an invariant is never a valid solution. Rejected C because
issue #8 requires a single shell execution entry point that Phase 1's `!`
passthrough and Bash view both call; splitting mutating commands out of
`shell.execute` fights that requirement and complicates transcript ordering.

Expansion order must be deterministic and documented, and each expanded event
folds one TranscriptEntry at the same index, per ARCHITECTURE.md:121.

Sub-questions, both yes:

- Cartridge commands are static `{stdout, stderr, exitCode}` records under
  `repository.commands`. Data, not behavior — keeps incident logic out of the
  interpreter per invariant 1.
- Transcript entries gain stream-tagged output plus an exit code. Issue #8 makes
  the result shape part of the replay contract, and without stream tags Phase 1
  cannot render stderr distinctly or fixtures assert on it.

## Q3 (task T6, open) — What bounded Git CLI and commit-identity policy should the simulator expose?

Context: Issue #10 names ten commands and requires full semantics, but the Git
model has no author identity for new commits and the issue does not define the
mutating forms for `branch`, `commit`, `restore`, path checkout, or pathspecs.
Choosing these details defines public cartridge and shell behavior rather than
an implementation detail. Parked branch: `factory/t6-git-commands`.
Options considered: A — add required `repository.gitIdentity` name/email and
support a bounded Git-compatible contract (`branch [name]`, `commit -m`,
`restore [--staged] <path>`, `checkout <ref>` and `checkout -- <path>`, exact
cwd-relative paths plus `.` for add); B — derive author identity from the VFS
user and support only the narrowest happy-path forms, avoiding schema work but
inventing an email/default policy; C — make commit author/message explicit on
every command invocation, which is deterministic but unlike the requested Git
register. Please also confirm fixed seven-character hash abbreviations with
deterministic extension on collisions, UTC/C-locale dates, and committed-tree
blame (working edits remain visible through diff/status, not blame).
**A:** Option A — required `repository.gitIdentity` (name/email) and the bounded Git-compatible contract as listed.

Rationale: this follows the standing decision recorded in `.factory/spec.md` — world facts are cartridge content. Commit authorship is a comedy surface exactly like `ls -la` ownership (a commit by a departed engineer is authored content, not an engine default). Option B derives identity from the VFS user and invents an email policy, which is precisely what Q1 rejected; option C breaks the shell's straight register.

Confirmed as asked: fixed seven-character hash abbreviations with deterministic extension on collision; UTC and C-locale dates (the schema already states the simulated machine has no other timezone); committed-tree blame.

DELIBERATE DEVIATION to record in `docs/DESIGN.md` in this task's PR: committed-tree blame differs from real `git blame`, which annotates the working tree and attributes uncommitted lines to "Not Committed Yet" with a zero hash. We accept the deviation because issue #6 requires log and blame to agree, and the real behavior forces a pseudo-commit into every fixture. Document it as a chosen simplification so it is not later read as a bug.

## Q4 (task T7, open) — What cartridge contracts should back curl, machine identity, uptime, and shell history?

Context: Issue #11 requires simulated endpoints, `uname`, machine uptime, and
session-accumulated history, but the cartridge has no endpoint, machine, or boot
metadata and shell execution does not append history. The approved plan names
these source-of-truth choices as a design blocker. Parked branch:
`factory/t7-system-world-commands`.
Options considered: A — add `repository.system` (`hostname`, `operatingSystem`,
`kernelRelease`, `architecture`, `bootedAt`) and exact-URL
`repository.endpoints` records linked to a service, with declared running and
unavailable `{stdout, stderr, exitCode}` responses; append every nonblank raw
shell input before its command-owned events, while `history` displays only
prior entries because command output is computed before expansion; B — use
runtime-fixed machine strings/session elapsed time and body-only endpoint
records, which is simpler but moves world content and uptime semantics into the
engine; C — defer `curl`/`uname`/`uptime`/accumulated history, which does not meet
issue #11. For bounded CLI behavior, please also confirm no options except
`uname -a`; `export NAME=value`; `man [section] name`; `systemctl
status|start|stop|restart service`; one PID for `kill`; and UTC/C-locale
formats for `date` and `uptime`.
**A:** Option A — add `repository.system` (`hostname`, `operatingSystem`, `kernelRelease`, `architecture`, `bootedAt`) and exact-URL `repository.endpoints` records linked to a service, with declared running and unavailable `{stdout, stderr, exitCode}` responses; append every nonblank raw shell input before its command-owned events.

Rationale: same standing decision — world facts are cartridge content. Option B hardcodes one machine into the engine and derives uptime from session elapsed time, which means every episode shares a host that has been up for four minutes. The premise is a different incident every day; the machine has to be authorable. A box up for 400 days on a kernel nobody dares patch is content.

Confirmed as asked, all as bounded POSIX-shaped behavior with no surface beyond what issue #11 requires: no options except `uname -a`; `export NAME=value`; `man [section] name`; `systemctl status|start|stop|restart <service>`; one PID for `kill`; UTC and C-locale formats for `date` and `uptime`.

DELIBERATE DEVIATION to record in `docs/DESIGN.md` in this task's PR: `history` displays only prior entries and does not list itself. Real bash appends a command to history before executing it, so `history` shows itself as the final line. We accept the deviation because command output is computed before event expansion. Document it as a chosen simplification — history is a surface a curious visitor will poke.
