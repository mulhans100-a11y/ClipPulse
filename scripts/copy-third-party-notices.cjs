const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const asar = require('@electron/asar');

const projectRoot = path.resolve(__dirname, '..');

function safeName(value) {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/g, '__');
}

function findProductionPackages() {
  const npmArguments = ['ls', '--omit=dev', '--all', '--parseable'];
  const npmOptions = {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  const output = process.env.npm_execpath
    ? execFileSync(process.execPath, [process.env.npm_execpath, ...npmArguments], npmOptions)
    : execFileSync('npm', npmArguments, { ...npmOptions, shell: process.platform === 'win32' });

  return [...new Set(output.split(/\r?\n/).filter(Boolean))]
    .filter((directory) => path.resolve(directory) !== projectRoot)
    .map((directory) => {
      const manifestPath = path.join(directory, 'package.json');
      if (!fs.existsSync(manifestPath)) return null;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return { directory, manifest };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function licenseFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(license|licence|copying|notice)(\.|$)/i.test(entry.name))
    .map((entry) => entry.name);
}

exports.default = async function copyThirdPartyNotices(context) {
  const resources = getPackagedResourcesDirectory(context);
  const destination = path.join(resources, 'third-party-licenses');
  const licensesDestination = path.join(destination, 'LICENSES');
  pruneForeignOnnxRuntimeBinaries(context);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(licensesDestination, { recursive: true });

  const packages = findProductionPackages();
  const supplementalRoot = path.join(projectRoot, 'licenses');
  const supplementalNotices = fs.existsSync(supplementalRoot)
    ? fs.readdirSync(supplementalRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (entry.name.startsWith('onnxruntime-') || entry.name.startsWith('guid-typescript-')))
      .map((entry) => entry.name)
      .sort()
    : [];
  for (const noticeDirectory of supplementalNotices) {
    fs.cpSync(
      path.join(supplementalRoot, noticeDirectory),
      path.join(licensesDestination, noticeDirectory),
      { recursive: true },
    );
  }

  const rows = [];
  for (const { directory, manifest } of packages) {
    const packageName = manifest.name || path.basename(directory);
    const packageVersion = manifest.version || 'unknown version';
    const packageKey = safeName(`${packageName}-${packageVersion}`);
    const files = licenseFiles(directory);
    const packageLicenseDir = path.join(licensesDestination, packageKey);
    for (const filename of files) {
      fs.mkdirSync(packageLicenseDir, { recursive: true });
      fs.copyFileSync(path.join(directory, filename), path.join(packageLicenseDir, filename));
    }

    const license = typeof manifest.license === 'string'
      ? manifest.license
      : manifest.license?.type || 'license metadata unavailable';
    const upstreamNotices = packageName === 'guid-typescript'
      ? supplementalNotices.filter((noticeDirectory) => noticeDirectory === `guid-typescript-${packageVersion}`)
      : packageName.startsWith('onnxruntime-')
        ? supplementalNotices.filter((noticeDirectory) => noticeDirectory === 'onnxruntime-v1.30.0')
      : [];
    const fileReferences = [
      ...(files.length ? [`\`LICENSES/${packageKey}/\``] : []),
      ...upstreamNotices.map((noticeDirectory) => `\`LICENSES/${noticeDirectory}/\``),
    ];
    rows.push(`| \`${packageName}@${packageVersion}\` | ${license.replaceAll('|', '\\|')} | ${fileReferences.length ? fileReferences.join(', ') : 'No license text file found in package'} |`);

    if (packageName.startsWith('@img/sharp-')) {
      const readme = path.join(directory, 'README.md');
      if (fs.existsSync(readme)) {
        fs.mkdirSync(packageLicenseDir, { recursive: true });
        fs.copyFileSync(readme, path.join(packageLicenseDir, 'README.md'));
      }
    }
  }

  const notice = [
    '# Third-party licenses',
    '',
    'This application includes the production npm packages listed below. License texts found in those packages are copied into the adjacent `LICENSES/` directory. The native `sharp` package README files are included because they identify licenses for bundled libvips components. Version-matched Microsoft ONNX Runtime MIT and third-party notices are also included for the locked ONNX Runtime packages. The declared ISC license text for guid-typescript is included because its npm archive omits that file.',
    '',
    'The application itself is licensed under GPL-3.0-or-later; see the `LICENSE` file at the application root.',
    '',
    '| Package | Declared license | Bundled license files |',
    '| --- | --- | --- |',
    ...rows.sort((a, b) => a.localeCompare(b)),
    '',
    'License metadata is copied from the package manifests and files installed for this build platform. It is provided for attribution and review, not as legal advice.',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(destination, 'THIRD_PARTY_NOTICES.md'), notice);
  verifyPackagedRuntime(context, packages);
  console.log(`Copied license and upstream notice files for ${packages.length} production packages to ${destination}`);
};

function pruneForeignOnnxRuntimeBinaries(context) {
  const napiRoot = path.join(
    getPackagedResourcesDirectory(context),
    'app.asar.unpacked',
    'node_modules',
    'onnxruntime-node',
    'bin',
    'napi-v6',
  );
  if (!fs.existsSync(napiRoot)) {
    throw new Error(`Unpacked ONNX Runtime binaries are missing: ${napiRoot}`);
  }

  for (const platformEntry of fs.readdirSync(napiRoot, { withFileTypes: true })) {
    if (!platformEntry.isDirectory()) continue;
    const platformPath = path.join(napiRoot, platformEntry.name);
    if (platformEntry.name !== process.platform) {
      fs.rmSync(platformPath, { recursive: true, force: true });
      continue;
    }

    for (const architectureEntry of fs.readdirSync(platformPath, { withFileTypes: true })) {
      if (architectureEntry.isDirectory() && architectureEntry.name !== process.arch) {
        fs.rmSync(path.join(platformPath, architectureEntry.name), { recursive: true, force: true });
      }
    }
  }
}

function verifyPackagedRuntime(context, packages) {
  const resources = getPackagedResourcesDirectory(context);
  const archive = path.join(resources, 'app.asar');
  if (!fs.existsSync(archive)) throw new Error(`Packaged application archive is missing: ${archive}`);
  if (!packages.length) throw new Error('No production npm packages were found while preparing the application package.');

  const entries = new Set(asar.listPackage(archive).map((entry) => entry.replaceAll('\\', '/').replace(/^\/+/, '')));
  const requiredEntries = [
    'package.json',
    'dist/package.json',
    'dist/src/main/index.js',
    'dist/src/main/cli.js',
    'dist/renderer/index.html',
    'node_modules/@huggingface/transformers/package.json',
    'node_modules/@modelcontextprotocol/sdk/package.json',
    'node_modules/chokidar/package.json',
    'node_modules/react/package.json',
    'node_modules/react-dom/package.json'
  ];
  const missingEntries = requiredEntries.filter((entry) => !entries.has(entry));
  if (missingEntries.length) throw new Error(`Packaged app.asar is missing required files: ${missingEntries.join(', ')}`);

  const platform = process.platform;
  const architecture = process.arch;
  const nativeBinding = path.join(resources, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', platform, architecture, 'onnxruntime_binding.node');
  if (!fs.existsSync(nativeBinding)) throw new Error(`Packaged ONNX Runtime native binding is missing for ${platform}/${architecture}: ${nativeBinding}`);

  const notices = path.join(resources, 'third-party-licenses', 'THIRD_PARTY_NOTICES.md');
  if (!fs.existsSync(notices) || fs.statSync(notices).size === 0) throw new Error('Packaged third-party license notices were not generated.');
  if (!fs.existsSync(path.join(resources, 'third-party-licenses', 'LICENSES'))) throw new Error('Packaged third-party license directory is missing.');
}

function getPackagedResourcesDirectory(context) {
  if (context.electronPlatformName === 'darwin') {
    const productFilename = context.packager?.appInfo?.productFilename;
    if (!productFilename) throw new Error('Cannot resolve the macOS app bundle name while collecting package notices.');
    return path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources');
  }
  return path.join(context.appOutDir, 'resources');
}

exports.getPackagedResourcesDirectory = getPackagedResourcesDirectory;
