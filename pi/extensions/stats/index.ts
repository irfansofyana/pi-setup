import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PiStatsDashboard } from "./dashboard.ts";
import { getDefaultPaths, loadCache, refreshCache } from "./stats.ts";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("stats", {
    description: "Show local Pi usage stats, heatmap, top models, projects, and sessions.",
    handler: async (args, ctx) => {
      const { sessionDir, cachePath } = getDefaultPaths();
      const cached = await loadCache(cachePath);

      if (ctx.mode !== "tui") {
        const result = await refreshCache(sessionDir, cachePath);
        const count = Object.values(result.cache.files).reduce((sum, file) => sum + file.session.events.length, 0);
        const errors = result.errors.length ? `, ${result.errors.length} errors` : "";
        console.log(`stats indexed ${result.totalFiles} sessions, ${count} usage events${errors}`);
        return;
      }

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        let active = true;
        const dashboard = new PiStatsDashboard({
          cache: cached,
          args,
          done: () => {
            active = false;
            done();
          },
          theme,
        });

        void refreshCache(sessionDir, cachePath)
          .then((result) => {
            if (!active) return;
            dashboard.setRefreshResult(result);
            tui.requestRender();
          })
          .catch((error) => {
            if (!active) return;
            dashboard.setRefreshError(error);
            tui.requestRender();
          });

        return dashboard;
      });
    },
  });
}
