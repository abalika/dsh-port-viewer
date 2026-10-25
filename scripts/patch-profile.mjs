#!/usr/bin/env node
/**
 * dsh-port-viewer —— profile 清单编辑器
 *
 * 只做一件事：把本包加进（或移出）某个 dsh profile 的 `package.json`：
 *   - `dsh.profile.bundles` 末尾追加/移除 bundle 名
 *   - `dependencies` 里登记/删除 `file:` 依赖
 *
 * 不碰 pnpm、不碰 node_modules、不碰 cordis.patch.yml —— 目录联接和备份由
 * 调用它的 PowerShell 脚本（install-desktop.ps1 / uninstall-desktop.ps1 /
 * verify-isolated.ps1）负责。
 *
 * 用法：
 *   node patch-profile.mjs add    <profile package.json> <packageName> <fileSpec>
 *   node patch-profile.mjs remove <profile package.json> <packageName>
 *
 * 幂等：已经加过就什么都不做（返回 changed:false）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [action, manifestPath, packageName, fileSpec] = process.argv.slice(2);

if (!['add', 'remove'].includes(action)) {
  console.error('usage: patch-profile.mjs <add|remove> <profile package.json> <packageName> [fileSpec]');
  process.exit(2);
}
if (!manifestPath || !packageName) {
  console.error('missing arguments');
  process.exit(2);
}
if (!existsSync(manifestPath)) {
  console.error(`profile manifest not found: ${manifestPath}`);
  process.exit(2);
}

const raw = readFileSync(manifestPath, 'utf8');
let manifest;
try {
  manifest = JSON.parse(raw);
} catch (error) {
  console.error(`profile manifest is not valid JSON (${manifestPath}): ${error.message}`);
  process.exit(1);
}

if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
  console.error('profile manifest must be a JSON object');
  process.exit(1);
}
manifest.dsh = manifest.dsh ?? {};
manifest.dsh.profile = manifest.dsh.profile ?? {};
manifest.dsh.profile.bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
manifest.dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' && !Array.isArray(manifest.dependencies)
  ? manifest.dependencies
  : {};

const bundles = manifest.dsh.profile.bundles;
const at = bundles.indexOf(packageName);
let changed = false;

if (action === 'add') {
  if (!fileSpec) {
    console.error('add requires a fileSpec');
    process.exit(2);
  }
  if (at === -1) {
    bundles.push(packageName);
    changed = true;
  }
  if (manifest.dependencies[packageName] !== fileSpec) {
    manifest.dependencies[packageName] = fileSpec;
    changed = true;
  }
} else {
  if (at !== -1) {
    bundles.splice(at, 1);
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(manifest.dependencies, packageName)) {
    delete manifest.dependencies[packageName];
    changed = true;
  }
}

if (!changed) {
  console.log(JSON.stringify({ changed: false, bundles }));
  process.exit(0);
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ changed: true, bundles }));
