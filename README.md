# Puzzle-App

Bild eines Puzzles laden, in ein Raster teilen und ein fotografiertes Puzzleteil im Bild finden.

Läuft komplett im Browser. Das Puzzlebild und die Teile werden nirgends hochgeladen.

## Benutzen

1. **Bild wählen**: das Puzzlebild (Vorlage).
2. Raster festlegen (Standard 40 × 50) und **Raster erstellen**.
3. **Teil wählen**: Foto des Puzzleteils. Es wird automatisch freigestellt (Hintergrund entfernt).
4. **Suchen**: die App zeigt die 3 wahrscheinlichsten Felder mit Vorschaubild und Übereinstimmung und markiert die Lage des Teils im Bild.

Tipps für das Foto: Teil vor einen einfarbigen, hellen Hintergrund legen, gleichmäßig ausleuchten, Teil mittig und gut sichtbar.
Teile ohne Muster (fast einfarbig) lassen sich nicht finden, dafür erscheint eine Fehlermeldung.

**Sichern** speichert das Projekt im Browser (IndexedDB, nur auf diesem Gerät und unter dieser Adresse).

## Veröffentlichen mit GitHub Pages

1. Repository anlegen (öffentlich) und `index.html` hochladen.
2. *Settings* → *Pages* → *Deploy from a branch* → Branch `main`, Ordner `/ (root)` → speichern.
3. Nach ein bis zwei Minuten ist die App unter `https://<name>.github.io/<repository>/` erreichbar.

## Dateien

- `index.html`: die komplette App (eine Datei, keine Abhängigkeiten).
- `bild-raster-katalog.jsx` (optional): dieselbe App als React-Komponente (benötigt React, Tailwind und lucide-react).
