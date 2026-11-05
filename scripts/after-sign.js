/**
 * electron-builder afterSign 钩子：
 * 在生成 NSIS 安装包之前，把解包目录里的主程序 PcAsMobile.exe 先用 SignPath 签名，
 * 这样安装后运行的 exe 也是已签名的，首次打开不会报未知发布者。
 *
 * 未设置 SIGNPATH_API_TOKEN 时会自动跳过（本地构建仍正常出未签名包）。
 *
 * @param {{ appOutDir: string }} context
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function runSign(target) {
  if (!process.env.SIGNPATH_API_TOKEN) {
    console.log('[signpath] 未设置 SIGNPATH_API_TOKEN，跳过签名（本地构建）。');
    return;
  }
  if (!fs.existsSync(target)) {
    console.log('[signpath] 跳过：找不到 ' + target);
    return;
  }
  const signer = path.join(__dirname, 'sign-signpath.js');
  console.log('[signpath] 签名主程序: ' + target);
  execFileSync('node', [signer, '--path', target], { stdio: 'inherit' });
}

async function afterSign(context) {
  const appOutDir = context && context.appOutDir;
  if (!appOutDir) return;
  runSign(path.join(appOutDir, 'PcAsMobile.exe'));
}

module.exports = afterSign;
