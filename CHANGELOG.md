# CHANGELOG — Little Hell

## [2.0.0] — Code Review & Refactoring (gemäß Verbindlichem Auftrag)

### P0 — Kritische Defekte behoben

- **P0-01 Stabile Avatar-Identität**: Jedem Spieler wird eine über die Session stabile `playerId` und `avatar` zugewiesen. Beim Fortsetzen, Browserneustart und über Partien hinweg bleiben Avatare identisch. Legacy-Spielstände werden migriert. `pickAvatar()` wird nur für neue Teilnehmer aufgerufen.

- **P0-02 Deterministische Firebase-Rundenübergänge**: Einführung eines autoritativen Match-State-Snapshots mit `matchId` und monotoner `revision`. Vollständige `playerStates` (scores, dice, saves, rollsUsed, lockedSave, history) werden atomar per `.set()` geschrieben. Keine unabhängig hochzählenden Runden mehr. `_buildSnapshot()` serialisiert den gesamten Zustand; `onRemoteStateUpdate()` adoptiert ihn idempotent.

- **P0-03 Endspiel-Meldung wird korrekt übertragen**: `hell.endGame` setzt `phase='gameEnd'` und ruft `pushState('gameEnd')` auf, bevor `MP.mpActive = false` gesetzt wird. Atomare Finalisierung im autoritativen Zustand.

- **P0-04 Remote-Zustand korrekt interpretiert**: `onRemoteStateUpdate` prüft `matchId`-Identität und `revision`-Monotonie statt `actorUid`. Vollständige Snapshot-Adoption: scores, dice, saves, rollsUsed, lockedSave, history, phase, round, target, turnPos. Stale und eigene Echos werden ignoriert.

- **P0-05 Doppelte Aktionen eliminiert**: `MP._actionInFlight`-Guard verhindert parallele Schreibvorgänge. `pushState` verwendet `.set()` statt `.update()` für atomare Übergänge. `MP.isMyTurn()` als zentrale Autorisierung.

- **P0-06 Idempotente finale Wertung**: `_finalizedMatchIds`-Set verhindert mehrfaches Addieren von Session-Punkten. Glicko-2-Berechnung genau einmal pro Match. `ratingChange` korrekt gegen eigenes vorheriges Rating berechnet.

### P1 — Sekundäre Fixes

- **P1-07 Host-Sortierung und Spielstart**: Deterministische Spielerreihenfolge aus Firebase `players`-Knoten. `MP._initializedMatchId` schützt gegen doppelte Initialisierung.

- **P1-08 UI-Abschirmung im Multiplayer**: `MP.isMyTurn()` prüft `turnUid === MP.uid` und autoritative Phase. `syncTurnUI()` deckt alle Phasen ab. Würfel-Click, Save-Buttons und Tastatur nur bei eigenem Zug.

- **P1-09 Zustandsgetreues Restore**: `restoreHell()` stellt alle Phasen korrekt wieder her: ready, choose, roundEnd, gameEnd. Würfelzustand, saves und rollsUsed werden exakt reproduziert.

- **P1-10 Timer-Epoche und async Effekte**: `timerEpoch` wird bei Spielstart, Restore und Matchwechsel erhöht. Alle `setTimeout`/`setInterval` verwenden epochale Wrapper (`scheduleTimeout`, `scheduleInterval`). Stale Callbacks werden wirkungslos.

- **P1-11 Room Lifecycle / Online-Präsenz**: `onDisconnect().set(false)` für beide Spieler. `leaveRoom` löscht während aktiver Partie nicht den Raum. Gegner-Online-Status-Monitoring mit Toast-Benachrichtigungen. Firebase `.info/connected`-Überwachung. Host-Offline-Guard beim Beitreten.

- **P1-12 Persistenz und Mehrgeräte-Konflikte**: Tombstone-basierte Löschverfolgung (`deletedSlots`) verhindert Wiederauferstehung gelöschter Slots. `adoptRemote()` merged Tombstones beidseitig. `validateSaveData()` für Schema-Validierung. 7-Tage-Pruning für Tombstones.

- **P1-13 HTML-Injektion und unsichere Profile**: `esc()` HTML-Entity-Escaping für alle innerHTML-Templates. `safeAvatarSrc()` Whitelist für Avatar-URLs. Spielernamen, Labels und Story-Texte werden escaped.

### P2 — Tertiäre Fixes

- **P2-14 Stats und Identität**: Positionsbasierte Indexierung ist innerhalb von Sessions stabil. Tiefere ID-basierte Migration für Architekturaufgabe vorgemerkt.

- **P2-15 Audio, i18n, Assets**:
  - Volume 0 Bug: `parseInt(v) || DEFAULT` durch `isNaN(n) ? DEFAULT : n` ersetzt
  - i18n: Alle 255 Keys in DE/EN/ES verifiziert komplett
  - `applyLang()`: Unterstützt `data-i18n-html` und `data-i18n-title` Attribute
  - Audio-Autoplay: Alle `.play()` Aufrufe haben `.catch()`, Visibility-Handler pausiert/resumed

### Architektur (C)

- Modulare Schichtung innerhalb der Single-File-HTML mit nummerierten Abschnittsmarkern:
  1. Core Infra (Timer-Epoche, DOM-Helpers, XSS-Utils)
  2. Audio (SFX) — 5-Kanal Web Audio
  3. Persistence — localStorage + Cloud Sync
  4. Game Engine — Pure State, Regeln, Scoring
  5. Renderer — UI-Komponenten, Animationen
  6. Statistics — Charts, Historie (inline in Engine)
  7. Multiplayer — Firebase Transport, Room Lifecycle, Glicko-2
  8. I18N — LANGS, t()/tf(), applyLang()

- Zustandsautomat dokumentiert:
  `ready → rolling → choose → ready|roundEnd|gameEnd`

- Autoritativer Match-State mit Schema: matchId, revision, phase, round, target, turnPos, turnUid, playerStates, order, lastAction, actorUid, timestamp

### Lieferumfang

- `index.html` — Vollständiges lauffähiges Spiel (Single-File)
- `firebase-rules.json` — RTDB Security Rules
- `tests/game-logic.test.js` — 65 automatisierte Unit-Tests (Vitest)
- `CHANGELOG.md` — Dieses Dokument
- `FIX-REPORT.md` — Fixbericht-Tabelle
- Alle Assets (avatars/, sounds/, icons/, manifest.json)
