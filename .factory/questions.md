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
