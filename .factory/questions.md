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
