# joemartin.work

My personal site. Plain HTML/CSS, no build step, hosted free on GitHub Pages.

## Edit it

- **All content** lives in [`index.html`](index.html). Each project is one
  `<section class="entry">` block — copy one to add a new project, changing the
  image, heading, text, and the `.cta` link. Sections auto-alternate image
  left/right.
- **Styling** is in [`style.css`](style.css). The colours/spacing are variables
  in the `:root {}` block at the top; dark mode is handled automatically.
- **Images** go in [`images/`](images/). Reference them as `images/yourfile.jpg`.
- **Embeds** (YouTube, etc.): drop an `<iframe>` inside a section's
  `<div class="entry__media">` in place of the `<img>`.

## Null Sector (the game)

A turn-based tactics game that runs in the browser. It's a separate page, since
it needs the whole viewport and mustn't scroll — [`game.html`](game.html),
[`game.css`](game.css), [`game.js`](game.js). Section 07 of `index.html` links
to it. Same rules as the rest of the site: no build step, no dependencies.

`game.js` is one IIFE split into numbered sections (config, RNG, data, rules,
enemy AI, generation, verifier, render, input, turn controller). Two things
worth knowing before changing it:

- **Levels are generated, then proved.** `buildLevel` composes a sector against
  a power budget and plants at least one dice-free kill (a pit behind a hostile).
  `canSolve` then *plays* the level with pessimistic dice — the player only
  trusts shots at 60%+ and rolls minimum damage, hostiles always hit and roll
  maximum. Only levels the solver beats ever ship. Retries 40 times, then falls
  back to `safeLevel`.
- **Combat rolls; the room doesn't.** Gunfire has a hit chance, but knockback,
  pits, barrels, frags and the shock prod are all deterministic. That's what
  keeps a bad streak from making a sector unwinnable — don't make the
  environment random.

Blast doors are placed **last** in `buildLevel`, after `connectAll` and the
kill-lever step, and only in a tile flanked by solid ground on both sides. They
used to be dropped on a random floor tile — which is why a player reported they
"did nothing": a sealed door standing in open ground blocks nothing. Placement
also has to come after the connectivity pass, because that pass demolishes walls
and can remove the doorway from under the door.

Operatives walk **through** each other but never stop on each other: `reach`
marks a squadmate's tile `thru`, so it's a stepping stone and not a destination
(the movement highlight and the solver both skip `thru` entries). This is scoped
to the player side deliberately — letting hostiles slip past each other would
remove body-blocking a corridor as a tactic.

Geometry: **feet are 4-way, eyes are 8-way.** Movement uses `DIRS` (orthogonal
steps, Manhattan `dist`) because 4-way pathing keeps the solver cheap and the
board readable. Aiming uses `AIM` (all eight directions) and Chebyshev `cheb`,
so a diagonal neighbour is one tile away rather than two — anything else makes
standing corner-to-corner with a hostile feel broken. Diagonal shots can't
squeeze through a corner gap: if both tiles flanking the step block sight, the
shot stops. Don't mix the two distance functions up; `cheb` is for range,
falloff, cover and "adjacent", `dist` is for walking.

There are twenty-eight requisitions, and each one is contested: every entry in
`REWARDS` carries a `run` (what it does for your squad), a `foe` (what it does for
theirs), a `took` line for the debrief, a `weight` for how badly they want it, and
a `scope` saying who ends up holding it. `scope` matters because the weapon crates
hand the gun to a single operative chosen by a heuristic — `scopeLabel()` and
`giveWeapon()` both ask `weaponRecipient()` so the card can't name one operative
and the gun go to another.
Squad-wide numbers (damage, accuracy, range, soak, revive, extra barrels/voids)
live on `G.mods`; weapon-shaped ones fold into a weapon **object** once via
`gunFor()` and are stored on the unit as `wpn`. Everything downstream reads
`gun(u)`, so a perk can't be applied in one place and forgotten in another —
if you add a stat, add it there rather than at each call site. Requisitions that
change a stat are capped in `ok()`; unbounded hull would overflow the pip readout
and flatten the curve.

Two gotchas when adding a requisition. `gunFor()` **early-returns the shared base
weapon** when none of the mods it knows about are set, so a new weapon-shaped mod
has to be added to that guard or it will silently do nothing. And perks the *room*
reads rather than a unit (coolant damage, frag footprint, debris reach, breaching)
are carried on the state — set them in `buildLevel`, `safeLevel`, `cloneSim` **and**
`startLevel`. That last one was missed for `shrapnel` and `revive`, which meant the
field surgeon never brought anyone back in a real game; it only ever worked inside
the solver, where the state came straight from the builder.

The room is destructible and shove-first. Guns do 1–3 damage; a slam into a
bulkhead does `BONK_DMG` (2) and the void is always fatal, so the question each
turn is where a thing lands rather than whether you can out-damage it. Barrels
blow out adjacent walls, terminals can be tripped by gunfire as well as by hand
(`chargeCoolant` is the single entry point for both), and blast doors stop sight
and gunfire but never movement — `blocksMove` deliberately ignores them. All
three change connectivity or line of fire mid-fight, so re-run the harness after
touching any of them.

**Debris** is the movable piece of furniture. Stand beside a block and spend your
action to shove it three tiles (five with the Wrecking bar); `shoveDebris` walks
it one tile at a time like `knockback` does, and hands the remaining momentum on
to whatever it runs into — a barrel is launched and then detonates where it lands,
a unit is driven back and takes **1 damage per tile it actually moves**, another
block carries on. It sinks in coolant and is gone in the void. Shooting a block
destroys it instead, so gunfire clears a lane and shoving weaponises it.

Two subtleties. A block is both shootable and shoveable, so `resolveIntent` checks
`interactables` **before** shots — standing right next to one, shoving is what you
meant. And `interactables` only offers the shove when `shoveGoesSomewhere()` says
it would achieve something, so a block wedged against a bulkhead falls through to
being a shot target rather than eating your action for nothing.

Debris is placed **after** the kill-lever step but **before** `connectAll`: after,
because a block landing on a lever tile would reject the whole level, and before,
because blocks stop movement, so connectivity repair has to be free to clear one
out of the only corridor. `connectAll` bulldozes `debris` for exactly that reason.

Rooms are irregular, not a fixed square. `carveArena` (run first in
`buildLevel`, before anything is placed) marks edge tiles `off` — out of play,
drawn as empty, and solid to feet, sight and shoves exactly like the board
edge, so it's a shape change, not a new mechanic. The carve is deliberately
constrained to a **skyline**: `off` only ever sits at the top of a column or as
a whole side-margin column, never mid-column, and the bottom row is never
touched. That guarantees every surviving column still reaches the always-floor
bottom row, so the room is one connected piece by construction — down-then-along
the bottom is always a valid path, and `connectAll` never has to fight the
shape. `keepMainRegion` and an area/deploy floor check are cheap safety nets; a
carve that leaves too little room falls back to the full square, so the worst
case is a plain sector. Carving raises the per-`buildLevel` rejection rate
(~8%), but the pipeline retries 40 seeds and still falls back ~never — measure
with the harness rather than trusting that. Rendering: `draw()` skips `off`
tiles, `drawFrame` traces the silhouette by drawing an edge wherever a playable
tile meets `off` or the grid edge, and `fillCell`/`ringCell` no-op on `off` so a
highlight or AoE can't bleed into the void beside the room.

Sector names come from `SECTOR_NAMES` and are read in order: a run is a silent
heist told only through the rooms you pass, looping with a pass number once you
run past the roof.

Difficulty comes from two places. The budget in `buildLevel` scales with the
sector number, and — every second sector — **the hostiles draft a requisition
before you do**. Each entry in `REWARDS` therefore has both a `run` (what it does
for your squad) and a `foe` (what it does for theirs), and whatever they take is
removed from your three options. Their picks accumulate on `G.foe`, get applied
when enemies are built, and are priced into the budget so individually tougher
hostiles means slightly fewer of them. `canSolve` still gates every level, so the
guarantee holds automatically as the drafts stack up — but if you change the
`foe` effects, re-run the generator harness below rather than assuming.

On the interface side, four conventions worth preserving:

- **Every committing action is two-stage.** The first click on a tile *arms* an
  intent (`G.ui.pending`) and shows the numbers; the second click on the same
  tile commits it. `resolveIntent` is the single place that decides what a click
  means, and `previewShot` is the single place that describes the outcome — so
  the panel, the on-board markers and the committed result can't disagree.
- **Hostiles telegraph movement, not aim.** `drawIntents` renders the walk and
  the destination and nothing else — no firing lines, no reticles on targets, no
  hatched threat cells. The one exception is the Recon uplink requisition, which
  exists precisely to break this rule: the aim data is already on the intent
  (`targetId`, `tx`, `ty`), just not drawn until you buy it. Consequence is read off your own squad instead:
  `threatTo(u)` totals everything about to land on an operative (every attacker,
  blast AoE, plus shove-into-wall impact, and it flags a shove into the void as
  certain death), `drawThreat` puts that single number over the operative, and
  the at-risk hull is marked on their card. It reports the **worst case**
  deliberately — the whole point is that a player can never be wiped by damage
  they had no way to add up. Two hostiles each telegraphing "2" against a 3-hull
  operative used to be an invisible death; verified across 40 turns that actual
  damage never exceeds the forecast, and 12/12 lethal flags really died.
- **To-hit lives on the board.** `drawOdds` runs last in `draw()`, after the
  enemy intent labels, because both want the same strip of pixels and the
  player's own odds must win. Combat numbers used to live in the bottom status
  bar, where `text-overflow: ellipsis` silently cut off the hit chance — don't
  put anything load-bearing back there.
- **The chrome is a Blendo pass, the board is not.** Panels are flat blocks with
  hard edges, solid offset shadows, stencilled `.tab` labels, dotted-leader
  `.led` rows and `.big` figures — field equipment, not a hologram. Archivo
  Black for labels, IBM Plex Mono for figures. The neon glow is reserved for the
  board itself, which is the only place it means anything. If you add UI, add it
  in that language rather than reaching for another gradient.
- **Nothing flashes on touch.** Three separate causes, all fixed and easy to
  reintroduce: the default tap highlight (killed with
  `-webkit-tap-highlight-color`), `:hover` rules that stick after a tap and make
  buttons jump (all gated behind `@media (hover:hover) and (pointer:fine)`), and
  rewriting the readout's `innerHTML` on every pointer move (`setTip` memoises on
  the markup string — 50 hovers of one tile now cause zero DOM writes). Don't add
  an ungated `:hover`, and don't write to the readout outside `setTip`.
- **Phones get compact content, portrait gets a docked sheet.** Two independent
  media queries, mirrored in JS by `isCompact()` and `isDocked()`. Compact
  (≤820px, any orientation) swaps the full dossier for `renderSheet()` — who,
  two figures, one warning, the confirm bar — because reflowing the desktop
  panel clipped the confirm bar off the bottom. Docked (≤820px *and* portrait)
  puts it in the flex flow at a fixed height so it reserves its own space and
  the board never reflows; in landscape height is the scarce axis, so it floats
  beside the board instead. `placeTip` measures against `.tac-app`, not
  `.stagewrap` — the panel is a sibling of the board, not a child.

To sanity-check the generator after edits, `game.js` exports its internals when
`module` exists — invisible in a normal browser, since nothing defines it — so you
can hammer it headlessly:

```js
global.window = { matchMedia: null };          // game.js expects a DOM-ish global
var g = require('./game.js');
var squad = [{id:'op1',name:'VEX',maxHp:5,move:3,weaponId:'pistol',perks:[]}];
var s = g.generateLevel(5, squad, 1);
console.log(g.canSolve(s));   // must be true for every shipped level
```

Use `buildLevel` rather than `generateLevel` when you want to test composition
without paying for the solver — it returns `null` for a rejected layout, which is
normal and retried (the baseline rejection rate is around 0.75%). The same export
block also exposes `state()` and `redraw()`, which let a page define `var module =
{ exports: {} }` before loading `game.js` and then stage an exact board to
screenshot. That's how the debris preview, facing and requisition-card screenshots
were checked; it's a test seam, not something production can reach.

## Analytics

[`analytics.js`](analytics.js) wires the site and the game into PostHog
(project **JoeMartin.work**, in the Joe-OS org). Loaded with `defer` on both
`index.html` and `game.html`.

- **Cookieless.** `cookieless_mode: 'always'` — no cookies, no localStorage, no
  consent banner needed. Visitors are counted with a hash computed on PostHog's
  servers. This only works because "cookieless server hash mode" is also enabled
  in the project settings; without it PostHog silently drops the events. It also
  means `identify()` must never be called — a distinct ID would be personal data.
- **Autocapture is off**, so every event is deliberate. Session replay and
  exception capture are on.
- Site events: `$pageview`, `project_section_viewed` (how far down people get),
  `outbound_link_clicked`, `game_cta_clicked`, `email_clicked`.
- Game events: `game_started`, `sector_started` (includes `gen_attempts` and
  `gen_fallback`, so the solvability guarantee can be checked against real
  players), `sector_cleared`, `upgrade_taken`, `hostile_killed` / `operative_lost`
  with a `cause` (`void`, `blast`, `frag`, `shock`, `shrapnel`, `impact`,
  `gunfire`, `self_detonate`), `hostiles_drafted` (which requisition they took),
  and `squad_lost`.

Two things to keep in mind when editing:

- **Never report from the solver.** `canSolve` plays entire games on cloned
  states, so anything hooked into the rules layer must check `s === G` first
  (see `reportDeath`). Otherwise one page load emits thousands of fake kills.
- **Tracking must never break play.** Everything goes through `window.jmTrack`,
  which no-ops if PostHog is blocked by an extension.

Testing note: posthog-js deliberately opts out on bot/headless user agents, so a
plain headless-Chrome check will show no events being sent. Pass a normal
`--user-agent` to see real `200 /e/` ingestion responses. Also, in cookieless
mode `has_opted_out_capturing()` reports `true` even when capture is working —
it's an artifact of having no storage to record consent in, not a problem.

## Preview locally

Just open `index.html` in a browser. (Or run `python3 -m http.server` in this
folder and visit http://localhost:8000.)

## Publish

Commit and push to `main`. GitHub Pages redeploys automatically within a minute.

- `CNAME` binds the site to the custom domain `joemartin.work`. Don't delete it.
- Pages settings: repo **Settings → Pages → Deploy from a branch → `main` / root**.
