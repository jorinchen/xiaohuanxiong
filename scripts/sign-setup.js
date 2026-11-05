/**
 * postdist 步骤：安装包 setup.exe 生成后，用 SignPath 对其签名。
 * 未设置 SIGNPATH_API_TOKEN 时跳过（本地构建出未签名包）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const setup = path.join(__dirname, '..', 'dist', 'setup.exe');
if (!fs.existsSync(setup)) {
  console.error('找不到 dist/setup.exe，请先运行 npm run dist');
  process.exit(1);
}

if (!process.env.SIGNPATH_API_TOKEN) {
  console.log('[signpath] 未设置 SIGNPATH_API_TOKEN，跳过 setup.exe 签名（本地构建）。');
  process.exit(0);
}

const signer = path.join(__dirname, 'sign-signpath.js');
console.log('[signpath] 签名安装包: ' + setup);
try {
  execFileSync('node', [signer, '--path', setup], { stdio: 'inherit' });
} catch (e) {
  console.error('SignPath 签名失败');
  process.exit(1);
}
