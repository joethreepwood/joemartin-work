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

Geometry: **feet are 4-way, eyes are 8-way.** Movement uses `DIRS` (orthogonal
steps, Manhattan `dist`) because 4-way pathing keeps the solver cheap and the
board readable. Aiming uses `AIM` (all eight directions) and Chebyshev `cheb`,
so a diagonal neighbour is one tile away rather than two — anything else makes
standing corner-to-corner with a hostile feel broken. Diagonal shots can't
squeeze through a corner gap: if both tiles flanking the step block sight, the
shot stops. Don't mix the two distance functions up; `cheb` is for range,
falloff, cover and "adjacent", `dist` is for walking.

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
- **Phones get compact content, portrait gets a docked sheet.** Two independent
  media queries, mirrored in JS by `isCompact()` and `isDocked()`. Compact
  (≤820px, any orientation) swaps the full dossier for `renderSheet()` — who,
  two figures, one warning, the confirm bar — because reflowing the desktop
  panel clipped the confirm bar off the bottom. Docked (≤820px *and* portrait)
  puts it in the flex flow at a fixed height so it reserves its own space and
  the board never reflows; in landscape height is the scarce axis, so it floats
  beside the board instead. `placeTip` measures against `.tac-app`, not
  `.stagewrap` — the panel is a sibling of the board, not a child.

To sanity-check the generator after edits, `game.js` exports its internals under
Node (invisible in browsers), so you can hammer it headlessly:

```js
var g = require('./game.js');
var squad = [{id:'op1',name:'VEX',maxHp:5,move:3,weaponId:'pistol'}];
var s = g.generateLevel(5, squad, 1);
console.log(g.canSolve(s));   // must be true for every shipped level
```

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
