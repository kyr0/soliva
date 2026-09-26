// SettingsMenu.tsx
// Menü als Holztafel in der Bildmitte (Zahnrad an der Rohstoffleiste oder
// F10, wie in AoE2): Spielerfarbe, Pause, Tempo, Ton und Musik, Kamera-Tempo,
// Anzeigen, Grafik, Speichern, zurück ins Hauptmenü. Einmal gerendert; refresh()
// setzt über Refs, was sich auch von außen ändert (Pause, Ton, laufendes
// Musikstück).

import { createRef, render, type Ref } from 'defuss';
import './SettingsMenu.css';
import woodBar from '../icons/wood-bar.png';
import { PLAYER_COLORS } from '../world/catalog';
import { ANIMALS_BELOW_DEFAULT, resetSettings, saveSettings, type Settings } from '../settings';
import { ANIMAL_CLASSES } from '../world/unit';
import { ZOOM_LEVELS } from '../game/Camera';
import { ShortcutList } from './Shortcuts';
import { confirmDialog } from './ConfirmDialog';

/** Was das Menü außer den Einstellungen braucht - main.ts liefert es. */
export interface MenuHooks {
  /** Nach jeder Änderung: Einstellungen anwenden. */
  apply(s: Settings): void;
  soundEnabled(): boolean;
  toggleSound(): void;
  paused(): boolean;
  togglePause(): void;
  /** Titel des Musikstücks, das gerade läuft, oder null. */
  musicTitle(): string | null;
  nextTrack(): void;
  /** Zurück ins Hauptmenü - dort geht es weiter, neu oder mit einem anderen Spielstand. */
  mainMenu(): void;
  /** Den Spielstand jetzt speichern. */
  save(): void;
}

const SPEEDS: [number, string][] = [[1, 'Normal'], [1.5, 'Schnell'], [2, 'Sehr schnell']];
/**
 * Wahl "bis Zoom N": Aus oder eine der Zoomstufen (Zoom 1 = weit draußen).
 * Gespeichert wird die Grenze in CSS-Pixeln je Tile, unter der es gilt - die
 * doppelte Pixelzahl der gewählten Stufe (Zoom 1 = 8 px → 16).
 */
function zoomChoices(off: string, upTo: (zoom: string) => string): [number, string, string][] {
  return [
    [0, 'Aus', off],
    ...ZOOM_LEVELS.map((px, i): [number, string, string] => [px * 2, String(i + 1), upTo(i === 0 ? 'Zoom 1' : `Zoom 1 bis ${i + 1}`)]),
  ];
}
/** Bäume als Bild bis zu dieser Zoomstufe - weit draußen sind Bäume nur noch wenige Pixel groß. */
const BILLBOARDS = zoomChoices('Bäume immer als 3D-Modell', (z) => `Bäume als Bild bei ${z}`);
/** Eine Tierart ausblenden bis zu dieser Zoomstufe. */
const HIDE_ANIMALS = zoomChoices('Immer zeigen', (z) => `Ausblenden bei ${z}`);
/** Die Tierarten in der Reihenfolge der Klassen: Kennung und Name. */
const ANIMAL_KINDS = ANIMAL_CLASSES.map((c) => [c.definition.type, c.definition.label] as const);

/** Regler 0..100 % mit der Zahl daneben. */
interface SliderRefs {
  input: Ref<HTMLInputElement>;
  output: Ref<HTMLOutputElement>;
}

const sliderRefs = (): SliderRefs => ({ input: createRef(), output: createRef() });

function Slider({ refs, min, max, step, onInput }: {
  refs: SliderRefs; min: number; max: number; step: number; onInput: (value: number) => void;
}) {
  return (
    <>
      <input type="range" min={String(min)} max={String(max)} step={String(step)} ref={refs.input}
        onInput={(e: Event) => onInput(Number((e.target as HTMLInputElement).value) / 100)} />
      <output ref={refs.output} />
    </>
  );
}

export class SettingsMenu {
  private root: HTMLDivElement;
  private opened = false;
  private pauseButton = createRef<HTMLButtonElement>();
  private soundButton = createRef<HTMLButtonElement>();
  private speedButtons = SPEEDS.map(() => createRef<HTMLButtonElement>());
  private billboardButtons = BILLBOARDS.map(() => createRef<HTMLButtonElement>());
  private animalButtons = new Map(ANIMAL_KINDS.map(([kind]) => [kind, HIDE_ANIMALS.map(() => createRef<HTMLButtonElement>())]));
  private colorButtons = new Map(Object.keys(PLAYER_COLORS).map((key) => [key, createRef<HTMLButtonElement>()]));
  private volume = sliderRefs();
  private music = sliderRefs();
  private scroll = sliderRefs();
  private track = createRef<HTMLSpanElement>();
  private showHelp = createRef<HTMLInputElement>();
  private showDebug = createRef<HTMLInputElement>();
  private idleFps = createRef<HTMLInputElement>();
  private minimapFps = createRef<HTMLInputElement>();
  /** Nur im Spiel: Hauptmenü, Pause, Speichern, Weiter spielen - aus dem Hauptmenü heraus stattdessen Zurück. */
  private pauseRow = createRef<HTMLDivElement>();
  private gameButtons = createRef<HTMLDivElement>();
  private mainMenuRow = createRef<HTMLDivElement>();
  private backButton = createRef<HTMLDivElement>();
  private title = createRef<HTMLDivElement>();
  private saveButton = createRef<HTMLButtonElement>();
  private savedTimer = 0;

  constructor(private settings: Settings, private hooks: MenuHooks) {
    this.root = document.createElement('div');
    this.root.id = 'menu';
    this.root.hidden = true;
    document.body.appendChild(this.root);
    // Klick neben die Tafel schließt das Menü.
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root) this.close();
    });
    render(this.board(), this.root);
    this.refresh();
  }

  private board() {
    const act = (fn: () => void) => () => {
      fn();
      this.refresh();
    };
    return (
      <div class="menu-board" role="dialog" aria-label="Menü" style={`background-image:url(${woodBar})`}>
        <img class="menu-logo" src="/logo.svg" alt="Soliva" />
        <div class="menu-title" ref={this.title}>Menü</div>
        <div class="menu-top" ref={this.mainMenuRow}>
          <button type="button" class="wood-btn menu-btn" onClick={() => this.mainMenu()}>← Hauptmenü</button>
        </div>
        <section>
          <h3>Spieler</h3>
          <div class="menu-row">
            <span>Farbe</span>
            <span class="menu-colors">
              {Object.entries(PLAYER_COLORS).map(([key, c]) => (
                <button type="button" title={c.label} style={`background:${c.color.toRgbString()}`}
                  ref={this.colorButtons.get(key)!} onClick={() => this.change({ playerColor: key })} />
              ))}
            </span>
          </div>
        </section>
        <section>
          <h3>Spiel</h3>
          <div class="menu-row" ref={this.pauseRow}>
            <span>Pause <small>F3</small></span>
            <button type="button" class="wood-btn menu-btn" ref={this.pauseButton} onClick={act(() => this.hooks.togglePause())} />
          </div>
          <div class="menu-row">
            <span>Geschwindigkeit</span>
            <span class="menu-choice">
              {SPEEDS.map(([value, label], i) => (
                <button type="button" class="wood-btn" ref={this.speedButtons[i]} onClick={() => this.change({ speed: value })}>{label}</button>
              ))}
            </span>
          </div>
        </section>
        <section>
          <h3>Ton</h3>
          <div class="menu-row">
            <span>Ton <small>M</small></span>
            <button type="button" class="wood-btn menu-btn" ref={this.soundButton} onClick={act(() => this.hooks.toggleSound())} />
          </div>
          <div class="menu-row">
            <span>Lautstärke</span>
            <Slider refs={this.volume} min={0} max={100} step={5} onInput={(v) => this.change({ volume: v })} />
          </div>
          <div class="menu-row">
            <span>Musik</span>
            <Slider refs={this.music} min={0} max={100} step={5} onInput={(v) => this.change({ music: v })} />
          </div>
          <div class="menu-row">
            <span class="menu-track" ref={this.track} />
            <button type="button" class="wood-btn menu-btn" onClick={act(() => this.hooks.nextTrack())}>Nächstes Stück</button>
          </div>
        </section>
        <section>
          <h3>Steuerung</h3>
          <div class="menu-row">
            <span>Kamera-Tempo</span>
            <Slider refs={this.scroll} min={50} max={200} step={10} onInput={(v) => this.change({ scroll: v })} />
          </div>
          <details class="menu-keys-box">
            <summary>Tastenkürzel</summary>
            <ShortcutList />
          </details>
        </section>
        <section>
          <h3>Anzeige</h3>
          <label class="menu-row">
            <span>Tastenhilfe <small>I</small></span>
            <input type="checkbox" ref={this.showHelp}
              onInput={(e: Event) => this.change({ showHelp: (e.target as HTMLInputElement).checked })} />
          </label>
          <label class="menu-row">
            <span>Legende und Entwickler-Infos <small>P</small></span>
            <input type="checkbox" ref={this.showDebug}
              onInput={(e: Event) => this.change({ showDebug: (e.target as HTMLInputElement).checked })} />
          </label>
        </section>
        <section>
          <h3>Grafik</h3>
          <div class="menu-row">
            <span title="Bäume als flaches Bild statt als 3D-Modell - weit draußen sieht man kaum einen Unterschied, das Spiel läuft aber flüssiger.">Bäume als Bild bis Zoom</span>
            <span class="menu-choice">
              {BILLBOARDS.map(([value, label, hint], i) => (
                <button type="button" class="wood-btn" title={hint} ref={this.billboardButtons[i]} onClick={() => this.change({ billboards: value })}>{label}</button>
              ))}
            </span>
          </div>
          <p class="menu-hint">
            Bis zu dieser Zoomstufe (1 = weit draußen, 5 = ganz nah) werden Bäume als flaches Bild statt als
            3D-Modell gezeichnet - das Spiel läuft flüssiger, weit draußen sieht man kaum einen Unterschied.
            {import.meta.env.DEV ? ' Entwicklermodus: die Bilder liegen in tools/export/out/billboards/.' : ''}
          </p>
          <details class="menu-keys-box">
            <summary title="Weit draußen sind Tiere kaum zu sehen - ausgeblendet läuft das Spiel flüssiger. Sie leben trotzdem weiter.">Tiere ausblenden bis Zoom</summary>
            {ANIMAL_KINDS.map(([kind, name]) => (
              <div class="menu-row">
                <span>{name}</span>
                <span class="menu-choice">
                  {HIDE_ANIMALS.map(([value, label, hint], i) => (
                    <button type="button" class="wood-btn" title={hint} ref={this.animalButtons.get(kind)![i]}
                      onClick={() => this.change({ animalsBelow: { ...this.settings.animalsBelow, [kind]: value } })}>{label}</button>
                  ))}
                </span>
              </div>
            ))}
            <p class="menu-hint">
              Bis zu dieser Zoomstufe wird die Tierart nicht gezeichnet - die Tiere leben trotzdem weiter.
            </p>
          </details>
          <label class="menu-row">
            <span>Im Stillstand 30 FPS</span>
            <input type="checkbox" ref={this.idleFps}
              onInput={(e: Event) => this.change({ idleFps: (e.target as HTMLInputElement).checked })} />
          </label>
          <p class="menu-hint">
            Steht die Kamera eine Sekunde still, zeichnet das Spiel nur noch 30 Bilder je Sekunde - schont Akku
            und Lüfter. Beim Verschieben, Zoomen oder Drehen sofort wieder volle Bildrate.
          </p>
          <label class="menu-row">
            <span>Minimap mit 10 FPS</span>
            <input type="checkbox" ref={this.minimapFps}
              onInput={(e: Event) => this.change({ minimapFps: (e.target as HTMLInputElement).checked })} />
          </label>
          <p class="menu-hint">
            Die Minimap wird nur 10-mal je Sekunde gezeichnet - sie bewegt sich langsam, man sieht es kaum.
            Aus: so oft wie das Spiel.
          </p>
        </section>
        <section>
          <div class="menu-row">
            <span>Alle Einstellungen</span>
            <button type="button" class="wood-btn menu-btn" onClick={() => this.reset()}>Zurücksetzen</button>
          </div>
        </section>
        <div class="menu-footer" ref={this.gameButtons}>
          <button type="button" class="wood-btn menu-btn" ref={this.saveButton} onClick={() => this.save()}>Speichern</button>
          <button type="button" class="wood-btn menu-btn" onClick={() => this.close()}>Weiter spielen <small>Esc</small></button>
        </div>
        <div class="menu-footer menu-footer-end" ref={this.backButton} hidden>
          <button type="button" class="wood-btn menu-btn" onClick={() => this.close()}>Zurück <small>Esc</small></button>
        </div>
      </div>
    );
  }

  /** Speichern - der Knopf bestätigt es kurz. */
  private save() {
    this.hooks.save();
    const button = this.saveButton.current;
    button.textContent = 'Gespeichert ✓';
    clearTimeout(this.savedTimer);
    this.savedTimer = window.setTimeout(() => { button.textContent = 'Speichern'; }, 1500);
  }

  /** Zurück ins Hauptmenü - nach Rückfrage; der Stand wird vorher gespeichert (main.ts). */
  private async mainMenu() {
    if (!await confirmDialog('Zurück zum Hauptmenü? Das Spiel wird gespeichert.', { ok: 'Zum Hauptmenü' })) return;
    this.close();
    this.hooks.mainMenu();
  }

  isOpen(): boolean {
    return this.opened;
  }

  /** @param fromTitle aus dem Hauptmenü: ohne Hauptmenü, Pause, Speichern und Weiter spielen - nur Zurück. */
  open(fromTitle = false) {
    this.opened = true;
    this.root.hidden = false;
    this.pauseRow.current.hidden = fromTitle;
    this.gameButtons.current.hidden = fromTitle;
    this.mainMenuRow.current.hidden = fromTitle;
    this.backButton.current.hidden = !fromTitle;
    this.title.current.textContent = fromTitle ? 'Einstellungen' : 'Menü';
    this.refresh();
  }

  close() {
    this.opened = false;
    this.root.hidden = true;
  }

  toggle() {
    if (this.opened) this.close();
    else this.open();
  }

  /** Zustände neu anzeigen, die sich auch von außen ändern (Pause, Ton, Musik). */
  refresh() {
    const s = this.settings;
    this.pauseButton.current.textContent = this.hooks.paused() ? 'Fortsetzen' : 'Anhalten';
    this.soundButton.current.textContent = this.hooks.soundEnabled() ? 'An' : 'Aus';
    SPEEDS.forEach(([value], i) => this.speedButtons[i].current.classList.toggle('active', value === s.speed));
    BILLBOARDS.forEach(([value], i) => this.billboardButtons[i].current.classList.toggle('active', value === s.billboards));
    for (const [kind, refs] of this.animalButtons) {
      const below = s.animalsBelow[kind] ?? ANIMALS_BELOW_DEFAULT;
      HIDE_ANIMALS.forEach(([value], i) => refs[i].current.classList.toggle('active', value === below));
    }
    for (const [key, ref] of this.colorButtons) ref.current.classList.toggle('active', key === s.playerColor);
    const slider = (refs: SliderRefs, v: number) => {
      refs.input.current.value = String(Math.round(v * 100));
      refs.output.current.textContent = `${Math.round(v * 100)} %`;
    };
    slider(this.volume, s.volume);
    slider(this.music, s.music);
    slider(this.scroll, s.scroll);
    const title = this.hooks.musicTitle();
    this.track.current.textContent = title ? `♪ ${title}` : 'Musik beginnt mit dem ersten Klick';
    this.showHelp.current.checked = s.showHelp;
    this.showDebug.current.checked = s.showDebug;
    this.idleFps.current.checked = s.idleFps;
    this.minimapFps.current.checked = s.minimapFps;
  }

  /** Alle Einstellungen auf ihre Vorgaben - nach Rückfrage. */
  private async reset() {
    if (!await confirmDialog('Alle Einstellungen zurücksetzen?', { ok: 'Zurücksetzen' })) return;
    resetSettings(this.settings);
    this.change({});
  }

  private change(patch: Partial<Settings>) {
    Object.assign(this.settings, patch);
    saveSettings(this.settings);
    this.hooks.apply(this.settings);
    this.refresh();
  }
}
