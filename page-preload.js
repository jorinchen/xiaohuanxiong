'use strict';
/* 注入到页面视图：
   1) 抹掉 Chromium 痕迹，使 navigator / 触摸 / 显卡特征与所模拟的移动内核一致
   2) 兜底移除站点注入的「仅支持移动设备」遮罩（脚本被拦时的最后一道保险） */
const { webFrame, ipcRenderer } = require('electron');

/* 内核由主进程决定（同步取，preload 早于页面脚本执行）：
   不能靠 navigator.userAgent 判断 —— 切内核后 reload 时 preload 可能先于 UA 覆盖运行，
   会拿到上一个内核的 UA 从而走错分支（Android 模式被当成 iOS 清理） */
let PAGE_ENV = { kernel: 'ios', device: '' };
try { PAGE_ENV = ipcRenderer.sendSync('get-page-env') || PAGE_ENV; } catch (e) {}
const KERNEL = PAGE_ENV.kernel || 'ios';

try {
  /* 按内核 + 机型取真机参数，与主进程注入的是同一份 */
  const { presetFor } = require('./page-devices.js');
  webFrame.executeJavaScript(require('./page-inject.js').source(presetFor(KERNEL, PAGE_ENV.device)))
} catch (e) {}

/* 移动判定自检：把常见判据读回主进程日志。
   站点弹"仅支持移动设备访问"时，日志里能看出是哪一项露馅（便于定点修复） */
try {
  setTimeout(function () {
    webFrame.executeJavaScript('(function(){ try { return {' +
      'url: location.href.slice(0, 100),' +
      'ua: navigator.userAgent,' +
      'uaMobile: /Mobile|Android|iPhone|iPad|iPod/i.test(navigator.userAgent),' +
      'platform: navigator.platform,' +
      'vendor: navigator.vendor,' +
      'touch: navigator.maxTouchPoints,' +
      'coarse: matchMedia("(pointer: coarse)").matches,' +
      'screen: screen.width + "x" + screen.height,' +
      'inner: innerWidth + "x" + innerHeight,' +
      'dpr: devicePixelRatio,' +
      'uad: !!navigator.userAgentData,' +
      'chrome: typeof window.chrome,' +
      'chromeIn: ("chrome" in window),' +
      'plugins: navigator.plugins.length,' +
      'webkitRAF: !!window.webkitRequestAnimationFrame,' +
      'bluetoothIn: ("bluetooth" in navigator),' +
      'usbIn: ("usb" in navigator),' +
      'touchCallout: (window.CSS && CSS.supports) ? CSS.supports("-webkit-touch-callout", "none") : null,' +
      'body: (document.body ? (document.body.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 70) : "")' +
      '}; } catch (e) { return { err: String(e) }; } })()')
      .then(function (r) { try { ipcRenderer.send('mobile-check', r); } catch (e) {} })
      .catch(function () {});
  }, 2500);
} catch (e) {}

/* 鼠标滚轮 / 触摸板双指 → 双指捏合：移动版地图（腾讯地图等）不响应滚轮 —— 真机没有滚轮。
   目标元素所在容器若能滚动（文章页等），滚轮照常滚动页面；否则接管为双指捏合
   （Input.dispatchTouchEvent，isTrusted=true，地图库才会响应）：
   向上滚 / 双指张开 = 放大，向下滚 / 双指合拢 = 缩小。
   触摸板捏合手势在 Windows 上表现为 Ctrl+wheel，同样走这里（Ctrl+滚轮不再保留给页面缩放，
   移动页面本来就该像真机一样只有捏合缩放） */
try {
  function canScroll(el) {
    var n = el;
    while (n && n.nodeType === 1) {
      var cs = getComputedStyle(n);
      if (/(auto|scroll|overlay)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 2) return true;
      if (/(auto|scroll|overlay)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 2) return true;
      n = n.parentElement;
    }
    return false;
  }
  window.addEventListener('wheel', function (e) {
    if (!e.ctrlKey && canScroll(e.target)) return;   /* 目标可滚动：滚轮照常滚动 */
    e.preventDefault();
    ipcRenderer.send('page-wheel', { x: e.clientX, y: e.clientY, deltaY: e.deltaY });
  }, { passive: false, capture: true });
} catch (e) {}
