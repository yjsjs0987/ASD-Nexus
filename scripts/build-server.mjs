import * as esbuild from "esbuild";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "..");

await esbuild.build({
  entryPoints: [path.join(rootDir, "src", "server", "index.ts")],
  outfile: path.join(rootDir, "dist", "server", "server.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: ["node-pty", "ws"],
  plugins: [
    {
      name: "strip-core-cli-autostart",
      setup(build) {
        build.onLoad({ filter: /mcp[\\/]server\.ts$/ }, async (args) => {
          const fs = await import("node:fs");
          let contents = fs.readFileSync(args.path, "utf8");
          contents = contents.replace(
            /invokedPath\.endsWith\("server\.js"\)/g,
            "false"
          );
          return { contents, loader: "ts" };
        });
        build.onLoad({ filter: /cli[\\/]index\.ts$/ }, async (args) => {
          const fs = await import("node:fs");
          let contents = fs.readFileSync(args.path, "utf8");
          contents = contents.replace(/if\s*\(\s*isDirectRun\(\)\s*\)/g, "if (false)");
          return { contents, loader: "ts" };
        });
      },
    },
  ],
  banner: {
    js: 'import { createRequire as __asdCreateRequire } from "node:module"; const require = __asdCreateRequire(import.meta.url);',
  },
});

console.log("Built server bundle: dist/server/server.js");
