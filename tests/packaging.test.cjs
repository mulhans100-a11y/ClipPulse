const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { getPackagedResourcesDirectory } = require('../scripts/copy-third-party-notices.cjs');

test('packaged macOS resources resolve inside the named app bundle', () => {
  const appOutDir = path.join('runner', 'release', 'mac-arm64');
  const resources = getPackagedResourcesDirectory({
    appOutDir,
    electronPlatformName: 'darwin',
    packager: { appInfo: { productFilename: 'ClipPulse' } },
  });

  assert.equal(resources, path.join(appOutDir, 'ClipPulse.app', 'Contents', 'Resources'));
});

test('Windows and Linux packaged resources resolve from the output root', () => {
  const appOutDir = path.join('runner', 'release', 'linux-x64');

  for (const electronPlatformName of ['win32', 'linux']) {
    assert.equal(
      getPackagedResourcesDirectory({ appOutDir, electronPlatformName }),
      path.join(appOutDir, 'resources'),
    );
  }
});

test('macOS resource resolution fails clearly without product metadata', () => {
  assert.throws(
    () => getPackagedResourcesDirectory({ appOutDir: 'release/mac', electronPlatformName: 'darwin' }),
    /Cannot resolve the macOS app bundle name/,
  );
});
