
interface PlayerSettings {
  volume?: number;
  muted?: boolean;
  playbackRate?: number;
  stableVolume?: boolean;
  ambientMode?: boolean;
  hdr?: boolean;
  cropBars?: boolean;
  objectFit?: string;
  /** Remembered as a LANGUAGE, not a track index — see MoviElement. */
  audioLang?: string;
  subtitleLang?: string;
}

const SETTINGS_FILE = 'movi_settings.json';

export class SettingsStorage {
  private static instance: SettingsStorage;
  private settings: PlayerSettings = {};
  /**
   * Choices saved since the file was last written. The write is debounced, and
   * every element that connects calls load() — a hover preview, a miniplayer,
   * the next page's player — which used to replace `settings` with what was on
   * disk. A choice made inside that window was then dropped (the timer wrote
   * the old file back) and handed to the new element as the OLD value: the
   * late restore put back the answer the viewer had just changed. Kept here
   * and laid over whatever the file says until it has been written.
   */
  private pending: Partial<PlayerSettings> = {};
  private savePromise: Promise<void> | null = null;

  private constructor() {}

  static getInstance(): SettingsStorage {
    if (!SettingsStorage.instance) {
      SettingsStorage.instance = new SettingsStorage();
    }
    return SettingsStorage.instance;
  }

  async load(): Promise<PlayerSettings> {
    try {
      const root = await navigator.storage.getDirectory();
      try {
        const fileHandle = await root.getFileHandle(SETTINGS_FILE);
        const file = await fileHandle.getFile();
        const text = await file.text();
        this.settings = { ...JSON.parse(text), ...this.pending };
      } catch (e) {
        // File doesn't exist or is invalid, use defaults
        this.settings = { ...this.pending };
      }
    } catch (e) {
      console.warn('OPFS not supported or accessible:', e);
      this.settings = { ...this.pending };
    }
    return this.settings;
  }

  async save(settings: Partial<PlayerSettings>): Promise<void> {
    this.settings = { ...this.settings, ...settings };
    this.pending = { ...this.pending, ...settings };
    
    // Debounce/Queue save
    if (this.savePromise) return this.savePromise;

    this.savePromise = new Promise((resolve) => {
      setTimeout(async () => {
        let again = false;
        try {
          const root = await navigator.storage.getDirectory();
          const fileHandle = await root.getFileHandle(SETTINGS_FILE, { create: true });
          const writable = await fileHandle.createWritable();
          // What is about to be on disk no longer needs holding; a choice that
          // lands while this write is in flight stays pending for the next.
          const snapshot = this.settings;
          const written = this.pending;
          await writable.write(JSON.stringify(snapshot));
          await writable.close();
          if (this.pending === written) this.pending = {};
          // A save that arrived after the snapshot joined THIS promise and
          // would otherwise wait for some unrelated later change to reach disk.
          else again = true;
        } catch (e) {
          console.warn('Failed to save settings to OPFS:', e);
        } finally {
          this.savePromise = null;
          resolve();
          if (again) void this.save({});
        }
      }, 500); // 500ms debounce
    });
    
    return this.savePromise;
  }

  get(): PlayerSettings {
    return this.settings;
  }
}
