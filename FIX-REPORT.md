# Fix Report — Little Hell Code Review

## Fixbericht-Tabelle

| ID | Problemursache | Datei / Funktion | Lösung | Testfall | Status |
|---|---|---|---|---|---|
| **P0-01** | Avatar-Zuordnung nicht persistiert; pickAvatar() bei jedem Spielstart neu aufgerufen | `index.html` / `hell.startGame()`, `setupPlayers()` | Stabile `playerId` + `avatar` in Session + Save-Slot persistiert; Legacy-Migration aus `state.players[].avatar`; pickAvatar nur für neue Teilnehmer | Avatar-Stabilität über 3/10/20 Partien; Save/Reload/Resume | ✅ Bestanden |
| **P0-02** | Beide Clients simulieren eigenen lokalen Zustand; unvollständiges gameState in Firebase; Race Conditions bei Rundenübergängen | `index.html` / `_buildSnapshot()`, `pushState()`, `onRemoteStateUpdate()` | Einziger autoritativer Snapshot mit matchId + monotoner revision; vollständige playerStates; atomares `.set()` statt `.update()` | State-Identität nach jeder Revision zwischen 2 Clients | ⚠️ NICHT VERIFIZIERT (erfordert 2-Client-Test mit Firebase) |
| **P0-03** | `endGame` setzt `mpActive=false` vor `pushState('gameEnd')` | `index.html` / `hell.endGame()` | Phase='gameEnd' und pushState vor mpActive=false; atomare Finalisierung | Endspiel-Meldung bei beiden Clients | ⚠️ NICHT VERIFIZIERT (erfordert 2-Client-Test) |
| **P0-04** | `onRemoteStateUpdate` filtert nach actorUid statt revision; setzt eigenmächtig Phase | `index.html` / `onRemoteStateUpdate()` | matchId-Prüfung + Revisions-Monotonie; vollständige Snapshot-Adoption; keine eigenmächtige Phase-Änderung | Reconnect + Tab-Wechsel rekonstruiert State | ⚠️ NICHT VERIFIZIERT (erfordert 2-Client-Test) |
| **P0-05** | Ungeschützte update()-Schreibvorgänge; separater DOM-Event-Listener für Save-Push | `index.html` / `pushState()`, `MP.isMyTurn()` | `_actionInFlight`-Guard; `.set()` für atomare Übergänge; zentrale `isMyTurn()` Autorisierung | Doppelklick-Test; concurrent actions | ✅ Bestanden (Client-Guard); ⚠️ Security Rules NICHT VERIFIZIERT (erfordert Emulator) |
| **P0-06** | Finale Wertung nicht idempotent; ratingChange gegen gegnerisches statt eigenes Rating | `index.html` / `hell.endGame()`, `updateRatings()` | `_finalizedMatchIds`-Set; Glicko-2 einmal pro Match; ratingChange = newRating - ownOldRating | Glicko-2 Referenzfälle; idempotente Finalisierung | ✅ Bestanden (Unit-Tests) |
| **P1-07** | Falscher Host-Vergleich; doppelter Spielstart | `index.html` / `listenRoom()`, `startMultiplayerGame()` | Host-UID aus DB; `_initializedMatchId`-Guard | Init nur einmal pro matchId | ✅ Bestanden |
| **P1-08** | UI nicht vollständig für MP abgeschirmt | `index.html` / `syncTurnUI()`, Click-Handler | `MP.isMyTurn()` prüft turnUid+phase+revision; syncTurnUI für alle Phasen | Gegner kann nicht würfeln/speichern | ✅ Bestanden (Code-Analyse) |
| **P1-09** | restoreHell() setzt immer phase='ready' | `index.html` / `restoreHell()` | Phasen-getreue Wiederherstellung für ready/choose/roundEnd/gameEnd | Restore in allen Phasen | ✅ Bestanden |
| **P1-10** | timerEpoch schützt nicht alle Callbacks | `index.html` / `scheduleTimeout()`, `scheduleInterval()` | Epoche bei Start/Restore/Matchwechsel erhöht; alle Timer über epochale Wrapper | Stale Callbacks wirkungslos nach Navigation | ✅ Bestanden |
| **P1-11** | Ghost-Players; Room-Löschung während Partie; fehlende Presence | `index.html` / `createRoom()`, `joinRoom()`, `leaveRoom()`, `listenRoom()` | onDisconnect-Handler; leaveRoom markiert offline statt löschen; Opponent-Monitoring mit Toasts; .info/connected; Host-Offline-Guard; i18n Keys DE/EN/ES | Presence-Tracking; Reconnect-Toasts | ✅ Bestanden (Code-Analyse); ⚠️ Live-Test NICHT VERIFIZIERT |
| **P1-12** | Keine Tombstones; stille Wiederauferstehung gelöschter Slots | `index.html` / `clearSlot()`, `adoptRemote()`, `initCloud()` | Tombstone-basierte Löschverfolgung; bidirektionaler Merge; 7-Tage-Pruning; validateSaveData() | Tombstone-Tests: Löschung überlebt Sync | ✅ Bestanden (Unit-Tests) |
| **P1-13** | innerHTML-XSS über Spielernamen, Avatar-URLs, Labels | `index.html` / `esc()`, `safeAvatarSrc()` | HTML-Entity-Escaping; Avatar-URL-Whitelist; textContent wo möglich | XSS-Payloads in esc(); safeAvatarSrc Negativtests | ✅ Bestanden (Unit-Tests) |
| **P2-14** | Stats referenzieren per playerIdx | `index.html` / Session/History | Positionsbasierte Indexierung innerhalb Sessions stabil; tiefere Migration vorgemerkt | Summen-Konsistenz | ✅ Bestanden (Analyse) |
| **P2-15a** | Volume 0 geht verloren (parseInt || DEFAULT) | `index.html` / Audio-Init | `isNaN(n) ? DEFAULT : n` | Volume 0 persistiert korrekt | ✅ Bestanden (Unit-Tests) |
| **P2-15b** | i18n Keys unvollständig | `index.html` / LANGS | Alle 255 Keys in DE/EN/ES verifiziert | Automated key count check | ✅ Bestanden |
| **P2-15c** | applyLang() ignoriert data-i18n-html/title | `index.html` / `applyLang()` | Handler für data-i18n-html und data-i18n-title hinzugefügt | Attribute werden angewendet | ✅ Bestanden |
| **Arch** | Keine modulare Schichtung; kein dokumentierter Zustandsautomat | `index.html` | 8 nummerierte Modul-Abschnitte; State-Machine-Diagramm; Match-State-Schema | Architektur-Dokumentation vorhanden | ✅ Bestanden |

## Legende

- ✅ **Bestanden** — Durch automatisierte Tests oder Code-Analyse eindeutig belegt
- ⚠️ **NICHT VERIFIZIERT** — Erfordert echte Firebase-Testumgebung (Emulator oder 2-Client-Setup); reproduzierbare manuelle Prüfschritte unten

## Manuelle Zwei-Geräte-Prüfschritte

### Test A: Avatar-Stabilität
1. Öffne index.html in Browser A
2. Starte eine Partie mit 3 Spielern (1 Mensch, 2 KI)
3. Notiere die Avatar-Zuordnung aller Spieler
4. Spiele 3 Partien in derselben Session — Avatare müssen identisch bleiben
5. Schließe den Browser, öffne neu, setze fort — Avatare müssen identisch bleiben
6. Lade einen alten Spielstand — Legacy-Avatare müssen migriert werden

### Test B: 2-Client-Online-Partie über alle Runden
1. Öffne index.html in Browser A und B (verschiedene Inkognito-Fenster)
2. Browser A: Raum erstellen, Code notieren
3. Browser B: Raum beitreten mit Code
4. Browser A: Spiel starten
5. Spiele alle 16 Runden durch, abwechselnd würfelnd
6. Nach jeder Runde: Prüfe dass beide Browser identischen Score, Target, Phase und History anzeigen
7. Besonders prüfen: Höllenpasch, Pasch, 1/2/3 Würfe, Rundenübergang
8. Am Ende: Beide Browser zeigen identisches Ergebnis und Statistik
9. Reload beider Browser: Endergebnis wird korrekt angezeigt

### Test C: Latenz und Reconnect
1. Wie Test B, aber: Nach Runde 3 Browser B für 10 Sekunden offline nehmen
2. Browser B wieder online: State muss vollständig rekonstruiert werden
3. Doppelklick auf Würfel-Button: Nur eine Aktion wird ausgeführt
4. Refresh während Würfel-Animation: Zustand nach Refresh konsistent

## Firebase Security Rules — Einspielanleitung

1. Öffne die [Firebase Console](https://console.firebase.google.com/project/little-hell/database/rules)
2. Ersetze die bestehenden Regeln durch den Inhalt von `firebase-rules.json`
3. Klicke "Publish" / "Veröffentlichen"
4. **Achtung**: Bestehende Produktivdaten werden NICHT gelöscht. Die Regeln schränken nur zukünftige Schreib-/Leseoperationen ein.
5. Zum Testen mit dem Firebase Emulator:
   ```bash
   npm install -g firebase-tools
   firebase init emulators  # Database auswählen
   firebase emulators:start --only database
   # Rules werden automatisch aus firebase-rules.json geladen
   ```

## Testbefehle

```bash
# Unit-Tests ausführen
npx vitest run

# Tests im Watch-Modus
npx vitest

# Mit Coverage
npx vitest run --coverage
```
