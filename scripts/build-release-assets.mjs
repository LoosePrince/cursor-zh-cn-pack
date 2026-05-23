import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const releaseDir = path.join(rootDir, 'artifacts', 'release');
const packageJsonPath = path.join(rootDir, 'package.json');
const workbenchPatchesPath = path.join(rootDir, 'data', 'workbench-patches.json');
const runtimePolicyPath = path.join(rootDir, 'data', 'workbench-patch-runtime-policy.json');
const manifestFileName = 'cursor-zh-cn-pack-release.json';

const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));
const sha256 = async (filePath) => {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
};
const toKiB = (bytes) => Number((bytes / 1024).toFixed(2));
const countBy = (items, selector) => items.reduce((accumulator, item) => {
  const key = selector(item);
  accumulator[key] = (accumulator[key] ?? 0) + 1;
  return accumulator;
}, {});
const normalizeRepository = (repository) => {
  const raw = typeof repository === 'string' ? repository : repository?.url ?? '';
  return raw
    .replace(/^git\+/, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/^github:/, '')
    .trim();
};
const describeFile = async (filePath, downloadUrl) => {
  const fileStat = await stat(filePath);
  return {
    fileName: path.basename(filePath),
    downloadUrl,
    sizeBytes: fileStat.size,
    sizeKiB: toKiB(fileStat.size),
    sha256: await sha256(filePath)
  };
};
const readChangelog = async () => {
  const changelogFile = process.env.RELEASE_CHANGELOG_FILE?.trim();
  if (changelogFile) {
    const raw = await readFile(path.resolve(rootDir, changelogFile), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('RELEASE_CHANGELOG_FILE must point to a JSON string array');
    }
    return parsed;
  }

  const changelogJson = process.env.RELEASE_CHANGELOG_JSON?.trim();
  if (!changelogJson) {
    return [];
  }

  const parsed = JSON.parse(changelogJson);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('RELEASE_CHANGELOG_JSON must be a JSON string array');
  }
  return parsed;
};

const packageJson = await readJson(packageJsonPath);
const workbenchPatches = await readJson(workbenchPatchesPath);
const runtimePolicy = await readJson(runtimePolicyPath);
const changelog = await readChangelog();

const version = packageJson.version;
const tag = process.env.RELEASE_TAG || `v${version}`;
const repository = process.env.GITHUB_REPOSITORY || normalizeRepository(packageJson.repository);
if (!repository) {
  throw new Error('Unable to determine GitHub repository for release asset URLs');
}

const releaseBaseUrl = `https://github.com/${repository}/releases/download/${tag}`;
const vsceEntryPath = path.join(rootDir, 'node_modules', '@vscode', 'vsce', 'vsce');
const vsixFileName = `${packageJson.name}-${version}.vsix`;
const manifestPath = path.join(releaseDir, manifestFileName);
const vsixPath = path.join(releaseDir, vsixFileName);
const copiedWorkbenchPatchesPath = path.join(releaseDir, 'workbench-patches.json');
const copiedRuntimePolicyPath = path.join(releaseDir, 'workbench-patch-runtime-policy.json');

await rm(releaseDir, { force: true, recursive: true });
await mkdir(releaseDir, { recursive: true });

const packageResult = spawnSync(process.execPath, [vsceEntryPath, 'package', '--out', vsixPath], {
  cwd: rootDir,
  stdio: 'inherit'
});

if (packageResult.error) {
  throw packageResult.error;
}

if (packageResult.status !== 0) {
  throw new Error(`vsce package failed with exit code ${packageResult.status ?? 'unknown'}`);
}

await cp(workbenchPatchesPath, copiedWorkbenchPatchesPath);
await cp(runtimePolicyPath, copiedRuntimePolicyPath);

const runtimeEligibleRules = workbenchPatches.filter((rule) => {
  const idAllowed = runtimePolicy.runtimeRuleIdPrefixes.some((prefix) => rule.id.startsWith(prefix));
  const sourceAllowed = runtimePolicy.safeSourcePrefixes.some((prefix) => rule.source.startsWith(prefix));
  return idAllowed && sourceAllowed;
});

const files = {
  vsix: await describeFile(vsixPath, `${releaseBaseUrl}/${vsixFileName}`),
  workbenchPatches: await describeFile(copiedWorkbenchPatchesPath, `${releaseBaseUrl}/workbench-patches.json`),
  workbenchPatchRuntimePolicy: await describeFile(copiedRuntimePolicyPath, `${releaseBaseUrl}/workbench-patch-runtime-policy.json`)
};

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  extension: {
    name: packageJson.name,
    displayName: packageJson.displayName,
    version,
    publisher: packageJson.publisher,
    repository: `https://github.com/${repository}`,
    tag,
    manifestFileName
  },
  changelog,
  downloads: {
    manifest: `${releaseBaseUrl}/${manifestFileName}`,
    vsix: files.vsix.downloadUrl,
    workbenchPatches: files.workbenchPatches.downloadUrl,
    workbenchPatchRuntimePolicy: files.workbenchPatchRuntimePolicy.downloadUrl
  },
  files,
  rules: {
    totalWorkbenchPatchRules: workbenchPatches.length,
    runtimeEligibleRuleCount: runtimeEligibleRules.length,
    runtimeRuleIdPrefixes: runtimePolicy.runtimeRuleIdPrefixes,
    runtimeRuleIdPrefixesCount: runtimePolicy.runtimeRuleIdPrefixes.length,
    safeSourcePrefixes: runtimePolicy.safeSourcePrefixes,
    safeSourcePrefixesCount: runtimePolicy.safeSourcePrefixes.length,
    ruleNamespaceCounts: countBy(workbenchPatches, (rule) => rule.id.split('.')[0] || 'unknown'),
    ruleModuleCounts: countBy(workbenchPatches, (rule) => rule.id.split('.').slice(0, 2).join('.') || 'unknown')
  }
};

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`Release assets generated in ${releaseDir}`);
console.log(`- ${vsixFileName}`);
console.log(`- ${manifestFileName}`);
console.log('- workbench-patch-runtime-policy.json');
console.log('- workbench-patches.json');