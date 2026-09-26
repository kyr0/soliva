// GalleryOverlay.tsx
// Die Seite der Galerie (/galerie): das Canvas, links die Liste der Modelle
// (nach Gruppen), unten die Animationen des gewählten Modells und Knöpfe zum
// Drehen - dazu für die Übersicht aller Modelle die Beschriftungen. Einmal
// gerendert; gallery.ts setzt über die zurückgegebenen Funktionen, was
// gewählt ist, und über die Elemente, wo die Beschriftungen stehen.

import { createRef, render, type Ref } from 'defuss';
import './GalleryOverlay.css';

/** Ein Eintrag der Liste: Gruppe, Name und seine Animationen (Namen). */
export interface GalleryItem {
  group: string;
  label: string;
  animations: string[];
  /** Zusatz zur gewählten Animation, z. B. "Abriss" bei Gebäuden - ein- und ausschaltbar. */
  extras?: string[];
}

export interface GalleryHooks {
  /** Modell gewählt - Index in `items`, oder -1 für die Übersicht aller. */
  select(index: number): void;
  /** Animation des gewählten Modells gewählt. */
  animate(index: number): void;
  /** Zusatz (Abriss) ein- oder ausschalten. */
  extra(): void;
  /** Ansicht drehen: -1 links herum, +1 rechts herum. */
  rotate(step: number): void;
}

export interface GalleryElements {
  canvas: HTMLCanvasElement;
  /** Übersicht: je Stück seine Beschriftung, in der Reihenfolge von `labels`. */
  labels: HTMLDivElement[];
  /** Übersicht: je Reihe ihr Titel, in der Reihenfolge von `titles`. */
  titles: HTMLDivElement[];
  /** Zeigt, was gewählt ist: Modell (-1 = Übersicht), Animation und ob der Zusatz läuft. */
  show(item: number, animation: number, extra: boolean): void;
  /** Die Dateien der gezeigten Modelle (src/models) unter dem Namen. */
  files(names: readonly string[]): void;
}

/**
 * Rendert die Galerie-Seite in `root`.
 * @param labels, titles Beschriftungen der Übersicht
 */
export function mountGallery(root: HTMLElement, items: GalleryItem[], labels: string[], titles: string[], hooks: GalleryHooks): GalleryElements {
  const canvas = createRef<HTMLCanvasElement>();
  const overview = createRef<HTMLDivElement>();
  const labelRefs: Ref<HTMLDivElement>[] = labels.map(() => createRef());
  const titleRefs: Ref<HTMLDivElement>[] = titles.map(() => createRef());
  const allRef = createRef<HTMLButtonElement>();
  const stage = createRef<HTMLDivElement>();
  const heading = createRef<HTMLDivElement>();
  const fileLine = createRef<HTMLDivElement>();
  const chips = createRef<HTMLDivElement>();

  const groups = [...new Set(items.map((it) => it.group))];
  render(
    <>
      <canvas ref={canvas} class="gal-canvas" />
      {/* Übersicht: Beschriftungen, gesetzt je Bild von gallery.ts */}
      <div class="gal-labels" ref={overview}>
        {labels.map((text, i) => <div ref={labelRefs[i]} class="gal-label">{text}</div>)}
        {titles.map((text, i) => <div ref={titleRefs[i]} class="gal-row-title">{text}</div>)}
      </div>

      <nav class="gal-list">
        <div class="gal-brand">
          <b>Soliva</b> · Galerie
          <a href="/">zum Spiel</a>
        </div>
        <button type="button" class="gal-item gal-all" ref={allRef} onClick={() => hooks.select(-1)}>Alle auf einmal</button>
        {/* Flach, Gruppe für Gruppe - verschachtelte Fragmente rendert defuss nicht. */}
        {groups.flatMap((group) => [
          <div class="gal-group">{group}</div>,
          ...items.flatMap((it, i) => it.group === group
            ? [<button type="button" class="gal-item" data-index={String(i)} onClick={() => hooks.select(i)}>{it.label}</button>]
            : []),
        ])}
      </nav>

      {/* Unten: Name, Animationen, Drehen - nur für ein einzelnes Modell. */}
      <div class="gal-stage" ref={stage}>
        <div class="gal-heading" ref={heading} />
        <div class="gal-file" ref={fileLine} />
        <div class="gal-chips" ref={chips} />
        <div class="gal-rotate">
          <button type="button" class="wood-btn" title="Links herum drehen" onClick={() => hooks.rotate(-1)}>⟲</button>
          <button type="button" class="wood-btn" title="Rechts herum drehen" onClick={() => hooks.rotate(1)}>⟳</button>
        </div>
      </div>
      <div class="gal-help">Ziehen dreht in alle Richtungen · rechts ziehen verschiebt · Mausrad zoomt · Q/E drehen · W/S neigen · ↑/↓ Modell · ←/→ Animation</div>
    </>,
    root,
  );

  // Die Knöpfe der Liste - Refs in der verschachtelten Liste setzt defuss nicht.
  const itemButtons = [...root.querySelectorAll<HTMLButtonElement>('.gal-item[data-index]')];
  const show = (item: number, animation: number, extra: boolean) => {
    allRef.current.classList.toggle('active', item < 0);
    for (const b of itemButtons) b.classList.toggle('active', Number(b.dataset.index) === item);
    overview.current.hidden = item >= 0;
    stage.current.hidden = item < 0;
    if (item < 0) return;
    const it = items[item];
    heading.current.textContent = `${it.group} · ${it.label}`;
    chips.current.replaceChildren();
    render(
      <>
        {it.animations.map((name, i) => (
          <button type="button" class={i === animation ? 'wood-btn gal-chip active' : 'wood-btn gal-chip'} onClick={() => hooks.animate(i)}>{name}</button>
        ))}
        {/* Zusatz, abgesetzt: gilt für die gewählte Variante. */}
        {(it.extras ?? []).map((name) => (
          <button type="button" class={extra ? 'wood-btn danger gal-chip gal-extra active' : 'wood-btn danger gal-chip gal-extra'} onClick={() => hooks.extra()}
            title={`${name} der gewählten Variante ein/aus`}>{extra ? `■ ${name}` : `▶ ${name}`}</button>
        ))}
      </>,
      chips.current,
    );
    itemButtons.find((b) => Number(b.dataset.index) === item)?.scrollIntoView({ block: 'nearest' });
  };

  return {
    canvas: canvas.current,
    labels: labelRefs.map((r) => r.current),
    titles: titleRefs.map((r) => r.current),
    show,
    files: (names) => {
      const text = names.join(' · ');
      if (fileLine.current.textContent !== text) fileLine.current.textContent = text;
    },
  };
}
