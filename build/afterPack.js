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

    // Rename original binary
    try {
      await rename(originalBin, originalBin + '.real');
    } catch {
      console.log('  • WARNING: could not rename ternimal binary');
      return;
    }

    // Create wrapper script with auto-retry for intermittent startup crashes
    const script = `#!/bin/bash
EXEC_DIR="$(dirname "$(readlink -f "$0")")"
MAX_RETRIES=3
RETRY_DELAY=0.3

for i in $(seq 1 $MAX_RETRIES); do
  "$EXEC_DIR/ternimal.real" --no-sandbox "$@"
  EXIT=$?
  # Exit code 133 (SIGTRAP) or 134 (SIGABRT) = Chromium startup crash, retry
  if [ $EXIT -ne 133 ] && [ $EXIT -ne 134 ]; then
    exit $EXIT
  fi
  [ $i -lt $MAX_RETRIES ] && sleep $RETRY_DELAY
done
exit $EXIT
`;
    await writeFile(originalBin, script, { mode: 0o755 });
    console.log('  • created wrapper with auto-retry');
  }
};
