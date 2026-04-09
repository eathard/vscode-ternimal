const { remove, rename, writeFile } = require('fs-extra');
const path = require('path');

exports.default = async function (context) {
  if (context.electronPlatformName === 'linux') {
    const appOutDir = context.appOutDir;
    const originalBin = path.join(appOutDir, 'ternimal');

    // Remove chrome-sandbox to avoid SUID sandbox crashes
    try {
      await remove(path.join(appOutDir, 'chrome-sandbox'));
      console.log('  • removed chrome-sandbox');
    } catch {
      // may not exist
    }

    // Rename original binary and create wrapper script
    try {
      await rename(originalBin, originalBin + '.real');
    } catch {
      console.log('  • WARNING: could not rename ternimal binary');
      return;
    }

    const script = `#!/bin/bash
exec "$(dirname "$0")/ternimal.real" --no-sandbox "$@"
`;
    await writeFile(originalBin, script, { mode: 0o755 });
    console.log('  • created wrapper ternimal -> ternimal.real --no-sandbox');
  }
};
