# Questions

Open blockers for the human. Agents append per the `factory-protocol` skill;
answers go inline under each question after `**A:**` (or answer in chat via
`/blocked`). Entries are never deleted — reconciliation marks an applied or
forwarded answer `consumed` in the same bookkeeping commit.

---

## Q1 (task T1, open) — What identity and implicit-directory policy should the VFS use?
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
**A:**

## Q2 (task T4, open) — How should shell execution coordinate cross-slice mutations?
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
**A:**
