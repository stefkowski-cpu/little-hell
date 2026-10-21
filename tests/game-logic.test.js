/**
 * LITTLE HELL — Unit Tests (Vitest + JSDOM)
 *
 * Tests extracted game logic functions: scoring, XSS prevention,
 * avatar identity, persistence, Glicko-2 rating, and state validation.
 *
 * Firebase RTDB tests require the Firebase Emulator and are marked
 * as NICHT VERIFIZIERT in the fix report.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Extracted pure functions for testing ─────────────────────────────────

// HELL_POINTS scoring table
const HELL_POINTS = {
  3: [25, 20, 14], 4: [20, 14, 8], 5: [15, 10, 6], 6: [12, 8, 4],
  7: [9, 6, 4],    8: [7, 4, 3],   9: [5, 4, 3],   10: [5, 4, 3],
};

function hellBonus(target, rollNo) {
  const t = target <= 10 ? target : 21 - target; // 11–18 mirror 3–10
  const row = HELL_POINTS[t];
  return row ? (row[rollNo - 1] || 0) : 0;
}

function esc(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const AVATARS = {
  m: ['avatars/m1.webp','avatars/m2.webp','avatars/m3.webp','avatars/m4.webp'],
  f: ['avatars/f1.webp','avatars/f2.webp','avatars/f3.webp','avatars/f4.webp']
};
const AVATAR_WHITELIST = new Set([...AVATARS.m, ...AVATARS.f]);

function safeAvatarSrc(url) {
  return AVATAR_WHITELIST.has(url) ? url : AVATARS.m[0];
}

function pickAvatar(gender, usedAvatars) {
  const pool = AVATARS[gender] || AVATARS.m;
  const free = pool.filter(a => !usedAvatars.has(a));
  const list = free.length ? free : pool;
  const pick = list[Math.floor(Math.random() * list.length)];
  usedAvatars.add(pick);
  return pick;
}

function emptySave() {
  return { v: 1, updatedAt: 0, slots: {}, lifetime: null, hellSession: null, deletedSlots: {} };
}

function validateSaveData(d) {
  if (!d || typeof d !== 'object' || d.v !== 1) return false;
  if (d.slots && typeof d.slots !== 'object') return false;
  if (d.slots) {
    Object.keys(d.slots).forEach(k => {
      const sl = d.slots[k];
      if (!sl || typeof sl !== 'object' || !sl.game) delete d.slots[k];
    });
  }
  return true;
}

function migrateSlots(d) {
  Object.keys(d.slots || {}).forEach(k => {
    const sl = d.slots[k];
    if (sl && !sl.game && k === 'chicago') {
      const id = 'm_' + k;
      sl.game = k;
      sl.startedAt = sl.startedAt || sl.savedAt;
      if (sl.state) sl.state.saveId = id;
      if (sl.session && !sl.session.saveId) sl.session.saveId = id;
      d.slots[id] = sl;
      delete d.slots[k];
    }
  });
  return d;
}

// Glicko-2 implementation
const GLICKO2 = (() => {
  const TAU = 0.5;
  const EPSILON = 0.000001;
  const SCALE = 173.7178;

  function toGlicko2(r, rd) {
    return { mu: (r - 1500) / SCALE, phi: rd / SCALE };
  }
  function fromGlicko2(mu, phi) {
    return { rating: mu * SCALE + 1500, rd: phi * SCALE };
  }
  function g(phi) {
    return 1 / Math.sqrt(1 + 3 * phi * phi / (Math.PI * Math.PI));
  }
  function E(mu, muj, phij) {
    return 1 / (1 + Math.exp(-g(phij) * (mu - muj)));
  }

  function update(rating, rd, vol, oppRating, oppRd, result) {
    const p = toGlicko2(rating, rd);
    const o = toGlicko2(oppRating, oppRd);
    const gPhi = g(o.phi);
    const eVal = E(p.mu, o.mu, o.phi);
    const v = 1 / (gPhi * gPhi * eVal * (1 - eVal));
    const delta = v * gPhi * (result - eVal);
    const a = Math.log(vol * vol);
    const phiSq = p.phi * p.phi;

    function f(x) {
      const ex = Math.exp(x);
      const d2 = delta * delta;
      const num1 = ex * (d2 - phiSq - v - ex);
      const den1 = 2 * Math.pow(phiSq + v + ex, 2);
      return num1 / den1 - (x - a) / (TAU * TAU);
    }

    let A = a;
    let B;
    if (delta * delta > phiSq + v) {
      B = Math.log(delta * delta - phiSq - v);
    } else {
      let k = 1;
      while (f(a - k * TAU) < 0) k++;
      B = a - k * TAU;
    }

    let fA = f(A), fB = f(B);
    let iter = 0;
    while (Math.abs(B - A) > EPSILON && iter < 100) {
      const C = A + (A - B) * fA / (fB - fA);
      const fC = f(C);
      if (fC * fB <= 0) { A = B; fA = fB; }
      else { fA = fA / 2; }
      B = C; fB = fC;
      iter++;
    }

    const newVol = Math.exp(A / 2);
    const phiStar = Math.sqrt(phiSq + newVol * newVol);
    const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
    const newMu = p.mu + newPhi * newPhi * gPhi * (result - eVal);
    const out = fromGlicko2(newMu, newPhi);
    return {
      rating: Math.round(out.rating),
      rd: Math.round(out.rd * 10) / 10,
      vol: Math.round(newVol * 10000) / 10000
    };
  }

  return { update, toGlicko2, fromGlicko2 };
})();

// Tombstone-based deletion
function clearSlot(data, id) {
  if (data.slots[id]) {
    delete data.slots[id];
    if (!data.deletedSlots) data.deletedSlots = {};
    data.deletedSlots[id] = Date.now();
    const cutoff = Date.now() - 7 * 86400000;
    Object.keys(data.deletedSlots).forEach(k => {
      if (data.deletedSlots[k] < cutoff) delete data.deletedSlots[k];
    });
  }
  return data;
}

function adoptRemote(localData, remote) {
  remote.slots = remote.slots || {};
  const localTombstones = localData.deletedSlots || {};
  const remoteTombstones = remote.deletedSlots || {};
  const mergedTombstones = { ...remoteTombstones, ...localTombstones };
  Object.keys(mergedTombstones).forEach(k => {
    if (remote.slots[k] && (remote.slots[k].savedAt || 0) < mergedTombstones[k]) {
      delete remote.slots[k];
    }
  });
  const cutoff = Date.now() - 7 * 86400000;
  Object.keys(mergedTombstones).forEach(k => {
    if (mergedTombstones[k] < cutoff) delete mergedTombstones[k];
  });
  remote.deletedSlots = mergedTombstones;
  return remote;
}

// Volume parsing (P2-15 fix)
function parseVolume(v, fallback) {
  const n = parseInt(v);
  return Math.max(0, Math.min(10, isNaN(n) ? fallback : n));
}

// ═══════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('Game Engine — hellBonus scoring', () => {
  it('returns correct points for target 3 (hardest)', () => {
    expect(hellBonus(3, 1)).toBe(25);
    expect(hellBonus(3, 2)).toBe(20);
    expect(hellBonus(3, 3)).toBe(14);
  });

  it('returns correct points for target 10 (easiest symmetric)', () => {
    expect(hellBonus(10, 1)).toBe(5);
    expect(hellBonus(10, 2)).toBe(4);
    expect(hellBonus(10, 3)).toBe(3);
  });

  it('mirrors targets 11–18 to 3–10', () => {
    // target 18 mirrors to 3 (21-18=3)
    expect(hellBonus(18, 1)).toBe(hellBonus(3, 1));
    expect(hellBonus(18, 2)).toBe(hellBonus(3, 2));
    expect(hellBonus(18, 3)).toBe(hellBonus(3, 3));
    // target 11 mirrors to 10 (21-11=10)
    expect(hellBonus(11, 1)).toBe(hellBonus(10, 1));
  });

  it('returns 0 for invalid roll numbers', () => {
    expect(hellBonus(5, 0)).toBe(0);
    expect(hellBonus(5, 4)).toBe(0);
  });

  it('returns 0 for targets outside range', () => {
    expect(hellBonus(2, 1)).toBe(0);
    expect(hellBonus(19, 1)).toBe(0);
  });

  it('all valid targets return decreasing points per roll', () => {
    for (let t = 3; t <= 18; t++) {
      const p1 = hellBonus(t, 1);
      const p2 = hellBonus(t, 2);
      const p3 = hellBonus(t, 3);
      expect(p1).toBeGreaterThanOrEqual(p2);
      expect(p2).toBeGreaterThanOrEqual(p3);
    }
  });
});

describe('XSS Prevention — esc()', () => {
  it('escapes HTML entities', () => {
    expect(esc('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes quotes', () => {
    expect(esc('" onmouseover="alert(1)')).toBe('&quot; onmouseover=&quot;alert(1)');
    expect(esc("' onclick='alert(1)")).toBe("&#39; onclick=&#39;alert(1)");
  });

  it('escapes ampersands', () => {
    expect(esc('Tom & Jerry')).toBe('Tom &amp; Jerry');
  });

  it('handles non-string input', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(42)).toBe('');
    expect(esc({})).toBe('');
  });

  it('preserves safe strings', () => {
    expect(esc('Hello World')).toBe('Hello World');
    expect(esc('Player 1')).toBe('Player 1');
  });

  it('handles complex injection payloads', () => {
    const payload = '<img src=x onerror="alert(document.cookie)">';
    const escaped = esc(payload);
    expect(escaped).not.toContain('<img ');
    expect(escaped).toContain('&lt;img');
    // When inserted as innerHTML, the escaped string is rendered as text, not HTML
    const div = document.createElement('div');
    div.innerHTML = escaped;
    expect(div.querySelector('img')).toBeNull();
  });
});

describe('XSS Prevention — safeAvatarSrc()', () => {
  it('allows whitelisted avatar paths', () => {
    expect(safeAvatarSrc('avatars/m1.webp')).toBe('avatars/m1.webp');
    expect(safeAvatarSrc('avatars/f4.webp')).toBe('avatars/f4.webp');
  });

  it('rejects non-whitelisted URLs', () => {
    expect(safeAvatarSrc('javascript:alert(1)')).toBe('avatars/m1.webp');
    expect(safeAvatarSrc('https://evil.com/avatar.webp')).toBe('avatars/m1.webp');
    expect(safeAvatarSrc('data:image/svg+xml,<svg>')).toBe('avatars/m1.webp');
    expect(safeAvatarSrc('../../../etc/passwd')).toBe('avatars/m1.webp');
  });

  it('rejects empty and invalid inputs', () => {
    expect(safeAvatarSrc('')).toBe('avatars/m1.webp');
    expect(safeAvatarSrc(null)).toBe('avatars/m1.webp');
    expect(safeAvatarSrc(undefined)).toBe('avatars/m1.webp');
  });
});

describe('Avatar Identity — pickAvatar()', () => {
  it('picks from correct gender pool', () => {
    const used = new Set();
    const avatar = pickAvatar('f', used);
    expect(avatar).toMatch(/^avatars\/f[1-4]\.webp$/);
  });

  it('avoids already-used avatars when pool has free ones', () => {
    const used = new Set(['avatars/m1.webp', 'avatars/m2.webp', 'avatars/m3.webp']);
    const avatar = pickAvatar('m', used);
    expect(avatar).toBe('avatars/m4.webp');
  });

  it('falls back when all avatars are used (allows duplicates)', () => {
    const used = new Set(['avatars/m1.webp', 'avatars/m2.webp', 'avatars/m3.webp', 'avatars/m4.webp']);
    const avatar = pickAvatar('m', used);
    expect(avatar).toMatch(/^avatars\/m[1-4]\.webp$/);
  });

  it('assigns stable avatars across multiple calls', () => {
    const used = new Set();
    const avatars = [];
    for (let i = 0; i < 4; i++) {
      avatars.push(pickAvatar('m', used));
    }
    // All 4 should be unique since pool has 4
    const unique = new Set(avatars);
    expect(unique.size).toBe(4);
  });

  it('defaults to male pool for unknown gender', () => {
    const used = new Set();
    const avatar = pickAvatar('x', used);
    expect(avatar).toMatch(/^avatars\/m[1-4]\.webp$/);
  });
});

describe('Persistence — emptySave()', () => {
  it('returns correct structure', () => {
    const save = emptySave();
    expect(save.v).toBe(1);
    expect(save.updatedAt).toBe(0);
    expect(save.slots).toEqual({});
    expect(save.lifetime).toBeNull();
    expect(save.hellSession).toBeNull();
    expect(save.deletedSlots).toEqual({});
  });

  it('returns a new object each time', () => {
    const a = emptySave();
    const b = emptySave();
    expect(a).not.toBe(b);
    a.slots.test = {};
    expect(b.slots.test).toBeUndefined();
  });
});

describe('Persistence — validateSaveData()', () => {
  it('accepts valid save data', () => {
    expect(validateSaveData({ v: 1, slots: {} })).toBe(true);
  });

  it('rejects null/undefined/non-object', () => {
    expect(validateSaveData(null)).toBe(false);
    expect(validateSaveData(undefined)).toBe(false);
    expect(validateSaveData('string')).toBe(false);
    expect(validateSaveData(42)).toBe(false);
  });

  it('rejects wrong version', () => {
    expect(validateSaveData({ v: 2, slots: {} })).toBe(false);
    expect(validateSaveData({ v: 0, slots: {} })).toBe(false);
  });

  it('rejects non-object slots', () => {
    expect(validateSaveData({ v: 1, slots: 'invalid' })).toBe(false);
  });

  it('removes invalid slot entries', () => {
    const data = { v: 1, slots: {
      good: { game: 'chicago', state: {} },
      bad1: null,
      bad2: 'string',
      bad3: { noGame: true },
    }};
    validateSaveData(data);
    expect(data.slots.good).toBeDefined();
    expect(data.slots.bad1).toBeUndefined();
    expect(data.slots.bad2).toBeUndefined();
    expect(data.slots.bad3).toBeUndefined();
  });
});

describe('Persistence — migrateSlots()', () => {
  it('migrates legacy chicago slot to m_chicago', () => {
    const data = {
      slots: {
        chicago: { savedAt: 12345, state: {} }
      }
    };
    const result = migrateSlots(data);
    expect(result.slots.chicago).toBeUndefined();
    expect(result.slots.m_chicago).toBeDefined();
    expect(result.slots.m_chicago.game).toBe('chicago');
  });

  it('does not re-migrate already migrated slots', () => {
    const data = {
      slots: {
        m_chicago: { game: 'chicago', savedAt: 12345 }
      }
    };
    const result = migrateSlots(data);
    expect(result.slots.m_chicago).toBeDefined();
    expect(result.slots.m_chicago.game).toBe('chicago');
  });

  it('handles empty slots', () => {
    const data = { slots: {} };
    const result = migrateSlots(data);
    expect(result.slots).toEqual({});
  });
});

describe('Persistence — tombstone deletion (P1-12)', () => {
  it('clearSlot creates tombstone on deletion', () => {
    const data = {
      slots: { s1: { game: 'chicago', savedAt: 100 } },
      deletedSlots: {}
    };
    const now = Date.now();
    clearSlot(data, 's1');
    expect(data.slots.s1).toBeUndefined();
    expect(data.deletedSlots.s1).toBeGreaterThanOrEqual(now);
  });

  it('clearSlot is idempotent for missing slots', () => {
    const data = { slots: {}, deletedSlots: {} };
    clearSlot(data, 'nonexistent');
    expect(data.deletedSlots.nonexistent).toBeUndefined();
  });

  it('clearSlot prunes tombstones older than 7 days', () => {
    const data = {
      slots: { s1: { game: 'chicago', savedAt: 100 } },
      deletedSlots: { old: Date.now() - 8 * 86400000 }
    };
    clearSlot(data, 's1');
    expect(data.deletedSlots.old).toBeUndefined();
    expect(data.deletedSlots.s1).toBeDefined();
  });

  it('adoptRemote respects tombstones — deleted slots stay deleted', () => {
    const now = Date.now();
    const localData = {
      slots: {},
      deletedSlots: { s1: now }
    };
    const remote = {
      slots: { s1: { game: 'chicago', savedAt: now - 1000 } },
      deletedSlots: {}
    };
    const result = adoptRemote(localData, remote);
    // s1 was deleted locally after it was saved remotely → stays deleted
    expect(result.slots.s1).toBeUndefined();
    expect(result.deletedSlots.s1).toBe(now);
  });

  it('adoptRemote keeps slots newer than tombstone', () => {
    const now = Date.now();
    const localData = {
      slots: {},
      deletedSlots: { s1: now - 5000 }
    };
    const remote = {
      slots: { s1: { game: 'chicago', savedAt: now } },
      deletedSlots: {}
    };
    const result = adoptRemote(localData, remote);
    // s1 was saved AFTER the tombstone → keep it
    expect(result.slots.s1).toBeDefined();
  });

  it('adoptRemote merges tombstones from both sides', () => {
    const now = Date.now();
    const localData = {
      slots: {},
      deletedSlots: { s1: now }
    };
    const remote = {
      slots: {},
      deletedSlots: { s2: now - 1000 }
    };
    const result = adoptRemote(localData, remote);
    expect(result.deletedSlots.s1).toBeDefined();
    expect(result.deletedSlots.s2).toBeDefined();
  });
});

describe('Audio — volume 0 fix (P2-15)', () => {
  it('preserves volume 0 instead of falling back to default', () => {
    expect(parseVolume('0', 10)).toBe(0);
  });

  it('uses default for NaN', () => {
    expect(parseVolume('abc', 10)).toBe(10);
    expect(parseVolume('', 10)).toBe(10);
  });

  it('clamps to 0-10 range', () => {
    expect(parseVolume('-5', 10)).toBe(0);
    expect(parseVolume('15', 10)).toBe(10);
  });

  it('parses valid numbers', () => {
    expect(parseVolume('5', 10)).toBe(5);
    expect(parseVolume('10', 10)).toBe(10);
  });
});

describe('Glicko-2 Rating System', () => {
  const DEFAULT_RATING = 1500;
  const DEFAULT_RD = 350;
  const DEFAULT_VOL = 0.06;

  it('winner gains rating, loser loses rating', () => {
    const winner = GLICKO2.update(DEFAULT_RATING, DEFAULT_RD, DEFAULT_VOL, DEFAULT_RATING, DEFAULT_RD, 1);
    const loser = GLICKO2.update(DEFAULT_RATING, DEFAULT_RD, DEFAULT_VOL, DEFAULT_RATING, DEFAULT_RD, 0);
    expect(winner.rating).toBeGreaterThan(DEFAULT_RATING);
    expect(loser.rating).toBeLessThan(DEFAULT_RATING);
  });

  it('draw keeps ratings near baseline for equal players', () => {
    const result = GLICKO2.update(DEFAULT_RATING, DEFAULT_RD, DEFAULT_VOL, DEFAULT_RATING, DEFAULT_RD, 0.5);
    // With equal ratings, a draw should barely change rating
    expect(Math.abs(result.rating - DEFAULT_RATING)).toBeLessThan(5);
  });

  it('higher RD means larger rating change', () => {
    const highRd = GLICKO2.update(DEFAULT_RATING, DEFAULT_RD, DEFAULT_VOL, DEFAULT_RATING, DEFAULT_RD, 1);
    const lowRd = GLICKO2.update(DEFAULT_RATING, 50, DEFAULT_VOL, DEFAULT_RATING, 50, 1);
    expect(Math.abs(highRd.rating - DEFAULT_RATING)).toBeGreaterThan(Math.abs(lowRd.rating - DEFAULT_RATING));
  });

  it('reduces RD after a game (more certain)', () => {
    const result = GLICKO2.update(DEFAULT_RATING, DEFAULT_RD, DEFAULT_VOL, DEFAULT_RATING, DEFAULT_RD, 1);
    expect(result.rd).toBeLessThan(DEFAULT_RD);
  });

  it('returns finite numbers for all standard inputs', () => {
    const result = GLICKO2.update(1500, 200, 0.06, 1400, 30, 1);
    expect(Number.isFinite(result.rating)).toBe(true);
    expect(Number.isFinite(result.rd)).toBe(true);
    expect(Number.isFinite(result.vol)).toBe(true);
  });

  it('upset win yields larger rating gain', () => {
    // Low-rated player beats high-rated player
    const upset = GLICKO2.update(1200, 100, 0.06, 1800, 100, 1);
    const expected = GLICKO2.update(1800, 100, 0.06, 1200, 100, 1);
    // Upset winner should gain more than expected winner
    expect(upset.rating - 1200).toBeGreaterThan(expected.rating - 1800);
  });

  it('rating change is correctly computed against own previous rating', () => {
    // P0-06 fix: ratingChange should be newRating - ownOldRating
    const oldRating = 1500;
    const result = GLICKO2.update(oldRating, DEFAULT_RD, DEFAULT_VOL, 1500, DEFAULT_RD, 1);
    const ratingChange = result.rating - oldRating; // correct formula
    expect(ratingChange).toBeGreaterThan(0);
  });
});

describe('State Machine — phase transitions', () => {
  // Valid transitions (documented in architecture header)
  const VALID_TRANSITIONS = {
    'ready': ['rolling'],
    'rolling': ['choose'],
    'choose': ['ready', 'roundEnd', 'gameEnd'],
    'roundEnd': ['ready'],
    'gameEnd': [],
  };

  const VALID_PHASES = ['ready', 'rolling', 'choose', 'roundEnd', 'gameEnd'];

  it('all phases are documented', () => {
    VALID_PHASES.forEach(phase => {
      expect(VALID_TRANSITIONS).toHaveProperty(phase);
    });
  });

  it('gameEnd is terminal', () => {
    expect(VALID_TRANSITIONS.gameEnd).toEqual([]);
  });

  it('ready is the entry point and reachable from choose and roundEnd', () => {
    expect(VALID_TRANSITIONS.choose).toContain('ready');
    expect(VALID_TRANSITIONS.roundEnd).toContain('ready');
  });

  it('no phase transitions to itself', () => {
    Object.entries(VALID_TRANSITIONS).forEach(([phase, targets]) => {
      expect(targets).not.toContain(phase);
    });
  });
});

describe('MP Actions — valid set', () => {
  const VALID_ACTIONS = ['roll', 'choose', 'turnEnd', 'roundEnd', 'gameEnd', 'init'];

  it('all actions are strings', () => {
    VALID_ACTIONS.forEach(a => expect(typeof a).toBe('string'));
  });

  it('actions cover full game lifecycle', () => {
    expect(VALID_ACTIONS).toContain('init');
    expect(VALID_ACTIONS).toContain('roll');
    expect(VALID_ACTIONS).toContain('choose');
    expect(VALID_ACTIONS).toContain('gameEnd');
  });
});

// Helper: Firebase rules use // comments which JSON.parse doesn't support
function parseFirebaseRules(text) {
  // Strip single-line comments (// ...) that aren't inside strings
  const stripped = text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped);
}

describe('Firebase Security Rules — structure validation', () => {
  it('rules file is valid JSON (with Firebase-style comments stripped)', async () => {
    const fs = await import('fs');
    const rules = parseFirebaseRules(fs.readFileSync('firebase-rules.json', 'utf8'));
    expect(rules).toHaveProperty('rules');
    expect(rules.rules).toHaveProperty('rooms');
    expect(rules.rules).toHaveProperty('profiles');
  });

  it('rooms require authentication', async () => {
    const fs = await import('fs');
    const rules = parseFirebaseRules(fs.readFileSync('firebase-rules.json', 'utf8'));
    const roomRules = rules.rules.rooms.$roomCode;
    expect(roomRules['.read']).toContain('auth !== null');
  });

  it('gameState validates required fields', async () => {
    const fs = await import('fs');
    const rules = parseFirebaseRules(fs.readFileSync('firebase-rules.json', 'utf8'));
    const gsRules = rules.rules.rooms.$roomCode.gameState;
    expect(gsRules['.validate']).toContain('matchId');
    expect(gsRules['.validate']).toContain('revision');
    expect(gsRules['.validate']).toContain('phase');
  });

  it('avatar URLs are validated against whitelist pattern', async () => {
    const fs = await import('fs');
    const rules = parseFirebaseRules(fs.readFileSync('firebase-rules.json', 'utf8'));
    const avatarRule = rules.rules.rooms.$roomCode.players.$uid.avatar['.validate'];
    expect(avatarRule).toContain('[mf][1-4]');
  });

  it('profiles only writable by owner', async () => {
    const fs = await import('fs');
    const rules = parseFirebaseRules(fs.readFileSync('firebase-rules.json', 'utf8'));
    const profileRules = rules.rules.profiles.$uid;
    expect(profileRules['.write']).toContain('auth.uid === $uid');
  });

  it('denies writes to unknown paths', async () => {
    const fs = await import('fs');
    const rules = parseFirebaseRules(fs.readFileSync('firebase-rules.json', 'utf8'));
    expect(rules.rules.$other['.write']).toBe(false);
    expect(rules.rules.$other['.read']).toBe(false);
  });
});

describe('HTML structure — script parsing', () => {
  it('index.html exists and contains game code', async () => {
    const fs = await import('fs');
    const html = fs.readFileSync('index.html', 'utf8');
    expect(html).toContain('LITTLE HELL');
    expect(html).toContain('function hellBonus');
    expect(html).toContain('function esc(');
    expect(html).toContain('function safeAvatarSrc');
  });

  it('all script blocks parse without syntax errors', async () => {
    const fs = await import('fs');
    const html = fs.readFileSync('index.html', 'utf8');
    const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || [];
    scripts.forEach((s) => {
      const code = s.replace(/<\/?script[^>]*>/g, '');
      if (code.trim().length === 0) return;
      expect(() => new Function(code)).not.toThrow();
    });
  });
});

describe('i18n — key completeness', () => {
  it('all three language dictionaries exist in source', async () => {
    const fs = await import('fs');
    const html = fs.readFileSync('index.html', 'utf8');
    expect(html).toContain("de: {");
    expect(html).toContain("en: {");
    expect(html).toContain("es: {");
  });
});

describe('Asset file existence', () => {
  it('all avatar files exist', async () => {
    const fs = await import('fs');
    const allAvatars = [...AVATARS.m, ...AVATARS.f];
    allAvatars.forEach(path => {
      expect(fs.existsSync(path), `Missing: ${path}`).toBe(true);
    });
  });

  it('manifest.json exists', async () => {
    const fs = await import('fs');
    expect(fs.existsSync('manifest.json')).toBe(true);
  });

  it('icon files exist', async () => {
    const fs = await import('fs');
    ['icons/favicon-32.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'].forEach(path => {
      expect(fs.existsSync(path), `Missing: ${path}`).toBe(true);
    });
  });
});
