#!/usr/bin/env node
// Friendly preflight: hybld uses the built-in node:sqlite, which needs
// Node >= 22.5. Without this check, older Nodes die with a cryptic
// ERR_UNKNOWN_BUILTIN_MODULE the moment the CLI graph loads.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(
    `hybld requires Node >= 22.5 (it uses the built-in node:sqlite); you are running ${process.versions.node}.\n` +
      `Upgrade Node (e.g. "nvm install 22" or use the latest LTS) and try again.`
  );
  process.exit(1);
}
await import("../dist/cli.js");
