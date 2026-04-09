const { remove } = require('fs-extra');
const path = require('path');

exports.default = async function (context) {
  // Remove chrome-sandbox to avoid SUID sandbox crashes on Linux distros
  // like Deepin. The app uses --no-sandbox instead.
  if (context.electronPlatformName === 'linux') {
    const chromeSandbox = path.join(context.appOutDir, 'chrome-sandbox');
    try {
      await remove(chromeSandbox);
      console.log('  • removed chrome-sandbox (SUID not needed, using --no-sandbox)');
    } catch {
      // chrome-sandbox may not exist, ignore
    }
  }
};
