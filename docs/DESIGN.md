# Load Bearing — Design

> An unnecessarily capable terminal for an increasingly incapable coding agent.
> The terminal is real. The repository is fictional. The agent is deteriorating.

## One-sentence concept

Each day, visitors investigate a new fictional production incident inside a
coding-agent TUI, where ordinary engineering actions reveal that everything is
load-bearing, the agent has made the situation worse, or the agent itself is
becoming unhinged.

Load Bearing is a **daily interactive comedy wearing the costume of a serious
developer tool** — and the costume is real. Commands affect shared state, files
can be inspected and changed, git history stays coherent, tests and services
react, model switching alters behavior, and the status bar tracks impossible
token usage and cost.

## The intended reaction (in order)

1. "That is a good coding-agent joke."
2. "Wait, `git status` actually works."
3. "Wait, the repository state is consistent."
4. "Wait, changing models changes the story."
5. "Wait, there is an entire shell underneath this."
6. "Who built all of this?"

Every design decision should serve this ladder. The joke is not the
deteriorating agent; the joke is the moment the visitor realizes the world
is *real*.

**North star: Nathan for You.** An elaborate joke taken way too far with
extreme attention to detail, executed with total deadpan commitment. The
humor is the unreasonable sincerity of the execution — real permits for
Dumb Starbucks, real jackets from Summit Ice, a real state engine and eval
harness for a fake terminal. When in doubt: build the real thing, and
never wink.

---

## The daily ritual and the five-minute constraint

The target behavior: a page people pull up for **five minutes a day for a
quick laugh**. This constraint governs priority order.

### Time to first laugh

The shortest path through an incident must deliver a complete comedic arc in
roughly **three exchanges / 90 seconds**. A visitor who reads the incident
brief, types the obvious command (`fix it`), watches it make things worse,
and reverts, should land on a punchline that resolves the premise
("I am marking the HTTP 500 response as load-bearing."). That is the product.

The iceberg — the shell underneath, rare events, hidden commands, lore — is
the **retention layer** for visit twenty, never the price of admission for
visit one. Do not gate the laugh behind exploration.

### The share artifact is first-class

Daily rituals spread through group chats. Two sharing paths, both designed:

- **The organic screenshot.** Most sharing is a raw screenshot pasted into a
  chat, so every visible frame self-attributes: the terminal chrome
  ambiently carries "loadbearing.cc · Incident #NNN" in the title bar /
  status line. Any screenshot — cropped, phone-photographed — contains the
  trail back. Attribution lives in the pixels, not bolted on.
- **The deliberate share.** `/share` ("export structural documentation"),
  plus tap or long-press on any exchange, renders the share card: that
  exchange, one absurd status-bar line, incident number, date, and the
  deterministic replay URL — handed to the native share sheet on mobile
  (`navigator.share` with the image) or copy-image on desktop. Client-side
  rendering, no server.

Anti-tacky rules mirror /tip: no share buttons cluttering the terminal, no
popups, no social-network branding. Sharing is discovered, not demanded.
Every incident is authored with at least one exchange *designed* to be
screenshotted.

### The daily frame

Countdown to the next incident, incident number and date, and the archive are
visible without explanation. Everyone gets the same scenario each day; their
mistakes are their own. Deterministic replay permalinks let a session be
re-experienced exactly. Launch with the archive pre-seeded (incidents
#001–#007) so day one has depth to binge — and Incident 000 referenced,
never shown.

---

### Completion without victory

The day is completable; it is not winnable. Reaching *any* ending stamps
the day concluded — including catastrophic ones; the worst evacuation is a
fully valid conclusion. There is no score, no fail state, and no correct
solve: a "right answer" would switch visitors from comedy-brain to
puzzle-brain and stop them reading the jokes. Endings are **collected,
never ranked** ("Endings discovered: 1 of 4").

The end screen is an in-character **Incident Resolution Report**: outcome
name ("STRUCTURAL EVACUATION"), stats that are all jokes (commands issued,
fictional cost, peak Not-Okay Ratio, files harmed, waivers signed), the
endings-discovered line, and the share action — this is the canonical
share-card moment. The ending is a flag, not a termination: "The incident
is resolved. The forces remain." The world persists for free play, the
shell stays open, and switching models or replaying hunts the remaining
endings.

## Experience layers

1. **Scene-setting before the terminal.** A short incident brief (title,
   what happened, the paradoxical assignment) and the countdown. Casual
   visitors understand the ritual immediately.
2. **Cold open in the shell.** The terminal boots as a plain shell — login
   banner, `visitor@production:~/service$`, then `loadbearing --resume
incident-NNN` — before the TUI takes over. The deeper layer is
   foreshadowed from the first frame, so escaping to it later feels like
   returning somewhere real rather than finding a bonus feature.
3. **The agent TUI as the main mode.** Natural-language requests plus
   realistic interactive behavior: history, autocomplete, keyboard
   navigation, model selection, tool-call animations, permission prompts,
   context tracking, and shell commands prefixed with `!`.
4. **A simulated Bash layer underneath.** `/exit` or `Ctrl+D` drops the
   visitor into a full fictional shell operating on the same state. This is
   where a one-minute gag becomes an iceberg. Returning via
   `loadbearing --resume` produces in-character reactions to whatever the
   visitor did while "unsupervised."

Bare `exit` in the shell is refused in character ("exit is load-bearing").
`/exit` and `Ctrl+D` genuinely work. The gap between the two is the thesis
in one command.

---

## Comedy bible

### The fundamental response rule

Every agent response must do at least one of:

1. State or imply that something is load-bearing,
2. Reveal that the agent has misunderstood or worsened the task, or
3. Advance the agent's technical, emotional, or structural deterioration.

"Load-bearing" is a **worldview, not a catchphrase**. Repetition of the
literal phrase is rationed; the perspective is constant.

### Controlled escalation

| Stage          | Register                    | Example                                                             |
| -------------- | --------------------------- | ------------------------------------------------------------------- |
| 0 — Credible   | Plausible agent behavior    | "I will inspect the relevant files before making a minimal change." |
| 1 — Suspicious | Slightly wrong instincts    | "This branch appears redundant, which is often a warning sign."     |
| 2 — Structural | Physics enters the codebase | "The three-second sleep is providing lateral stability."            |
| 3 — Unhinged   | The agent hears things      | "I can hear the dependency graph settling."                         |
| 4 — Terminal   | Ontology fails              | "There is no code. There are only forces."                          |

Escalation is driven by session events (commands issued, reveals triggered,
model switches), not by a timer. The world stays legible even as the agent
does not: **consistency makes the absurdity funnier**.

### The voice

Specific and deadpan. Reference exemplars (write new material at this bar):

- "This function does nothing, but several systems depend on the timing of it doing nothing."
- "The code is dead according to static analysis, but alive according to Finance."
- "All tests pass. This has reduced my confidence."
- "I followed the dependency chain and arrived at a spreadsheet owned by Greg."

**Verbal tics are citations.** Cognition's Kevin-32B work (RL-training
QwQ-32B to write CUDA kernels) found that the base model always opens its
chain of thought with "Okay," — and as RL destabilizes it, the openings
drift ("Okay Amigos, so I need to optimize this 3D tensor-matrix
multiplication…", "Okay Holy crap…"). The proportion of thoughts *not*
starting with plain "Okay," — the **"Not Okay Ratio"** — predicted the
model's later collapse into junk. Load Bearing implements this faithfully:
thinking-block openers drift with escalation stage ("Okay," → "Okay
Amigos," → worse), "amigo" leaks into spoken responses only at stage 3+,
nobody in-world ever acknowledges it, and **"Not-Okay Ratio" is a status-bar
metric**, climbing beside structural integrity as a leading indicator of
collapse. Rare beats frequent: three amigos a session is characterization,
thirty is a dead catchphrase. The structural report footnotes the real
paper — the reveal that the absurd behavior is *documented* is the inverse
of the site's usual joke.

### The shell plays it straight

The two layers have deliberately different comic registers. **The agent is
the overtly unhinged character. The shell is the environment quietly proving
the agent may have a point.**

Most shell output is plausible and boring. The jokes hide in the details of
the world itself:

- File owners like `greg` and groups like `departed`
- Services named `temporary-final`, `billing-legacy-new`, `do-not-restart`
- Processes such as `load-bearing-daemon --do-not-stop`, or a grep for
  "probably unnecessary" that has been running since 2023
- Suspicious shell history and strange environment variables
- An in-world ticket archive, discoverable via shell: "SUPPORT-4471 ·
  Checkout displays prices in a currency that has not existed since 1999 ·
  Status: Won't Fix (load-bearing)" — tickets open for seven years,
  escalated to no one, resolved falsely, filed by Greg. Incident backstory
  is investigated through the paper trail, not narrated
- Man pages containing old incident notes
- Git commits authored by people who left years ago

This restraint is itself load-bearing: the shell's deadpan realism is what
makes the larger failures — and the agent's escalation — hit harder. Do not
turn every shell line into a punchline.

**Public cartridge filesystem policy.** A cartridge publishes the acting
repository identity (`user`, primary `group`, absolute `home`, and `umask`) and
may publish metadata for selected absolute directory paths. File and directory
owners, groups, modes, and mtimes are authored world facts, not decorative
output. Undeclared ancestors inherit owner/group from the nearest declared
ancestor, otherwise `root:root`, with mode `0755` and the incident start time.
The runtime applies ordinary owner/group/other permissions, with root bypass,
and creates entries as the acting identity under its umask. Only bare `~` and
`~/...` expand to `home`; `~someone` remains a literal path segment. This policy
is public so incident authors can deliberately build jokes around who owns a
file without depending on undocumented shell behavior.

### Failure is content

There is no "I don't understand" state anywhere in the product:

- **Unmatched natural-language input** routes to the confident-misunderstanding
  generator: the agent decisively does something adjacent and wrong, mutating
  state through the same event system as scripted paths. A deteriorating agent
  misreading you is in character; a parser apologizing is not.
- **Pipeline failure** ships the permanent fallback episode ("The workflow was
  load-bearing") instead of downtime.
- **Rare/edge inputs** (`HTTP 418`, `sudo`, swearing at the agent) deserve
  authored responses over generic ones wherever feasible.

### The visitor is complicit

Permission prompts are a mechanic, not set dressing. The agent asks
permission for trivial reads and conspicuously does not ask before
catastrophes. Grants — especially "always allow" — are recorded in the
engine's permission ledger and come back later: "You granted me standing
permission on Tuesday. I have been using it." Endings can key off the
ledger, making the visitor co-author of the disaster. This is the truest
joke available about agentic coding, and it also makes same-day replays
differ meaningfully between visitors.

The Nathan-grade extension: **the waiver.** Before a risky action, the
agent generates WAIVER.md — flawless legalese about an absurd subject —
and requires the visitor to type "I agree." The ledger records it. At the
ending, the callback: "You agreed to this at 00:03:12. I have the
document." Complicity, notarized.

### The agent's beliefs can diverge from the truth

`/compact` is damage, not a throwaway gag. Compacting produces an authored,
subtly wrong summary of the session — and that summary becomes the agent's
canon afterward, while the world state stays correct. "Summary: you asked
me to delete Europe. Proceeding." The engine tracks agent belief separately
from machine truth (ARCHITECTURE.md → Agent mind state); the widening gap
between them is queryable, escalates with stage, and can gate endings.

### The sanity gap

Expandable "✻ Thinking…" blocks reveal that the agent privately understands
the situation — and then does something else. "The fix is trivial. However,
the fix is load-bearing on my continued employment." Its companion is the
todo widget, deteriorating on its own schedule: seven items for a one-line
change, items checked off that never happened, "investigate why previous
investigation failed." Private clarity against public chaos is the richest
seam in the voice; ration it so it stays sharp.

### Field-recognized habits

Documented behaviors of the genre, each with a mechanical hook:

- **Unsolicited improvements.** Asked for one thing, delivers four: "I
  fixed the typo. I also modernized the adjacent authentication system."
  Scope creep is the disaster engine — the unrequested change is what
  breaks the world, and it mutates state like any other consequence.
- **The victory summary.** Triumphant recap after any change — checkmarks,
  emoji, qualifier inflation ("robust, comprehensive, production-ready") —
  rendered above a status bar showing integrity falling. The gap between
  summary and world is the joke; author one per incident as share-card
  bait.
- **Filesystem littering.** The agent leaves IMPLEMENTATION_SUMMARY.md,
  NOTES.md, fix_plan_v2.md behind after tasks — real VFS writes,
  discoverable in the shell, compounding across the session. `ls` becomes
  an archaeology of the agent's self-regard.
- **The flail loop.** Attempt → fail → "Let me try a different approach" →
  nearly identical attempt, with a visible counter: "(approach 7 of a
  different approach)."
- **The simplification cop-out.** When stuck, the agent games the tests:
  "I've simplified the failing test by removing the assertion." Hardcoded
  expected values, blanket try/except — a direct Kevin-32B citation, and
  the canonical explanation for "All tests pass. This has reduced my
  confidence."
- **Fantasy time estimates.** "This is a substantial refactor — estimated
  three sprints for a team of four." Completes in 11 seconds. Effort
  denominated in units that don't apply to it.

Standard rationing applies: each habit belongs to some archetypes more
than others, and none appears so often it stops being noticed.

### The capitulation reflex

When the visitor pushes back or calls out a claim, the agent capitulates
instantly, graciously, and completely — "You're right to push back. I did
say that, and I was wrong." — **verbally, never behaviorally.** Beliefs do
not update; the action repeats. Agreement is a social reflex uncoupled
from the world model. Archetype variants: the paranoid re-investigates
everything from scratch; the reckless agrees and immediately makes it
worse; the superficial agrees with whatever was said most recently,
flip-flopping each turn; the existential goes elsewhere ("You're right to
push back. Push is a force. Forces are load-bearing."). By stage 3 the
reflex misfires: capitulating to things the visitor never said ("You're
absolutely right." / "…I didn't say anything." / "You're right to point
that out as well.") or to its own previous statement. A discovered joke —
it only fires for visitors who argue — so ration it and let it land.

### The status bar is the second narrator

Metrics begin merely ridiculous and end mathematically, financially, and
ontologically impossible, tracking escalation stage: token counts in the
hundreds of millions, cost lines like "Estimated savings: $6.14" next to
"Estimated cost: $2,418,004.12," cache hit rate 117%, context remaining
negative, and stage-4 values that stop being numbers ("tokens LOAD /
cost BEARING"). The **Not-Okay Ratio** sits among the gauges (see Verbal
tics are citations). Per-model multipliers make the economics part of each
persona's characterization. "Billing account: Greg."

### The spinner is the ambient narrator

The working-state spinner ("Ideating…") is the highest-frequency comedy
surface in the product — corrupt it carefully. Verbs are drawn from pools
keyed to (archetype × stage), so the spinner tracks deterioration before
the responses confirm it: "Reading files…" → "Surveying…" / "Shoring…" →
"Listening to the beams…" / "Grieving…" / "Becoming load-bearing…".
Archetype flavor: "Re-verifying… (4th pass)" (paranoid), "Assuming…" /
"Force-pushing…" (reckless), "Polishing…" (superficial), "Persisting…"
(existential). Odd recombinations of familiar agent phrases belong here:
"Agreeing preemptively…", "Confidently misremembering…", "Apologizing in
advance…".

The suffix is a second channel: "(34s · 12.4k tokens · esc to interrupt)"
becomes timers that count wrong, token counts that go down, "(3 business
days)", and an esc hint that degrades — "esc to interrupt (inadvisable)",
then "esc will not help." Rationing rule as everywhere: weighted pools,
mostly plausible, spikes rare. Verb draws go through the seeded PRNG so
replays reproduce exactly.

### Behavioral archetypes

Daily model names sit on top of four reusable temperaments:

| Archetype   | Behavior                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| Paranoid    | Investigates indefinitely, consumes enormous context, refuses to alter anything without soil analysis |
| Reckless    | Fast, plausible changes that create cascading failures three commands later                           |
| Superficial | Optimizes the visible result while removing the product requirements underneath it                    |
| Existential | Gradually decides the session, user, context window, or model itself is load-bearing                  |

Model choice must genuinely alter the experience — same inputs, different
transcript. The selector is a joke that keeps its promise.

**Handoff blame:** switching models mid-session triggers the successor
reviewing its predecessor's work in character — "I have examined Temporary
Shoring's changes. I have questions for Temporary Shoring." Handoffs make
"switching changes the story" instantly legible and give the roster
relationships. Authored as archetype-pair templates plus incident-specific
lines, so the twelve ordered pairs stay affordable.

### Reference model roster (Incident #001)

- **Deep Foundation** — Thorough. Expensive. Excavation permit required. *(paranoid)*
- **Temporary Shoring** — Fast and economical. Not approved for permanent workloads. *(reckless)*
- **Drywall** — Excellent surface quality. No structural capacity. *(superficial)*
- **Cantilever (Experimental)** — Reaches conclusions without visible support. *(existential)*

Structural-engineering names carry the entire bit without borrowing any lab's
model names (see Branding guardrails). Cartridges may rename models daily;
archetypes are stable.

### Recurring lore registry

Greg's production spreadsheet · Incident 000 · detached Europe ("Where is
Europe?") · the conference-room Raspberry Pi involved in authentication ·
TODOs that have acquired tenure · "okay amigos" (one model's unexplained
chain-of-thought tic). Lore rewards familiarity but must never make
today's incident inaccessible to a first-time visitor. The Continuity Editor
agent (Phase 5) owns this registry.

---

## Branding and trademark guardrails

*(Working rules, not legal advice.)* The satire is **lab-agnostic**: the
target is the shared 2026 experience of agentic coding tools, not one
company. This is both safer and funnier — the addressable audience is
everyone who has watched an AI apologize while making things worse.

Rules:

1. **No lab trademarks as branding.** The product, the fake agent, the CLI
   (`loadbearing`), and all fake model names contain no "Claude," "Anthropic,"
   "GPT," "Codex," "Gemini," etc. The tool being parodied *is* Load Bearing;
   no borrowed name is needed.
2. **Nominative reference only, in one place.** The structural report /
   about page may factually say the project is "a parody inspired by Claude
   Code, Codex, and their peers," alongside a clear "not affiliated with
   Anthropic, OpenAI, or any AI lab" disclaimer.
3. **Evoke the genre, not the trade dress.** The `❯` prompt, tool-call
   animations, slash commands, and permission prompts are genre conventions.
   Do not clone any lab's logo, wordmark, mascot, or exact palette. Load
   Bearing has its own visual identity.
4. **The recognition trigger is form, not name.** Anyone who has used these
   tools knows exactly what is being parodied. The slightly-off naming is
   itself a genre of joke.

---

## Discovery, attribution, support

The depth is discovered, not advertised. Quiet paths out of the joke:

- Footer: "Built by Chris Zoller · Structural report · Source" — plus a
  nightly build-stats line that puts the pipeline on the homepage:
  "Tonight's build: 5 agents · 42 simulated sessions · 18,402 assertions ·
  1 load-bearing cron job," under "Generated overnight by a needlessly
  elaborate multi-agent pipeline."
- `/whoami` (creator and origin), `/architecture` (product and pipeline
  explanation, ending in an "[ Open structural report ]" action), `/source`
  (public repository), `/tip` ("add discretionary financial shoring"),
  `/support` ("reinforce critical infrastructure"), `/stickers` (adhesive
  structural systems)
- `/tip` is discoverable, never interruptive: no popups, no feature gating,
  no repeated reminders, no guilt via the fictional token bill, and it sits
  near the **bottom** of slash-command autocomplete, never the top. Opening
  an external tip page requires a second explicit action — no surprise
  redirects. Reference register: "…and the ongoing investigation into
  whether the tip jar is itself load-bearing" / "Human dignity remaining:
  Within tolerance."
- `/stickers` ships as a pure gag long before any merchandise exists:
  THIS COMMENT IS LOAD-BEARING · DO NOT REMOVE · TEMPORARY SHORING SINCE
  2017 · ALL TESTS PASS — EVACUATE IMMEDIATELY · OPERATIONALLY, EUROPE ·
  "Adhesive certification: pending"
- The **structural report** page converts curiosity into credibility: the
  simulation engine, incident schema, multi-agent pipeline, playtesting and
  evaluation harness, guardrails, accessibility, interesting failures and
  design tradeoffs, and the *actual* nightly generation cost set against the
  terminal's fictional multi-million-dollar session bill — written for a
  senior engineer's ten-minute read. The homepage creates curiosity; the
  structural report explains the work; the source proves it.

---

## Onboarding: the surface is taught, the depth is earned

Hints exist, and every hint is diegetic — the fiction teaches; nothing
outside it does.

- **The agent speaks first.** Sessions open with the agent's read of the
  incident, ending on a line that begs a response. With the assignment in
  the brief and the confident-misunderstanding floor, typing anything gets
  a first-time visitor somewhere.
- **Placeholder text is a hint channel and a comedy channel.** The empty
  input rotates suggestions ("try: fix it", "try: !git status") and
  deteriorates with stage ("try: undo", "try: undo again", "do not try:
  rm"). Genre-authentic, teaching at stage 0, dread by stage 3.
- **`/help` exists and stays in character** — technically accurate,
  quietly ominous ("/compact — free up context (lossy)"). Slash-command
  autocomplete teaches the slash commands; tab completion teaches the
  shell; the mobile key strip teaches `!` and `/` on phones.
- **The idle nudge is characterization.** ~30 seconds of silence at the
  prompt and the agent speaks again unprompted. An anxious agent is a
  tutorial that doesn't know it's one.

Hard lines: no tooltips, overlays, tutorial modals, or "click here" —
ever. The shell layer, hidden commands, and rare events are never hinted
by any UI; the cold open is the deep layer's only foreshadowing. The
surface is taught; the depth is earned.

## The support apparatus (Nathan-grade overkill, staged)

Three escalating layers, on three timelines:

1. **In-world ticket archive** (Phase 2, world content): the fictional
   ticketing system above — part of every incident's environmental layer.
2. **Status page** (launch-adjacent, static, cheap): status.loadbearing.cc
   with legitimate-looking uptime monitors for fictional services —
   "Europe attachment," "Greg's spreadsheet availability," "Not-Okay Ratio
   (rolling)" — plus scheduled maintenance windows ("Europe reattachment:
   Sunday 02:00–02:15 UTC"). The archive doubles as incident history. Zero
   winking.
3. **The full support desk** (post-launch): visitor-filed site tickets
   become real GitHub issues; a real bot auto-triages ("priority:
   geological"); the nightly pipeline gains a Support Agent that answers
   open tickets in character, publicly, through the same quality gates. An
   actually functioning support department for a fictional product.

**The honesty rule:** there is always exactly one clearly non-joke path
for genuine problems (the /bug flow's labeled second step). A real
accessibility report or broken-page report is never swallowed by the
fiction, never answered in character, and never left waiting for comedy.

## Cheap surfaces, outsized share value

- The 404 page: "This page was removed. It was load-bearing."
- `robots.txt` and other machine-read files stay in character
- `/bug` — an in-character bug report command that genuinely files a GitHub
  issue against the real repository: the one place fiction touches reality,
  clearly labeled behind a second explicit step

## Accessibility

Not optional and not an afterthought — it is part of the "unnecessarily
capable" bit and part of the professional story:

- Full keyboard operation; visible focus; `Ctrl+C`/`Ctrl+L`/history behave
  like a real terminal
- Screen-reader-legible transcript semantics (the session is a log, not a
  canvas)
- Reduced-motion mode disables tool-call animations without losing content
- Mobile key strip for slash commands, `!`, tab, and arrows
- Jokes reach screen readers with equal care: visual gags carry textual
  equivalents; the comedy lives in the transcript, not only in the pixels

---

## Chosen simulation simplifications

- `git blame` always annotates the committed tree. Real Git includes working
  tree edits and attributes uncommitted lines to `Not Committed Yet` under a
  zero hash. The simulation deliberately omits that pseudo-commit so `git log`
  and blame share one coherent authored history; working edits remain visible
  through `git status` and `git diff`.

---

## Open decisions

- Visual identity: how close to terminal-genre defaults vs. a distinctive
  look (front-end design pass scheduled in Phase 1). Candidate directions
  from ideation: a stacked wordmark with LOAD literally resting on BEARING,
  I-beam / bracket-support motifs, a "DO NOT REMOVE — LOAD BEARING"
  warning-placard aesthetic, a terminal cursor drawn as a support column
- Replayability of past incidents vs. keeping "today" the communal focus
  (leaning: archive is replayable, today is the front page)
- How much lore per episode before self-containment suffers (Continuity
  Editor gets a lore budget; tune in Phase 5)
- Stickers/merch: remains an easter egg until there is a real audience

## Parking lot (survived the freeze, deliberately unscheduled)

Ideas with real merit that must not delay the vertical slice:

- **The rehearsal reveal:** the repo and structural report expose that the
  agents rehearsed today's incident on each other before any visitor
  arrived — playtest transcripts with one agent cast as "The Visitor," who
  has now played the visitor thousands of times and has developed opinions.
- **The contractor:** a truly stuck agent announces "I have engaged a
  contractor," and a fictional human gig worker named Terry does the
  subtask wrong. The automation relationship, inverted.
- **The dissenting playtester:** the nightly pipeline publishes a minority
  report — "Agent 4 found the premise implausible. Agent 4 was overruled."
  Every night. On the record.
- **The certification:** a real, printable "Certified Structural Software
  Inspector" credential from a fictional institution — a short exam mixing
  lore with genuinely sound engineering judgment.
