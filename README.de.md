<p align="center">
  <img src="assets/readme/Smile_LauncHer_logo.png" width="360" alt="Smile LauncHer">
</p>

# Smile LauncHer

Ein lokaler Minecraft: Java Edition Launcher für Windows.

**Sprachen:** [English](README.md) · [Русский](README.ru.md) · [Deutsch](README.de.md)

SLH trennt Minecraft-Instanzen voneinander, verwaltet Konten und Java lokal und installiert kompatible Inhalte in die ausgewählte Instanz. Der Launcher basiert auf Tauri, React, TypeScript, Rust und SQLite.

> **Status:** Entwicklungsversion. Sichere wichtige Welten, bevor du einen neuen Build ausprobierst.

## Funktionen

- Getrennte Minecraft-Instanzen mit Gruppen, Raster-/Listenansicht, Logs, Welten, Screenshots und individuellen Einstellungen.
- Vanilla, Fabric, Forge, NeoForge und Quilt.
- Microsoft-, Ely.by- und Offline-Konten.
- Modrinth-Suche und geprüfte Installation; CurseForge ist verfügbar, wenn der Zugriff eingerichtet ist.
- Verwaltetes Eclipse Temurin Java 8, 17, 21 und 25 sowie Erkennung vorhandener Java-Laufzeiten.
- Englisch, Russisch und Deutsch sind enthalten; eigene Übersetzungen werden unterstützt.
- Optionaler lokaler Austausch ausgewählter Dateien zwischen Instanzen mit expliziter Einrichtung und Backups.
- Keine Analytik und keine Werbung. Launcher-Daten bleiben auf dem lokalen Gerät.

## Screenshots

<p align="center"><img src="assets/readme/Home.png" alt="SLH-Startseite" width="100%"></p>

<p align="center"><img src="assets/readme/Library.png" alt="SLH-Instanzbibliothek" width="100%"></p>

<p align="center"><img src="assets/readme/Discover.png" alt="SLH Discover" width="100%"></p>

<p align="center"><img src="assets/readme/SettingsAppearance.png" alt="SLH-Erscheinungsbild-Einstellungen" width="100%"></p>

<p align="center"><img src="assets/readme/SettingsSync.png" alt="SLH-Synchronisierungseinstellungen" width="100%"></p>

<table>
  <tr>
    <td width="50%"><img src="assets/readme/Skin1.png" alt="SLH-Skinauswahl"></td>
    <td width="50%"><img src="assets/readme/Skin2.png" alt="SLH-Skin-Einstellungen"></td>
  </tr>
</table>

## Download

Lade den passenden Build über [GitHub Releases](https://github.com/gareldd/slh/releases) herunter.

| Paket | Verwende es, wenn … |
| --- | --- |
| `*-setup.exe` | du eine geführte Standardinstallation möchtest. |
| `*.msi` | du ein MSI für manuelle oder verwaltete Bereitstellung brauchst. |
| `portable/` | du einen eigenständigen Ordner möchtest. Entpacke den **gesamten** Ordner auf ein beschreibbares lokales Laufwerk und starte `SLH.exe`. |

Portable Releases enthalten ein Archiv mit einer festen WebView2-Laufzeit. SLH entpackt diese beim ersten Start automatisch; zusätzliche Downloads oder eine Browser-Installation sind nicht nötig.

Release-Pakete sind absichtlich leer: Sie enthalten keine Konten, Instanzen, Java-Installationen, Welten, Logs oder Caches.

## Datenschutz und Konten

SLH speichert Daten lokal. Für die Microsoft-Anmeldung wird eine konfigurierte Client-ID benötigt; die Verfügbarkeit von CurseForge hängt von der eingerichteten Zugriffsmethode oder einem Schlüssel ab. `data/` darf niemals committet oder veröffentlicht werden: Der Ordner kann Konten, Tokens, Welten und private Serverdaten enthalten.

## Aus dem Quellcode bauen

Für die Entwicklung unter Windows werden Node.js/npm, Rust mit MSVC-Toolchain, Visual Studio Build Tools mit **Desktop development with C++** und Microsoft Edge WebView2 Runtime benötigt.

```powershell
npm install
npm run tauri:dev
```

Prüfungen:

```powershell
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

Anleitungen für Portable-Pakete und Installer: [DEVELOPMENT.md](DEVELOPMENT.md), [PORTABLE.md](PORTABLE.md).

> **Veröffentliche niemals deinen persönlichen Ordner `release/SLH-Portable`.** Das Portable-Buildskript erhält dessen `data/`, damit der Entwicklungs-Launcher seine Daten nicht verliert. Erstelle für GitHub einen sauberen Ordner und prüfe vor dem Upload, dass `data/` keine Dateien enthält.

## Architektur

Die React-Oberfläche wird in WebView2 angezeigt. Rust/Tauri erledigt privilegierte Aufgaben wie Dateien, SQLite, Java, Minecraft-Start und Netzwerkanfragen über eine typisierte IPC-Schnittstelle. Während der Entwicklung kann `localhost` verwendet werden; veröffentlichte Builds laden die Oberfläche aus gebündelten lokalen Dateien und stellen keinen öffentlichen Webserver bereit.

## Dokumentation

- [Architektur](ARCHITECTURE.md)
- [Authentifizierung](AUTH.md)
- [Sprachen](LANGUAGES.md)
- [Portable-Speicher](PORTABLE.md)
- [Fehler melden oder Verbesserung vorschlagen](https://github.com/gareldd/slh/issues)

## Lizenz

SLH wird unter der GNU General Public License v3.0 (GPLv3) veröffentlicht. Siehe [LICENSE](LICENSE).
