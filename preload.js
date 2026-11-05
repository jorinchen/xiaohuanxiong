'use strict';
/* 仅向浏览器 UI 暴露必要的桌面能力，保持 contextIsolation */
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (callback) => {
  ipcRenderer.on(channel, (_event, data) => callback(data));
};

contextBridge.exposeInMainWorld('phoneSimDesktop', {
  isDesktop: true,

  /* 菜单与窗口状态 */
  onMenuAction: on('menu-action'),
  onFullscreenChanged: on('fullscreen-changed'),

  /* 页面视图事件 */
  onPageNavigated: on('page-navigated'),
  onPageTitle: on('page-title'),
  onPageLoading: on('page-loading'),
  onPageError: on('page-error'),
  onPageConsole: on('page-console'),
  onPageNetwork: on('page-network'),
  /* 请求体 / 响应体等网络详情（CDP 采集） */
  onPageNetworkDetail: on('page-network-detail'),

  /* 页面控制 */
  navigate: (url) => ipcRenderer.invoke('page-navigate', url),
  goBack: () => ipcRenderer.invoke('page-back'),
  goForward: () => ipcRenderer.invoke('page-forward'),
  reload: () => ipcRenderer.invoke('page-reload'),

  /* 标签页 */
  onTabsState: on('tabs-state'),
  tabNew: (url) => ipcRenderer.invoke('tab-new', url),
  tabClose: (id) => ipcRenderer.invoke('tab-close', id),
  tabActivate: (id) => ipcRenderer.invoke('tab-activate', id),
  setKernel: (kernel) => ipcRenderer.invoke('set-kernel', kernel),
  /* 机型菜单：静态机型表 + 切换当前标签的内核/机型 */
  getDevicePresets: () => ipcRenderer.sendSync('device-presets'),
  setDevice: (kernel, deviceId) => ipcRenderer.invoke('set-device', kernel, deviceId),
  setZoom: (factor) => ipcRenderer.invoke('set-zoom', factor),
  setViewport: (vp) => ipcRenderer.invoke('set-viewport', vp),
  /* 元素选取期间关掉"鼠标→触摸"转换，让页面重新收到 mousemove（悬停高亮 / DOM 定位） */
  setTouchEmit: (enabled) => ipcRenderer.invoke('set-touch-emit', enabled),
  getTabEnv: () => ipcRenderer.invoke('tab-env-get'),
  onTabEnv: on('tab-env'),
  exec: (code) => ipcRenderer.invoke('page-exec', code),
  readSource: (url) => ipcRenderer.invoke('read-source', url),
  layout: (rect) => ipcRenderer.send('page-layout', rect),
  setPageVisible: (visible) => ipcRenderer.send('page-visible', !!visible),
  /* 弹层置顶前先给页面拍快照：截当前页面铺在原处，隐藏视图后页面不黑屏 */
  capturePage: () => ipcRenderer.invoke('page-snapshot'),
  /* 置顶弹层小窗口（菜单 / 机型列表）：页面无需隐藏，视频照常播放 */
  popShow: (payload) => ipcRenderer.send('pop-show', payload),
  popHide: () => ipcRenderer.send('pop-hide'),
  popArmClose: (ms) => ipcRenderer.send('pop-arm-close', ms),
  popCancelClose: () => ipcRenderer.send('pop-cancel-close'),
  popSetButtonOut: () => ipcRenderer.send('pop-btn-out'),
  onPopSelected: on('pop-selected'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  /* 工具：浏览数据清理 */
  clearCookies: () => ipcRenderer.invoke('clear-cookies'),
  clearCache: () => ipcRenderer.invoke('clear-cache'),

  /* 应用 */
  toggleWindowFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  getInfo: () => ipcRenderer.invoke('app-info'),
  quit: () => ipcRenderer.invoke('quit-app'),

  /* 硬件接口（摄像头 / 麦克风 / 网络 / GPS / 传感器 / 蓝牙） */
  getHw: () => ipcRenderer.invoke('hw-get'),
  setHw: (patch) => ipcRenderer.invoke('hw-set', patch),
  onHwState: on('hw-state')
});
