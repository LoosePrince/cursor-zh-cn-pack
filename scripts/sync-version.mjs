import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const packageLockPath = path.join(rootDir, 'package-lock.json');

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));
const writeJson = async (filePath, value) => {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const packageJson = await readJson(packageJsonPath);
const packageLock = await readJson(packageLockPath);
const version = String(packageJson.version ?? '').trim();

if (!versionPattern.test(version)) {
  throw new Error(`Invalid package.json version: ${version}`);
}

let changed = false;

if (packageLock.version !== version) {
  packageLock.version = version;
  changed = true;
}

if (packageLock.packages && packageLock.packages[''] && packageLock.packages[''].version !== version) {
  packageLock.packages[''].version = version;
  changed = true;
}

if (changed) {
  await writeJson(packageLockPath, packageLock);
}

console.log(changed ? `Synced package-lock.json to version ${version}` : `package-lock.json already matches version ${version}`);