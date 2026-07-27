/* ============================================================
   NULL SECTOR — a small turn-based cyberpunk tactics game.

   Design notes, for future me:
   - Enemies telegraph exactly what they will do (Into the Breach).
     Gunfire rolls to hit (Fallout), but the environment never rolls:
     shoving something into a pit, popping a barrel, the shock prod
     and grenades are all certainties. That is what makes every
     generated sector beatable even on a cold streak.
   - Every level is procedurally built, then *verified* by a solver
     that actually plays it with pessimistic dice. Levels that the
     solver can't win are thrown away and rebuilt.
   - Shooting is orthogonal only. It keeps the board readable and
     makes knockback lines obvious.
   - No dependencies, no build step. One IIFE, like carousel.js.
   ============================================================ */
(function () {
  'use strict';

  // ============================================================
  // 0. CONFIG
  // ============================================================
  var W = 8, H = 8;              // board is always 8x8 — fits any viewport, no scrolling
  var MIN_TILE = 34;             // below this we ask for a bigger window
  var MAX_TILE = 82;
  var TURN_BUDGET = 12;          // solver must win inside this many turns
  var GEN_TRIES = 40;            // rebuild attempts before falling back to a safe layout
  var MAX_OPS = 3;

  var C = {                      // palette — mirrors the site's .cy / .crt sections
    bg: '#0b0818', grid: '#1d1636', gridLit: '#2a2050',
    floor: '#120e24', wall: '#2b2350', wallTop: '#483c7a',
    pit: '#040309', water: '#0a4a63', waterLit: '#00e5ff',
    barrel: '#ff9a2d', console: '#8affc0', door: '#7a5cff',
    ally: '#00e5ff', enemy: '#ff2d95', mint: '#8affc0',
    dim: '#9a90c0', warn: '#ffcf3f', ink: '#08060f'
  };

  // ============================================================
  // 1. RNG — seeded for generation, live for combat. No Math.random.
  // ============================================================
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  var liveRng = mulberry32((Date.now() ^ 0x9e3779b9) >>> 0);

  // Dice. `live` rolls for real; `sim` is the verifier's pessimistic
  // stand-in: the player only counts shots they'd reasonably trust and
  // always rolls minimum, enemies always hit and always roll maximum.
  var DICE = {
    live: {
      hit: function (pct) { return liveRng() * 100 < pct; },
      dmg: function (lo, hi) { return lo + Math.floor(liveRng() * (hi - lo + 1)); }
    },
    sim: {
      hit: function (pct, side) { return side === 'enemy' ? true : pct >= 60; },
      dmg: function (lo, hi, side) { return side === 'enemy' ? hi : lo; }
    }
  };

  // ============================================================
  // 2. DATA
  // ============================================================
  var BASE_HP = 5, BASE_MOVE = 3;

  var WEAPONS = {
    pistol:  { id: 'pistol',  name: 'Sidearm',    range: 4, dmgMin: 2, dmgMax: 3, acc: 92,  falloff: 7,  kb: 1,
               blurb: 'All-rounder. Loses 7% accuracy per tile of distance.' },
    shotgun: { id: 'shotgun', name: 'Scattergun', range: 2, dmgMin: 3, dmgMax: 5, acc: 96,  falloff: 14, kb: 2,
               blurb: 'Short range, big shove. The best tool for putting something in the void.' },
    railgun: { id: 'railgun', name: 'Railgun',    range: 6, dmgMin: 2, dmgMax: 3, acc: 88,  falloff: 4,  kb: 0, pierce: true,
               blurb: 'Reaches across the board and pierces everything in the lane — including your own people.' },
    shock:   { id: 'shock',   name: 'Shock Prod', range: 1, dmgMin: 1, dmgMax: 2, acc: 100, falloff: 0,  kb: 1, stun: true, electrify: true,
               blurb: 'Adjacent only, but never misses. Stuns, and electrifies coolant the target is standing in.' }
  };
  var UPGRADE = { pistol: 'shotgun', shotgun: 'railgun' };  // railgun is the top of the chain
  var GRENADE = { name: 'Frag', range: 3, dmgMin: 2, dmgMax: 3, kb: 1 };

  var ENEMIES = {
    grunt:   { id: 'grunt',   name: 'Drone',    hp: 2, move: 3, cost: 2, unlock: 1,
               atk: { range: 1, dmgMin: 2, dmgMax: 2, acc: 100 } },
    shooter: { id: 'shooter', name: 'Sniper',   hp: 2, move: 2, cost: 3, unlock: 3,
               atk: { range: 4, dmgMin: 2, dmgMax: 2, acc: 80, falloff: 6 } },
    hacker:  { id: 'hacker',  name: 'Spider',   hp: 3, move: 3, cost: 3, unlock: 4,
               atk: { range: 1, dmgMin: 1, dmgMax: 1, acc: 100, disable: true } },
    bruiser: { id: 'bruiser', name: 'Enforcer', hp: 4, move: 2, cost: 4, unlock: 5, kbResist: 1,
               atk: { range: 1, dmgMin: 3, dmgMax: 3, acc: 100 } },
    bomber:  { id: 'bomber',  name: 'Sapper',   hp: 1, move: 3, cost: 3, unlock: 7,
               atk: { range: 0, dmgMin: 3, dmgMax: 3, acc: 100, blast: true } }
  };

  var BLAST_DMG = 3;   // barrels and sappers
  var SHOCK_DMG = 3;   // standing in electrified coolant
  var BONK_DMG = 1;    // slammed into a wall or another unit

  // ============================================================
  // 3. STATE + small helpers
  // ============================================================
  var G = null;        // live game state
  var uidN = 0;
  function uid(p) { return p + (++uidN); }

  // ---- analytics (see analytics.js) -------------------------------------
  // Two rules, both important:
  //  1. Never let it affect play — if PostHog is blocked, these are no-ops.
  //  2. Never report from the solver. `canSolve` plays entire games on cloned
  //     states, so anything keyed off the rules layer must check it is looking
  //     at the live state (`s === G`) before reporting.
  function track(name, props) {
    try { if (window.jmTrack) window.jmTrack(name, props); } catch (e) {}
  }
  function squadInfo() {
    return {
      squad_size: G.squad.length,
      weapons: G.squad.map(function (m) { return m.weaponId; }).sort().join(','),
      grenades: G.grenades
    };
  }
  function reportDeath(s, u, cause) {
    if (s !== G) return;                    // simulated game, not a real one
    track(u.side === 'enemy' ? 'hostile_killed' : 'operative_lost', {
      sector: G.level,
      turn: G.turn,
      unit: u.side === 'enemy' ? u.typeId : 'operative',
      cause: cause || 'gunfire'
    });
  }

  function tile(t) { return { t: t || 'floor', open: false, live: false, spent: false }; }
  function blankTiles() {
    var g = [], y, x;
    for (y = 0; y < H; y++) { g[y] = []; for (x = 0; x < W; x++) g[y][x] = tile('floor'); }
    return g;
  }

  function inB(x, y) { return x >= 0 && y >= 0 && x < W && y < H; }
  function at(s, x, y) { return s.tiles[y][x]; }
  // Walking distance — feet stay on the 4-way grid.
  function dist(ax, ay, bx, by) { return Math.abs(ax - bx) + Math.abs(ay - by); }
  // Sight distance. Eyes and guns work in 8 directions, so a diagonal
  // neighbour is one tile away, not two. Range, falloff and "adjacent" all
  // use this — otherwise standing corner-to-corner with something feels broken.
  function cheb(ax, ay, bx, by) { return Math.max(Math.abs(ax - bx), Math.abs(ay - by)); }

  function blocksMove(s, x, y) {
    var t = at(s, x, y).t;
    if (t === 'door') return !at(s, x, y).open;
    return t === 'wall' || t === 'barrel' || t === 'console' || t === 'pit';
  }
  function blocksSight(s, x, y) {
    var t = at(s, x, y).t;
    if (t === 'door') return !at(s, x, y).open;
    return t === 'wall' || t === 'barrel' || t === 'console';
  }
  function blocksKnock(s, x, y) {
    var t = at(s, x, y).t;
    if (t === 'door') return !at(s, x, y).open;
    return t === 'wall' || t === 'barrel' || t === 'console';
  }

  function unitAt(s, x, y) {
    for (var i = 0; i < s.units.length; i++) {
      var u = s.units[i];
      if (u.hp > 0 && u.x === x && u.y === y) return u;
    }
    return null;
  }
  function alive(s, side) {
    return s.units.filter(function (u) { return u.hp > 0 && (!side || u.side === side); });
  }
  function byId(s, id) {
    for (var i = 0; i < s.units.length; i++) if (s.units[i].id === id) return s.units[i];
    return null;
  }
  function passable(s, x, y) { return inB(x, y) && !blocksMove(s, x, y) && !unitAt(s, x, y); }
  function weaponOf(u) { return u.side === 'player' ? WEAPONS[u.weaponId] : u.atk; }

  // A lean clone for the solver: terrain + units + counters, no render/UI cruft.
  function cloneSim(s) {
    return {
      tiles: s.tiles.map(function (row) {
        return row.map(function (t) { return { t: t.t, open: t.open, live: t.live, spent: t.spent }; });
      }),
      units: s.units.map(function (u) {
        return {
          id: u.id, side: u.side, typeId: u.typeId, x: u.x, y: u.y, hp: u.hp, maxHp: u.maxHp,
          move: u.move, weaponId: u.weaponId, atk: u.atk, kbResist: u.kbResist,
          stunned: u.stunned, disabled: u.disabled, armed: u.armed,
          hasMoved: false, hasActed: false, intent: null
        };
      }),
      grenades: s.grenades,
      sim: true
    };
  }

  // ============================================================
  // 4. RULES — movement, lines of fire, damage, knockback, hazards
  // ============================================================

  // Reachable tiles within `steps`, walking orthogonally around units and terrain.
  // Returns { key -> {x,y,d,px,py} } so we can also rebuild the walked path.
  function reach(s, u, steps) {
    var out = {}, q = [{ x: u.x, y: u.y, d: 0 }], seen = {};
    out[u.y * 32 + u.x] = { x: u.x, y: u.y, d: 0, px: -1, py: -1 };
    seen[u.y * 32 + u.x] = true;
    while (q.length) {
      var c = q.shift();
      if (c.d >= steps) continue;
      var dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      for (var i = 0; i < 4; i++) {
        var nx = c.x + dirs[i][0], ny = c.y + dirs[i][1], k = ny * 32 + nx;
        if (!inB(nx, ny) || seen[k]) continue;
        if (blocksMove(s, nx, ny)) continue;
        var o = unitAt(s, nx, ny);
        if (o && o !== u) continue;
        seen[k] = true;
        out[k] = { x: nx, y: ny, d: c.d + 1, px: c.x, py: c.y };
        q.push({ x: nx, y: ny, d: c.d + 1 });
      }
    }
    return out;
  }
  function pathFrom(rmap, x, y) {
    var p = [], n = rmap[y * 32 + x];
    while (n && n.px >= 0) { p.unshift({ x: n.x, y: n.y }); n = rmap[n.py * 32 + n.px]; }
    return p;
  }

  // Terrain-only distance field from a point — used for enemy pathing so they
  // route around walls sensibly and deterministically.
  function distField(s, tx, ty) {
    var f = {}, q = [{ x: tx, y: ty, d: 0 }];
    f[ty * 32 + tx] = 0;
    while (q.length) {
      var c = q.shift(), dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      for (var i = 0; i < 4; i++) {
        var nx = c.x + dirs[i][0], ny = c.y + dirs[i][1], k = ny * 32 + nx;
        if (!inB(nx, ny) || f[k] !== undefined || blocksMove(s, nx, ny)) continue;
        f[k] = c.d + 1; q.push({ x: nx, y: ny, d: c.d + 1 });
      }
    }
    return f;
  }

  var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];                   // walking: four ways
  var AIM = [                                                      // aiming: all eight
    [0, -1], [1, -1], [1, 0], [1, 1],
    [0, 1], [-1, 1], [-1, 0], [-1, -1]
  ];

  // Walk one lane, orthogonal or diagonal. Units and shootable barrels are
  // targets; walls, consoles and shut doors stop the shot.
  function lineScan(s, fx, fy, dx, dy, range, pierce) {
    var hits = [], barrel = null;
    for (var i = 1; i <= range; i++) {
      var x = fx + dx * i, y = fy + dy * i;
      if (!inB(x, y)) break;
      // Diagonals can't squeeze through a corner gap: if both tiles flanking
      // the step are solid, the shot is blocked. Keeps walls feeling solid.
      if (dx && dy) {
        var ax = x - dx, ay = y, bx = x, by = y - dy;
        if (inB(ax, ay) && inB(bx, by) && blocksSight(s, ax, ay) && blocksSight(s, bx, by)) break;
      }
      if (at(s, x, y).t === 'barrel') { barrel = { x: x, y: y }; break; }
      if (blocksSight(s, x, y)) break;
      var u = unitAt(s, x, y);
      if (u) { hits.push(u); if (!pierce) break; }
    }
    return { hits: hits, barrel: barrel };
  }

  // Everything this shooter could hit from (fx,fy). One entry per lane.
  function shotsFrom(s, fx, fy, w) {
    var out = [];
    for (var d = 0; d < AIM.length; d++) {
      var sc = lineScan(s, fx, fy, AIM[d][0], AIM[d][1], w.range, w.pierce);
      if (sc.hits.length) out.push({ dir: d, kind: 'unit', hits: sc.hits, x: sc.hits[0].x, y: sc.hits[0].y });
      if (sc.barrel) out.push({ dir: d, kind: 'barrel', hits: [], x: sc.barrel.x, y: sc.barrel.y });
    }
    return out;
  }

  // Hugging real cover makes you harder to hit. For a straight lane that means
  // solid ground to either side; for a diagonal, the two tiles the shot had to
  // thread between. The map edge is not cover, and nothing shields you from
  // something standing right next to you.
  function coverPen(s, fx, fy, tx, ty) {
    if (cheb(fx, fy, tx, ty) <= 1) return 0;
    var dx = Math.sign(tx - fx), dy = Math.sign(ty - fy), flank;
    if (dx && dy) flank = [[-dx, 0], [0, -dy]];
    else if (dy) flank = [[-1, 0], [1, 0]];
    else flank = [[0, -1], [0, 1]];
    for (var i = 0; i < flank.length; i++) {
      var x = tx + flank[i][0], y = ty + flank[i][1];
      if (inB(x, y) && blocksSight(s, x, y)) return 12;
    }
    return 0;
  }
  function hitChance(s, w, fx, fy, tx, ty) {
    var d = cheb(fx, fy, tx, ty);
    var pct = w.acc - Math.max(0, d - 1) * (w.falloff || 0) - coverPen(s, fx, fy, tx, ty);
    return Math.max(40, Math.min(100, Math.round(pct)));
  }

  function plus(x, y) {
    return [{ x: x, y: y }, { x: x, y: y - 1 }, { x: x + 1, y: y }, { x: x, y: y + 1 }, { x: x - 1, y: y }]
      .filter(function (p) { return inB(p.x, p.y); });
  }

  // ---- mutations. `fx` is an optional effects sink so the renderer can
  // ---- replay what happened; the solver passes nothing and skips it all.
  function note(fx, o) { if (fx) fx.push(o); }

  function hurt(s, u, n, fxq, label) {
    if (!u || u.hp <= 0 || n <= 0) return;
    u.hp -= n;
    note(fxq, { kind: 'dmg', x: u.x, y: u.y, n: n, label: label, side: u.side });
    if (u.hp <= 0) {
      u.hp = 0;
      note(fxq, { kind: 'die', x: u.x, y: u.y, side: u.side });
      reportDeath(s, u, label ? label.toLowerCase() : 'gunfire');
    }
  }

  function explode(s, x, y, fxq, depth) {
    var t = at(s, x, y);
    if (t.t === 'barrel') t.t = 'floor';
    note(fxq, { kind: 'boom', x: x, y: y });
    var cells = plus(x, y), i;
    for (i = 0; i < cells.length; i++) {
      var u = unitAt(s, cells[i].x, cells[i].y);
      if (u) hurt(s, u, BLAST_DMG, fxq, 'BLAST');
    }
    // chain into neighbouring barrels
    if ((depth || 0) < 4) {
      for (i = 1; i < cells.length; i++) {
        if (at(s, cells[i].x, cells[i].y).t === 'barrel') explode(s, cells[i].x, cells[i].y, fxq, (depth || 0) + 1);
      }
    }
  }

  // Only pools that are actually live conduct. The console lights all of
  // them; the shock prod only lights the puddle it is standing in.
  function electrify(s, fxq) {
    var y, x, any = false;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var t = at(s, x, y);
      if (t.t !== 'water' || !t.live) continue;
      any = true;
      note(fxq, { kind: 'zap', x: x, y: y });
      var u = unitAt(s, x, y);
      if (u) hurt(s, u, SHOCK_DMG, fxq, 'SHOCK');
    }
    return any;
  }

  // Deterministic. This is the reliable way to kill things.
  function knockback(s, u, dx, dy, n, fxq) {
    n -= (u.kbResist || 0);
    for (var i = 0; i < n && u.hp > 0; i++) {
      var nx = u.x + dx, ny = u.y + dy;
      if (!inB(nx, ny) || blocksKnock(s, nx, ny)) {
        if (inB(nx, ny) && at(s, nx, ny).t === 'barrel') { hurt(s, u, BONK_DMG, fxq, 'IMPACT'); explode(s, nx, ny, fxq, 0); }
        else hurt(s, u, BONK_DMG, fxq, 'IMPACT');
        return;
      }
      var o = unitAt(s, nx, ny);
      if (o) { hurt(s, u, BONK_DMG, fxq, 'IMPACT'); hurt(s, o, BONK_DMG, fxq, 'IMPACT'); return; }
      u.x = nx; u.y = ny;
      note(fxq, { kind: 'shove', id: u.id, x: nx, y: ny });
      if (at(s, nx, ny).t === 'pit') {
        u.hp = 0;
        note(fxq, { kind: 'fall', x: nx, y: ny, side: u.side });
        reportDeath(s, u, 'void');
        return;
      }
    }
    if (u.hp > 0 && at(s, u.x, u.y).t === 'water' && at(s, u.x, u.y).live) hurt(s, u, SHOCK_DMG, fxq, 'SHOCK');
  }

  // Resolve one shot. Shared by the player, the enemies and the solver.
  function fire(s, u, w, target, dice, fxq) {
    var dx = Math.sign(target.x - u.x), dy = Math.sign(target.y - u.y);
    note(fxq, { kind: 'shot', fx: u.x, fy: u.y, tx: target.x, ty: target.y, side: u.side });

    if (target.kind === 'barrel') { explode(s, target.x, target.y, fxq, 0); return; }

    var list = target.hits && target.hits.length ? target.hits.slice() : [];
    var first = list[0];
    if (!first) return;

    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (v.hp <= 0) continue;
      var pct = hitChance(s, w, u.x, u.y, v.x, v.y);
      if (!dice.hit(pct, u.side)) { note(fxq, { kind: 'miss', x: v.x, y: v.y }); continue; }
      hurt(s, v, dice.dmg(w.dmgMin, w.dmgMax, u.side), fxq);
      if (v.hp > 0 && w.stun) { v.stunned = 1; note(fxq, { kind: 'stun', x: v.x, y: v.y }); }
      if (v.hp > 0 && w.electrify && at(s, v.x, v.y).t === 'water') { at(s, v.x, v.y).live = true; electrify(s, fxq); at(s, v.x, v.y).live = false; }
      if (v.hp > 0 && w.kb) knockback(s, v, dx, dy, w.kb, fxq);
    }
  }

  function throwGrenade(s, u, tx, ty, dice, fxq) {
    note(fxq, { kind: 'lob', fx: u.x, fy: u.y, tx: tx, ty: ty });
    note(fxq, { kind: 'boom', x: tx, y: ty });
    var cells = plus(tx, ty), i, victims = [];
    for (i = 0; i < cells.length; i++) {
      var v = unitAt(s, cells[i].x, cells[i].y);
      if (v) victims.push(v);
    }
    for (i = 0; i < victims.length; i++) {
      hurt(s, victims[i], dice.dmg(GRENADE.dmgMin, GRENADE.dmgMax, u.side), fxq, 'FRAG');
      if (victims[i].hp > 0) {
        var kx = Math.sign(victims[i].x - tx), ky = Math.sign(victims[i].y - ty);
        if (kx || ky) knockback(s, victims[i], kx, ky, GRENADE.kb, fxq);
      }
    }
    for (i = 0; i < cells.length; i++) {
      if (at(s, cells[i].x, cells[i].y).t === 'barrel') explode(s, cells[i].x, cells[i].y, fxq, 0);
    }
  }

  // Interacting with the two hackable things.
  function interact(s, u, x, y, fxq) {
    var t = at(s, x, y);
    if (t.t === 'console' && !t.spent) {
      t.spent = true;
      var y2, x2;
      for (y2 = 0; y2 < H; y2++) for (x2 = 0; x2 < W; x2++) if (at(s, x2, y2).t === 'water') at(s, x2, y2).live = true;
      electrify(s, fxq);
      for (y2 = 0; y2 < H; y2++) for (x2 = 0; x2 < W; x2++) if (at(s, x2, y2).t === 'water') at(s, x2, y2).live = false;
      return 'COOLANT ELECTRIFIED';
    }
    if (t.t === 'door') {
      if (!t.open && unitAt(s, x, y)) return null;
      t.open = !t.open;
      note(fxq, { kind: 'door', x: x, y: y });
      return t.open ? 'BLAST DOOR OPEN' : 'BLAST DOOR SEALED';
    }
    return null;
  }
  function interactables(s, u) {
    var out = [];
    for (var i = 0; i < AIM.length; i++) {                 // diagonals count as beside
      var x = u.x + AIM[i][0], y = u.y + AIM[i][1];
      if (!inB(x, y)) continue;
      var t = at(s, x, y);
      if (t.t === 'console' && !t.spent) out.push({ x: x, y: y, kind: 'console' });
      if (t.t === 'door') out.push({ x: x, y: y, kind: 'door' });
    }
    return out;
  }

  // ============================================================
  // 5. ENEMY AI — one pure, fully ordered function, so the telegraph
  //    is always exactly what is about to happen.
  // ============================================================
  function pickTarget(s, e) {
    var ops = alive(s, 'player');
    if (!ops.length) return null;
    var f = distField(s, e.x, e.y), best = null, bestKey = null;
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i], d = Infinity;
      // distance to any tile beside them (they occupy their own tile)
      for (var k = 0; k < 4; k++) {
        var v = f[(o.y + DIRS[k][1]) * 32 + (o.x + DIRS[k][0])];
        if (v !== undefined && v < d) d = v;
      }
      if (d === Infinity) d = 900 + dist(e.x, e.y, o.x, o.y);
      var key = [d, o.hp, o.id].join('|');
      if (!bestKey || key < bestKey) { bestKey = key; best = o; }
    }
    return best;
  }

  function computeIntents(s) {
    var es = alive(s, 'enemy');
    es.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    for (var i = 0; i < es.length; i++) {
      var e = es[i];
      e.intent = null;
      if (e.stunned) { e.intent = { kind: 'stunned', path: [] }; continue; }

      // An armed sapper does one thing: it goes off.
      if (e.typeId === 'bomber' && e.armed) {
        e.intent = { kind: 'detonate', path: [], cells: plus(e.x, e.y), dmg: e.atk.dmgMax };
        continue;
      }
      var tgt = pickTarget(s, e);
      if (!tgt) { e.intent = { kind: 'idle', path: [] }; continue; }

      var rm = reach(s, e, e.move), keys = Object.keys(rm), j;
      var opts = [];
      for (j = 0; e.atk.range > 0 && j < keys.length; j++) {   // sappers never shoot
        var c = rm[keys[j]], canHit = false;
        for (var d = 0; d < AIM.length; d++) {
          var ln = lineScan(s, c.x, c.y, AIM[d][0], AIM[d][1], e.atk.range, false);
          if (ln.hits.length && ln.hits[0].id === tgt.id) { canHit = true; break; }
        }
        if (canHit) opts.push(c);
      }
      if (opts.length) {
        // nearest firing position; ties broken by board order so it never flickers
        opts.sort(function (a, b) { return (a.d - b.d) || (a.y - b.y) || (a.x - b.x); });
        var st = opts[0];
        e.intent = {
          kind: 'attack', path: pathFrom(rm, st.x, st.y), dest: { x: st.x, y: st.y },
          targetId: tgt.id, tx: tgt.x, ty: tgt.y,
          pct: hitChance(s, e.atk, st.x, st.y, tgt.x, tgt.y),
          dmg: e.atk.dmgMax, cells: [{ x: tgt.x, y: tgt.y }],
          disable: !!e.atk.disable
        };
        continue;
      }

      // Can't reach — close the distance along the shortest route.
      var f = distField(s, tgt.x, tgt.y), bestC = null, bestK = null;
      for (j = 0; j < keys.length; j++) {
        var cc = rm[keys[j]], fv = f[cc.y * 32 + cc.x];
        if (fv === undefined) fv = 900 + dist(cc.x, cc.y, tgt.x, tgt.y);
        var kk = [fv, cc.d, cc.y, cc.x].join('|');
        if (!bestK || kk < bestK) { bestK = kk; bestC = cc; }
      }
      if (bestC && (bestC.x !== e.x || bestC.y !== e.y)) {
        var arms = e.typeId === 'bomber' && cheb(bestC.x, bestC.y, tgt.x, tgt.y) === 1;
        e.intent = { kind: 'move', path: pathFrom(rm, bestC.x, bestC.y), dest: { x: bestC.x, y: bestC.y }, arms: arms };
      } else {
        e.intent = { kind: 'idle', path: [], arms: e.typeId === 'bomber' && cheb(e.x, e.y, tgt.x, tgt.y) === 1 };
      }
    }
  }

  // Execute the telegraphed intents. Same code path in play and in the solver.
  function resolveEnemies(s, dice, fxq) {
    var es = alive(s, 'enemy');
    es.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    for (var i = 0; i < es.length; i++) {
      var e = es[i];
      if (e.hp <= 0) continue;
      if (e.stunned) { e.stunned = 0; continue; }
      var it = e.intent;
      if (!it) continue;

      if (it.kind === 'detonate') {
        note(fxq, { kind: 'boom', x: e.x, y: e.y });
        var cells = plus(e.x, e.y);
        for (var c = 0; c < cells.length; c++) {
          var v = unitAt(s, cells[c].x, cells[c].y);
          if (v && v !== e) hurt(s, v, e.atk.dmgMax, fxq, 'BLAST');
        }
        for (c = 0; c < cells.length; c++) {
          if (at(s, cells[c].x, cells[c].y).t === 'barrel') explode(s, cells[c].x, cells[c].y, fxq, 0);
        }
        e.hp = 0;
        note(fxq, { kind: 'die', x: e.x, y: e.y, side: 'enemy' });
        reportDeath(s, e, 'self_detonate');
        continue;
      }

      // walk (re-checking each step: the board may have changed)
      if (it.path && it.path.length) {
        for (var p = 0; p < it.path.length; p++) {
          var st = it.path[p];
          if (!passable(s, st.x, st.y)) break;
          e.x = st.x; e.y = st.y;
          note(fxq, { kind: 'step', id: e.id, x: st.x, y: st.y });
          if (at(s, st.x, st.y).t === 'water' && at(s, st.x, st.y).live) hurt(s, e, SHOCK_DMG, fxq, 'SHOCK');
          if (e.hp <= 0) break;
        }
      }
      if (e.hp <= 0) continue;

      if (it.kind === 'attack') {
        var tgt = byId(s, it.targetId);
        // If the intended target is gone, re-derive with the same rule the
        // telegraph used — predictable rather than arbitrary.
        if (!tgt || tgt.hp <= 0) tgt = pickTarget(s, e);
        if (tgt && tgt.hp > 0) {
          for (var d = 0; d < AIM.length; d++) {
            var ln = lineScan(s, e.x, e.y, AIM[d][0], AIM[d][1], e.atk.range, false);
            if (ln.hits.length && ln.hits[0].id === tgt.id) {
              fire(s, e, e.atk, { kind: 'unit', x: tgt.x, y: tgt.y, hits: [tgt] }, dice, fxq);
              if (e.atk.disable && tgt.hp > 0) { tgt.disabled = 1; note(fxq, { kind: 'hack', x: tgt.x, y: tgt.y }); }
              break;
            }
          }
        }
      }
      if (it.arms) { e.armed = true; note(fxq, { kind: 'arm', x: e.x, y: e.y }); }
    }
  }

  // ============================================================
  // 6. GENERATION — build constructively, inside a budget, and always
  //    plant at least one dice-free way to kill something.
  // ============================================================
  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

  function connectAll(s, must) {
    // Flood from the first required cell; knock down walls until every
    // required cell is in the same region.
    for (var guard = 0; guard < 60; guard++) {
      var seen = {}, q = [must[0]], k0 = must[0].y * 32 + must[0].x;
      seen[k0] = true;
      while (q.length) {
        var c = q.shift();
        for (var i = 0; i < 4; i++) {
          var nx = c.x + DIRS[i][0], ny = c.y + DIRS[i][1], k = ny * 32 + nx;
          if (!inB(nx, ny) || seen[k] || blocksMove(s, nx, ny)) continue;
          seen[k] = true; q.push({ x: nx, y: ny });
        }
      }
      var bad = null;
      for (var m = 0; m < must.length; m++) if (!seen[must[m].y * 32 + must[m].x]) { bad = must[m]; break; }
      if (!bad) return true;
      // carve a straight corridor from the orphan back toward the anchor
      var cx = bad.x, cy = bad.y, a = must[0], steps = 0;
      while ((cx !== a.x || cy !== a.y) && steps++ < 20) {
        if (cx !== a.x) cx += Math.sign(a.x - cx); else cy += Math.sign(a.y - cy);
        var t = at(s, cx, cy);
        if (t.t === 'wall' || t.t === 'pit' || t.t === 'barrel' || t.t === 'console') s.tiles[cy][cx] = tile('floor');
        if (t.t === 'door') t.open = true;
      }
    }
    return true;
  }

  function buildLevel(level, squad, grenades, seed) {
    var rng = mulberry32(seed >>> 0);
    var s = { tiles: blankTiles(), units: [], grenades: grenades, seed: seed, level: level };
    var i, x, y, tries;

    // --- terrain: a few wall clusters, kept out of the deploy band ---
    var nWalls = 2 + Math.floor(rng() * 3) + Math.min(3, Math.floor(level / 3));
    for (i = 0; i < nWalls; i++) {
      var wx = 1 + Math.floor(rng() * (W - 2)), wy = 1 + Math.floor(rng() * (H - 3));
      var len = 1 + Math.floor(rng() * 3), vert = rng() < 0.5;
      for (var l = 0; l < len; l++) {
        var px = wx + (vert ? 0 : l), py = wy + (vert ? l : 0);
        if (inB(px, py) && py < H - 2) s.tiles[py][px] = tile('wall');
      }
    }

    // --- deploy the squad along the bottom ---
    var slots = [];
    for (x = 0; x < W; x++) { slots.push({ x: x, y: H - 1 }); slots.push({ x: x, y: H - 2 }); }
    for (i = slots.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)), t2 = slots[i]; slots[i] = slots[j]; slots[j] = t2; }
    for (i = 0; i < squad.length; i++) {
      var sl = slots[i];
      s.tiles[sl.y][sl.x] = tile('floor');
      s.units.push({
        id: squad[i].id, side: 'player', typeId: 'op', name: squad[i].name,
        x: sl.x, y: sl.y, hp: squad[i].maxHp, maxHp: squad[i].maxHp,
        move: squad[i].move, weaponId: squad[i].weaponId,
        hasMoved: false, hasActed: false, stunned: 0, disabled: 0, intent: null
      });
    }

    // --- enemies, drawn against a power budget so difficulty tracks your squad ---
    var pool = Object.keys(ENEMIES).filter(function (k) { return ENEMIES[k].unlock <= level; });
    var budget = 1.5 + level * 1.7 + squad.length * 0.5;
    var cap = Math.min(6, 2 + Math.floor((level + 1) / 2));
    var placed = 0;
    for (tries = 0; tries < 200 && placed < cap && budget > 1.5; tries++) {
      var def = ENEMIES[pick(rng, pool)];
      if (def.cost > budget + 1) continue;
      x = Math.floor(rng() * W); y = Math.floor(rng() * Math.max(2, Math.min(4, H - 3)));
      if (!inB(x, y) || blocksMove(s, x, y) || unitAt(s, x, y)) continue;
      var tooClose = alive(s, 'player').some(function (o) { return cheb(o.x, o.y, x, y) <= 2; });
      if (tooClose) continue;
      s.units.push({
        id: uid('e'), side: 'enemy', typeId: def.id, x: x, y: y, hp: def.hp, maxHp: def.hp,
        move: def.move, atk: def.atk, kbResist: def.kbResist || 0,
        hasMoved: false, hasActed: false, stunned: 0, armed: false, intent: null
      });
      budget -= def.cost; placed++;
    }
    if (!placed) return null;

    // --- hazards + interactables ---
    var enemies = alive(s, 'enemy');
    var nPits = 1 + Math.floor(rng() * 2), nBarrels = 1 + Math.floor(rng() * 2);
    function freeSpot(minY, maxY) {
      for (var a = 0; a < 60; a++) {
        var fx2 = Math.floor(rng() * W), fy2 = minY + Math.floor(rng() * (maxY - minY + 1));
        if (!inB(fx2, fy2) || unitAt(s, fx2, fy2) || at(s, fx2, fy2).t !== 'floor') continue;
        if (fy2 >= H - 2) continue;               // keep the deploy band clear
        return { x: fx2, y: fy2 };
      }
      return null;
    }
    for (i = 0; i < nPits; i++) { var p = freeSpot(1, H - 3); if (p) s.tiles[p.y][p.x] = tile('pit'); }
    for (i = 0; i < nBarrels; i++) { var b = freeSpot(1, H - 3); if (b) s.tiles[b.y][b.x] = tile('barrel'); }

    if (level >= 3 && rng() < 0.8) {              // coolant pool + its console
      var wp = freeSpot(1, H - 3);
      if (wp) {
        s.tiles[wp.y][wp.x] = tile('water');
        for (i = 0; i < 3; i++) {
          var d2 = DIRS[Math.floor(rng() * 4)], nx2 = wp.x + d2[0], ny2 = wp.y + d2[1];
          if (inB(nx2, ny2) && ny2 < H - 2 && at(s, nx2, ny2).t === 'floor' && !unitAt(s, nx2, ny2)) s.tiles[ny2][nx2] = tile('water');
        }
        var cp = freeSpot(2, H - 3);
        if (cp) s.tiles[cp.y][cp.x] = tile('console');
      }
    }
    if (level >= 4 && rng() < 0.6) {              // a blast door in a wall run
      var dp = freeSpot(1, H - 3);
      if (dp) { s.tiles[dp.y][dp.x] = tile('door'); s.tiles[dp.y][dp.x].open = false; }
    }

    // --- guarantee a dice-free kill line: put a pit behind an enemy, with a
    //     clear lane on the opposite side for someone to shove from. ---
    var lever = false;
    for (i = 0; i < enemies.length && !lever; i++) {
      var e = enemies[i];
      for (var d3 = 0; d3 < AIM.length && !lever; d3++) {
        var px2 = e.x + AIM[d3][0], py2 = e.y + AIM[d3][1];          // where the pit goes
        var bx = e.x - AIM[d3][0], by = e.y - AIM[d3][1];            // where the shooter stands
        if (!inB(px2, py2) || !inB(bx, by)) continue;
        if (unitAt(s, px2, py2) || unitAt(s, bx, by)) continue;
        if (at(s, px2, py2).t === 'wall' || at(s, px2, py2).t === 'floor' || at(s, px2, py2).t === 'pit') {
          if (at(s, bx, by).t !== 'floor' && at(s, bx, by).t !== 'water') continue;
          s.tiles[py2][px2] = tile('pit');
          lever = true;
        }
      }
    }
    if (!lever) return null;

    // --- connectivity: squad and every enemy must share one region ---
    var must = alive(s, 'player').map(function (o) { return { x: o.x, y: o.y }; })
      .concat(enemies.map(function (o) { return { x: o.x, y: o.y }; }));
    connectAll(s, must);

    computeIntents(s);
    return s;
  }

  // ============================================================
  // 7. VERIFIER — actually play the level with pessimistic dice.
  //    The solver is deliberately dumber than a person: it moves then
  //    acts once, in a fixed order, choosing greedily. So if it can win,
  //    a human certainly can.
  // ============================================================

  // What would this shot achieve? Analytic, no cloning — and deliberately
  // conservative (it ignores explosion chains, which only ever help).
  function scoreShot(s, u, w, fx, fy, shot) {
    var sc = 0, i;
    if (shot.kind === 'barrel') {
      var cells = plus(shot.x, shot.y);
      for (i = 0; i < cells.length; i++) {
        var v = unitAt(s, cells[i].x, cells[i].y);
        if (!v) continue;
        var lethal = v.hp <= BLAST_DMG;
        sc += (v.side === 'enemy' ? (lethal ? 100 : 30) : (lethal ? -400 : -60));
      }
      return sc;
    }
    for (i = 0; i < shot.hits.length; i++) {
      var t = shot.hits[i];
      var pct = hitChance(s, w, fx, fy, t.x, t.y);
      var trust = pct >= 60;                       // the solver won't bank on long shots
      var dmg = trust ? w.dmgMin : 0;
      var mine = t.side === 'enemy' ? 1 : -1;

      // knockback is deterministic, so price it exactly
      var kbKill = false, kbDmg = 0;
      if (w.kb) {
        var dx = Math.sign(t.x - fx), dy = Math.sign(t.y - fy), cx = t.x, cy = t.y;
        var n = w.kb - (t.kbResist || 0);
        for (var k = 0; k < n; k++) {
          var nx = cx + dx, ny = cy + dy;
          if (!inB(nx, ny) || blocksKnock(s, nx, ny)) { kbDmg = BONK_DMG; break; }
          if (unitAt(s, nx, ny)) { kbDmg = BONK_DMG; break; }
          cx = nx; cy = ny;
          if (at(s, cx, cy).t === 'pit') { kbKill = true; break; }
        }
      }
      if (kbKill && trust) { sc += mine * 140; continue; }      // a certain kill, dice or not
      if (kbKill && !trust) { sc += mine * 20; continue; }
      var total = dmg + (trust ? kbDmg : 0);
      if (total >= t.hp && trust) sc += mine * 100;
      else sc += mine * total * 12;
      if (t.side === 'player') sc -= 40;                        // never casually clip an ally
    }
    return sc;
  }

  function threatCells(s) {
    var set = {};
    var es = alive(s, 'enemy');
    for (var i = 0; i < es.length; i++) {
      var it = es[i].intent;
      if (!it || !it.cells) continue;
      for (var c = 0; c < it.cells.length; c++) set[it.cells[c].y * 32 + it.cells[c].x] = true;
    }
    return set;
  }

  // Best (move, action) for one unit. Used by the solver only.
  function bestPlay(s, u) {
    if (u.disabled) return { score: 0, mx: u.x, my: u.y, act: null };
    var rm = reach(s, u, u.move), keys = Object.keys(rm);
    var w = WEAPONS[u.weaponId], threat = threatCells(s);
    var best = { score: -1e9 };

    // Only ever consider frag targets on or beside a hostile, and work out
    // the coolant situation once — checking all 64 tiles per candidate tile
    // made generation take seconds.
    var es = alive(s, 'enemy'), gCand = [], gSeen = {}, i, k;
    for (i = 0; i < es.length; i++) {
      var near = plus(es[i].x, es[i].y);
      for (k = 0; k < near.length; k++) {
        var gk = near[k].y * 32 + near[k].x;
        if (!gSeen[gk]) { gSeen[gk] = true; gCand.push(near[k]); }
      }
    }
    var liveWater = 0;
    for (var wy0 = 0; wy0 < H; wy0++) for (var wx0 = 0; wx0 < W; wx0++) {
      if (at(s, wx0, wy0).t !== 'water') continue;
      var wu = unitAt(s, wx0, wy0);
      if (!wu) continue;
      liveWater += wu.side === 'enemy' ? (wu.hp <= SHOCK_DMG ? 110 : 30) : -300;
    }

    for (i = 0; i < keys.length; i++) {
      var c = rm[keys[i]];
      var base = -c.d * 0.4;                        // mild preference for staying put
      if (threat[c.y * 32 + c.x]) base -= 45;       // don't stand where you're about to be shot
      if (at(s, c.x, c.y).t === 'water') base -= 4;

      var shots = shotsFrom(s, c.x, c.y, w);
      for (k = 0; k < shots.length; k++) {
        var sv = base + scoreShot(s, u, w, c.x, c.y, shots[k]);
        if (sv > best.score) best = { score: sv, mx: c.x, my: c.y, act: { kind: 'shot', shot: shots[k] } };
      }
      // frag: reliable, so worth spending when it kills
      if (s.grenades > 0) {
        for (var g = 0; g < gCand.length; g++) {
          var gt = gCand[g];
          if (cheb(c.x, c.y, gt.x, gt.y) > GRENADE.range) continue;
          var cells = plus(gt.x, gt.y), gs = base - 8, hitAny = false;
          for (var q = 0; q < cells.length; q++) {
            var v = unitAt(s, cells[q].x, cells[q].y);
            if (!v) continue;
            hitAny = true;
            var lethal = v.hp <= GRENADE.dmgMin;
            gs += v.side === 'enemy' ? (lethal ? 95 : 26) : (lethal ? -400 : -70);
          }
          if (hitAny && gs > best.score) best = { score: gs, mx: c.x, my: c.y, act: { kind: 'grenade', x: gt.x, y: gt.y } };
        }
      }
      // console: only when it actually catches somebody
      if (liveWater !== 0) {
        var ints = interactables(s, { x: c.x, y: c.y });
        for (k = 0; k < ints.length; k++) {
          if (ints[k].kind !== 'console') continue;
          var zs = base + liveWater;
          if (zs > best.score) best = { score: zs, mx: c.x, my: c.y, act: { kind: 'interact', x: ints[k].x, y: ints[k].y } };
        }
      }
      if (base > best.score) best = { score: base, mx: c.x, my: c.y, act: null };
    }
    return best.score === -1e9 ? null : best;
  }

  function applyPlay(s, u, play, dice, fxq) {
    if (!play) return;
    if (play.mx !== u.x || play.my !== u.y) {
      var rm = reach(s, u, u.move), path = pathFrom(rm, play.mx, play.my);
      u.x = play.mx; u.y = play.my; u.hasMoved = true;
      if (fxq) note(fxq, { kind: 'walk', id: u.id, path: path });
      if (at(s, u.x, u.y).t === 'water' && at(s, u.x, u.y).live) hurt(s, u, SHOCK_DMG, fxq, 'SHOCK');
    }
    if (!play.act || u.hp <= 0) return;
    if (play.act.kind === 'shot') fire(s, u, WEAPONS[u.weaponId], play.act.shot, dice, fxq);
    else if (play.act.kind === 'grenade') { throwGrenade(s, u, play.act.x, play.act.y, dice, fxq); s.grenades--; }
    else if (play.act.kind === 'interact') interact(s, u, play.act.x, play.act.y, fxq);
    u.hasActed = true;
  }

  function canSolve(state) {
    var s = cloneSim(state), turn;
    for (turn = 1; turn <= TURN_BUDGET; turn++) {
      if (!alive(s, 'enemy').length) return true;
      computeIntents(s);
      var ops = alive(s, 'player');
      ops.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
      for (var i = 0; i < ops.length; i++) {
        if (ops[i].hp <= 0) continue;
        applyPlay(s, ops[i], bestPlay(s, ops[i]), DICE.sim, null);
      }
      if (!alive(s, 'enemy').length) return true;
      resolveEnemies(s, DICE.sim, null);
      if (!alive(s, 'player').length) return false;
      alive(s, 'player').forEach(function (o) { o.disabled = 0; });
    }
    return !alive(s, 'enemy').length;
  }

  // ============================================================
  // 8. PIPELINE — only ever hand back a level the solver has beaten.
  // ============================================================
  function safeLevel(level, squad, grenades) {
    // The floor: open room, a couple of drones, each with a pit at its back.
    var s = { tiles: blankTiles(), units: [], grenades: grenades, seed: 0, level: level };
    var n = Math.min(3, 1 + Math.ceil(level / 4)), i;
    for (i = 0; i < squad.length; i++) {
      s.units.push({
        id: squad[i].id, side: 'player', typeId: 'op', name: squad[i].name,
        x: 2 + i * 2, y: H - 1, hp: squad[i].maxHp, maxHp: squad[i].maxHp,
        move: squad[i].move, weaponId: squad[i].weaponId,
        hasMoved: false, hasActed: false, stunned: 0, disabled: 0, intent: null
      });
    }
    for (i = 0; i < n; i++) {
      var ex = 1 + i * 3, ey = 2;
      s.units.push({
        id: uid('e'), side: 'enemy', typeId: 'grunt', x: ex, y: ey,
        hp: ENEMIES.grunt.hp, maxHp: ENEMIES.grunt.hp, move: ENEMIES.grunt.move,
        atk: ENEMIES.grunt.atk, kbResist: 0,
        hasMoved: false, hasActed: false, stunned: 0, armed: false, intent: null
      });
      if (ey - 1 >= 0) s.tiles[ey - 1][ex] = tile('pit');
    }
    computeIntents(s);
    return s;
  }

  function generateLevel(level, squad, grenades) {
    var t0 = Date.now();
    for (var a = 0; a < GEN_TRIES; a++) {
      var seed = (Math.floor(liveRng() * 0xffffffff) ^ (level * 2654435761)) >>> 0;
      var s = buildLevel(level, squad, grenades, seed);
      if (!s) continue;
      if (!alive(s, 'player').length || !alive(s, 'enemy').length) continue;
      if (canSolve(s)) {
        s.gen = { attempts: a + 1, fallback: false, ms: Date.now() - t0 };
        return s;
      }
    }
    // Should not happen in practice — worth knowing if it ever does in the wild.
    var f = safeLevel(level, squad, grenades);
    f.gen = { attempts: GEN_TRIES, fallback: true, ms: Date.now() - t0 };
    return f;
  }

  // ============================================================
  // 9. RENDER — everything is drawn from state, every time.
  // ============================================================
  var cv, ctx, app, elSector, elTurn, elSquad, elMsg, elActs, elEnd, elOverlay, elPanel, elLive, wrap, elTip, elHelp, elFoes;

  function neon(color, blur) { ctx.shadowColor = color; ctx.shadowBlur = blur || 0; }
  // Canvas type. Heavy grotesque for labels, mono for figures — bigger than
  // it used to be, because everything here is meant to be read at a glance.
  function fontHeavy(mult) { ctx.font = Math.round(G.tile * mult) + 'px "Archivo Black","Arial Black",sans-serif'; }
  function fontData(mult) { ctx.font = '700 ' + Math.round(G.tile * mult) + 'px "IBM Plex Mono",monospace'; }
  function noNeon() { ctx.shadowBlur = 0; }
  function cx(x) { return x * G.tile + G.tile / 2; }
  function cy(y) { return y * G.tile + G.tile / 2; }

  function layout() {
    if (!G) return;
    var availW = wrap.clientWidth, availH = wrap.clientHeight;
    var t = Math.floor(Math.min(availW / W, availH / H));
    var tiny = t < MIN_TILE;
    app.classList.toggle('is-tiny', tiny);
    t = Math.max(MIN_TILE, Math.min(MAX_TILE, t));
    G.tile = t;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.style.width = (t * W) + 'px'; cv.style.height = (t * H) + 'px';
    cv.width = Math.round(t * W * dpr); cv.height = Math.round(t * H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function drawTile(x, y) {
    var T = G.tile, t = at(G, x, y), px = x * T, py = y * T;

    ctx.fillStyle = C.floor;
    ctx.fillRect(px, py, T, T);
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    ctx.strokeRect(px + .5, py + .5, T - 1, T - 1);

    if (t.t === 'wall') {
      ctx.fillStyle = C.wall; ctx.fillRect(px + 2, py + 2, T - 4, T - 4);
      ctx.fillStyle = C.wallTop; ctx.fillRect(px + 2, py + 2, T - 4, Math.max(3, T * .16));
      ctx.strokeStyle = '#5a4a95'; ctx.lineWidth = 1;
      ctx.strokeRect(px + 2.5, py + 2.5, T - 5, T - 5);
    } else if (t.t === 'pit') {
      ctx.fillStyle = C.pit; ctx.fillRect(px + 1, py + 1, T - 2, T - 2);
      ctx.strokeStyle = 'rgba(255,45,149,.5)'; ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(px + 3, py + 3, T - 6, T - 6);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,45,149,.34)';
      fontHeavy(.20);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('VOID', cx(x), cy(y));
    } else if (t.t === 'water') {
      ctx.fillStyle = t.live ? 'rgba(0,229,255,.55)' : 'rgba(10,74,99,.75)';
      ctx.fillRect(px + 1, py + 1, T - 2, T - 2);
      ctx.strokeStyle = t.live ? C.waterLit : 'rgba(0,229,255,.4)';
      ctx.lineWidth = t.live ? 2 : 1;
      if (t.live) neon(C.waterLit, 12);
      for (var i = 1; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(px + T * .18, py + T * (i * .3 + .1));
        ctx.quadraticCurveTo(px + T * .5, py + T * (i * .3 - .02), px + T * .82, py + T * (i * .3 + .1));
        ctx.stroke();
      }
      noNeon();
    } else if (t.t === 'barrel') {
      neon(C.barrel, 14);
      ctx.fillStyle = 'rgba(255,154,45,.22)';
      ctx.beginPath();
      ctx.arc(cx(x), cy(y), T * .32, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = C.barrel; ctx.lineWidth = 2; ctx.stroke();
      noNeon();
      ctx.fillStyle = C.barrel;
      fontHeavy(.34);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('!', cx(x), cy(y) + 1);
    } else if (t.t === 'console') {
      var col = t.spent ? '#4a4468' : C.console;
      if (!t.spent) neon(col, 12);
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.strokeRect(px + T * .24, py + T * .24, T * .52, T * .52);
      ctx.fillStyle = t.spent ? 'rgba(74,68,104,.2)' : 'rgba(138,255,192,.14)';
      ctx.fillRect(px + T * .24, py + T * .24, T * .52, T * .52);
      noNeon();
      if (!t.spent) {
        ctx.fillStyle = col;
        fontData(.26);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('///', cx(x), cy(y));
      }
    } else if (t.t === 'door') {
      neon(C.door, 10);
      ctx.strokeStyle = C.door; ctx.lineWidth = 2;
      if (t.open) {
        ctx.beginPath();
        ctx.moveTo(px + T * .12, py + T * .5); ctx.lineTo(px + T * .3, py + T * .5);
        ctx.moveTo(px + T * .7, py + T * .5); ctx.lineTo(px + T * .88, py + T * .5);
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(122,92,255,.28)';
        ctx.fillRect(px + 3, py + T * .3, T - 6, T * .4);
        ctx.strokeRect(px + 3.5, py + T * .3, T - 7, T * .4);
      }
      noNeon();
    }
  }

  function fillCell(x, y, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x * G.tile + 1, y * G.tile + 1, G.tile - 2, G.tile - 2);
  }
  function ringCell(x, y, color, wid) {
    ctx.strokeStyle = color; ctx.lineWidth = wid || 2;
    ctx.strokeRect(x * G.tile + 2, y * G.tile + 2, G.tile - 4, G.tile - 4);
  }

  function drawHighlights() {
    var u = selected(), T = G.tile, k;

    // where the enemies are about to strike
    var es = alive(G, 'enemy');
    for (var i = 0; i < es.length; i++) {
      var it = es[i].intent;
      if (!it || !it.cells) continue;
      for (k = 0; k < it.cells.length; k++) {
        var c = it.cells[k];
        if (!inB(c.x, c.y)) continue;
        fillCell(c.x, c.y, 'rgba(255,45,149,.14)');
        ctx.save();
        ctx.strokeStyle = 'rgba(255,45,149,.34)'; ctx.lineWidth = 1;
        ctx.beginPath();
        for (var h = -T; h < T; h += 7) {
          ctx.moveTo(c.x * T + h, c.y * T);
          ctx.lineTo(c.x * T + h + T, c.y * T + T);
        }
        ctx.save(); ctx.beginPath();
        ctx.rect(c.x * T + 1, c.y * T + 1, T - 2, T - 2); ctx.clip();
        ctx.stroke(); ctx.restore(); ctx.restore();
      }
    }

    if (!u || G.phase !== 'PLAYER') return;

    if (G.ui.mode === 'GRENADE') {
      for (var gy = 0; gy < H; gy++) for (var gx = 0; gx < W; gx++) {
        if (cheb(u.x, u.y, gx, gy) <= GRENADE.range) fillCell(gx, gy, 'rgba(255,207,63,.10)');
      }
      var hv = G.ui.hover;
      if (hv && cheb(u.x, u.y, hv.x, hv.y) <= GRENADE.range) {
        var cells = plus(hv.x, hv.y);
        for (k = 0; k < cells.length; k++) { fillCell(cells[k].x, cells[k].y, 'rgba(255,207,63,.3)'); ringCell(cells[k].x, cells[k].y, C.warn, 2); }
      }
      return;
    }

    // movement range
    if (!u.hasMoved && !u.disabled) {
      var rm = reach(G, u, u.move), keys = Object.keys(rm);
      for (k = 0; k < keys.length; k++) {
        var c2 = rm[keys[k]];
        if (c2.x === u.x && c2.y === u.y) continue;
        fillCell(c2.x, c2.y, 'rgba(0,229,255,.13)');
        ringCell(c2.x, c2.y, 'rgba(0,229,255,.38)', 2);
      }
    }
    // firing lanes + targets
    if (!u.hasActed && !u.disabled) {
      var w = WEAPONS[u.weaponId];
      for (var d = 0; d < AIM.length; d++) {
        for (var i2 = 1; i2 <= w.range; i2++) {
          var lx = u.x + AIM[d][0] * i2, ly = u.y + AIM[d][1] * i2;
          if (!inB(lx, ly)) break;
          var stop = at(G, lx, ly).t === 'barrel' || blocksSight(G, lx, ly);
          fillCell(lx, ly, 'rgba(255,45,149,.09)');
          var uu = unitAt(G, lx, ly);
          if (stop) break;
          if (uu && !w.pierce) break;
        }
      }
      var shots = shotsFrom(G, u.x, u.y, w);
      for (k = 0; k < shots.length; k++) {
        var sh = shots[k];
        if (sh.kind === 'barrel') { ringCell(sh.x, sh.y, C.barrel, 2); continue; }
        // mint = you can hit this; pink reticles (below) = it can hit you
        for (var q = 0; q < sh.hits.length; q++) {
          var vt = sh.hits[q];
          reticle(vt.x, vt.y, vt.side === 'enemy' ? C.mint : C.warn);
        }
      }
      var ints = interactables(G, u);
      for (k = 0; k < ints.length; k++) ringCell(ints[k].x, ints[k].y, C.console, 2);
    }

    // the armed (first-clicked) action, awaiting confirmation
    drawPending(u);
    // walking preview
    if (G.ui.path && G.ui.path.length) {
      ctx.strokeStyle = C.ally; ctx.lineWidth = 2; ctx.setLineDash([3, 4]);
      neon(C.ally, 8);
      ctx.beginPath();
      ctx.moveTo(cx(u.x), cy(u.y));
      for (k = 0; k < G.ui.path.length; k++) ctx.lineTo(cx(G.ui.path[k].x), cy(G.ui.path[k].y));
      ctx.stroke();
      ctx.setLineDash([]); noNeon();
      var last = G.ui.path[G.ui.path.length - 1];
      ringCell(last.x, last.y, C.ally, 2);
    }
  }

  // Put the odds on the board, not just in a panel — this is the number that
  // decides every shot. Drawn in its own pass, last, so an enemy intent label
  // in the same strip can never hide it.
  function drawOdds(u) {
    if (!u || G.phase !== 'PLAYER' || u.hasActed || u.disabled || G.ui.mode === 'GRENADE') return;
    var w = WEAPONS[u.weaponId], shots = shotsFrom(G, u.x, u.y, w);
    for (var k = 0; k < shots.length; k++) {
      if (shots[k].kind !== 'unit') continue;
      for (var q = 0; q < shots[k].hits.length; q++) {
        var vt = shots[k].hits[q];
        if (vt.side !== 'enemy') continue;
        var pct = hitChance(G, w, u.x, u.y, vt.x, vt.y);
        odds(vt.x, vt.y, pct >= 100 ? 'SURE' : pct + '%', pct >= 85 ? C.mint : pct >= 60 ? C.ally : C.warn);
      }
    }
  }

  // keep a centred label fully on the board
  function clampX(px, w) {
    return Math.max(w / 2 + 1, Math.min(W * G.tile - w / 2 - 1, px));
  }

  // small odds badge under a target
  function odds(x, y, text, color) {
    var T = G.tile, py = y * T + T - 2;
    fontData(.30);
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    var w = ctx.measureText(text).width + 10, bh = T * .28;
    var px = clampX(cx(x), w);
    ctx.fillStyle = color;                       // solid tag, dark text: reads instantly
    ctx.fillRect(px - w / 2, py - bh, w, bh);
    ctx.fillStyle = C.ink;
    ctx.fillText(text, px, py - bh * .16);
  }

  // The action the player has armed with their first click. Shows the outcome
  // before they commit to it.
  function drawPending(sel) {
    var p = G.ui.pending;
    if (!p || !sel) return;
    var T = G.tile;

    if (p.kind === 'move') {
      // ghost of where they'd end up
      ctx.save();
      ctx.globalAlpha = .5;
      ctx.strokeStyle = C.ally; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
      neon(C.ally, 12);
      ctx.strokeRect(p.x * T + 3, p.y * T + 3, T - 6, T - 6);
      ctx.setLineDash([]);
      ctx.beginPath();
      var gx = cx(p.x), gy = cy(p.y), r = T * .26;
      ctx.moveTo(gx, gy - r); ctx.lineTo(gx + r * .82, gy + r * .72);
      ctx.lineTo(gx, gy + r * .34); ctx.lineTo(gx - r * .82, gy + r * .72);
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,229,255,.28)'; ctx.fill(); ctx.stroke();
      noNeon(); ctx.restore();
      confirmBadge(p.x, p.y, C.ally);
      return;
    }

    if (p.kind === 'grenade') {
      var cells = plus(p.x, p.y);
      for (var i = 0; i < cells.length; i++) { fillCell(cells[i].x, cells[i].y, 'rgba(255,207,63,.34)'); ringCell(cells[i].x, cells[i].y, C.warn, 2); }
      confirmBadge(p.x, p.y, C.warn);
      return;
    }

    if (p.kind === 'interact') {
      ringCell(p.x, p.y, C.console, 3);
      confirmBadge(p.x, p.y, C.console);
      return;
    }

    if (p.kind === 'shot') {
      var pv = previewShot(sel, p.w, p.shot);
      // bold trajectory
      ctx.strokeStyle = C.mint; ctx.lineWidth = 3; neon(C.mint, 14);
      ctx.beginPath(); ctx.moveTo(cx(sel.x), cy(sel.y)); ctx.lineTo(cx(p.x), cy(p.y)); ctx.stroke();
      noNeon();
      reticle(p.x, p.y, C.mint);
      ringCell(p.x, p.y, C.mint, 2);

      // where the shove puts them, and whether that is fatal
      if (pv.kbKill && (pv.kbKill.x !== p.x || pv.kbKill.y !== p.y)) {
        var kx = pv.kbKill.x, ky = pv.kbKill.y;
        var fatal = pv.kbKill.result === 'void' || pv.kbKill.result === 'barrel';
        var col = fatal ? C.mint : C.warn;
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = col; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(cx(p.x), cy(p.y)); ctx.lineTo(cx(kx), cy(ky)); ctx.stroke();
        ctx.setLineDash([]);
        ringCell(kx, ky, col, 2);
        if (fatal) {
          fontHeavy(.20);
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          var kw = ctx.measureText('GONE').width + 10;
          ctx.fillStyle = col;
          ctx.fillRect(cx(kx) - kw / 2, cy(ky) - T * .14, kw, T * .28);
          ctx.fillStyle = C.ink;
          ctx.fillText(pv.kbKill.result === 'void' ? 'GONE' : 'BOOM', cx(kx), cy(ky) + 1);
        }
      }
      confirmBadge(p.x, p.y, C.mint);
    }
  }

  // The armed target pulses. The "click again" wording lives in the inspector
  // panel only — an on-canvas badge collided with the enemy intent labels.
  function confirmBadge(x, y, color) {
    var T = G.tile, pulse = .5 + .5 * Math.sin(Date.now() / 170);
    ctx.save();
    ctx.globalAlpha = .45 + pulse * .55;
    ctx.strokeStyle = color; ctx.lineWidth = 3;
    neon(color, 16);
    ctx.strokeRect(x * T + 2.5, y * T + 2.5, T - 5, T - 5);
    noNeon();
    ctx.restore();
  }

  function reticle(x, y, color) {
    var T = G.tile, r = T * .40, px = cx(x), py = cy(y), s = T * .13;
    ctx.strokeStyle = color; ctx.lineWidth = 2; neon(color, 8);
    var corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (var i = 0; i < 4; i++) {
      var dx = corners[i][0], dy = corners[i][1];
      ctx.beginPath();
      ctx.moveTo(px + dx * r, py + dy * r - dy * s);
      ctx.lineTo(px + dx * r, py + dy * r);
      ctx.lineTo(px + dx * r - dx * s, py + dy * r);
      ctx.stroke();
    }
    noNeon();
  }

  function drawIntents() {
    var es = alive(G, 'enemy'), T = G.tile;
    for (var i = 0; i < es.length; i++) {
      var e = es[i], it = e.intent;
      if (!it) continue;
      // the move it plans
      if (it.path && it.path.length) {
        ctx.strokeStyle = 'rgba(255,45,149,.75)'; ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]); neon(C.enemy, 8);
        ctx.beginPath();
        ctx.moveTo(cx(e.rx), cy(e.ry));
        for (var k = 0; k < it.path.length; k++) ctx.lineTo(cx(it.path[k].x), cy(it.path[k].y));
        ctx.stroke();
        ctx.setLineDash([]); noNeon();
        var d2 = it.dest;
        ctx.strokeStyle = 'rgba(255,45,149,.6)'; ctx.lineWidth = 1;
        ctx.strokeRect(d2.x * T + 4.5, d2.y * T + 4.5, T - 9, T - 9);
      }
      // the strike it plans
      if (it.kind === 'attack') {
        var from = it.dest || { x: e.x, y: e.y };
        ctx.strokeStyle = C.enemy; ctx.lineWidth = 2; neon(C.enemy, 10);
        ctx.beginPath(); ctx.moveTo(cx(from.x), cy(from.y)); ctx.lineTo(cx(it.tx), cy(it.ty)); ctx.stroke();
        noNeon();
        reticle(it.tx, it.ty, C.enemy);
        // boxed, so it stays readable over whatever is beneath it
        fontData(.28);
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        var lbl = (it.pct >= 100 ? 'SURE' : it.pct + '%') + '\u2009' + it.dmg;
        var lw = ctx.measureText(lbl).width + 10, lh = T * .28;
        var lx = clampX(cx(it.tx), lw);
        ctx.fillStyle = C.enemy;
        ctx.fillRect(lx - lw / 2, it.ty * T - lh, lw, lh);
        ctx.fillStyle = C.ink;
        ctx.fillText(lbl, lx, it.ty * T - lh * .16);
      }
      if (it.kind === 'detonate') {
        var cells = it.cells;
        for (var c = 0; c < cells.length; c++) { fillCell(cells[c].x, cells[c].y, 'rgba(255,154,45,.28)'); ringCell(cells[c].x, cells[c].y, C.barrel, 2); }
      }
    }
  }

  function hpPips(u) {
    var T = G.tile, n = u.maxHp, wid = Math.min(T * .13, 7), gap = 2;
    var total = n * wid + (n - 1) * gap, sx = cx(u.rx) - total / 2, sy = u.ry * T + T * .12;
    for (var i = 0; i < n; i++) {
      var full = i < u.hp;
      ctx.fillStyle = full ? (u.side === 'player' ? C.mint : C.enemy) : 'rgba(255,255,255,.14)';
      ctx.fillRect(sx + i * (wid + gap), sy, wid, Math.max(3, T * .07));
    }
  }

  // Two markers under each operative: square = move, circle = action.
  // Filled means still available this turn.
  function actionPips(u) {
    var T = G.tile, s = Math.max(4, T * .12), gap = Math.max(3, T * .06);
    var y = u.ry * T + T - s - Math.max(2, T * .06);
    var x0 = cx(u.rx) - (s * 2 + gap) / 2;
    var canMove = !u.hasMoved && !u.disabled, canAct = !u.hasActed && !u.disabled;

    ctx.lineWidth = 1.5;
    // move (square)
    ctx.beginPath();
    ctx.rect(x0, y, s, s);
    ctx.fillStyle = canMove ? C.mint : 'rgba(0,0,0,.35)';
    ctx.strokeStyle = canMove ? C.mint : 'rgba(154,144,192,.7)';
    if (canMove) neon(C.mint, 6);
    ctx.fill(); ctx.stroke(); noNeon();
    // action (circle)
    ctx.beginPath();
    ctx.arc(x0 + s + gap + s / 2, y + s / 2, s / 2, 0, Math.PI * 2);
    ctx.fillStyle = canAct ? C.mint : 'rgba(0,0,0,.35)';
    ctx.strokeStyle = canAct ? C.mint : 'rgba(154,144,192,.7)';
    if (canAct) neon(C.mint, 6);
    ctx.fill(); ctx.stroke(); noNeon();
  }

  function drawUnit(u) {
    var T = G.tile, px = cx(u.rx), py = cy(u.ry), r = T * .28;
    var col = u.side === 'player' ? C.ally : C.enemy;
    var sel = G.ui.selId === u.id;

    // base shadow blob
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.beginPath(); ctx.ellipse(px, py + r * .95, r * .85, r * .3, 0, 0, Math.PI * 2); ctx.fill();

    if (sel) {
      ctx.strokeStyle = C.ally; ctx.lineWidth = 2; neon(C.ally, 14);
      ctx.beginPath(); ctx.arc(px, py, T * .42, 0, Math.PI * 2); ctx.stroke(); noNeon();
    }
    if (u.side === 'player' && u.hasMoved && u.hasActed) { ctx.globalAlpha = .55; }

    neon(col, 12);
    ctx.strokeStyle = col; ctx.lineWidth = 2.2;
    ctx.fillStyle = u.side === 'player' ? 'rgba(0,229,255,.20)' : 'rgba(255,45,149,.20)';
    ctx.beginPath();

    if (u.side === 'player') {                      // operative: upward chevron
      ctx.moveTo(px, py - r);
      ctx.lineTo(px + r * .82, py + r * .72);
      ctx.lineTo(px, py + r * .34);
      ctx.lineTo(px - r * .82, py + r * .72);
      ctx.closePath();
    } else if (u.typeId === 'grunt') {              // drone: triangle
      ctx.moveTo(px, py + r); ctx.lineTo(px + r * .9, py - r * .7); ctx.lineTo(px - r * .9, py - r * .7); ctx.closePath();
    } else if (u.typeId === 'shooter') {            // sniper: diamond
      ctx.moveTo(px, py - r); ctx.lineTo(px + r * .8, py); ctx.lineTo(px, py + r); ctx.lineTo(px - r * .8, py); ctx.closePath();
    } else if (u.typeId === 'bruiser') {            // enforcer: hexagon
      for (var i = 0; i < 6; i++) {
        var a = Math.PI / 6 + i * Math.PI / 3, X = px + Math.cos(a) * r * 1.05, Y = py + Math.sin(a) * r * 1.05;
        if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
      }
      ctx.closePath();
    } else if (u.typeId === 'hacker') {             // spider: splayed cross
      ctx.moveTo(px - r * .9, py - r * .9); ctx.lineTo(px + r * .9, py + r * .9);
      ctx.moveTo(px + r * .9, py - r * .9); ctx.lineTo(px - r * .9, py + r * .9);
      ctx.moveTo(px, py - r); ctx.lineTo(px, py + r);
    } else {                                        // sapper: circle
      ctx.arc(px, py, r * .85, 0, Math.PI * 2);
    }
    if (u.typeId === 'hacker') ctx.stroke();
    else { ctx.fill(); ctx.stroke(); }
    noNeon();

    // armed sapper pulses
    if (u.armed) {
      var pulse = .5 + .5 * Math.sin(Date.now() / 160);
      ctx.strokeStyle = C.barrel; ctx.lineWidth = 2; ctx.globalAlpha = .4 + pulse * .6;
      neon(C.barrel, 16);
      ctx.beginPath(); ctx.arc(px, py, T * .40, 0, Math.PI * 2); ctx.stroke();
      noNeon(); ctx.globalAlpha = 1;
    }
    if (u.stunned) {
      ctx.fillStyle = C.warn;
      fontHeavy(.24);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('\u2716', px + r, py - r);
    }
    if (u.disabled) {
      ctx.fillStyle = C.enemy;
      fontData(.20);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('HACKED', px, py + r * 1.6);
    }
    // callsign initial, so you can tell your operatives apart at a glance
    if (u.side === 'player') {
      ctx.fillStyle = C.ally;
      fontHeavy(.30);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText((u.name || '?').charAt(0), px, py + r * .12);
    }
    ctx.globalAlpha = 1;
    hpPips(u);
    if (u.side === 'player') actionPips(u);
  }

  function drawFx() {
    var T = G.tile, i;
    for (i = 0; i < G.rings.length; i++) {
      var rg = G.rings[i], p = rg.t / rg.dur;
      ctx.globalAlpha = Math.max(0, 1 - p);
      ctx.strokeStyle = rg.color; ctx.lineWidth = 3; neon(rg.color, 18);
      ctx.beginPath(); ctx.arc(cx(rg.x), cy(rg.y), T * (.2 + p * 1.1), 0, Math.PI * 2); ctx.stroke();
      noNeon(); ctx.globalAlpha = 1;
    }
    for (i = 0; i < G.beams.length; i++) {
      var bm = G.beams[i];
      ctx.globalAlpha = Math.max(0, 1 - bm.t / bm.dur);
      ctx.strokeStyle = bm.color; ctx.lineWidth = 3; neon(bm.color, 14);
      ctx.beginPath(); ctx.moveTo(cx(bm.fx), cy(bm.fy)); ctx.lineTo(cx(bm.tx), cy(bm.ty)); ctx.stroke();
      noNeon(); ctx.globalAlpha = 1;
    }
    for (i = 0; i < G.fx.length; i++) {
      var f = G.fx[i], pr = f.t / f.dur;
      ctx.globalAlpha = Math.max(0, 1 - pr);
      ctx.fillStyle = f.color;
      fontHeavy(f.big ? .30 : .24);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(f.text, cx(f.x), cy(f.y) - pr * T * .7);
      ctx.globalAlpha = 1;
    }
  }

  function draw() {
    if (!G || !ctx) return;
    ctx.clearRect(0, 0, W * G.tile, H * G.tile);
    var x, y;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) drawTile(x, y);
    drawHighlights();
    drawIntents();
    var us = alive(G, 'player').concat(alive(G, 'enemy'));
    for (var i = 0; i < us.length; i++) drawUnit(us[i]);
    drawOdds(selected());     // last, so nothing can cover the to-hit numbers
    drawFx();
    syncHud();
  }

  // ============================================================
  // 10. ANIMATION — units walk their path, effects fade. Frames are only
  //     requested while something is actually moving.
  // ============================================================
  function isBusy() {
    if (G.fx.length || G.rings.length || G.beams.length) return true;
    for (var i = 0; i < G.units.length; i++) {
      var u = G.units[i];
      if (u.rpath && u.rpath.length) return true;
      if (Math.abs(u.rx - u.x) > 0.002 || Math.abs(u.ry - u.y) > 0.002) return true;
    }
    return false;
  }
  function hasArmed() {
    return alive(G, 'enemy').some(function (e) { return e.armed; });
  }

  var raf = null, lastTs = 0;
  function tick(ts) {
    var dt = lastTs ? Math.min(50, ts - lastTs) : 16;
    lastTs = ts;
    var busy = false, i;

    for (i = 0; i < G.units.length; i++) {
      var u = G.units[i];
      var goal = (u.rpath && u.rpath.length) ? u.rpath[0] : { x: u.x, y: u.y };
      var dx = goal.x - u.rx, dy = goal.y - u.ry, d = Math.sqrt(dx * dx + dy * dy);
      var sp = 0.0125 * dt;
      if (d > 0.002) {
        if (d <= sp) { u.rx = goal.x; u.ry = goal.y; if (u.rpath && u.rpath.length) u.rpath.shift(); }
        else { u.rx += dx / d * sp; u.ry += dy / d * sp; }
        busy = true;
      } else if (u.rpath && u.rpath.length) { u.rpath.shift(); busy = true; }
    }
    [G.fx, G.rings, G.beams].forEach(function (list) {
      for (var j = list.length - 1; j >= 0; j--) {
        var o = list[j];
        if (o.delay > 0) { o.delay -= dt; busy = true; continue; }
        o.t += dt;
        if (o.t >= o.dur) list.splice(j, 1); else busy = true;
      }
    });

    draw();
    if (busy || hasArmed()) raf = requestAnimationFrame(tick);
    else { raf = null; lastTs = 0; }
  }
  function ensureTick() { if (raf === null) { lastTs = 0; raf = requestAnimationFrame(tick); } }

  // Animations are decoration — they must never be able to hold up the game.
  // If frames are starved (backgrounded tab) or the player is impatient, we
  // fast-forward to the finished state instead of waiting.
  function snapAnimations() {
    for (var i = 0; i < G.units.length; i++) {
      var u = G.units[i];
      u.rx = u.x; u.ry = u.y; u.rpath = [];
    }
    G.fx.length = 0; G.rings.length = 0; G.beams.length = 0;
  }
  function waitIdle(cb) {
    ensureTick();
    var waited = 0, epoch = G.epoch;
    var iv = setInterval(function () {
      // A new sector started while we were waiting — this callback is stale and
      // would otherwise resolve the *new* level. Drop it.
      if (G.epoch !== epoch) { clearInterval(iv); return; }
      waited += 60;
      if (!isBusy()) { clearInterval(iv); cb(); return; }
      if (waited > 2500) { clearInterval(iv); snapAnimations(); draw(); cb(); }
    }, 60);
  }

  // Turn the effect notes from the rules layer into things you can see.
  function playFx(q) {
    var paths = {}, delay = 0, i;
    for (i = 0; i < q.length; i++) {
      var f = q[i];
      switch (f.kind) {
        case 'walk':
          paths[f.id] = (paths[f.id] || []).concat(f.path);
          delay += 60 * f.path.length; break;
        case 'step': case 'shove':
          (paths[f.id] = paths[f.id] || []).push({ x: f.x, y: f.y });
          delay += 70; break;
        case 'shot':
          G.beams.push({ fx: f.fx, fy: f.fy, tx: f.tx, ty: f.ty, color: f.side === 'player' ? C.ally : C.enemy, t: 0, dur: 260, delay: delay });
          delay += 90; break;
        case 'lob':
          G.beams.push({ fx: f.fx, fy: f.fy, tx: f.tx, ty: f.ty, color: C.warn, t: 0, dur: 300, delay: delay });
          delay += 120; break;
        case 'dmg':
          G.fx.push({ x: f.x, y: f.y, text: '-' + f.n + (f.label ? ' ' + f.label : ''), color: f.side === 'player' ? C.enemy : C.mint, t: 0, dur: 900, delay: delay });
          delay += 70; break;
        case 'miss':
          G.fx.push({ x: f.x, y: f.y, text: 'MISS', color: C.dim, t: 0, dur: 800, delay: delay });
          delay += 70; break;
        case 'boom':
          G.rings.push({ x: f.x, y: f.y, color: C.barrel, t: 0, dur: 520, delay: delay });
          delay += 110; break;
        case 'zap':
          G.rings.push({ x: f.x, y: f.y, color: C.waterLit, t: 0, dur: 460, delay: delay }); break;
        case 'fall':
          G.fx.push({ x: f.x, y: f.y, text: 'VOID', color: C.enemy, big: true, t: 0, dur: 1000, delay: delay });
          delay += 90; break;
        case 'die':
          G.rings.push({ x: f.x, y: f.y, color: f.side === 'player' ? C.ally : C.enemy, t: 0, dur: 520, delay: delay }); break;
        case 'stun':
          G.fx.push({ x: f.x, y: f.y, text: 'STUNNED', color: C.warn, t: 0, dur: 900, delay: delay }); break;
        case 'hack':
          G.fx.push({ x: f.x, y: f.y, text: 'HACKED', color: C.enemy, t: 0, dur: 900, delay: delay }); break;
        case 'arm':
          G.fx.push({ x: f.x, y: f.y, text: 'ARMED', color: C.barrel, t: 0, dur: 900, delay: delay }); break;
      }
    }
    Object.keys(paths).forEach(function (id) {
      var u = byId(G, id);
      if (u) u.rpath = (u.rpath || []).concat(paths[id]);
    });
    ensureTick();
  }

  // ============================================================
  // 10b. SHOT PREVIEW — what will this shot actually do?
  //      Used for the on-board badges, the inspector panel and nothing else:
  //      the real outcome still comes from fire(), so this only ever needs to
  //      describe, never decide.
  // ============================================================
  function previewShot(sel, w, shot) {
    var out = { pct: 100, sure: false, targets: [], allies: 0, kbKill: null, barrel: false };
    if (shot.kind === 'barrel') {
      out.barrel = true;
      out.blast = plus(shot.x, shot.y).filter(function (c) { return !!unitAt(G, c.x, c.y); }).length;
      return out;
    }
    var dx = Math.sign(shot.x - sel.x), dy = Math.sign(shot.y - sel.y);
    for (var i = 0; i < shot.hits.length; i++) {
      var t = shot.hits[i];
      if (t.side === 'player') { out.allies++; continue; }
      var pct = hitChance(G, w, sel.x, sel.y, t.x, t.y);
      out.pct = Math.min(out.pct, pct);
      out.targets.push({ unit: t, pct: pct });

      // Knockback is deterministic — say exactly where it ends up.
      if (w.kb && !out.kbKill) {
        var n = w.kb - (t.kbResist || 0), cx2 = t.x, cy2 = t.y, res = null;
        for (var k = 0; k < n; k++) {
          var nx = cx2 + dx, ny = cy2 + dy;
          if (!inB(nx, ny) || blocksKnock(G, nx, ny)) {
            res = (inB(nx, ny) && at(G, nx, ny).t === 'barrel') ? 'barrel' : 'wall';
            break;
          }
          if (unitAt(G, nx, ny)) { res = 'unit'; break; }
          cx2 = nx; cy2 = ny;
          if (at(G, cx2, cy2).t === 'pit') { res = 'void'; break; }
        }
        out.kbKill = { result: res, x: cx2, y: cy2, tiles: n };
      }
    }
    out.sure = out.pct >= 100;
    return out;
  }

  // Does this shot kill for certain, no dice involved? That's the mechanic the
  // whole game rests on, so it gets called out loudly wherever it applies.
  function sureKill(pv) {
    if (!pv.kbKill) return null;
    if (pv.kbKill.result === 'void') return 'Shoved into the void — certain kill';
    if (pv.kbKill.result === 'barrel') return 'Shoved into a barrel — it detonates';
    return null;
  }

  // ============================================================
  // 11. HUD
  // ============================================================
  function selected() {
    var u = G.ui.selId ? byId(G, G.ui.selId) : null;
    return (u && u.hp > 0 && u.side === 'player') ? u : null;
  }
  function done(u) { return u.hasMoved && u.hasActed; }

  // draw() runs every animation frame, so only touch the DOM when something
  // the HUD actually shows has changed.
  var hudSig = null;
  function syncHud() {
    var sig = [G.level, G.turn, G.phase, G.ui.selId, G.ui.mode, G.grenades,
      G.ui.pending ? G.ui.pending.key : '-',
      alive(G, 'enemy').length].concat(G.squad.map(function (m) {
        var u = byId(G, m.id);
        return [m.name, m.weaponId, m.move, (m.perks || []).join('+'), u ? u.hp : -1, u ? u.maxHp : -1,
          u ? (u.hasMoved ? 1 : 0) + (u.hasActed ? 2 : 0) : 0, u ? u.disabled : 0].join('.');
      })).join('|');
    if (sig === hudSig) return;
    hudSig = sig;

    var foes = alive(G, 'enemy').length;
    elSector.textContent = String(G.level).padStart(2, '0');
    elTurn.textContent = String(G.turn);
    if (elFoes) elFoes.textContent = String(foes);

    elSquad.innerHTML = '';
    G.squad.forEach(function (m) {
      var u = byId(G, m.id), w = WEAPONS[m.weaponId];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (G.ui.selId === m.id ? ' chip--sel' : '') + (u && u.hp > 0 ? (done(u) ? ' chip--done' : '') : ' chip--down');
      var pips = '';
      if (u) for (var i = 0; i < u.maxHp; i++) pips += '<i class="chip__pip' + (i < u.hp ? '' : ' chip__pip--empty') + '"></i>';
      var canMove = u && u.hp > 0 && !u.hasMoved && !u.disabled;
      var canAct = u && u.hp > 0 && !u.hasActed && !u.disabled;
      var perks = (m.perks && m.perks.length) ? '<span class="chip__perk" title="' + m.perks.join(', ') + '">▲' + m.perks.length + '</span>' : '';
      b.innerHTML =
        '<span class="chip__id"><span class="chip__name">' + m.name + '</span>' +
        '<span class="chip__wpn">' + w.name + ' · R' + w.range + ' · ' + w.dmgMin + '–' + w.dmgMax + '</span></span>' +
        '<span class="chip__hp">' + pips + '</span>' +
        '<span class="av"><i class="' + (canMove ? 'on' : '') + '"></i><i class="act ' + (canAct ? 'on' : '') + '"></i></span>' +
        perks;
      b.title = m.name + ' — ' + w.name + ': range ' + w.range + ', ' + w.dmgMin + '–' + w.dmgMax + ' damage, ' +
        (w.acc >= 100 ? 'never misses' : w.acc + '% point blank') + (w.kb ? ', shoves ' + w.kb : '') +
        (m.perks && m.perks.length ? '\nUpgrades: ' + m.perks.join(', ') : '');
      if (u && u.hp > 0) b.addEventListener('click', function () { selectUnit(m.id); });
      elSquad.appendChild(b);
    });

    elActs.innerHTML = '';
    var sel = selected();
    if (G.phase === 'PLAYER' && sel && !sel.hasActed && !sel.disabled && G.grenades > 0) {
      var g = document.createElement('button');
      g.type = 'button';
      g.className = 'btn-act' + (G.ui.mode === 'GRENADE' ? ' btn-act--on' : '');
      g.textContent = (G.ui.mode === 'GRENADE' ? 'Cancel' : 'Frag ' + G.grenades);
      g.addEventListener('click', function () {
        G.ui.mode = G.ui.mode === 'GRENADE' ? 'SELECT' : 'GRENADE';
        G.ui.path = null; G.ui.pending = null;
        draw(); renderTip(G.ui.hover);
      });
      elActs.appendChild(g);
    }
    elEnd.disabled = G.phase !== 'PLAYER';

    // How much of your turn is still unspent — the thing it's easiest to forget.
    if (G.phase === 'PLAYER') {
      var ops = alive(G, 'player');
      var pend = ops.filter(function (o) { return !done(o) && !o.disabled; }).length;
      elEnd.textContent = pend ? 'End turn' : 'End turn \u25B6';
      elEnd.classList.toggle('btn-end--ready', !pend);
      if (!G.ui.pending) {
        msg(pend
          ? pend + ' of ' + ops.length + ' operatives still have orders left'
          : 'All orders spent. End the turn.');
      }
    }
  }
  function msg(t) { elMsg.textContent = t || ''; }
  function say(t) { elLive.textContent = t; }

  // ============================================================
  // 12. INPUT — mouse only
  // ============================================================
  function tileFromEvent(e) {
    var r = cv.getBoundingClientRect();
    var x = Math.floor((e.clientX - r.left) / G.tile), y = Math.floor((e.clientY - r.top) / G.tile);
    return inB(x, y) ? { x: x, y: y } : null;
  }

  // What would clicking this tile do? One place decides, so the preview, the
  // inspector panel and the committed action can never disagree.
  function resolveIntent(sel, t) {
    if (!sel || !t || sel.disabled) return null;
    var i;
    if (G.ui.mode === 'GRENADE') {
      if (sel.hasActed || G.grenades <= 0) return null;
      if (cheb(sel.x, sel.y, t.x, t.y) > GRENADE.range) return null;
      return { kind: 'grenade', key: 'g:' + t.x + ',' + t.y, x: t.x, y: t.y };
    }
    if (!sel.hasActed) {
      var w = WEAPONS[sel.weaponId], shots = shotsFrom(G, sel.x, sel.y, w);
      for (i = 0; i < shots.length; i++) {
        var sh = shots[i];
        var hit = (sh.kind === 'barrel' && sh.x === t.x && sh.y === t.y) ||
          (sh.kind === 'unit' && sh.hits.some(function (h) { return h.x === t.x && h.y === t.y; }));
        if (hit) return { kind: 'shot', key: 's:' + t.x + ',' + t.y, shot: sh, w: w, x: t.x, y: t.y };
      }
      var ints = interactables(G, sel);
      for (i = 0; i < ints.length; i++) {
        if (ints[i].x === t.x && ints[i].y === t.y) {
          return { kind: 'interact', key: 'i:' + t.x + ',' + t.y, x: t.x, y: t.y, ikind: ints[i].kind };
        }
      }
    }
    if (!sel.hasMoved && !unitAt(G, t.x, t.y) && !blocksMove(G, t.x, t.y)) {
      var rm = reach(G, sel, sel.move), n = rm[t.y * 32 + t.x];
      if (n && !(t.x === sel.x && t.y === sel.y)) {
        return { kind: 'move', key: 'm:' + t.x + ',' + t.y, x: t.x, y: t.y, path: pathFrom(rm, t.x, t.y), steps: n.d };
      }
    }
    return null;
  }

  function threatened(x, y) {
    var es = alive(G, 'enemy');
    for (var i = 0; i < es.length; i++) {
      var it = es[i].intent;
      if (!it || !it.cells) continue;
      for (var c = 0; c < it.cells.length; c++) if (it.cells[c].x === x && it.cells[c].y === y) return es[i];
    }
    return null;
  }

  function perkList(u) {
    var m = null;
    for (var i = 0; i < G.squad.length; i++) if (G.squad[i].id === u.id) m = G.squad[i];
    return (m && m.perks && m.perks.length) ? m.perks : null;
  }

  // Structured description of a tile. Grouped into blocks — subject, then the
  // consequence of clicking — so the panel can be scanned rather than read.
  function describe(t) {
    var sel = selected(), u = unitAt(G, t.x, t.y), tt = at(G, t.x, t.y);
    var d = { tag: 'Terrain', rows: [], warn: [], kind: 'neutral', name: '', sub: '' };
    var it = sel ? resolveIntent(sel, t) : null;
    var armed = it && G.ui.pending && G.ui.pending.key === it.key;

    if (u && u.side === 'enemy') {
      var def = ENEMIES[u.typeId];
      d.tag = 'Threat assessment'; d.name = def.name; d.kind = 'foe';
      d.sub = 'hostile · ' + (def.atk.range === 0 ? 'suicide charge' : def.atk.range === 1 ? 'close quarters' : 'ranged');
      d.rows.push(['Hull', u.hp + ' / ' + u.maxHp]);
      d.rows.push(['Move', def.move]);
      d.rows.push(['Its attack', def.atk.range === 0
        ? 'blast ' + def.atk.dmgMax
        : def.atk.dmgMax + ' dmg @ ' + def.atk.range]);
      if (def.kbResist) d.rows.push(['Braced', '−' + def.kbResist + ' shove']);
      if (u.stunned) d.warn.push('Stunned. Skips its next turn.');
      if (u.armed) d.warn.push('Armed. Detonates on its next turn.');
      if (u.intent && u.intent.kind === 'attack') {
        var v = byId(G, u.intent.targetId);
        d.warn.push('Will hit ' + (v ? v.name : 'someone') + ' for ' + u.intent.dmg +
          (u.intent.pct >= 100 ? ' — certain.' : ' at ' + u.intent.pct + '%.'));
      }
    } else if (u && u.side === 'player') {
      var wp = WEAPONS[u.weaponId];
      d.tag = 'Operative'; d.name = u.name; d.kind = 'ally'; d.sub = wp.name;
      d.bigs = [
        { v: u.hp + '/' + u.maxHp, label: 'hull', cls: '' },
        { v: String(u.move), label: 'move', cls: '' },
        { v: 'R' + wp.range, label: 'reach', cls: '' }
      ];
      d.rows.push(['Damage', wp.dmgMin + '–' + wp.dmgMax]);
      d.rows.push(['Accuracy', wp.acc >= 100 ? 'never misses'
        : wp.acc + '%' + (wp.falloff ? ' −' + wp.falloff + '/tile' : '')]);
      if (wp.kb) d.rows.push(['Shove', wp.kb + (wp.kb === 1 ? ' tile' : ' tiles')]);
      if (wp.pierce) d.rows.push(['Pierce', 'whole lane']);
      if (u.maxHp > BASE_HP) d.rows.push(['Plating', '+' + (u.maxHp - BASE_HP) + ' hull']);
      if (u.move > BASE_MOVE) d.rows.push(['Servos', '+' + (u.move - BASE_MOVE) + ' move']);
      d.avail = { move: !u.hasMoved && !u.disabled, act: !u.hasActed && !u.disabled };
      d.note = wp.blurb;
      d.perks = perkList(u);
      if (u.disabled) d.warn.push('Hacked. Cannot act this turn.');
      var th = threatened(u.x, u.y);
      if (th) d.warn.push('In ' + ENEMIES[th.typeId].name + '’s firing line.');
    } else {
      var TERRAIN = {
        pit: ['Void', 'Anything shoved in falls out of the world. No dice involved.'],
        barrel: ['Fuel barrel', 'Shoot it or shove something into it. ' + BLAST_DMG + ' damage in a cross, and it chains.'],
        water: ['Coolant', 'Harmless until something electrifies it — then ' + SHOCK_DMG + ' damage to everything standing in it.'],
        console: ['Console', tt.spent ? 'Burned out.' : 'Stand beside it to electrify every coolant pool at once.'],
        door: ['Blast door', tt.open ? 'Open. Stand beside it to seal the lane.' : 'Sealed. Stand beside it to open it.'],
        wall: ['Bulkhead', 'Stops movement and gunfire. Standing against one gives cover.'],
        floor: ['Deck', '']
      };
      var info = TERRAIN[tt.t] || TERRAIN.floor;
      d.name = info[0];
      d.note = info[1];
    }

    // ---- the consequence of clicking, as its own block ----
    if (it && sel) {
      var a = { tag: 'Order', rows: [], bigs: [], warn: [] };
      if (it.kind === 'shot') {
        var pv = previewShot(sel, it.w, it.shot);
        a.tag = 'Firing solution';
        if (pv.barrel) {
          a.bigs = [{ v: 'SURE', label: 'to hit', cls: 'big--sure' },
                    { v: String(BLAST_DMG), label: 'blast', cls: 'big--dmg' }];
          a.rows.push(['Weapon', it.w.name]);
          a.rows.push(['Caught', pv.blast + ' unit' + (pv.blast === 1 ? '' : 's')]);
        } else {
          a.bigs = [{ v: pv.sure ? 'SURE' : pv.pct + '%', label: 'to hit', cls: pv.sure ? 'big--sure' : 'big--hit' },
                    { v: it.w.dmgMin + '–' + it.w.dmgMax, label: 'damage', cls: 'big--dmg' }];
          a.rows.push(['Weapon', it.w.name]);
          a.rows.push(['Range', cheb(sel.x, sel.y, it.x, it.y) + ' of ' + it.w.range]);
          if (pv.kbKill) {
            var r = pv.kbKill.result;
            a.rows.push(['Shove', r === 'void' ? 'into the void'
              : r === 'barrel' ? 'into a barrel'
              : r === 'wall' ? 'into a wall +' + BONK_DMG
              : r === 'unit' ? 'into a unit +' + BONK_DMG
              : pv.kbKill.tiles + ' tile' + (pv.kbKill.tiles === 1 ? '' : 's')]);
          }
          if (pv.allies) a.warn.push('This lane also hits ' + pv.allies + ' of your own.');
        }
        a.kill = sureKill(pv);
        d.confirm = { text: armed ? 'Click again to fire' : 'Click to aim', state: armed ? (pv.allies ? 'danger' : 'ready') : 'wait' };
      } else if (it.kind === 'grenade') {
        a.tag = 'Frag';
        a.bigs = [{ v: 'SURE', label: 'to hit', cls: 'big--sure' },
                  { v: GRENADE.dmgMin + '–' + GRENADE.dmgMax, label: 'damage', cls: 'big--dmg' }];
        var caught = plus(it.x, it.y).map(function (c) { return unitAt(G, c.x, c.y); }).filter(Boolean);
        var mine = caught.filter(function (v2) { return v2.side === 'player'; }).length;
        a.rows.push(['Area', 'cross, 5 tiles']);
        a.rows.push(['Caught', caught.length + ' unit' + (caught.length === 1 ? '' : 's')]);
        a.rows.push(['Left', String(G.grenades)]);
        if (mine) a.warn.push('Would also catch ' + mine + ' of your own.');
        d.confirm = { text: armed ? 'Click again to throw' : 'Click to aim', state: armed ? (mine ? 'danger' : 'ready') : 'wait' };
      } else if (it.kind === 'interact') {
        a.tag = it.ikind === 'console' ? 'Console' : 'Blast door';
        a.rows.push(['Effect', it.ikind === 'console' ? 'electrify all coolant' : (at(G, it.x, it.y).open ? 'seal it' : 'open it')]);
        d.confirm = { text: armed ? 'Click again to use' : 'Click to use', state: armed ? 'ready' : 'wait' };
      } else if (it.kind === 'move') {
        a.tag = 'Move order';
        a.bigs = [{ v: String(it.steps), label: 'tiles', cls: '' },
                  { v: String(sel.move - it.steps), label: 'spare', cls: '' }];
        var thr = threatened(it.x, it.y);
        if (thr) a.warn.push('That tile is inside ' + ENEMIES[thr.typeId].name + '’s planned attack.');
        if (at(G, it.x, it.y).t === 'water') a.warn.push('Coolant. Risky if anything electrifies it.');
        d.confirm = { text: armed ? 'Click again to move' : 'Click to plan', state: armed ? (thr ? 'danger' : 'ready') : 'wait' };
      }
      d.action = a;
    } else if (sel && u === sel) {
      d.confirm = { text: 'Pick a tile or a hostile', state: 'wait' };
    }
    return d;
  }

  function led(k, v) {
    return '<div class="led"><span class="led__k">' + k + '</span>' +
      '<span class="led__fill"></span><span class="led__v">' + v + '</span></div>';
  }
  function bigs(list) {
    return '<div class="tip__bigs">' + list.map(function (b) {
      return '<span class="big ' + (b.cls || '') + '"><b>' + b.v + '</b><i>' + b.label + '</i></span>';
    }).join('') + '</div>';
  }

  function renderTip(t) {
    if (!t || G.phase !== 'PLAYER') { elTip.hidden = true; return; }
    var d = describe(t);
    if (!d.rows.length && !d.confirm && !d.note && !d.warn.length) { elTip.hidden = true; return; }

    var tabCls = d.kind === 'foe' ? 'tab--foe' : d.kind === 'ally' ? 'tab--ally' : '';
    var h = '<div class="tip__head"><span class="tab ' + tabCls + '">' + d.tag + '</span>' +
      '<span class="tip__name tip__name--' + d.kind + '">' + d.name.toUpperCase() + '</span>';
    if (d.sub) h += '<span class="tip__sub">' + d.sub + '</span>';
    h += '</div>';

    // subject block
    if (d.bigs || d.rows.length || d.avail || d.note || d.warn.length || d.perks) {
      h += '<div class="tip__block">';
      if (d.bigs) h += bigs(d.bigs);
      if (d.avail) {
        h += led('Unspent', '<span class="av"><i class="' + (d.avail.move ? 'on' : '') + '"></i>' +
          '<i class="act ' + (d.avail.act ? 'on' : '') + '"></i></span> ' +
          (d.avail.move && d.avail.act ? 'move + action' : d.avail.move ? 'move' : d.avail.act ? 'action' : 'none'));
      }
      d.rows.forEach(function (r) { h += led(r[0], r[1]); });
      if (d.perks) h += '<p class="tip__perks">▲ ' + d.perks.join(' · ') + '</p>';
      if (d.note) h += '<p class="tip__note">' + d.note + '</p>';
      d.warn.forEach(function (w) { h += '<p class="tip__warn">' + w + '</p>'; });
      h += '</div>';
    }

    // order block
    if (d.action) {
      h += '<div class="tip__block"><span class="tab tab--mint">' + d.action.tag + '</span>';
      if (d.action.bigs.length) h += bigs(d.action.bigs);
      d.action.rows.forEach(function (r) { h += led(r[0], r[1]); });
      if (d.action.kill) h += '<p class="tip__kill">▮ ' + d.action.kill + '</p>';
      d.action.warn.forEach(function (w) { h += '<p class="tip__warn">' + w + '</p>'; });
      h += '</div>';
    }

    if (d.confirm) {
      h += '<div class="tip__confirm tip__confirm--' + d.confirm.state + '">' + d.confirm.text + '</div>';
    }

    elTip.innerHTML = h;
    elTip.hidden = false;

    // Prefer the empty space beside the board so the panel never covers tiles.
    // Only overlay the board when the window is too narrow for a side gap.
    var wrapR = wrap.getBoundingClientRect(), cvR = cv.getBoundingClientRect();
    var offX = cvR.left - wrapR.left, offY = cvR.top - wrapR.top;
    var tw = elTip.offsetWidth, th2 = elTip.offsetHeight;
    var gapR = wrapR.width - (offX + cvR.width), gapL = offX;
    var x, y = offY + Math.max(0, Math.min(t.y * G.tile - G.tile, cvR.height - th2));

    if (gapR >= tw + 14) x = offX + cvR.width + 10;          // park in the right gap
    else if (gapL >= tw + 14) x = offX - tw - 10;            // …or the left one
    else {                                                   // no room: overlay, flipping side
      x = offX + (t.x + 1) * G.tile + 10;
      if (x + tw > wrapR.width - 4) x = offX + t.x * G.tile - tw - 10;
    }
    if (x < 4) x = 4;
    if (x + tw > wrapR.width - 4) x = Math.max(4, wrapR.width - tw - 4);
    if (y + th2 > wrapR.height - 4) y = wrapR.height - th2 - 4;
    if (y < 4) y = 4;
    elTip.style.left = Math.round(x) + 'px';
    elTip.style.top = Math.round(y) + 'px';
  }

  function onMove(e) {
    if (!G || G.phase !== 'PLAYER') return;
    var t = tileFromEvent(e);
    if (t && G.ui.hover && t.x === G.ui.hover.x && t.y === G.ui.hover.y) return;  // same tile, nothing to redo
    G.ui.hover = t;
    G.ui.path = null;
    if (t) {
      var sel = selected();
      if (sel && G.ui.mode === 'SELECT' && !sel.hasMoved && !sel.disabled && !unitAt(G, t.x, t.y)) {
        var rm = reach(G, sel, sel.move);
        if (rm[t.y * 32 + t.x]) G.ui.path = pathFrom(rm, t.x, t.y);
      }
    }
    draw();
    renderTip(t);
  }

  function selectUnit(id) {
    var u = byId(G, id);
    if (!u || u.hp <= 0) return;
    G.ui.selId = id; G.ui.mode = 'SELECT'; G.ui.path = null; G.ui.pending = null;
    msg('');
    draw();
  }
  function autoSelect() {
    var ops = alive(G, 'player');
    for (var i = 0; i < ops.length; i++) if (!done(ops[i]) && !ops[i].disabled) { G.ui.selId = ops[i].id; return; }
    for (i = 0; i < ops.length; i++) if (!done(ops[i])) { G.ui.selId = ops[i].id; return; }
    G.ui.selId = ops.length ? ops[0].id : null;
  }

  function afterPlayerAction() {
    computeIntents(G);
    G.ui.mode = 'SELECT'; G.ui.path = null;
    if (!alive(G, 'enemy').length) { waitIdle(clearedLevel); draw(); return; }
    var sel = selected();
    if (sel && done(sel)) autoSelect();
    draw();
  }

  // Commit a previewed intent. Everything irreversible goes through here.
  function commitIntent(sel, it) {
    var q = [];
    if (it.kind === 'grenade') {
      throwGrenade(G, sel, it.x, it.y, DICE.live, q);
      G.grenades--; sel.hasActed = true;
      say('Frag thrown.');
    } else if (it.kind === 'shot') {
      fire(G, sel, it.w, it.shot, DICE.live, q);
      sel.hasActed = true;
      say(it.w.name + ' fired.');
    } else if (it.kind === 'interact') {
      var res = interact(G, sel, it.x, it.y, q);
      if (!res) { msg('Nothing to do there.'); G.ui.pending = null; draw(); return; }
      sel.hasActed = true;
      say(res); msg(res);
    } else if (it.kind === 'move') {
      sel.x = it.x; sel.y = it.y; sel.hasMoved = true;
      note(q, { kind: 'walk', id: sel.id, path: it.path });
      if (at(G, it.x, it.y).t === 'water' && at(G, it.x, it.y).live) hurt(G, sel, SHOCK_DMG, q, 'SHOCK');
    }
    G.ui.pending = null;
    G.ui.mode = 'SELECT';
    playFx(q);
    afterPlayerAction();
  }

  // Two stages: the first click previews and arms, the second commits. Nothing
  // costly happens on a single stray click.
  function onClick(e) {
    if (!G || G.phase !== 'PLAYER') return;
    if (isBusy()) snapAnimations();          // impatient clicks skip the flourish
    var t = tileFromEvent(e);
    if (!t) return;

    var clicked = unitAt(G, t.x, t.y);
    if (clicked && clicked.side === 'player') {
      if (clicked.id === G.ui.selId) {       // clicking the selected operative cancels
        G.ui.pending = null; G.ui.mode = 'SELECT';
        msg('');
        draw(); renderTip(t);
        return;
      }
      selectUnit(clicked.id); renderTip(t);
      return;
    }

    var sel = selected();
    if (!sel) { msg('Click one of your operatives to select them.'); return; }

    var it = resolveIntent(sel, t);
    if (!it) {
      G.ui.pending = null;
      if (sel.disabled) msg(sel.name + ' was hacked — sitting this turn out.');
      else if (done(sel)) msg(sel.name + ' is done. Pick someone else, or end the turn.');
      else msg('');
      draw(); renderTip(t);
      return;
    }

    if (G.ui.pending && G.ui.pending.key === it.key) { commitIntent(sel, it); return; }

    G.ui.pending = it;                       // first click: show the numbers
    msg('');
    draw();
    renderTip(t);
  }

  // ============================================================
  // 13. TURN CONTROLLER
  // ============================================================
  function endTurn() {
    if (G.phase !== 'PLAYER') return;
    if (isBusy()) snapAnimations();
    G.phase = 'RESOLVING';
    G.ui.mode = 'SELECT'; G.ui.path = null; G.ui.selId = null; G.ui.pending = null;
    if (elTip) elTip.hidden = true;
    alive(G, 'player').forEach(function (u) { u.disabled = 0; });
    msg('Hostiles acting…'); syncHud();

    var q = [];
    resolveEnemies(G, DICE.live, q);
    playFx(q);

    waitIdle(function () {
      if (!alive(G, 'player').length) { lost(); return; }
      if (!alive(G, 'enemy').length) { clearedLevel(); return; }
      G.turn++;
      alive(G, 'player').forEach(function (u) { u.hasMoved = false; u.hasActed = false; });
      computeIntents(G);
      G.phase = 'PLAYER';
      autoSelect();
      msg('');
      say('Turn ' + G.turn + '. Your move.');
      draw();
    });
  }

  // ============================================================
  // 14. SCREENS
  // ============================================================
  function showPanel(html) {
    elPanel.innerHTML = html;
    elOverlay.hidden = false;
  }
  function hidePanel() { elOverlay.hidden = true; }

  function rule(n, html) {
    return '<div class="how__row"><span class="how__n">' + n + '</span><p class="how__t">' + html + '</p></div>';
  }
  var RULES = '<div class="how">' +
    rule(1, '<b>One move and one action</b> per operative, per turn. The square and circle under each token are what is still unspent.') +
    rule(2, '<b>Clicking is two-stage.</b> The first click shows you the numbers. The second click on the same tile commits it. Right-click to cancel.') +
    rule(3, '<b>Guns fire in eight directions</b>, diagonals included, out to their range. Bulkheads stop a shot, and nothing squeezes through a corner gap.') +
    rule(4, '<b>Every hostile shows its plan.</b> The dashed line is where it walks; the tag on your operative is what it will do, and its odds.') +
    rule(5, '<s>Guns roll to hit. The room never does.</s> Shove something into the void and it is gone. Barrels, frags and the shock prod are certainties too — that is how you beat a cold streak.') +
    rule(6, 'Clear the sector, take one requisition, drop into a harder one. <em>Every sector is generated and then solved before you ever see it.</em>') +
    '</div>';

  function titleScreen() {
    showPanel(
      '<span class="tab tab--foe">Field manual</span>' +
      '<h1>Null <span>Sector</span></h1>' +
      '<p class="lede">Turn-based tactics · mouse only</p>' +
      RULES +
      '<button class="btn-neon" data-go>Deploy</button>'
    );
    elPanel.querySelector('[data-go]').addEventListener('click', function () { hidePanel(); startRun(); });
  }

  // The "?" in the top bar — same rules, mid-run.
  function helpScreen() {
    if (!elOverlay.hidden || G.phase === 'TITLE') return;
    var back = G.phase;
    showPanel('<span class="tab tab--amber">Field manual</span><h2>How to play</h2>' + RULES +
      '<button class="btn-neon" data-back>Back to it</button>');
    G.phase = 'HELP';
    elPanel.querySelector('[data-back]').addEventListener('click', function () {
      hidePanel(); G.phase = back; draw();
    });
  }

  // Upgrades are recorded on the operatives they affect, so you can always see
  // where a squad's numbers came from (shown on the cards and in the inspector).
  function givePerk(m, label) {
    if (!m.perks) m.perks = [];
    if (m.perks.indexOf(label) < 0) m.perks.push(label);
  }
  function tallyPerk(m, label) {
    if (!m.perks) m.perks = [];
    for (var i = 0; i < m.perks.length; i++) {
      var mt = /^(.*?)(?: ×(\d+))?$/.exec(m.perks[i]);
      if (mt && mt[1] === label) { m.perks[i] = label + ' ×' + ((+mt[2] || 1) + 1); return; }
    }
    m.perks.push(label);
  }

  var REWARDS = [
    {
      id: 'recruit', icon: '+', name: 'Reinforcement', desc: 'A new operative joins the squad',
      ok: function () { return G.squad.length < MAX_OPS; },
      run: function () { G.squad.push(newOp('pistol')); }
    },
    {
      id: 'upgrade', icon: '↑', name: 'Weapon upgrade', desc: 'Trade up: Sidearm → Scattergun → Railgun',
      ok: function () { return G.squad.some(function (m) { return UPGRADE[m.weaponId]; }); },
      run: function () {
        for (var i = 0; i < G.squad.length; i++) {
          if (UPGRADE[G.squad[i].weaponId]) {
            G.squad[i].weaponId = UPGRADE[G.squad[i].weaponId];
            givePerk(G.squad[i], WEAPONS[G.squad[i].weaponId].name);
            return;
          }
        }
      }
    },
    {
      id: 'prod', icon: '⚡', name: 'Shock prod', desc: 'Melee, never misses, stuns — and electrifies coolant',
      ok: function () { return !G.squad.some(function (m) { return m.weaponId === 'shock'; }) && G.squad.length > 1; },
      run: function () {
        var m = G.squad[G.squad.length - 1];
        m.weaponId = 'shock';
        givePerk(m, 'Shock prod');
      }
    },
    {
      id: 'plating', icon: '▣', name: 'Plating', desc: '+2 max HP for everyone',
      ok: function () { return true; },
      run: function () { G.squad.forEach(function (m) { m.maxHp += 2; tallyPerk(m, 'Plating'); }); }
    },
    {
      id: 'frags', icon: '◉', name: 'Ordnance', desc: '+2 frag grenades',
      ok: function () { return true; },
      run: function () { G.grenades += 2; }
    },
    {
      id: 'legs', icon: '»', name: 'Servo legs', desc: '+1 movement for everyone',
      ok: function () { return G.squad.every(function (m) { return m.move < 5; }); },
      run: function () { G.squad.forEach(function (m) { m.move += 1; tallyPerk(m, 'Servo legs'); }); }
    }
  ];

  function clearedLevel() {
    // Reachable from both the killing blow and the end of a turn — only resolve once.
    if (G.phase === 'REWARD' || G.phase === 'LOST') return;
    G.phase = 'REWARD';
    // survivors are patched up; anyone lost is gone for good
    var down = G.squad.filter(function (m) { var u = byId(G, m.id); return !u || u.hp <= 0; });
    G.squad = G.squad.filter(function (m) { var u = byId(G, m.id); return u && u.hp > 0; });
    if (!G.squad.length) { lost(); return; }

    track('sector_cleared', Object.assign({
      sector: G.level,
      turns: G.turn,
      operatives_lost: down.length
    }, squadInfo()));

    var pool = REWARDS.filter(function (r) { return r.ok(); });
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(liveRng() * (i + 1)), t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    var offer = pool.slice(0, 3);

    var lostLine = down.length
      ? '<p class="tip__warn" style="display:block">' + down.map(function (m) { return m.name; }).join(', ') +
        ' did not make it out.</p>'
      : '';
    // Current squad, so the upgrades you've taken are visible when you pick more.
    var roster = '<dl class="roster">' + G.squad.map(function (m) {
      var w = WEAPONS[m.weaponId];
      return '<div class="roster__row"><dt>' + m.name + '</dt><dd>' +
        w.name + ' · R' + w.range + ' · ' + w.dmgMin + '–' + w.dmgMax + ' dmg' +
        ' · ' + m.maxHp + ' HP' + (m.maxHp > BASE_HP ? ' (+' + (m.maxHp - BASE_HP) + ')' : '') +
        ' · move ' + m.move + (m.move > BASE_MOVE ? ' (+' + (m.move - BASE_MOVE) + ')' : '') +
        (m.perks && m.perks.length ? '<span class="roster__perks">' + m.perks.join(' · ') + '</span>' : '') +
        '</dd></div>';
    }).join('') +
      '<div class="roster__row"><dt>Frags</dt><dd>' + G.grenades + ' in the pack</dd></div></dl>';

    var html = '<span class="tab tab--mint">Debrief</span>' +
      '<h2>Sector ' + String(G.level).padStart(2, '0') + ' cleared</h2>' +
      lostLine + roster +
      '<span class="tab">Requisition</span>' +
      '<p>Squad patched up. Draw one item before the next drop.</p><div class="rewards">';
    offer.forEach(function (r, k) {
      html += '<button class="reward" type="button" data-r="' + k + '">' +
        '<span class="reward__icon">' + r.icon + '</span>' +
        '<span class="reward__name">' + r.name + '</span>' +
        '<span class="reward__desc">' + r.desc + '</span></button>';
    });
    html += '</div>';
    showPanel(html);
    say('Sector clear. Choose an upgrade.');
    Array.prototype.forEach.call(elPanel.querySelectorAll('[data-r]'), function (b) {
      b.addEventListener('click', function () {
        var chosen = offer[+b.getAttribute('data-r')];
        track('upgrade_taken', {
          sector: G.level,
          upgrade: chosen.id,
          upgrade_name: chosen.name,
          offered: offer.map(function (o) { return o.id; }).join(',')
        });
        chosen.run();
        hidePanel();
        G.level++;
        startLevel();
      });
    });
  }

  function lost() {
    if (G.phase === 'LOST') return;
    G.phase = 'LOST';
    track('squad_lost', {
      sector: G.level,
      sectors_cleared: G.level - 1,
      turns: G.turn,
      run_seconds: G.runStart ? Math.round((Date.now() - G.runStart) / 1000) : null
    });
    showPanel(
      '<span class="tab tab--foe">Contact lost</span>' +
      '<h2>Squad lost</h2>' +
      '<p>Furthest sector reached: <b>' + String(G.level).padStart(2, '0') + '</b>.</p>' +
      '<p class="lede">The room is the sharpest weapon you have</p>' +
      '<p>Next time, put something in the void. It never misses.</p>' +
      '<button class="btn-neon" data-again>Redeploy</button>'
    );
    say('Squad lost at sector ' + G.level);
    elPanel.querySelector('[data-again]').addEventListener('click', function () { hidePanel(); startRun(); });
  }

  // ============================================================
  // 15. RUN / LEVEL SETUP
  // ============================================================
  var NAMES = ['VEX', 'NOMI', 'KADE', 'RIL', 'JUNO', 'ASH', 'ODEN', 'PIX'];
  var nameN = 0;
  function newOp(weaponId) {
    return { id: uid('op'), name: NAMES[nameN++ % NAMES.length], maxHp: BASE_HP, move: BASE_MOVE, weaponId: weaponId, perks: [] };
  }

  function startRun() {
    nameN = 0;
    G.level = 1;
    G.grenades = 1;
    G.squad = [newOp('pistol'), newOp('shotgun')];
    G.runStart = Date.now();
    track('game_started', {});
    startLevel();
  }

  function startLevel() {
    G.epoch = (G.epoch || 0) + 1;      // invalidates any in-flight waitIdle callbacks
    var built = generateLevel(G.level, G.squad, G.grenades);
    G.tiles = built.tiles;
    G.units = built.units;
    G.grenades = built.grenades;
    G.turn = 1;
    G.phase = 'PLAYER';
    G.fx = []; G.rings = []; G.beams = [];
    G.units.forEach(function (u) { u.rx = u.x; u.ry = u.y; u.rpath = []; });
    computeIntents(G);
    autoSelect();
    msg('');
    say('Sector ' + G.level + '. ' + alive(G, 'enemy').length + ' hostiles. Your move.');
    layout();

    var foes = alive(G, 'enemy');
    var kinds = {}, hazards = {}, x, y;
    foes.forEach(function (e) { kinds[e.typeId] = (kinds[e.typeId] || 0) + 1; });
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var t = at(G, x, y).t;
      if (t !== 'floor' && t !== 'wall') hazards[t] = (hazards[t] || 0) + 1;
    }
    track('sector_started', Object.assign({
      sector: G.level,
      hostiles: foes.length,
      hostile_types: Object.keys(kinds).sort().join(','),
      hazards: Object.keys(hazards).sort().join(',') || 'none',
      pits: hazards.pit || 0,
      barrels: hazards.barrel || 0,
      gen_attempts: built.gen ? built.gen.attempts : null,
      gen_fallback: built.gen ? built.gen.fallback : null,
      gen_ms: built.gen ? built.gen.ms : null
    }, squadInfo()));
  }

  // ============================================================
  // 16. BOOT
  // ============================================================
  function boot() {
    app = document.querySelector('[data-app]');
    cv = document.querySelector('[data-stage]');
    if (!app || !cv || !cv.getContext) return;
    ctx = cv.getContext('2d');
    wrap = document.querySelector('.stagewrap');
    elSector = document.querySelector('[data-sector]');
    elTurn = document.querySelector('[data-turn]');
    elSquad = document.querySelector('[data-squad]');
    elMsg = document.querySelector('[data-msg]');
    elActs = document.querySelector('[data-acts]');
    elEnd = document.querySelector('[data-end]');
    elOverlay = document.querySelector('[data-overlay]');
    elPanel = document.querySelector('[data-panel]');
    elLive = document.querySelector('[data-live]');
    elTip = document.querySelector('[data-tip]');
    elHelp = document.querySelector('[data-help]');
    elFoes = document.querySelector('[data-foes]');

    G = {
      tiles: blankTiles(), units: [], squad: [], grenades: 0,
      level: 1, turn: 1, phase: 'TITLE', tile: 48,
      fx: [], rings: [], beams: [],
      ui: { mode: 'SELECT', selId: null, hover: null, path: null, pending: null }
    };

    cv.addEventListener('mousemove', onMove);
    cv.addEventListener('mouseleave', function () {
      G.ui.hover = null; G.ui.path = null;
      if (elTip) elTip.hidden = true;
      draw();
    });
    cv.addEventListener('click', onClick);
    cv.addEventListener('contextmenu', function (e) {   // right-click cancels
      e.preventDefault();
      G.ui.mode = 'SELECT'; G.ui.pending = null;
      draw(); renderTip(G.ui.hover);
    });
    elEnd.addEventListener('click', endTurn);
    if (elHelp) elHelp.addEventListener('click', helpScreen);

    var rt;
    window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(layout, 120); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { draw(); });

    layout();
    titleScreen();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  // Headless hook — lets a Node harness hammer the generator and the solver
  // without a browser. Invisible in the browser (`module` is undefined there).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      buildLevel: buildLevel, safeLevel: safeLevel, generateLevel: generateLevel,
      canSolve: canSolve, computeIntents: computeIntents, resolveEnemies: resolveEnemies,
      bestPlay: bestPlay, applyPlay: applyPlay, cloneSim: cloneSim,
      alive: alive, at: at, DICE: DICE, WEAPONS: WEAPONS, ENEMIES: ENEMIES,
      W: W, H: H, TURN_BUDGET: TURN_BUDGET
    };
  }
})();
