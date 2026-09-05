import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * Idempotent patcher for @earendil-works/pi-coding-agent, @earendil-works/pi-tui,
 * and pi-mcp-adapter to prevent crashes on missing .invalidate() methods.
 */
function patchFile(filePath, replacements) {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  let content = fs.readFileSync(filePath, "utf8");
  let modified = false;

  for (const { oldText, newText } of replacements) {
    if (content.includes(oldText)) {
      content = content.replace(oldText, newText);
      modified = true;
    }
  }

  if (modified) {
    fs.writeFileSync(filePath, content, "utf8");
    console.log(`Patched: ${filePath}`);
    return true;
  }
  return false;
}

export function runPatches() {
  const appData = process.env.APPDATA || (process.platform === "win32" ? path.join(process.env.USERPROFILE || "", "AppData", "Roaming") : "");
  const globalNpmDir = appData ? path.join(appData, "npm", "node_modules") : "";
  const piAgentDir = path.join(process.env.USERPROFILE || "", ".pi", "agent");

  if (globalNpmDir) {
    // 1. Patch pi-tui mouse-region.js
    const mouseRegionJs = path.join(
      globalNpmDir,
      "@earendil-works",
      "pi-coding-agent",
      "node_modules",
      "@earendil-works",
      "pi-tui",
      "dist",
      "components",
      "mouse-region.js"
    );
    patchFile(mouseRegionJs, [
      {
        oldText: "    invalidate() {\n        this.child.invalidate();\n    }",
        newText: "    invalidate() {\n        this.child?.invalidate?.();\n    }",
      },
    ]);

    // 2. Patch pi-tui tui-alt-screen.js
    const altScreenJs = path.join(
      globalNpmDir,
      "@earendil-works",
      "pi-coding-agent",
      "node_modules",
      "@earendil-works",
      "pi-tui",
      "dist",
      "tui-alt-screen.js"
    );
    patchFile(altScreenJs, [
      {
        oldText: "child.invalidate();",
        newText: "child.invalidate?.();",
      },
    ]);

    // 3. Patch pi-tui tui.js
    const tuiJs = path.join(
      globalNpmDir,
      "@earendil-works",
      "pi-coding-agent",
      "node_modules",
      "@earendil-works",
      "pi-tui",
      "dist",
      "tui.js"
    );
    patchFile(tuiJs, [
      {
        oldText: "overlay.component.invalidate();",
        newText: "overlay.component.invalidate?.();",
      },
    ]);

    // 4. Patch bundled cli chunk in pi-coding-agent
    const chunksDir = path.join(globalNpmDir, "@earendil-works", "pi-coding-agent", "dist", "bundle", "chunks");
    if (fs.existsSync(chunksDir)) {
      for (const file of fs.readdirSync(chunksDir)) {
        if (file.endsWith(".js")) {
          patchFile(path.join(chunksDir, file), [
            {
              oldText: "invalidate(){this.child.invalidate()}}",
              newText: "invalidate(){this.child?.invalidate?.()}}",
            },
            {
              oldText: "for(let child of this.children)child.invalidate()}},this.implicitScroll",
              newText: "for(let child of this.children)child.invalidate?.()}},this.implicitScroll",
            },
            {
              oldText: "of this.overlayStack)overlay.component.invalidate()}start(){",
              newText: "of this.overlayStack)overlay.component.invalidate?.()}start(){",
            },
          ]);
        }
      }
    }
  }

  // 5. Patch pi-mcp-adapter tool-result-renderer.ts
  const mcpRendererTs = path.join(piAgentDir, "npm", "node_modules", "pi-mcp-adapter", "tool-result-renderer.ts");
  patchFile(mcpRendererTs, [
    {
      oldText: "  const hasErrorDetails = Boolean(result.details.error);",
      newText: "  const hasErrorDetails = Boolean(result.details?.error);",
    },
  ]);
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  runPatches();
}
