import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type CornellNotesPlugin from "./main";

export interface CornellSettings {
  cueWidth: number;
  dividerColor: string;
  dividerThickness: number;
  /** A trigger word the user types on its own line in a Cornell note; it
   *  auto-expands into `> [!cue] `. Empty disables the shortcut — the user can
   *  always still type `> [!cue]` by hand. */
  cueShortcut: string;
  /** A trigger word the user types on its own line in a Cornell note; it
   *  auto-expands into `> [!summary] `. Empty disables the shortcut — the user
   *  can always still type `> [!summary]` by hand. Mirrors `cueShortcut`. */
  summaryShortcut: string;
  /** A trigger word the user types on its own line in a Cornell note; it
   *  auto-expands into `> [!title] `. Empty disables the shortcut — the user
   *  can always still type `> [!title]` by hand. Mirrors `cueShortcut`. */
  titleShortcut: string;
  /** Review mode only: when true, hovering a cue (or the summary) draws a
   *  colored box around it to signal it's clickable. Off by default — the
   *  pointer cursor is the only affordance unless the user opts in. */
  reviewHoverHighlight: boolean;
  /** When true, the right-click "Export PDF" / "Export to PDFs" menu items are
   *  shown on Cornell notes and folders. Off by default — the feature is opt-in,
   *  so the context menu stays uncluttered until the user enables it. Disabling
   *  hides the menu items entirely (the export modal is never reachable). */
  pdfExportEnabled: boolean;
}

export const DEFAULT_SETTINGS: CornellSettings = {
  cueWidth: 120,
  dividerColor: "lightgrey",
  dividerThickness: 1,
  cueShortcut: "",
  summaryShortcut: "",
  titleShortcut: "",
  reviewHoverHighlight: false,
  pdfExportEnabled: false,
};

/** The three shortcut trigger words, keyed by callout kind. */
export interface ShortcutTriggers {
  cue: string;
  summary: string;
  title: string;
}

/** Pure validator: returns the trigger word shared by two or more shortcuts
 *  (after trimming; blank triggers are ignored), or null when every non-empty
 *  trigger is distinct. The settings tab uses this to block ambiguous configs —
 *  two shortcuts must never expand from the same word. */
export function findDuplicateTrigger(triggers: ShortcutTriggers): string | null {
  const seen = new Set<string>();
  for (const raw of [triggers.cue, triggers.summary, triggers.title]) {
    const t = raw.trim();
    if (!t) continue;
    if (seen.has(t)) return t;
    seen.add(t);
  }
  return null;
}

type SettingsTab = "layout" | "optional";

export class CornellSettingsTab extends PluginSettingTab {
  private plugin: CornellNotesPlugin;
  /** Which sub-tab is showing. Persisted only for the lifetime of the open
   *  settings pane — it resets to "layout" each time the pane is reopened. */
  private activeTab: SettingsTab = "layout";

  constructor(app: App, plugin: CornellNotesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Sub-tab nav: keeps the pane from overwhelming the user by splitting the
    // core layout knobs from the opt-in extras. Obsidian has no native settings
    // sub-tabs, so this is a small button row that swaps the rendered body.
    const nav = containerEl.createDiv({ cls: "cornell-settings-nav" });
    const body = containerEl.createDiv({ cls: "cornell-settings-body" });

    const tabs: { id: SettingsTab; label: string }[] = [
      { id: "layout", label: "Layout" },
      { id: "optional", label: "Optional" },
    ];
    const renderBody = () => {
      body.empty();
      if (this.activeTab === "layout") this.renderLayoutTab(body);
      else this.renderOptionalTab(body);
    };
    tabs.forEach(({ id, label }) => {
      const btn = nav.createEl("button", {
        text: label,
        cls: "cornell-settings-tab",
      });
      btn.toggleClass("is-active", this.activeTab === id);
      btn.addEventListener("click", () => {
        this.activeTab = id;
        nav
          .querySelectorAll(".cornell-settings-tab")
          .forEach((el) => el.removeClass("is-active"));
        btn.addClass("is-active");
        renderBody();
      });
    });

    renderBody();
  }

  /** Core layout knobs — the everyday Cornell-sheet geometry. */
  private renderLayoutTab(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Cue column width")
      .setDesc("Width of the left margin column for cues, in pixels.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.cueWidth))
          .setValue(String(this.plugin.settings.cueWidth))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.cueWidth = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Divider line color")
      .setDesc(
        "Color of the vertical line between the cue column and the notes body. Any CSS color value works, such as lightgrey, #ccc, or rgb(180, 180, 180)."
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.dividerColor)
          .setValue(this.plugin.settings.dividerColor)
          .onChange(async (value) => {
            this.plugin.settings.dividerColor =
              value || DEFAULT_SETTINGS.dividerColor;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Divider line thickness")
      .setDesc("Thickness of the divider line, in pixels. Set to 0 to hide it.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.dividerThickness))
          .setValue(String(this.plugin.settings.dividerThickness))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (Number.isFinite(n) && n >= 0) {
              this.plugin.settings.dividerThickness = n;
              await this.plugin.saveSettings();
            }
          })
      );
  }

  /** Opt-in extras — features that not every user needs, kept out of the way so
   *  the main pane stays uncluttered. */
  private renderOptionalTab(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Enable PDF export")
      .setDesc(
        "Show a PDF export option in the right-click menu, off by default. Cornell notes and folders of them can then be exported as study sheets."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.pdfExportEnabled)
          .onChange(async (value) => {
            this.plugin.settings.pdfExportEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Highlight cue on hover (review mode)")
      .setDesc(
        "In review mode, draw a colored box around a cue (and the summary) when you hover it, marking it as clickable. Off by default."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.reviewHoverHighlight)
          .onChange(async (value) => {
            this.plugin.settings.reviewHoverHighlight = value;
            await this.plugin.saveSettings();
          })
      );

    this.addShortcutSetting(containerEl, {
      key: "cue",
      name: "Cue shortcut",
      desc: "Type this word on its own line in a Cornell note and it auto-expands into '> [!cue] ', dropping the cursor right after it. Leave blank to disable (you can always type '> [!cue]' by hand). Must differ from the summary and title shortcuts. Example: cc",
      placeholder: "e.g. cc",
    });

    this.addShortcutSetting(containerEl, {
      key: "summary",
      name: "Summary shortcut",
      desc: "Type this word on its own line in a Cornell note and it auto-expands into '> [!summary] ', dropping the cursor right after it. Leave blank to disable (you can always type '> [!summary]' by hand). Must differ from the cue and title shortcuts. Example: ss",
      placeholder: "e.g. ss",
    });

    this.addShortcutSetting(containerEl, {
      key: "title",
      name: "Title shortcut",
      desc: "Type this word on its own line in a Cornell note and it auto-expands into '> [!title] ', dropping the cursor right after it. Leave blank to disable (you can always type '> [!title]' by hand). Must differ from the cue and summary shortcuts. Example: tt",
      placeholder: "e.g. tt",
    });
  }

  /** Live snapshot of all three shortcut triggers from saved settings. */
  private currentTriggers(): ShortcutTriggers {
    return {
      cue: this.plugin.settings.cueShortcut,
      summary: this.plugin.settings.summaryShortcut,
      title: this.plugin.settings.titleShortcut,
    };
  }

  /** Render one shortcut text setting. All three route through here so the
   *  distinct-trigger check applies uniformly: a value that collides with
   *  another non-empty shortcut is rejected (error notice + field reverts to
   *  the last saved value); a blank value always disables that shortcut. */
  private addShortcutSetting(
    containerEl: HTMLElement,
    opts: {
      key: keyof ShortcutTriggers;
      name: string;
      desc: string;
      placeholder: string;
    }
  ): void {
    const settingKey = `${opts.key}Shortcut` as const;

    new Setting(containerEl)
      .setName(opts.name)
      .setDesc(opts.desc)
      .addText((text) =>
        text
          .setPlaceholder(opts.placeholder)
          .setValue(this.plugin.settings[settingKey])
          .onChange(async (value) => {
            const candidate = value.trim();
            // Test the candidate against the other two live triggers. A blank
            // candidate can never collide, so it's always accepted.
            const triggers = this.currentTriggers();
            triggers[opts.key] = candidate;
            if (candidate && findDuplicateTrigger(triggers) === candidate) {
              new Notice(
                `Shortcut "${candidate}" is already used by another shortcut. Pick a different word.`
              );
              // Revert the field to the last saved value (setValue does not
              // re-fire onChange, so this won't loop).
              text.setValue(this.plugin.settings[settingKey]);
              return;
            }
            this.plugin.settings[settingKey] = candidate;
            await this.plugin.saveSettings();
          })
      );
  }
}
