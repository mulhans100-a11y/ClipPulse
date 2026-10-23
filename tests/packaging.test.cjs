const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Arch } = require('builder-util');
const {
  getPackagedResourcesDirectory,
  getTargetArchitecture,
  pruneForeignOnnxRuntimeBinaries,
} = require('../scripts/copy-third-party-notices.cjs');

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

test('native runtime pruning follows the requested electron-builder architecture', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'clippulse-package-arch-'));
  const appOutDir = path.join(temporaryDirectory, 'release', 'mac');
  const resources = path.join(appOutDir, 'ClipPulse.app', 'Contents', 'Resources');
  const napiRoot = path.join(resources, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');

  try {
    for (const architecture of ['x64', 'arm64']) {
      const binding = path.join(napiRoot, 'darwin', architecture, 'onnxruntime_binding.node');
      fs.mkdirSync(path.dirname(binding), { recursive: true });
      fs.writeFileSync(binding, 'fixture');
    }

    const context = {
      appOutDir,
      electronPlatformName: 'darwin',
      arch: Arch.x64,
      packager: { appInfo: { productFilename: 'ClipPulse' } },
    };
    assert.equal(getTargetArchitecture(context), 'x64');
    pruneForeignOnnxRuntimeBinaries(context);

    assert.equal(fs.existsSync(path.join(napiRoot, 'darwin', 'x64', 'onnxruntime_binding.node')), true);
    assert.equal(fs.existsSync(path.join(napiRoot, 'darwin', 'arm64')), false);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('installed ONNX Runtime native binding can be loaded by Node', () => {
  const transformersRequire = createRequire(require.resolve('@huggingface/transformers'));
  const runtime = transformersRequire('onnxruntime-node');
  assert.ok(runtime.InferenceSession);
  assert.ok(runtime.env.versions.node);
});
