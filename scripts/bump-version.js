#!/usr/bin/env node
/**
 * 自动递增“小浣熊”版本号：
 *   1. 读取 package.json，按 patch（默认）/ minor / major 递增
 *   2. 同步 data.json 的 version 字段（小浣熊桌面版数据里的版本号）
 *   3. 同步 package-lock.json 的 version 字段
 *
 * 用法：
 *   node scripts/bump-version.js            # 递增 patch（1.0.0 -> 1.0.1）
 *   node scripts/bump-version.js minor      # 1.0.0 -> 1.1.0
 *   node scripts/bump-version.js major      # 1.0.0 -> 2.0.0
 */
const fs = require('fs');
const path = require('path');

// tag 发布时由 CI 显式设定版本号，跳过自动 +1，避免 tag 与打出版本不一致
if ((process.env.SKIP_BUMP || '').trim() === '1') {
  console.log('[bump] 检测到 SKIP_BUMP=1，跳过版本号递增。');
  process.exit(0);
}

const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const dataPath = path.join(root, 'data.json');
const lockPath = path.join(root, 'package-lock.json');

const release = process.argv[2] || 'patch';
if (!['major', 'minor', 'patch'].includes(release)) {
  console.error('用法: node scripts/bump-version.js [patch|minor|major]');
  process.exit(1);
}

function bump(v) {
  const parts = String(v).split('.').map((n) => parseInt(n, 10) || 0);
  let [maj, min, pat] = parts;
  if (release === 'major') { maj += 1; min = 0; pat = 0; }
  else if (release === 'minor') { min += 1; pat = 0; }
  else { pat += 1; }
  return `${maj}.${min}.${pat}`;
}

function writeJson(file, transform) {
  const raw = fs.readFileSync(file, 'utf8');
  const obj = JSON.parse(raw);
  transform(obj);
  // 保持与 package.json 一致的 2 空格缩进 + 末尾换行
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const oldVersion = pkg.version;
const newVersion = bump(oldVersion);

writeJson(pkgPath, (o) => { o.version = newVersion; });

const synced = ['package.json'];
if (fs.existsSync(dataPath)) {
  writeJson(dataPath, (o) => { o.version = newVersion; });
  synced.push('data.json');
}
if (fs.existsSync(lockPath)) {
  writeJson(lockPath, (o) => {
    o.version = newVersion;
    if (o.packages && o.packages['']) o.packages[''].version = newVersion;
  });
  synced.push('package-lock.json');
}

console.log(`版本号已更新: ${oldVersion} -> ${newVersion} (${release})`);
console.log(`已同步: ${synced.join(', ')}`);
console.log('运行时 “小浣熊桌面版 v' + newVersion + '” 会自动读取该版本号。');
