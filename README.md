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
[`game.css`](game.css), [`game.js`](game.js). Section 12 of `index.html` links
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
  with a `cause` (`void`, `blast`, `frag`, `shock`, `impact`, `gunfire`,
  `self_detonate`), and `squad_lost`.

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
