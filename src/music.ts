// music.ts
// Hintergrundmusik: die Stücke aus assets/music/ in gemischter Reihenfolge,
// jedes erst wieder, wenn alle einmal dran waren, mit sanftem Übergang
// zwischen zweien. Gespielt wird mit <audio>-Elementen - die Dateien werden gestreamt,
// statt ganz in den Speicher dekodiert zu werden.
//
// Browser erlauben Ton erst nach einer Nutzeraktion - die Musik beginnt darum
// beim ersten Klick oder Tastendruck. Steht sie später (abgelehnt, oder die
// Seite kam per Zurück aus dem Browser-Cache und wurde dabei angehalten),
// läuft sie beim nächsten Klick oder Tastendruck weiter.

/** Anzeige-Titel je Datei (assets/music/<name>.mp3) - sonst aus dem Dateinamen. */
const TITLES: Record<string, string> = {
  a_colony_is_born: 'A Colony Is Born',
  colony_dawn: 'Colony Dawn',
  erntedankfest: 'Erntedankfest',
  erntedankfest_op_2: 'Erntedankfest Op. 2',
  foundations_of_a_new_home: 'Foundations of a New Home',
  fruehlingsfest: 'Frühlingsfest',
  lets_build_an_empire: 'Lets Build An Empire!',
  on_a_sunny_morning: 'On A Sunny Morning',
  wind_swellings: 'Wind Swellings',
};

const TRACKS: { title: string; url: string }[] = Object.entries(
  import.meta.glob('../assets/music/*.mp3', { eager: true, query: '?url', import: 'default' }) as Record<string, string>,
).map(([path, url]) => {
  const name = path.replace(/^.*\//, '').replace(/\.mp3$/, '');
  return { title: TITLES[name] ?? name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), url };
});

/** Sekunden, über die ein Stück aus- und das nächste eingeblendet wird. */
const FADE = 4;

export class Music {
  /** Zwei Spieler: einer läuft, der andere blendet beim Wechsel ein. */
  private players = [new Audio(), new Audio()];
  private current = 0;
  private order: number[] = [];
  private index = -1;
  private started = false;
  private level = 0.4;
  private muted = false;
  /** Laufende Überblendung: Start (performance.now, ms), von welchem zu welchem Spieler. */
  private fade: { start: number; from: HTMLAudioElement; to: HTMLAudioElement } | null = null;

  constructor() {
    for (const p of this.players) {
      p.preload = 'auto';
      p.addEventListener('timeupdate', () => {
        // Kurz vor dem Ende schon das nächste Stück einblenden.
        if (p === this.players[this.current] && !this.fade && p.duration && p.duration - p.currentTime < FADE) this.next();
      });
      p.addEventListener('ended', () => {
        if (p === this.players[this.current] && !this.fade) this.next();
      });
    }
    // Jede Nutzeraktion - in der Capture-Phase, damit kein stopPropagation
    // sie verschluckt. Safari zählt pointerdown nicht immer als Aktion, click
    // und touchend schon.
    const resume = () => this.resume();
    for (const type of ['pointerdown', 'keydown', 'click', 'touchend']) {
      window.addEventListener(type, resume, { capture: true });
    }
    // Zurück aus dem Browser-Cache: gleich versuchen - ohne neue Nutzeraktion
    // lässt der Browser das oft schon zu, sonst beim nächsten Klick.
    window.addEventListener('pageshow', (e) => {
      if (e.persisted && this.started) this.resume();
    });
    const tick = () => {
      this.updateFade();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** Beim ersten Mal beginnen, danach das laufende Stück fortsetzen, falls es steht. */
  private resume() {
    if (TRACKS.length === 0) return;
    if (!this.started) {
      this.started = true;
      this.next();
      return;
    }
    const player = this.players[this.current];
    if (player.paused && player.src) {
      void player.play().catch(() => {
        // Noch nicht erlaubt - beim nächsten Klick erneut.
      });
    }
  }

  /** Titel des Stücks, das gerade läuft (Dateiname), oder null. */
  get title(): string | null {
    return this.index >= 0 && this.order.length > 0 ? TRACKS[this.order[this.index]].title : null;
  }

  /** Lautstärke 0..1 (Einstellungen). */
  set volume(v: number) {
    this.level = Math.min(1, Math.max(0, v));
    this.applyVolume();
  }

  /** Aus, wenn der Ton aus ist (Taste M) - dann läuft sie leise weiter. */
  set mute(on: boolean) {
    this.muted = on;
    this.applyVolume();
  }

  /** Zum nächsten Stück - mit Überblendung. */
  next() {
    if (!this.started || TRACKS.length === 0) return;
    this.index++;
    if (this.index >= this.order.length) {
      // Neu mischen - aber nicht dasselbe Stück zweimal hintereinander.
      const last = this.order[this.order.length - 1];
      this.order = TRACKS.map((_, i) => i).sort(() => Math.random() - 0.5);
      if (this.order.length > 1 && this.order[0] === last) this.order.push(this.order.shift()!);
      this.index = 0;
    }
    const from = this.players[this.current];
    this.current = 1 - this.current;
    const to = this.players[this.current];
    to.src = TRACKS[this.order[this.index]].url;
    to.currentTime = 0;
    to.volume = 0;
    void to.play().catch(() => {
      // Abgelehnt (noch keine Nutzeraktion) - resume() versucht es beim nächsten Klick.
    });
    this.fade = { start: performance.now(), from, to };
  }

  private target(): number {
    return this.muted ? 0 : this.level * 0.6;
  }

  private applyVolume() {
    if (!this.fade) this.players[this.current].volume = this.target();
  }

  private updateFade() {
    if (!this.fade) return;
    const t = Math.min(1, (performance.now() - this.fade.start) / (FADE * 1000));
    const v = this.target();
    this.fade.to.volume = v * t;
    this.fade.from.volume = v * (1 - t);
    if (t >= 1) {
      this.fade.from.pause();
      this.fade = null;
    }
  }
}
