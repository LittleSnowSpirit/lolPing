import { BrowserWindow, ipcMain, screen, type Display, type WebContents } from 'electron';
import { EventEmitter } from 'node:events';
import { isEmoteRefShape, type EmoteArt, type EmoteRef } from '../shared/emotes';
import {
  OVERLAY_ASSETS, OVERLAY_EMOTED, OVERLAY_PINGED, type OverlayChannel, type OverlayEvents, type PingTag,
} from '../shared/ipc';
import { isPingId, type PingId } from '../shared/pings';
import type { HelperEvent, WheelKind } from '../shared/protocol';
import type { OverlaySettings } from '../shared/settings';
import { physicalToLocal, type DisplayMap } from './coords';
import { numberDisplays, type NumberedDisplay } from './displayNumbers';
import { IS_MAC, loadPage, preloadPath } from './paths';

/** A ping the user just placed, in overlay-local CSS px: the room shares these. */
export interface SharedPing {
  id: PingId;
  displayId: number;
  x: number;
  y: number;
}

/** An emote the user just placed, in overlay-local CSS px: the room shares these. */
export interface SharedEmote {
  ref: EmoteRef;
  displayId: number;
  x: number;
  y: number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * One transparent, click-through, always-on-top window per display.
 * Emits 'shared' (SharedPing) for every wheel or trigger+click ping and 'sharedEmote' (SharedEmote) for every wheel or
 * trigger+click emote, never for settings previews.
 */
export class OverlayManager extends EventEmitter {
  readonly missingAssets = new Set<string>();
  private readonly windows = new Map<number, BrowserWindow>();
  /** The visible window area within each display; Windows excludes the taskbar. */
  private windowAreas = new Map<number, Display['bounds']>();
  private maps: DisplayMap[] = [];
  private numberedList: NumberedDisplay[] = [];
  private wheelDisplay: number | null = null;
  private wheelKind: WheelKind = 'ping';

  /** `resolveArt` says what an emote looks like: `remote` is true for a room member's, whose files may be missing here. */
  constructor(private settings: OverlaySettings, private readonly resolveArt: (ref: EmoteRef, remote: boolean) => EmoteArt) {
    super();
  }

  start(): void {
    ipcMain.on(OVERLAY_ASSETS, (_event, missing: unknown) => {
      if (!Array.isArray(missing)) return;
      for (const m of missing) if (typeof m === 'string') this.missingAssets.add(m);
    });
    ipcMain.on(OVERLAY_PINGED, (event, raw: unknown) => {
      const p = raw as { id?: unknown; x?: unknown; y?: unknown } | null;
      if (!p || !isPingId(p.id) || !isNum(p.x) || !isNum(p.y)) return;
      const displayId = this.displayOf(event.sender);
      if (displayId !== undefined) {
        const point = this.toDisplayPoint(displayId, p.x, p.y);
        this.emit('shared', { id: p.id, displayId, ...point } satisfies SharedPing);
      }
    });
    ipcMain.on(OVERLAY_EMOTED, (event, raw: unknown) => {
      const p = raw as { ref?: unknown; x?: unknown; y?: unknown } | null;
      if (!p || !isEmoteRefShape(p.ref) || !isNum(p.x) || !isNum(p.y)) return;
      const displayId = this.displayOf(event.sender);
      if (displayId === undefined) return;
      const point = this.toDisplayPoint(displayId, p.x, p.y);
      this.emit('sharedEmote', { ref: p.ref, displayId, ...point } satisfies SharedEmote);
      // The wheel's own overlay already shows it. Another display may still hold an earlier one of ours.
      this.clearElsewhere(displayId, 'self');
    });
    this.rebuild();
    screen.on('display-added', () => this.rebuild());
    screen.on('display-removed', () => this.rebuild());
    screen.on('display-metrics-changed', () => this.rebuild());
  }

  updateSettings(s: OverlaySettings): void {
    this.settings = s;
    for (const id of this.windows.keys()) this.send(id, 'overlay:settings', s);
  }

  handle(ev: HelperEvent): void {
    switch (ev.type) {
      case 'wheelOpen': {
        const p = physicalToLocal(ev.x, ev.y, this.maps);
        if (!p) return;
        this.wheelDisplay = p.displayId;
        this.wheelKind = ev.wheel;
        this.send(p.displayId, 'wheel:open', { ...this.toWindowPoint(p.displayId, p.x, p.y), wheel: ev.wheel });
        break;
      }
      case 'wheelMove':
      case 'wheelRelease': {
        if (this.wheelDisplay === null) return;
        const p = physicalToLocal(ev.x, ev.y, this.maps, this.wheelDisplay);
        if (!p) return;
        this.send(p.displayId, ev.type === 'wheelMove' ? 'wheel:move' : 'wheel:release', {
          ...this.toWindowPoint(p.displayId, p.x, p.y), wheel: this.wheelKind,
        });
        if (ev.type === 'wheelRelease') this.wheelDisplay = null;
        break;
      }
      case 'click': {
        const p = physicalToLocal(ev.x, ev.y, this.maps);
        if (!p) break;
        const point = this.toWindowPoint(p.displayId, p.x, p.y);
        if (ev.wheel === 'emote') {
          const ref = this.settings.clickEmoteId;
          this.send(p.displayId, 'emote:spawn', { owner: 'self', art: this.resolveArt(ref, false), ...point });
          this.clearElsewhere(p.displayId, 'self');
          this.emit('sharedEmote', { ref, displayId: p.displayId, x: p.x, y: p.y } satisfies SharedEmote);
          break;
        }
        this.send(p.displayId, 'ping:spawn', { id: this.settings.clickPingId, ...point });
        this.emit('shared', { id: this.settings.clickPingId, displayId: p.displayId, x: p.x, y: p.y } satisfies SharedPing);
        break;
      }
      case 'cancel':
        this.cancelWheel();
        break;
      default:
        break;
    }
  }

  previewPing(id: PingId): void {
    const d = screen.getPrimaryDisplay();
    const area = this.windowArea(d);
    this.send(d.id, 'ping:spawn', { id, x: area.width / 2, y: area.height / 2 });
  }

  /** A room member's ping, already mapped onto one of our displays. */
  spawnRemote(p: { displayId: number; x: number; y: number; id: PingId; tag: PingTag }): void {
    this.send(p.displayId, 'ping:spawn', { id: p.id, ...this.toWindowPoint(p.displayId, p.x, p.y), tag: p.tag });
  }

  /** Shows an emote in the middle of the main display, without sharing it (the settings page's preview). */
  previewEmote(ref: EmoteRef): void {
    const d = screen.getPrimaryDisplay();
    const area = this.windowArea(d);
    this.send(d.id, 'emote:spawn', { owner: 'preview', art: this.resolveArt(ref, false), x: area.width / 2, y: area.height / 2 });
  }

  /** A room member's emote, already mapped onto one of our displays. It replaces their earlier one, whichever display that was on. */
  spawnRemoteEmote(p: { displayId: number; x: number; y: number; ref: EmoteRef; peer: string; tag: PingTag }): void {
    this.send(p.displayId, 'emote:spawn', {
      owner: p.peer, art: this.resolveArt(p.ref, true), ...this.toWindowPoint(p.displayId, p.x, p.y), tag: p.tag,
    });
    this.clearElsewhere(p.displayId, p.peer);
  }

  /** This machine's displays with their room numbers (#1 = primary). */
  numbered(): NumberedDisplay[] {
    return this.numberedList;
  }

  toast(title: string, body: string): void {
    this.send(screen.getPrimaryDisplay().id, 'toast:show', { title, body });
  }

  destroy(): void {
    for (const w of this.windows.values()) if (!w.isDestroyed()) w.destroy();
    this.windows.clear();
    this.windowAreas.clear();
  }

  /** Dismisses a wheel that is on screen, if any. Also used when the helper stops: its cancel would never arrive. */
  cancelWheel(): void {
    if (this.wheelDisplay === null) return;
    this.send(this.wheelDisplay, 'wheel:cancel', null);
    this.wheelDisplay = null;
  }

  private displayOf(sender: WebContents): number | undefined {
    const win = BrowserWindow.fromWebContents(sender);
    return [...this.windows].find(([, w]) => w === win)?.[0];
  }

  /** Each owner has one emote on screen: clear theirs on every display but the one that just showed their new one. */
  private clearElsewhere(displayId: number, owner: string): void {
    for (const id of this.windows.keys()) if (id !== displayId) this.send(id, 'emote:clear', { owner });
  }

  private rebuild(): void {
    this.cancelWheel();
    const displays = screen.getAllDisplays();
    // The macOS helper already reports points in Electron's DIP space; dipToScreenRect only exists on Windows.
    this.maps = displays.map((d) => IS_MAC
      ? { id: d.id, dip: d.bounds, phys: d.bounds, scale: 1 }
      : { id: d.id, dip: d.bounds, phys: screen.dipToScreenRect(null, d.bounds), scale: d.scaleFactor });
    this.windowAreas = new Map(displays.map((d) => [d.id, this.windowArea(d)]));
    this.numberedList = numberDisplays(displays, screen.getPrimaryDisplay().id);
    this.emit('displays', this.numberedList);
    for (const [id, win] of this.windows) {
      if (!displays.some((d) => d.id === id)) {
        win.destroy();
        this.windows.delete(id);
      }
    }
    for (const d of displays) {
      const win = this.windows.get(d.id);
      if (win) {
        win.setBounds(this.windowArea(d));
      }
      else this.windows.set(d.id, this.createWindow(d));
    }
  }

  /** The actual Windows window must stop at the taskbar instead of relying on alpha-window clipping. */
  private windowArea(d: Display): Display['bounds'] {
    if (IS_MAC) return d.bounds;
    // Leave a two-DIP guard where the work area meets reserved system UI. Windows can
    // round the work-area and HWND edges differently at non-100% display scaling.
    const guard = 2;
    const left = d.workArea.x > d.bounds.x ? guard : 0;
    const top = d.workArea.y > d.bounds.y ? guard : 0;
    const right = d.workArea.x + d.workArea.width < d.bounds.x + d.bounds.width ? guard : 0;
    const bottom = d.workArea.y + d.workArea.height < d.bounds.y + d.bounds.height ? guard : 0;
    return {
      x: d.workArea.x + left,
      y: d.workArea.y + top,
      width: Math.max(1, d.workArea.width - left - right),
      height: Math.max(1, d.workArea.height - top - bottom),
    };
  }

  /** Convert display-local CSS coordinates to the smaller window's local coordinates. */
  private toWindowPoint(displayId: number, x: number, y: number): { x: number; y: number } {
    const display = this.maps.find((m) => m.id === displayId);
    const area = this.windowAreas.get(displayId);
    if (!display || !area) return { x, y };
    return { x: x - (area.x - display.dip.x), y: y - (area.y - display.dip.y) };
  }

  /** Convert a window-local point back to display-local coordinates for room sharing. */
  private toDisplayPoint(displayId: number, x: number, y: number): { x: number; y: number } {
    const display = this.maps.find((m) => m.id === displayId);
    const area = this.windowAreas.get(displayId);
    if (!display || !area) return { x, y };
    return { x: x + (area.x - display.dip.x), y: y + (area.y - display.dip.y) };
  }

  private createWindow(d: Display): BrowserWindow {
    const win = new BrowserWindow({
      ...this.windowArea(d),
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      enableLargerThanScreen: true, // also stops macOS pushing the window below the menu bar
      show: false,
      type: IS_MAC ? 'panel' : 'toolbar', // a macOS panel can float over full-screen apps
      webPreferences: {
        preload: preloadPath('overlay'),
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        spellcheck: false,
      },
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.webContents.on('did-finish-load', () => win.webContents.send('overlay:settings', this.settings));
    win.once('ready-to-show', () => {
      win.showInactive();
      const current = screen.getAllDisplays().find((display) => display.id === d.id) ?? d;
      win.setBounds(this.windowArea(current)); // re-apply: mixed-DPI setups can size the first frame wrong
    });
    void loadPage(win, 'overlay');
    return win;
  }

  private send<C extends OverlayChannel>(displayId: number, channel: C, payload: OverlayEvents[C]): void {
    const w = this.windows.get(displayId);
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}
