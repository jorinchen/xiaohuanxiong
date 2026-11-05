'use strict';
/* 置顶弹层小窗口（菜单 / 机型列表）的 preload：
   只暴露渲染数据回传能力，保持 contextIsolation */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('popUI', {
  /* 主窗口发来的弹层内容（kind: 'menu' | 'device'） */
  onData: (cb) => ipcRenderer.on('pop-data', (_e, data) => cb(data)),
  /* 自报内容尺寸，主进程据此设定窗口大小 */
  resize: (w, h) => ipcRenderer.send('pop-resize', { w: Math.ceil(w), h: Math.ceil(h) }),
  /* 选中某项：回传给主窗口执行 */
  select: (payload) => ipcRenderer.send('pop-select', payload),
  /* 鼠标进出弹层：进入取消延迟关闭，离开重新计时 */
  hoverIn: () => ipcRenderer.send('pop-hover-in'),
  hoverOut: () => ipcRenderer.send('pop-hover-out'),
  hide: () => ipcRenderer.send('pop-hide')
});
