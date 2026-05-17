import { App, PluginSettingTab, Setting } from "obsidian";
import type CornellNotesPlugin from "./main";

export interface CornellSettings {
  cueWidth: number;
  dividerColor: string;
  dividerThickness: number;
}

export const DEFAULT_SETTINGS: CornellSettings = {
  cueWidth: 120,
  dividerColor: "lightgrey",
  dividerThickness: 1,
};

export class CornellSettingsTab extends PluginSettingTab {
  private plugin: CornellNotesPlugin;

  constructor(app: App, plugin: CornellNotesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

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
        "Color of the vertical line between the cue column and the notes body. Any CSS color value (e.g. lightgrey, #ccc, rgb(180, 180, 180))."
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
}
