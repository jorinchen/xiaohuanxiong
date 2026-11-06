/**
 * postdist 步骤：安装包 setup.exe 生成后检查签名来源。
 *
 * 当配置了本地 PFX（CSC_LINK）时，setup.exe 已由 electron-builder 用原生 CSC 签名，
 * 此处直接跳过（避免重复处理）。未配置时同样跳过（出未签名包）。
 */
const setup = require('path').join(__dirname, '..', 'dist', 'setup.exe');
const fs = require('fs');

if (!fs.existsSync(setup)) {
  console.error('找不到 dist/setup.exe，请先运行 npm run dist');
  process.exit(1);
}

if (process.env.CSC_LINK) {
  console.log('[sign] 安装包由 electron-builder 本地 CSC 签名，postdist 跳过。');
} else {
  console.log('[sign] 未设置 CSC_LINK，setup.exe 未签名（出未签名包）。');
}
