/**
 * electron-builder afterSign 钩子。
 *
 * 当配置了本地 PFX（环境变量 CSC_LINK 指向 .pfx 文件）时，主程序 PcAsMobile.exe
 * 已由 electron-builder 用原生 CSC 签名（windows-sign / signtool），本钩子无需再处理。
 * 未配置 CSC_LINK 时直接跳过（出未签名包）。
 *
 * @param {{ appOutDir: string }} context
 */
const path = require('path');

function runSign(target) {
  if (!process.env.CSC_LINK) {
    console.log('[sign] 未设置 CSC_LINK，跳过主程序签名（出未签名包）。');
    return;
  }
  console.log('[sign] 主程序已交由 electron-builder 本地 CSC 签名: ' + target);
}

async function afterSign(context) {
  const appOutDir = context && context.appOutDir;
  if (!appOutDir) return;
  runSign(path.join(appOutDir, 'PcAsMobile.exe'));
}

module.exports = afterSign;
