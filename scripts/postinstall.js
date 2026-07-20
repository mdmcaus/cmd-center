// Ensure node-pty's prebuilt spawn-helper binaries keep their execute bit.
// npm does not reliably preserve the exec bit when extracting prebuilt binaries,
// which makes node-pty fail at runtime with "posix_spawnp failed". This runs after
// every install to restore it. Safe no-op on platforms/paths that do not exist.
const fs = require('fs');
const path = require('path');

const prebuilds = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');

try {
  if (!fs.existsSync(prebuilds)) process.exit(0);
  for (const dir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper');
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
      console.log('[postinstall] chmod +x', path.relative(path.join(__dirname, '..'), helper));
    }
  }
} catch (err) {
  // Non-fatal: a chmod failure should not break install on unrelated platforms.
  console.warn('[postinstall] could not fix spawn-helper perms:', err.message);
}
