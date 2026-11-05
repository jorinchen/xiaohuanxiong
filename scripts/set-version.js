#!/usr/bin/env node
/**
 * 把 package.json、data.json、package-lock.json 的版本号统一设定为指定值（CI 打 tag 发布时使用）。
 * 支持传入带前缀的 tag，如 v1.0.6 -> 1.0.6。
 *
 * 用法：node scripts/set-version.js 1.0.6   （或 v1.0.6）
 */
const fs = require('fs');
const path = require('path');

let v = process.argv[2];
if (!v) {
  console.error('用法: node scripts/set-version.js <version>');
  process.exit(1);
}
if (v.startsWith('v')) v = v.slice(1);

const root = path.resolve(__dirname, '..');
function writeJson(file, transform) {
  const p = path.join(root, file);
  const raw = fs.readFileSync(p, 'utf8');
  const j = JSON.parse(raw);
  transform(j);
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf8');
}
writeJson('package.json', (j) => { j.version = v; });
writeJson('data.json', (j) => { j.version = v; });
const lockPath = path.join(root, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  writeJson('package-lock.json', (j) => {
    j.version = v;
    if (j.packages && j.packages['']) j.packages[''].version = v;
  });
}
console.log('[set-version] 版本号已设定为 ' + v);
