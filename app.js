/* 小浣熊移动内核桌面浏览器 —— 浏览器 UI 渲染进程 */
(function () {
  'use strict';

  const desktop = window.phoneSimDesktop;
  if (!desktop || !desktop.isDesktop) {
    const only = document.getElementById('desktopOnly');
    if (only) only.hidden = false;
    return;
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.prototype.slice.call(root.querySelectorAll(sel));
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const escapeHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nowTime = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

  /* 机型表由主进程同步下发（纯数据）：UI 菜单、视口宽度、注入脚本共用一份参数 */
  const DEVICE_DATA = (typeof desktop.getDevicePresets === 'function' && desktop.getDevicePresets()) || {};
  const DEVICE_PRESETS = DEVICE_DATA.presets || {};
  const DEFAULT_DEVICE = DEVICE_DATA.defaults || {};
  const KERNEL_ORDER = DEVICE_DATA.kernels || ['ios', 'android', 'harmony'];

  const store = {
    get(key, fallback) {
      try { const raw = localStorage.getItem(key); return raw === null ? fallback : JSON.parse(raw); }
      catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
    }
  };

  const DEFAULT_BOOKMARKS = [
    { title: '小浣熊起始页', url: 'demo://home' },
    { title: '应用商店', url: 'demo://store' },
    { title: '技术文章 · 移动内核演进', url: 'demo://article' }
  ];

  const state = {
    /* 内核 / 机型 / 视口 / 缩放跟着标签走，初值由主进程 tab-env 校正 */
    kernel: 'ios',
    device: DEFAULT_DEVICE.ios || '',
    /* 每个内核各自记住上次选的机型，切回来时恢复 */
    deviceByKernel: (function () {
      const saved = store.get('ps-device-by-kernel', {});
      const out = {};
      KERNEL_ORDER.forEach((k) => {
        out[k] = (saved && typeof saved[k] === 'string' && saved[k]) ? saved[k] : (DEFAULT_DEVICE[k] || '');
      });
      return out;
    })(),
    /* 持续记录：勾选后刷新/换网址不清空控制器与网络记录 */
    persistLog: !!store.get('ps-persist-log', false),
    viewportMode: 'phone',
    pageZoom: 1,
    password: String(store.get('ps.password', '123456')),
    bookmarks: (function () {
      const saved = store.get('ps.bookmarks', DEFAULT_BOOKMARKS);
      return Array.isArray(saved) ? saved : DEFAULT_BOOKMARKS.slice();
    })(),
    displayUrl: 'https://www.baidu.com',
    title: '百度一下，你就知道',
    lastPageUrl: '',
    lastFailedUrl: '',
    serverBase: '',
    pageVisible: true,
    pageErrorVisible: false,
    desktopFullscreen: false,
    inspectMode: false,
    inspectPoll: null,
    selectedPath: null,
    activeTab: 'elements',
    logs: [],
    logOpen: new Set(),   /* 已展开的长日志 id */
    /* 调试器：页面脚本列表 / 当前文件 / 待定位行 */
    sources: [],
    srcUrl: '',
    srcLine: 0,
    srcFilter: '',
    srcScanned: false,
    /* 控制台级别筛选：true/缺省 = 显示，false = 隐藏 */
    logFilter: { error: true, warn: true, info: true, system: true },
    requests: [],
    netSeq: 0,
    cmdHistory: [],
    cmdIndex: 0,
    netFilter: 'all',
    /* 网络详情：请求 id → {postData, body, base64}；当前选中的详情子标签 */
    netExtra: {},
    netDetailTab: 'headers',
    netSelected: 0,
    /* 请求详情的概要块默认折叠（URL / 所属页面 / 状态 / UA 那一坨） */
    netSummaryOpen: false,
    /* 首次按 F12 默认停靠在**右侧**（不遮挡页面纵向空间）；用户手动切换后记住选择。
       key 换成 v2：旧的 bottom 记录不再生效，避免之前选过底部的机器回不到默认值 */
    dtDock: (function () {
      try {
        const v = localStorage.getItem('ps-dt-dock-v2');
        return v === 'bottom' ? 'bottom' : 'right';
      } catch (e) { return 'right'; }
    })(),
    /* 默认尺寸：0 = 未设置，打开时按工作区宽度自适应（右侧停靠取 57%，即截图里红框的比例）；
       用户拖过或切过停靠后记住具体像素值，不再自适应 */
    dtSize: (function () {
      try {
        const v = Number(localStorage.getItem('ps-dt-size-v4'));
        return v > 0 ? v : 0;
      } catch (e) { return 0; }
    })(),
    /* 当前 DevTools 数据归属的标签页 id */
    devTabId: 0
  };

  /* DevTools 数据按标签页隔离：每个标签各自的控制台日志 / 网络记录 / 脚本列表。
     state.logs 等始终是"当前标签"的那一份，切换标签时整体换入换出 */
  const devStores = new Map();
  function storeFor(tabId) {
    if (!devStores.has(tabId)) devStores.set(tabId, {
      logs: [], requests: [], sources: [],
      srcUrl: '', srcLine: 0, srcScanned: false, sourceCache: new Map(),
      netExtra: {}
    });
    return devStores.get(tabId);
  }
  function swapDevState(toId) {
    if (toId === state.devTabId) return;
    const cur = storeFor(state.devTabId);
    cur.logs = state.logs; cur.requests = state.requests; cur.sources = state.sources;
    cur.srcUrl = state.srcUrl; cur.srcLine = state.srcLine; cur.srcScanned = state.srcScanned;
    cur.sourceCache = sourceCache; cur.netExtra = state.netExtra;
    const next = storeFor(toId);
    state.logs = next.logs; state.requests = next.requests; state.sources = next.sources;
    state.srcUrl = next.srcUrl; state.srcLine = next.srcLine; state.srcScanned = next.srcScanned;
    sourceCache = next.sourceCache;
    state.netExtra = next.netExtra || (next.netExtra = {});
    state.devTabId = toId;
    /* 计数徽标与面板内容随标签刷新 */
    if (el.netCount) el.netCount.textContent = String(state.requests.length);
    if (el.netTotal) el.netTotal.textContent = String(state.requests.length);
    if (el.srcCount) el.srcCount.textContent = String(state.sources.length);
    if (state.activeTab === 'console') renderLogs();
    else if (state.activeTab === 'network') renderNetwork();
    else if (state.activeTab === 'sources') renderSourceTree();
    else if (state.activeTab === 'elements') { clearSelection(); buildDomTree(); }
  }

  const el = {
    addressInput: $('#addressInput'), btnVault: $('#btnVault'), btnRefresh: $('#btnRefresh'),
    btnBack: $('#btnBack'), btnForward: $('#btnForward'), btnHome: $('#btnHome'),
    uaBadge: $('#uaBadge'), uaLine: $('#uaLine'),
    pageFrame: $('#pageFrame'), progressBar: $('#progressBar'), pageLoading: $('#pageLoading'),
    pageSnapshot: $('#pageSnapshot'),
    blockedTip: $('#blockedTip'), pageErrorText: $('#pageErrorText'),
    btnOpenNewWindow: $('#btnOpenNewWindow'), btnBackHome: $('#btnBackHome'),
    pageZoomOut: $('#pageZoomOut'), pageZoomIn: $('#pageZoomIn'), pageZoomLabel: $('#pageZoomLabel'),
    btnFullscreen: $('#btnFullscreen'), btnDevtools: $('#btnDevtools'),
    devtools: $('#devtools'), netCount: $('#netCount'),
    btnClearDevtools: $('#btnClearDevtools'), btnCloseDevtools: $('#btnCloseDevtools'),
    persistLog: $('#persistLog'), devicePop: $('#devicePop'),
    workbench: $('#workbench'), btnDockToggle: $('#btnDockToggle'), devtoolsResizer: $('#devtoolsResizer'),
    btnInspectMode: $('#btnInspectMode'),
    tabsScroll: $('#tabsScroll'), btnNewTab: $('#btnNewTab'),
    appMenu: $('#appMenu'), menuPop: $('#menuPop'), ctxMenu: $('#ctxMenu'),
    btnHw: $('#btnHw'), hwModal: $('#hwModal'), closeHwBtn: $('#closeHwBtn'),
    hwNet: $('#hwNet'), hwGpsOn: $('#hwGpsOn'), hwLat: $('#hwLat'), hwLng: $('#hwLng'),
    hwGeoPresets: $('#hwGeoPresets'), hwSensorMode: $('#hwSensorMode'),
    hwAlpha: $('#hwAlpha'), hwBeta: $('#hwBeta'), hwGamma: $('#hwGamma'), hwAngleRow: $('#hwAngleRow'),
    hwCam: $('#hwCam'), hwMic: $('#hwMic'), hwBt: $('#hwBt'), hwTouch: $('#hwTouch'),
    hwSaveBtn: $('#hwSaveBtn'), hwResetBtn: $('#hwResetBtn'),
    btnRefreshDom: $('#btnRefreshDom'),
    domPath: $('#domPath'), domTree: $('#domTree'), domDetail: $('#domDetail'),
    consoleOutput: $('#consoleOutput'), consoleForm: $('#consoleForm'), consoleInput: $('#consoleInput'),
    logFilters: $('#logFilters'),
    netTotal: $('#netTotal'),
    netFilters: $('#netFilters'), netFiltered: $('#netFiltered'),
    networkBody: $('#networkBody'), networkDetail: $('#networkDetail'),
    sourcesTree: $('#sourcesTree'), sourcesBody: $('#sourcesBody'), srcFileLabel: $('#srcFileLabel'),
    srcFileMeta: $('#srcFileMeta'), srcCount: $('#srcCount'), srcFilter: $('#srcFilter'),
    btnRefreshSources: $('#btnRefreshSources'),
    pwdModal: $('#pwdModal'), pwdInput: $('#pwdInput'), pwdError: $('#pwdError'),
    pwdSubmit: $('#pwdSubmit'), pwdCancel: $('#pwdCancel'),
    vaultModal: $('#vaultModal'), closeVaultBtn: $('#closeVaultBtn'), vaultCount: $('#vaultCount'),
    addCurrentBtn: $('#addCurrentBtn'), vaultList: $('#vaultList'),
    changePwdBtn: $('#changePwdBtn'), changePwdBox: $('#changePwdBox'),
    oldPwd: $('#oldPwd'), newPwd: $('#newPwd'), savePwdBtn: $('#savePwdBtn'),
    pwdChangeError: $('#pwdChangeError'), vaultDoneBtn: $('#vaultDoneBtn'),
    resendModal: $('#resendModal'), resendMethod: $('#resendMethod'), resendUrl: $('#resendUrl'),
    resendHeaders: $('#resendHeaders'), resendBody: $('#resendBody'), resendError: $('#resendError'),
    resendSend: $('#resendSend'), resendCancel: $('#resendCancel'), resendCloseBtn: $('#resendCloseBtn'),
    tplPathOf: $('#tplPathOf'), tplDomTree: $('#tplDomTree'), tplDetail: $('#tplDetail'),
    tplSetAttrs: $('#tplSetAttrs'), tplTextNode: $('#tplTextNode'), tplRemoveNode: $('#tplRemoveNode'),
    tplInspect: $('#tplInspect'), tplPoll: $('#tplPoll'), tplStop: $('#tplStop'),
    tplHighlight: $('#tplHighlight'), tplChildren: $('#tplChildren'),
    toastWrap: $('#toastWrap')
  };

  /* ================= 通用反馈 ================= */
  function toast(text, type, duration) {
    const node = document.createElement('div');
    node.className = 'toast ' + (type || '');
    node.textContent = text;
    el.toastWrap.appendChild(node);
    setTimeout(() => node.remove(), duration || 2800);
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function pageExec(script) {
    /* 超时保护：页面主线程繁忙或 renderer 卡顿时 executeJavaScript 可能无限挂起，
       会拖死整个选取轮询链；超时后放弃本次执行，让上层 catch 恢复流程 */
    return Promise.race([
      desktop.exec(script),
      new Promise((_, rej) => setTimeout(() => rej(new Error('页面执行超时')), 8000))
    ]).then((r) => {
      if (!r.ok) throw new Error(r.error || '执行失败');
      return r.value;
    });
  }

  /* 页面内脚本统一前置 tplPathOf：跨 frame 解析（__simFrameChain / __simResolve / __simAbsRect）
     都定义在那里，单独执行某个模板会取不到，iframe 内的元素就定位/高亮不了 */
  function pageTpl(name, path, ops) {
    let body = el[name] ? el[name].textContent : '';
    if (path !== undefined) body = body.replace('__PATH_JSON__', JSON.stringify(path));
    if (ops !== undefined) body = body.replace('__OPS_JSON__', JSON.stringify(ops));
    return el.tplPathOf.textContent + '\n' + body;
  }

  /* ================= 导航 ================= */
  function demoSrc(page, params) {
    const qs = new URLSearchParams();
    qs.set('page', page);
    Object.keys(params || {}).forEach((k) => qs.set(k, params[k]));
    qs.set('k', state.kernel);
    return state.serverBase + '/demo.html?' + qs.toString();
  }

  function resolveInput(raw) {
    const value = String(raw || '').trim();
    if (!value) return null;
    if (/^demo:\/\//i.test(value)) {
      const rest = value.slice(7);
      const qi = rest.indexOf('?');
      const page = (qi > -1 ? rest.slice(0, qi) : rest).replace(/\/$/, '') || 'home';
      const params = {};
      if (qi > -1) new URLSearchParams(rest.slice(qi + 1)).forEach((v, k) => { params[k] = v; });
      return { src: demoSrc(page, params), display: value };
    }
    let url = value;
    if (!/^https?:\/\//i.test(url)) {
      if (/^(localhost(:\d+)?|[\w-]+(\.[\w-]+)+)(\/|$|\?)/i.test(url)) url = 'https://' + url;
      else return { src: demoSrc('search', { q: value }), display: 'demo://search?q=' + encodeURIComponent(value) };
    }
    return { src: url, display: url };
  }

  function ensureBase() {
    if (state.serverBase) return Promise.resolve();
    return desktop.getInfo().then((info) => {
      state.serverBase = 'http://127.0.0.1:' + info.port;
    });
  }

  function navigate(raw) {
    ensureBase().then(() => {
      const resolved = resolveInput(raw);
      if (!resolved) { toast('请输入网址', 'err'); return; }
      /* 未勾选「持续」：换网址前清空控制器与网络记录 */
      if (!state.persistLog) resetDevRecords();
      state.displayUrl = resolved.display;
      el.addressInput.value = resolved.display;
      el.blockedTip.hidden = true;
      state.pageErrorVisible = false;
      syncPageVisibility();
      el.btnRefresh.classList.remove('spinning');
      void el.btnRefresh.offsetWidth;
      el.btnRefresh.classList.add('spinning');
      setTimeout(() => el.btnRefresh.classList.remove('spinning'), 650);
      clearSelection(false);
      updateStarState();
      pushLog('system', '导航 → ' + resolved.display);
      return desktop.navigate(resolved.src);
    }).catch((err) => toast('导航失败：' + err.message, 'err'));
  }

  function refreshPage() {
    /* 未勾选「持续」：刷新前清空控制器与网络记录 */
    if (!state.persistLog) resetDevRecords();
    if (state.pageErrorVisible) {
      state.pageErrorVisible = false;
      el.blockedTip.hidden = true;
      syncPageVisibility();
    }
    toast('正在刷新页面…');
    desktop.reload().catch((err) => toast('刷新失败：' + err.message, 'err'));
  }

  /* ================= 内核 / 机型 / 视口 / 缩放 / 全屏 ================= */
  /* 机型参数全部来自 page-devices.js（经主进程下发），这里只负责查表与界面同步 */
  function deviceFor(kernel, id) {
    const list = DEVICE_PRESETS[kernel] || [];
    return list.find((d) => d.id === id) ||
      list.find((d) => d.id === DEFAULT_DEVICE[kernel]) || list[0] || null;
  }
  function currentDevice() {
    return deviceFor(state.kernel, state.device) || deviceFor('ios', DEFAULT_DEVICE.ios);
  }
  function saveDeviceChoice() {
    try { localStorage.setItem('ps-device-by-kernel', JSON.stringify(state.deviceByKernel)); } catch (e) {}
  }

  function updateKernelUI() {
    $$('.seg[data-kernel]').forEach((b) => {
      const k = b.dataset.kernel;
      b.classList.toggle('active', k === state.kernel);
      const dev = deviceFor(k, state.deviceByKernel[k]);
      b.title = !dev ? ''
        : (k === state.kernel
          ? dev.label + ' · 当前使用 ' + dev.name + '（悬停选择机型）'
          : dev.label + '（悬停查看机型，点击后才会切换）');
    });
    const dev = currentDevice();
    el.uaBadge.textContent = dev ? dev.badge : 'WebKit';
  }

  function updateUaLine() {
    const dev = currentDevice();
    const width = state.viewportMode === 'full' ? '全宽' : (dev ? dev.screenW + 'px' : '390px');
    el.uaLine.textContent = (dev ? dev.osLabel : '模拟内核') + ' · 视口 ' + width;
  }

  /* 主进程推来的"当前标签环境"：内核 / 机型 / 视口 / 缩放都随标签切换而切换 */
  function applyTabEnv(env) {
    if (!env) return;
    const prevKernel = state.kernel;
    state.kernel = DEVICE_PRESETS[env.kernel] ? env.kernel : 'ios';
    if (env.device && deviceFor(state.kernel, env.device)) {
      state.device = env.device;
      state.deviceByKernel[state.kernel] = env.device;
      saveDeviceChoice();
    } else if (state.kernel !== prevKernel || !state.device) {
      state.device = state.deviceByKernel[state.kernel] || DEFAULT_DEVICE[state.kernel] || '';
    }
    state.viewportMode = env.vp === 'full' ? 'full' : 'phone';
    state.pageZoom = Number(env.zoom) || 1;
    document.body.dataset.kernel = state.kernel;
    /* 页面框宽度 = 所选机型的逻辑宽度（缩放倍数仍由 --page-zoom 处理） */
    const dev = currentDevice();
    if (dev) el.pageFrame.style.setProperty('--page-w', dev.screenW + 'px');
    el.pageFrame.classList.toggle('vp-full', state.viewportMode === 'full');
    $$('.seg.vp').forEach((b) => b.classList.toggle('active', b.dataset.vp === state.viewportMode));
    el.pageZoomLabel.textContent = Math.round(state.pageZoom * 100) + '%';
    document.documentElement.style.setProperty('--page-zoom', String(state.pageZoom));
    updateKernelUI();
    updateUaLine();
    setTimeout(sendLayout, 20);
  }

  /* 菜单里的"切换内核"：按 iOS → Android → 鸿蒙 循环 */
  function nextKernel() {
    const i = KERNEL_ORDER.indexOf(state.kernel);
    return KERNEL_ORDER[(i + 1) % KERNEL_ORDER.length];
  }

  /* 切换内核或机型：只作用于当前标签，主进程会重载页面应用新 UA / 屏幕 / DPR */
  function selectDevice(kernel, deviceId) {
    const dev = deviceFor(kernel, deviceId);
    if (!dev) return;
    state.deviceByKernel[kernel] = dev.id;
    saveDeviceChoice();
    applyTabEnv({ kernel: kernel, device: dev.id, vp: state.viewportMode, zoom: state.pageZoom });
    if (typeof desktop.setDevice === 'function') desktop.setDevice(kernel, dev.id).catch(() => {});
    else if (typeof desktop.setKernel === 'function') desktop.setKernel(kernel).catch(() => {});
    pushLog('system', '当前标签机型切换为 ' + dev.menuText);
    toast('当前标签：' + dev.name + '（' + dev.screenW + '×' + dev.screenH +
      ' · Dpr:' + dev.dpr + ' · ' + dev.os + '）', 'ok');
  }

  function setKernel(kernel) {
    if (!DEVICE_PRESETS[kernel]) return;
    if (kernel === state.kernel) return;
    selectDevice(kernel, state.deviceByKernel[kernel] || DEFAULT_DEVICE[kernel]);
  }

  function setPageZoom(value) {
    state.pageZoom = clamp(Math.round(value * 10) / 10, 0.5, 2);
    el.pageZoomLabel.textContent = Math.round(state.pageZoom * 100) + '%';
    /* 页面框随缩放整体放大/缩小（宽高都乘缩放倍数），
       主进程再把 CSS 视口设成"框尺寸 ÷ 倍数"，内容在框里等比放大 */
    document.documentElement.style.setProperty('--page-zoom', String(state.pageZoom));
    desktop.setZoom(state.pageZoom).catch(() => {});
    /* 框尺寸变了 → 重新同步视图边界给主进程 */
    setTimeout(sendLayout, 40);
  }

  async function toggleFullscreen() {
    const value = await desktop.toggleWindowFullscreen();
    state.desktopFullscreen = !!value;
    el.btnFullscreen.textContent = value ? '⛶ 退出全屏' : '⛶ 全屏';
    toast(value ? '已进入窗口全屏，按 Esc 退出' : '已退出全屏', 'ok');
  }

  /* ================= 布局同步（WebContentsView 边界） ================= */
  function sendLayout() {
    const r = el.pageFrame.getBoundingClientRect();
    if (r.width > 10 && r.height > 10) {
      desktop.layout({ x: r.left, y: r.top, width: r.width, height: r.height });
    }
  }

  /* ================= 弹层遮挡处理 =================
     网页由原生 WebContentsView 渲染，永远浮在窗口 HTML 之上，
     因此弹出密码框 / 收藏列表或加载失败提示时，需要暂时隐藏网页视图。
     注意：必须是同步立即隐藏！之前"先等 capturePage 快照再隐藏"在
     ArkWeb + 全宽大页面上 capturePage 偶尔挂起不返回，网页视图不隐藏，
     HTML 弹窗就永远被原生页面盖住（表现为"收藏网址弹窗出不来"）。
     顶部菜单与机型列表不在此列 —— 它们用独立置顶小窗（popShow），
     网页无需隐藏，视频 / 动画照常播放。 */
  function syncPageVisibility() {
    const modalOpen = !el.pwdModal.hidden || !el.vaultModal.hidden || !el.hwModal.hidden;
    const wantVisible = !modalOpen && !state.pageErrorVisible;
    if (wantVisible === state.pageVisible) return;
    state.pageVisible = wantVisible;
    if (el.pageSnapshot) el.pageSnapshot.hidden = true;
    /* 网页视图隐藏时页面容器改为深色，弹窗遮罩背后不会露出一块白 */
    if (el.pageFrame) el.pageFrame.classList.toggle('page-off', !wantVisible);
    desktop.setPageVisible(wantVisible);
    pushLog('system', wantVisible ? '网页视图已恢复显示' : '网页视图已隐藏（弹窗置顶）');
  }

  const modalObserver = new MutationObserver(() => syncPageVisibility());
  modalObserver.observe(el.pwdModal, { attributes: true, attributeFilter: ['hidden'] });
  modalObserver.observe(el.vaultModal, { attributes: true, attributeFilter: ['hidden'] });
  modalObserver.observe(el.hwModal, { attributes: true, attributeFilter: ['hidden'] });

  /* ================= 置顶弹层小窗口（菜单 / 机型列表选中回传） ================= */
  desktop.onPopSelected((p) => {
    if (!p) return;
    if (p.kind === 'device') { selectDevice(p.kernel, p.device); return; }
    if (p.kind === 'menu') {
      $$('.menu-item.open').forEach((b) => b.classList.remove('open'));
      runMenuAction(p.action);
    }
  });

  /* ================= 收藏网址（密码保护） ================= */
  function updateStarState() {
    const saved = state.bookmarks.some((b) => b.url === state.displayUrl);
    el.btnVault.classList.toggle('saved', saved);
    el.btnVault.textContent = saved ? '★' : '☆';
    el.btnVault.title = saved ? '已收藏 · 点击查看收藏网址列表' : '收藏网址（需输入密码）';
  }

  function openPasswordModal() {
    el.pwdInput.value = '';
    el.pwdError.textContent = '';
    el.pwdModal.hidden = false;
    setTimeout(() => el.pwdInput.focus(), 30);
  }

  function submitPassword() {
    if (el.pwdInput.value === state.password) {
      el.pwdModal.hidden = true;
      el.changePwdBox.hidden = true;
      renderVault();
      el.vaultModal.hidden = false;
      toast('收藏夹已解锁', 'ok');
    } else {
      el.pwdError.textContent = '密码错误，请重试（默认 123456）';
      el.pwdModal.classList.remove('shake');
      void el.pwdModal.offsetWidth;
      el.pwdModal.classList.add('shake');
      el.pwdInput.select();
    }
  }

  function colorFor(url) {
    const colors = ['#2f88ff', '#7b5cff', '#35d29a', '#ff9f45', '#e8637d', '#26b4c9'];
    let hash = 0;
    for (let i = 0; i < url.length; i++) hash = (hash * 31 + url.charCodeAt(i)) >>> 0;
    return colors[hash % colors.length];
  }

  function renderVault() {
    el.vaultCount.textContent = state.bookmarks.length;
    if (!state.bookmarks.length) {
      el.vaultList.innerHTML = '<div class="vault-empty">还没有收藏网址，点击上方按钮收藏当前页面吧</div>';
      return;
    }
    el.vaultList.innerHTML = state.bookmarks.map((b, i) =>
      '<div class="vault-item" data-index="' + i + '">' +
        '<div class="vault-favicon" style="background:' + colorFor(b.url) + '">' +
          escapeHtml((b.title || b.url).charAt(0).toUpperCase()) + '</div>' +
        '<div class="vault-info"><strong>' + escapeHtml(b.title) + '</strong><span>' + escapeHtml(b.url) + '</span></div>' +
        '<button class="vault-del" data-del="' + i + '" title="删除">✕</button>' +
      '</div>').join('');
  }

  function addCurrentBookmark() {
    if (state.bookmarks.some((b) => b.url === state.displayUrl)) {
      toast('当前网址已在收藏夹中');
      return;
    }
    state.bookmarks.push({ title: state.title || state.displayUrl, url: state.displayUrl });
    store.set('ps.bookmarks', state.bookmarks);
    renderVault();
    updateStarState();
    toast('已收藏：' + state.displayUrl, 'ok');
    pushLog('system', '新增收藏：' + state.displayUrl);
  }

  function savePassword() {
    const oldPwd = el.oldPwd.value;
    const newPwd = el.newPwd.value;
    if (oldPwd !== state.password) { el.pwdChangeError.textContent = '原密码不正确'; return; }
    if (newPwd.length < 4) { el.pwdChangeError.textContent = '新密码至少需要 4 位'; return; }
    state.password = newPwd;
    store.set('ps.password', newPwd);
    el.oldPwd.value = '';
    el.newPwd.value = '';
    el.pwdChangeError.textContent = '';
    el.changePwdBox.hidden = true;
    toast('密码已更新，下次查看收藏需使用新密码', 'ok');
  }

  /* ================= F12 控制台：标签 / 日志 / 网络 ================= */
  function switchTab(tab) {
    state.activeTab = tab;
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
    if (tab === 'elements') buildDomTree();
    if (tab === 'console') renderLogs();
    if (tab === 'network') renderNetwork();
    /* 每个页面打开调试器时扫一次（补齐缓存命中的脚本），之后靠网络回调增量 + 手动 ↻ */
    if (tab === 'sources') {
      renderSourceTree();
      if (!state.srcScanned) { state.srcScanned = true; scanPageScripts(); }
    }
  }

  function toggleDevtools(force) {
    const show = typeof force === 'boolean' ? force : el.devtools.hidden;
    el.devtools.hidden = !show;
    if (show) {
      applyDockLayout();
      switchTab(state.activeTab);
      pushLog('system', 'DevTools 已打开 · F12 可关闭 · 可拖拽边缘调整大小');
    }
    setTimeout(sendLayout, 40);
  }

  /* ================= DevTools 停靠（底部 / 右侧）与大小拖拽 ================= */
  function applyDockLayout() {
    const right = state.dtDock === 'right';
    el.workbench.classList.toggle('dock-right', right);
    /* 未设置过尺寸（首次打开）时按工作区比例给默认值：右侧 57% 宽、底部 42% 高，
       和截图里红框的大小一致；之后用户拖拽 / 切停靠都沿用记住的像素值 */
    if (!state.dtSize) {
      const rect = el.workbench.getBoundingClientRect();
      state.dtSize = Math.round(right ? (rect.width || 1200) * 0.57 : (rect.height || 700) * 0.42);
    }
    el.workbench.style.setProperty('--dt-size', state.dtSize + 'px');
    el.btnDockToggle.textContent = right ? '⇩ 底部' : '⇥ 右侧';
    el.btnDockToggle.title = right ? '停靠到底部' : '停靠到右侧';
  }

  el.btnDockToggle.addEventListener('click', () => {
    /* 方向换了尺寸含义也变了（宽度 ↔ 高度），重置后按新方向的默认比例重算 */
    state.dtSize = 0;
    state.dtDock = state.dtDock === 'bottom' ? 'right' : 'bottom';
    try { localStorage.setItem('ps-dt-dock-v2', state.dtDock); } catch (e) {}
    applyDockLayout();
    sendLayout();
    pushLog('system', 'DevTools 已停靠到' + (state.dtDock === 'right' ? '右侧' : '底部'));
  });

  let dtDragging = false;
  el.devtoolsResizer.addEventListener('mousedown', (e) => {
    if (el.devtools.hidden) return;
    dtDragging = true;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dtDragging) return;
    /* 兜底：mouseup 丢在窗口外时按钮已松开，别再跟着移动改尺寸 */
    if (e.buttons === 0) { dtDragging = false; return; }
    const wb = el.workbench.getBoundingClientRect();
    if (state.dtDock === 'bottom') {
      state.dtSize = Math.round(Math.min(Math.max(wb.bottom - e.clientY, 180), wb.height - 140));
    } else {
      state.dtSize = Math.round(Math.min(Math.max(wb.right - e.clientX, 260), wb.width - 260));
    }
    el.workbench.style.setProperty('--dt-size', state.dtSize + 'px');
    sendLayout();
  });
  window.addEventListener('mouseup', () => {
    if (!dtDragging) return;
    dtDragging = false;
    try { localStorage.setItem('ps-dt-size-v4', String(state.dtSize)); } catch (e) {}
    sendLayout();
  });

  function pushLog(level, text, extra) {
    const rec = { id: (state.logSeq = (state.logSeq || 0) + 1), level: level, text: text, time: nowTime() };
    if (extra) {
      if (extra.source) rec.source = extra.source;
      if (extra.line) rec.line = extra.line;
      if (extra.file) rec.file = extra.file;
    }
    state.logs.push(rec);
    if (state.logs.length > 500) state.logs.shift();
    if (state.activeTab === 'console' && !el.devtools.hidden) renderLogs();
  }

  /* 未勾选「持续」时，刷新 / 换网址清空控制器与网络记录（与 Chrome DevTools 一致）。
     调试器脚本列表由 onPageNavigated 单独重置，这里只管日志和抓包记录。 */
  function resetDevRecords() {
    state.logs = [];
    state.requests = [];
    state.netExtra = {};
    state.netSelected = 0;
    el.networkDetail.innerHTML = '<p class="empty">点击请求查看详情</p>';
    renderLogs();
    renderNetwork();
  }

  /* 日志一律单行显示（超宽用 … 截断，多行压成一行），双击展开全文 / 收起；
     展开状态按日志 id 记住，重绘后不丢。
     是否溢出用实际渲染宽度判断，比按字符数猜更准 */
  let clipRaf = 0;

  function markClips() {
    if (!el.consoleOutput) return;
    if (clipRaf) cancelAnimationFrame(clipRaf);
    clipRaf = requestAnimationFrame(() => {
      clipRaf = 0;
      Array.prototype.forEach.call(el.consoleOutput.querySelectorAll('.log-line'), (row) => {
        const t = row.querySelector('.log-text');
        if (!t || t.classList.contains('open')) return;
        const txt = t.textContent || '';
        /* 有多行内容，或横向被截断，都算"折叠中" */
        const over = txt.indexOf('\n') >= 0 || t.scrollWidth > t.clientWidth + 2;
        t.classList.toggle('clipped', over);
        row.classList.toggle('long-closed', over);
        if (over) t.title = '双击展开（共 ' + txt.length + ' 字符）';
        else t.removeAttribute('title');
      });
    });
  }

  /* 日志级别归一：页面里的 log / info / debug 都算「信息」，result 也归到信息 */
  function logKind(level) {
    const l = String(level || 'info').toLowerCase();
    if (l === 'error') return 'error';
    if (l === 'warn' || l === 'warning') return 'warn';
    if (l === 'system') return 'system';
    return 'info';
  }

  /* 来源短名：优先显示「文件:行号」，完整地址放 title */
  function shortSource(src, line) {
    let s = String(src || '').trim();
    if (!s) return '';
    try {
      const u = new URL(s);
      const parts = u.pathname.split('/').filter(Boolean);
      s = parts.slice(-2).join('/') || u.hostname;
      if (u.search) s += '?…';
    } catch (e) {
      const seg = s.split(/[\\/]/).filter(Boolean);
      s = seg.slice(-2).join('/') || s;
    }
    if (s.length > 48) s = '…' + s.slice(-46);
    return line ? s + ':' + line : s;
  }

  /* ================= 调试器：页面脚本列表 + 源码查看 ================= */
  let sourceCache = new Map();     /* 同一文件反复点不用重复下载（按标签页隔离） */

  /* 脚本地址入列表（保持顺序、去重） */
  function addSourceUrl(url) {
    const u = String(url || '').trim();
    if (!u || !/^https?:|^file:/i.test(u)) return;
    if (state.sources.indexOf(u) >= 0) return;
    state.sources.push(u);
    if (el.srcCount) el.srcCount.textContent = String(state.sources.length);
  }
  /* 指定标签存储用的版本（后台标签的脚本也记进它自己的列表） */
  function addSourceUrlTo(store, url) {
    const u = String(url || '').trim();
    if (!u || !/^https?:|^file:/i.test(u)) return;
    if (store.sources.indexOf(u) >= 0) return;
    store.sources.push(u);
  }

  /* 从页面扫描脚本：script[src] + performance 里 initiatorType=script 的资源（含动态加载的模块） */
  function scanPageScripts() {
    const script = `JSON.stringify((function () {
      var out = [];
      Array.prototype.forEach.call(document.querySelectorAll('script[src]'), function (s) {
        if (s.src) out.push(s.src);
      });
      try {
        performance.getEntriesByType('resource').forEach(function (r) {
          if (r && (r.initiatorType === 'script' || /\\.js($|\\?)/i.test(r.name || ''))) out.push(r.name);
        });
      } catch (e) {}
      return out.filter(function (v, i, a) { return v && a.indexOf(v) === i; });
    })())`;
    return pageExec(script).then((txt) => {
      if (!txt) return;
      let list = null;
      try { list = JSON.parse(txt); } catch (e) { list = null; }
      if (Array.isArray(list)) list.forEach(addSourceUrl);
      renderSourceTree();
    }).catch(() => {});
  }

  /* 把地址按 origin + 路径分段成树 */
  function buildSourceTree(urls) {
    const root = { dirs: new Map(), files: [] };
    urls.forEach((u) => {
      let segs = [];
      try { segs = new URL(u).pathname.split('/').filter(Boolean); } catch (e) { segs = String(u).split('/').filter(Boolean); }
      if (!segs.length) segs = [String(u)];
      const dirs = segs.slice(0, -1);
      const name = segs[segs.length - 1];
      let cur = root;
      dirs.forEach((d) => {
        if (!cur.dirs.has(d)) cur.dirs.set(d, { dirs: new Map(), files: [] });
        cur = cur.dirs.get(d);
      });
      cur.files.push({ name: name, url: u });
    });
    return root;
  }

  function srcNodesHtml(node, depth) {
    let html = '';
    node.dirs.forEach((child, name) => {
      html += '<div class="src-node">' +
        '<div class="src-dir" style="padding-left:' + (depth * 12 + 2) + 'px"><span class="src-caret">▾</span>' + escapeHtml(name) + '</div>' +
        '<div class="src-children">' + srcNodesHtml(child, depth + 1) + '</div>' +
        '</div>';
    });
    node.files.forEach((f) => {
      const active = f.url === state.srcUrl ? ' active' : '';
      html += '<div class="src-file-row' + active + '" data-url="' + escapeHtml(f.url) + '" title="' + escapeHtml(f.url) + '">' +
        '<span class="src-js">JS</span>' +
        '<span class="src-name">' + escapeHtml(f.name) + '</span>' +
        '</div>';
    });
    return html;
  }

  function renderSourceTree() {
    if (!el.sourcesTree) return;
    if (el.srcCount) el.srcCount.textContent = String(state.sources.length);
    const kw = (state.srcFilter || '').toLowerCase();
    const urls = state.sources.filter((u) => !kw || u.toLowerCase().indexOf(kw) >= 0);
    if (!urls.length) {
      el.sourcesTree.innerHTML = '<p class="empty">' +
        (state.sources.length ? '没有匹配的脚本' : '暂无脚本，页面加载 JS 后自动出现') + '</p>';
      return;
    }
    /* 按域名分组，组内构树 */
    const groups = new Map();
    urls.forEach((u) => {
      let origin = '';
      try { origin = new URL(u).origin; } catch (e) { origin = ''; }
      if (!groups.has(origin)) groups.set(origin, []);
      groups.get(origin).push(u);
    });
    let html = '';
    groups.forEach((list, origin) => {
      html += '<div class="src-origin" title="' + escapeHtml(origin) + '">' +
        escapeHtml(origin.replace(/^https?:\/\//, '') || '(本地)') +
        '<span class="src-count">' + list.length + '</span></div>';
      html += srcNodesHtml(buildSourceTree(list), 0);
    });
    el.sourcesTree.innerHTML = html;
    /* 当前文件滚动到可见区 */
    const act = el.sourcesTree.querySelector('.src-file-row.active');
    if (act) act.scrollIntoView({ block: 'nearest' });
  }

  /* 打开某个文件：切到调试器面板、选中文件、渲染源码并定位到对应行 */
  function openInDebugger(url, line) {
    const u = String(url || '').trim();
    if (!u) return;
    state.srcUrl = u;
    state.srcLine = Number(line) || 0;
    addSourceUrl(u);
    switchTab('sources');
    renderSourceTree();
    loadSource(u, state.srcLine);
  }

  function shortFileName(url) {
    try { return new URL(url).pathname.split('/').filter(Boolean).pop() || url; } catch (e) { return url; }
  }

  function loadSource(url, line) {
    if (!el.sourcesBody) return;
    el.srcFileLabel.textContent = shortFileName(url);
    el.srcFileLabel.title = url;
    el.srcFileMeta.textContent = '';
    const cached = sourceCache.get(url);
    if (cached != null) { renderSource(cached, line); return; }
    el.sourcesBody.innerHTML = '<p class="empty">读取中…</p>';
    desktop.readSource(url).then((r) => {
      if (!r || !r.ok) {
        el.sourcesBody.innerHTML = '<p class="empty">无法读取源文件：' + escapeHtml((r && r.error) || '未知错误') + '</p>';
        return;
      }
      if (sourceCache.size > 30) sourceCache.delete(sourceCache.keys().next().value);
      sourceCache.set(url, r.text);
      renderSource(r.text, line);
    }).catch((err) => {
      el.sourcesBody.innerHTML = '<p class="empty">无法读取源文件：' + escapeHtml(err.message) + '</p>';
    });
  }

  function renderSource(text, line) {
    const MAXLINES = 8000;
    const all = String(text == null ? '' : text).split(/\r\n|\r|\n/);
    const clipped = all.length > MAXLINES;
    const lines = clipped ? all.slice(0, MAXLINES) : all;
    el.sourcesBody.innerHTML = lines.map((t, i) => {
      const no = i + 1;
      return '<div class="src-line' + (no === Number(line) ? ' hit' : '') + '">' +
        '<span class="src-no">' + no + '</span>' +
        '<span class="src-code">' + (t ? escapeHtml(t) : '&nbsp;') + '</span>' +
        '</div>';
    }).join('');
    el.srcFileMeta.textContent = (line ? '定位到第 ' + line + ' 行 · ' : '') +
      '共 ' + all.length + ' 行' + (clipped ? '（仅显示前 ' + MAXLINES + ' 行）' : '');
    const hit = el.sourcesBody.querySelector('.src-line.hit');
    if (hit) hit.scrollIntoView({ block: 'center' });
    else el.sourcesBody.scrollTop = 0;
  }

  function renderLogs() {
    const counts = { error: 0, warn: 0, info: 0, system: 0 };
    const shown = [];
    state.logs.forEach((l) => {
      const kind = logKind(l.level);
      counts[kind] = (counts[kind] || 0) + 1;
      if (state.logFilter[kind] !== false) shown.push(l);
    });
    /* 筛选按钮上的计数（能看到被隐藏了多少） */
    if (el.logFilters) {
      Array.prototype.forEach.call(el.logFilters.querySelectorAll('.log-filter'), (btn) => {
        const k = btn.dataset.kind;
        btn.classList.toggle('active', state.logFilter[k] !== false);
        const b = btn.querySelector('b');
        if (b) b.textContent = String(counts[k] || 0);
      });
    }
    if (!shown.length) {
      el.consoleOutput.innerHTML = '<p class="empty">' + (state.logs.length ? '当前筛选下没有日志' : '暂无日志，页面报错与 console 输出会显示在这里') + '</p>';
      return;
    }
    el.consoleOutput.innerHTML = shown.map((l) => {
      const kind = logKind(l.level);
      const src = l.source ? shortSource(l.source, l.line) : '';
      const lv = String(l.level).toLowerCase();
      const txt = String(l.text == null ? '' : l.text);
      const open = state.logOpen.has(l.id);
      return '<div class="log-line ' + kind + (lv === kind ? '' : ' ' + escapeHtml(lv)) + '" data-log="' + l.id + '">' +
        '<span class="log-time">' + escapeHtml(l.time) + '</span>' +
        '<span class="log-badge">' + escapeHtml(String(l.level).toUpperCase()) + '</span>' +
        '<span class="log-text' + (open ? ' open' : '') + '"' +
          (open ? ' title="双击收起"' : '') + '>' +
          escapeHtml(txt) + '</span>' +
        (src ? '<span class="log-source" data-src="' + escapeHtml(l.source) + '" data-line="' + (l.line || 0) + '" title="' +
          (l.line ? '点击打开源文件并定位到第 ' + l.line + ' 行' : '点击打开源文件') + '\n' + escapeHtml(l.source) + '">' + escapeHtml(src) + '</span>' : '') +
      '</div>';
    }).join('');
    el.consoleOutput.scrollTop = el.consoleOutput.scrollHeight;
    /* 渲染后按实际宽度标记哪些是折起来的（可双击展开） */
    markClips();
  }

  function addRequest(entry) {
    const rec = Object.assign({
      id: ++state.netSeq, time: nowTime(), name: '', url: '', method: 'GET',
      status: 200, type: 'resource', size: 0, duration: 0, error: ''
    }, entry);
    state.requests.push(rec);
    if (state.requests.length > 200) state.requests.shift();
    el.netCount.textContent = state.requests.length;
    if (state.activeTab === 'network' && !el.devtools.hidden) renderNetwork();
    return rec.id;
  }

  /* 网络详情（请求体 / 响应体）按请求 id 存：
     CDP 的 requestId 与列表行 id 不是一套，靠 url+method 配对 */
  function netExtraOf(id) {
    if (!state.netExtra[id]) state.netExtra[id] = {};
    return state.netExtra[id];
  }
  /* 找到与这条详情对应的请求行：同 url + 同方法，取最近一条还没被认领的 */
  function matchRequestRow(url, method, tabId) {
    const list = state.requests;
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      if (r.url !== url) continue;
      if (method && r.method && r.method !== method) continue;
      if (tabId && r.tabId && r.tabId !== tabId) continue;
      const ex = state.netExtra[r.id];
      if (ex && (ex.body !== undefined || ex.postData !== undefined || ex._taken)) continue;
      return r;
    }
    return null;
  }

  /* 请求列表里带上域名，广告 / CDN 的第三方请求一眼可辨 */
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  function statusCell(status) {
    const n = Number(status) || 0;
    if (n >= 200 && n < 400) return '<span class="status-ok">' + n + '</span>';
    return '<span class="status-fail">' + (n || 'ERR') + '</span>';
  }

  /* 资源类型归类：把 Chromium 的 resourceType 映射成 DevTools 风格的筛选分类 */
  function netCategory(type) {
    const t = String(type || '').toLowerCase();
    if (t.indexOf('frame') >= 0 || t === 'document') return 'html';
    if (t.indexOf('stylesheet') >= 0) return 'css';
    if (t.indexOf('script') >= 0) return 'js';
    if (t === 'xhr' || t === 'fetch') return 'xhr';
    if (t.indexOf('font') >= 0) return 'font';
    if (t.indexOf('image') >= 0) return 'img';
    if (t.indexOf('media') >= 0) return 'media';
    if (t.indexOf('websocket') >= 0) return 'ws';
    return 'other';
  }

  /* Electron 的 resourceType 对主文档叫 mainFrame，展示时换成 DevTools 习惯的 document */
  function netTypeName(t) {
    const s = String(t || '');
    if (s === 'mainFrame') return 'document';
    return s;
  }

  function renderNetwork() {
    const total = state.requests.length;
    el.netTotal.textContent = total;
    el.netCount.textContent = total;
    const list = state.requests.filter((r) => state.netFilter === 'all' || netCategory(r.type) === state.netFilter);
    el.netFiltered.textContent = state.netFilter === 'all' ? '' : '当前分类 ' + list.length + ' 条';
    if (!list.length) {
      el.networkBody.innerHTML = '<tr><td colspan="7" class="net-empty">' +
        (total ? '该分类下暂无请求' : '暂无请求，导航到页面后自动抓包') + '</td></tr>';
      return;
    }
    el.networkBody.innerHTML = list.slice().reverse().map((r) =>
      '<tr data-id="' + r.id + '">' +
        '<td>' + r.id + '</td>' +
        '<td title="' + escapeHtml(r.url || r.name) + '">' +
          '<span class="net-host">' + escapeHtml(hostOf(r.url)) + '</span>' +
          escapeHtml(r.name) + '</td>' +
        '<td>' + escapeHtml(r.method) + '</td>' +
        '<td>' + statusCell(r.status) + '</td>' +
        '<td>' + escapeHtml(netTypeName(r.type)) + '</td>' +
        '<td>' + escapeHtml(formatSize(r.size)) + '</td>' +
      '</tr>').join('');
  }

  /* ===== 网络详情：消息头 / Cookie / 请求 / 响应 =====
     对应 Chrome DevTools 网络面板右侧详情区的四个子标签 */

  /* 把 {name: value|string[]} 统一成 [{name, value}] 列表 */
  function headerRows(obj) {
    const rows = [];
    Object.keys(obj || {}).forEach((k) => {
      const v = obj[k];
      if (Array.isArray(v)) v.forEach((one) => rows.push({ name: k, value: String(one) }));
      else rows.push({ name: k, value: String(v) });
    });
    return rows;
  }
  function headerTable(rows, emptyText) {
    if (!rows.length) return '<p class="empty">' + escapeHtml(emptyText || '无') + '</p>';
    return '<table class="nd-table"><tbody>' + rows.map((r) =>
      '<tr><td class="nd-k">' + escapeHtml(r.name) + '</td><td class="nd-v">' + escapeHtml(r.value) + '</td></tr>'
    ).join('') + '</tbody></table>';
  }
  /* Cookie 串 → [{name, value}] */
  function parseCookieString(str) {
    const out = [];
    String(str || '').split(';').forEach((part) => {
      const p = part.trim();
      if (!p) return;
      const i = p.indexOf('=');
      if (i < 0) out.push({ name: p, value: '' });
      else out.push({ name: p.slice(0, i).trim(), value: p.slice(i + 1).trim() });
    });
    return out;
  }
  /* Set-Cookie：拆成 name / value / 属性 */
  function parseSetCookie(str) {
    const out = [];
    String(str || '').split(',').forEach((chunk) => {
      const c = chunk.trim();
      if (!c) return;
      const parts = c.split(';');
      const head = parts.shift() || '';
      const i = head.indexOf('=');
      out.push({
        name: i < 0 ? head.trim() : head.slice(0, i).trim(),
        value: i < 0 ? '' : head.slice(i + 1).trim(),
        attrs: parts.map((a) => a.trim()).filter(Boolean).join('; ')
      });
    });
    return out;
  }
  /* 查询参数 */
  function parseQuery(url) {
    const out = [];
    try {
      const q = String(url || '').split('?')[1];
      if (!q) return out;
      q.split('&').forEach((kv) => {
        if (!kv) return;
        const i = kv.indexOf('=');
        out.push(i < 0
          ? { name: decodeURIComponent(kv), value: '' }
          : { name: decodeURIComponent(kv.slice(0, i)), value: decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' ')) });
      });
    } catch (e) {}
    return out;
  }
  function prettyBody(text) {
    const s = String(text || '');
    try {
      const j = JSON.parse(s);
      return JSON.stringify(j, null, 2);
    } catch (e) { return s; }
  }

  /* 常见 Chromium 网络错误码的中文含义（浏览器通用，与具体站点无关） */
  const NET_ERROR_HINTS = [
    [/ERR_ABORTED/i, '导航或请求被取消：常见于父页面改写/移除子框架、重定向链中断，不一定是网络故障'],
    [/ERR_BLOCKED_BY_(ORB|RESPONSE)/i, 'ORB 不透明响应阻断：Chromium 对跨源响应做类型嗅探后拦截（Firefox 无等价机制）'],
    [/ERR_BLOCKED_BY_CLIENT/i, '被客户端主动阻断：浏览器扩展、拦截规则或页面脚本'],
    [/ERR_CONNECTION_REFUSED/i, '目标主机拒绝连接：端口未监听或服务未启动'],
    [/ERR_CONNECTION_(TIMED_OUT|RESET|CLOSED)/i, '连接超时 / 被重置 / 被关闭：主机不可达或被中间设备断开'],
    [/ERR_NAME_NOT_RESOLVED/i, 'DNS 解析失败：域名不存在或无法解析'],
    [/ERR_CERT_/i, 'TLS 证书校验失败：过期、域名不匹配或自签名'],
    [/ERR_TOO_MANY_REDIRECTS/i, '重定向次数过多，通常是重定向环'],
    [/ERR_UNSAFE_PORT/i, '端口被 Chromium 列入不安全端口黑名单，浏览器直接拒绝'],
    [/ERR_INTERNET_DISCONNECTED/i, '本机网络不可用'],
    [/ERR_FAILED/i, '通用失败，结合上面的拦截原因 / CORS 信息判断']
  ];
  function netErrorHint(code) {
    const c = String(code || '');
    const hit = NET_ERROR_HINTS.find((pair) => pair[0].test(c));
    return hit ? hit[1] : '';
  }

  /* 失败原因明细：默认展开的「消息头」标签里就能看到，
     不用先展开概要 —— ERR_ABORTED 究竟是被取消、被策略拦截还是 CORS 拒绝，一眼分清 */
  function failReasonRows(r) {
    const f = (state.netExtra[r.id] || {}).failReason || {};
    const rows = [
      { name: '错误', value: r.error || '请求失败' },
      { name: '是否被取消', value: f.canceled ? '是（导航/请求被主动取消）' : '否' }
    ];
    const hint = netErrorHint(r.error || f.errorText);
    if (hint) rows.push({ name: '含义', value: hint });
    if (f.blockedReason) rows.push({ name: '拦截原因', value: f.blockedReason });
    if (f.corsError) rows.push({ name: 'CORS 错误', value: f.corsError + (f.corsFailedParameter ? ' · ' + f.corsFailedParameter : '') });
    if (f.errorText && f.errorText !== r.error) rows.push({ name: '底层描述', value: f.errorText });
    return rows;
  }

  function netDetailPaneHeaders(r) {
    const req = headerRows(r.reqHeaders);
    const res = headerRows(r.resHeaders);
    let out = '';
    if (r.error) {
      out += '<div class="nd-sec"><div class="nd-sec-t">失败原因 · Failure</div>' +
        headerTable(failReasonRows(r), '') + '</div>';
    }
    return out +
      '<div class="nd-sec"><div class="nd-sec-t">请求头 · Request Headers</div>' +
      headerTable(req, r.error ? '请求未完成，未捕获到请求头' : '未捕获到请求头') + '</div>' +
      '<div class="nd-sec"><div class="nd-sec-t">响应头 · Response Headers</div>' +
      headerTable(res, r.error ? '请求失败，无响应头' : '未捕获到响应头') + '</div>';
  }

  function netDetailPaneCookies(r) {
    const reqCookie = (r.reqHeaders || {})['Cookie'] || (r.reqHeaders || {})['cookie'] || '';
    const reqList = parseCookieString(reqCookie);
    const setList = [];
    Object.keys(r.resHeaders || {}).forEach((k) => {
      if (k.toLowerCase() !== 'set-cookie') return;
      const v = r.resHeaders[k];
      (Array.isArray(v) ? v : [v]).forEach((one) => parseSetCookie(one).forEach((c) => setList.push(c)));
    });
    /* 表格是按 ; 拆开后的 name / value 两列，整表复制出来会变成 "name<TAB>value"，
       容易被误认为请求头格式被改坏；这里再给一份未拆分的原始串，可直接对照与复制 */
    const rawBlock = reqCookie
      ? '<div class="nd-sec"><div class="nd-sec-t">原始 Cookie 串（请求头里的值）</div>' +
          '<div class="box-model">' + escapeHtml(reqCookie) + '</div></div>'
      : '';
    return '<div class="nd-sec"><div class="nd-sec-t">请求 Cookie</div>' +
      (reqList.length
        ? '<table class="nd-table"><tbody>' + reqList.map((c) =>
            '<tr><td class="nd-k">' + escapeHtml(c.name) + '</td><td class="nd-v">' + escapeHtml(c.value) + '</td></tr>').join('') + '</tbody></table>'
        : '<p class="empty">该请求未携带 Cookie</p>') +
      '</div>' + rawBlock +
      '<div class="nd-sec"><div class="nd-sec-t">响应 Set-Cookie</div>' +
      (setList.length
        ? '<table class="nd-table"><tbody>' + setList.map((c) =>
            '<tr><td class="nd-k">' + escapeHtml(c.name) + '</td><td class="nd-v">' + escapeHtml(c.value) +
            (c.attrs ? '<div class="nd-attr">' + escapeHtml(c.attrs) + '</div>' : '') + '</td></tr>').join('') + '</tbody></table>'
        : '<p class="empty">响应未设置 Cookie</p>') +
      '</div>';
  }

  function netDetailPaneRequest(r) {
    const q = parseQuery(r.url);
    const extra = state.netExtra[r.id] || {};
    let out = '<div class="nd-sec"><div class="nd-sec-t">查询参数 · Query String</div>' +
      (q.length
        ? '<table class="nd-table"><tbody>' + q.map((p) =>
            '<tr><td class="nd-k">' + escapeHtml(p.name) + '</td><td class="nd-v">' + escapeHtml(p.value) + '</td></tr>').join('') + '</tbody></table>'
        : '<p class="empty">无查询参数</p>') + '</div>';
    const pd = extra.postData;
    out += '<div class="nd-sec"><div class="nd-sec-t">请求载荷 · Payload</div>' +
      (pd ? '<pre class="nd-pre">' + escapeHtml(prettyBody(pd)) + '</pre>' : '<p class="empty">无请求体</p>') + '</div>';
    return out;
  }

  function netDetailPaneResponse(r) {
    const extra = state.netExtra[r.id] || {};
    let out = '<div class="nd-sec"><div class="nd-sec-t">响应正文 · Response</div>';
    if (extra.body === undefined) {
      out += '<p class="empty">响应体尚未获取' +
        (extra.bodyErr ? '（' + escapeHtml(String(extra.bodyErr).slice(0, 120)) + '）' : '（可能仍在加载或为二进制资源）') + '</p>';
    } else if (extra.base64) {
      out += '<p class="empty">二进制内容，不显示正文（' + formatSize(extra.body.length) + '）</p>';
    } else {
      if (extra.bodyNote) out += '<div class="nd-note">' + escapeHtml(extra.bodyNote) + '</div>';
      out += '<pre class="nd-pre">' + escapeHtml(prettyBody(extra.body)) + '</pre>';
    }
    return out + '</div>';
  }

  const NET_TABS = [
    { key: 'headers', label: '消息头', render: netDetailPaneHeaders },
    { key: 'cookies', label: 'Cookie', render: netDetailPaneCookies },
    { key: 'request', label: '请求', render: netDetailPaneRequest },
    { key: 'response', label: '响应', render: netDetailPaneResponse }
  ];

  function showNetworkDetail(id) {
    const r = state.requests.find((item) => item.id === Number(id));
    if (!r) return;
    state.netSelected = r.id;
    $$('#networkBody tr').forEach((tr) => tr.classList.toggle('selected', Number(tr.dataset.id) === Number(id)));
    /* 这条请求属于哪个标签页：广告 iframe 的域名（如 pos.baidu.com）容易让人误以为是别的标签串了 */
    const owner = tabsList.find((t) => t.id === (r.tabId || state.devTabId));
    const tab = NET_TABS.find((t) => t.key === state.netDetailTab) || NET_TABS[0];
    const ua = (r.reqHeaders || {})['User-Agent'] || (r.reqHeaders || {})['user-agent'] || '';
    const urlText = r.url || r.name || '';
    const ownerText = owner ? (owner.url || owner.title) : '当前标签';
    /* 概要（URL/所属页面/状态/UA…）默认折叠：详情区优先展示四个子标签，点标题再展开 */
    const sumOpen = !!state.netSummaryOpen;
    el.networkDetail.innerHTML =
      '<h4 class="nd-sum' + (sumOpen ? ' nd-open' : '') + '" title="' +
        (sumOpen ? '收起概要' : '展开概要（URL / 所属页面 / 状态 / User-Agent）') + '">' +
        '<span class="nd-caret">▸</span>请求详情 #' + r.id +
        '<button class="nd-resend" title="修改方法 / 网址 / 参数后重新发送该请求">↻ 重新发送</button>' +
      '</h4>' +
      '<div class="nd-summary"' + (sumOpen ? '' : ' hidden') + '>' +
        '<dl class="kv">' +
          '<dt>URL</dt><dd class="nd-clamp" title="' + escapeHtml(urlText) + '">' + escapeHtml(urlText) + '</dd>' +
          '<dt>所属页面</dt><dd class="nd-clamp" title="' + escapeHtml(ownerText) + '">' + escapeHtml(ownerText) + '</dd>' +
          '<dt>方法</dt><dd>' + escapeHtml(r.method) + '</dd>' +
          '<dt>状态</dt><dd>' + statusCell(r.status) + (r.error ? ' · ' + escapeHtml(r.error) : '') + '</dd>' +
          '<dt>类型</dt><dd>' + escapeHtml(netTypeName(r.type)) + '</dd>' +
          '<dt>大小</dt><dd>' + escapeHtml(formatSize(r.size)) + '</dd>' +
          '<dt>耗时</dt><dd>' + escapeHtml(r.duration ? r.duration + ' ms' : '—') + '</dd>' +
          '<dt>时间</dt><dd>' + escapeHtml(r.time) + '</dd>' +
        '</dl>' +
        (ua ? '<div class="box-model">User-Agent: ' + escapeHtml(ua) + '</div>' : '') +
      '</div>' +
      '<div class="nd-tabs">' + NET_TABS.map((t) =>
        '<button class="nd-tab' + (t.key === tab.key ? ' active' : '') + '" data-nt="' + t.key + '">' + t.label + '</button>').join('') +
      '</div>' +
      '<div class="nd-pane">' + tab.render(r) + '</div>';
  }

  /* ================= 控制器 ================= */
  const HELP_TEXT = [
    '可用命令：',
    '  help                 显示本帮助',
    '  clear                清空控制器输出',
    '  document.title       读取当前页面标题',
    '  navigator.userAgent  查看当前模拟内核 UA（iOS Safari / Android Chrome）',
    '  document.body.style.background = "#eef"   修改页面样式',
    '  document.querySelectorAll("*").length     统计 DOM 节点',
    '说明：脚本在页面视图上下文执行，任何网站均可用；返回值需为可序列化数据。'
  ].join('\n');

  function formatResult(value) {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'string') return value;
    if (typeof value === 'function') return 'ƒ ()';
    try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
  }

  function runCommand(code) {
    if (code === 'clear') { state.logs = []; renderLogs(); return; }
    if (code === 'help') { pushLog('system', HELP_TEXT); return; }
    pageExec(code).then((value) => pushLog('result', formatResult(value)))
      .catch((err) => pushLog('error', err.message));
  }

  /* ================= 查看器（远程 DOM 树） ================= */
  function renderDomUnavailable(message) {
    el.domTree.innerHTML = '<p class="empty">' + escapeHtml(message || '无法读取页面 DOM') + '</p>';
  }

  let buildSeq = 0;
  function buildDomTree(thenPath) {
    const my = ++buildSeq;
    const script = el.tplPathOf.textContent + '\n' +
      el.tplDomTree.textContent.replace('__TARGET_JSON__', JSON.stringify(thenPath || null));
    pageExec(script).then((txt) => {
      if (my !== buildSeq) return;   // 过期构建：已有更新的定向构建，丢弃避免覆盖
      const data = JSON.parse(txt);
      if (!data || data.t !== 'el') { renderDomUnavailable('页面 DOM 为空'); return; }
      el.domTree.innerHTML = '';
      el.domTree.appendChild(buildTreeNode(data, 0));
      $$('.dom-row').forEach((row) => row.classList.toggle('selected', row._path === state.selectedPath));
      if (thenPath) { locateInTree(thenPath); return; }
      /* 切到查看器时触发的构建：处理等待定位的悬停目标 */
      if (state.pendingHover) {
        const p = state.pendingHover;
        state.pendingHover = null;
        if (!locateInTree(p)) buildDomTree(p);
      }
    }).catch((err) => renderDomUnavailable('读取 DOM 失败：' + err.message));
  }

  /* 展开某一行自身的子节点（让元素内容可见：img / 文本 / 内部结构） */
  function expandRow(row) {
    if (!row) return;
    const node = row.parentElement;
    const box = node && node.querySelector(':scope > .dom-children');
    if (box && box.style.display === 'none') {
      box.style.display = '';
      const crow = node.querySelector(':scope > .dom-close-row');
      if (crow) crow.style.display = '';
      const caret = row.querySelector('.dom-caret');
      if (caret) caret.textContent = '-';
    }
  }

  /* 在查看器 DOM 树中定位并高亮一个节点（选取模式悬停跟随）：
     先展开其所有折叠的父级与自身，再滚动到可视区并闪烁高亮；
     动态页面里目标元素可能已被重建，精确失败时回退到最近的祖先节点 */
  function locateInTree(path) {
    let row = $$('.dom-row').find((r) => r._path === path);
    if (!row) {
      const parts = path.split(' > ');
      for (let cut = parts.length - 1; cut >= 1 && !row; cut--) {
        const anc = parts.slice(0, cut).join(' > ');
        row = $$('.dom-row').find((r) => r._path === anc);
      }
    }
    if (!row) return false;
    let p = row.parentElement;
    while (p && p !== el.domTree) {
      if (p.classList && p.classList.contains('dom-children') && p.style.display === 'none') {
        p.style.display = '';
        const node = p.parentElement;
        const crow = node && node.querySelector(':scope > .dom-close-row');
        if (crow) crow.style.display = '';
        const caret = node && node.querySelector(':scope > .dom-row > .dom-caret');
        if (caret) caret.textContent = '-';
      }
      p = p.parentElement;
    }
    expandRow(row);
    $$('.dom-row').forEach((r) => r.classList.remove('hover-flash'));
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    row.classList.add('hover-flash');
    setTimeout(() => row.classList.remove('hover-flash'), 900);
    return true;
  }

  let lastTreeBuild = 0;
  function trackHoverInTree(path) {
    if (state.activeTab !== 'elements') {
      /* 选取模式下首次悬停自动切到查看器（只切一次）；构建完成后定位 */
      if (state.hoverSwitched) return;
      state.hoverSwitched = true;
      state.pendingHover = path;
      switchTab('elements');
      return;
    }
    if (locateInTree(path)) {
      /* 祖先回退命中 ≠ 精确命中：把精确节点连同其内容子树补进树中（节流），
         否则用户悬停图片时树里永远只有外层 div、看不到 <img> */
      if (!$$('.dom-row').some((r) => r._path === path)) {
        const now = Date.now();
        if (now - lastTreeBuild > 1500) { lastTreeBuild = now; buildDomTree(path); }
      }
      return;
    }
    /* 树中找不到（未构建 / 超出默认采样）：定向重建，保证任意深层元素都能定位 */
    buildDomTree(path);
  }

  function kidsBoxOf(node, depth) {
    const box = document.createElement('div');
    box.className = 'dom-children';
    (node.kids || []).forEach((kid) => {
      if (kid.t === 'text') {
        const trow = document.createElement('div');
        trow.className = 'dom-row text-row';
        trow.title = '双击修改这段文字，右键可删除' + (kid.len > 70 ? '（原文 ' + kid.len + ' 字符，编辑框内为完整内容）' : '');
        /* 文本行没有自己的选择器：右键删除时按父元素路径 + 文本序号回取节点 */
        trow._parentPath = node.path;
        trow._ti = kid.ti;
        const span = document.createElement('span');
        span.className = 'dom-text';
        span.textContent = '"' + kid.x + '"';
        trow.appendChild(span);
        /* 文本节点没有独立选择器：定位到它的父元素（不额外画框，避免每次点文字都滚动页面） */
        trow.addEventListener('click', () => selectByPath(node.path, null, { noHighlight: true }));
        trow.addEventListener('dblclick', (e) => {
          e.preventDefault();
          openTextEditor(node.path, kid.ti);
        });
        box.appendChild(trow);
      } else {
        box.appendChild(buildTreeNode(kid, depth + 1));
      }
    });
    return box;
  }

  /* 懒加载子级：默认树只采 800 个节点，深层元素会成空壳。
     用户主动展开时按路径向页面补取直接子级（每个子节点再带 + 号，可逐层展开） */
  function lazyLoadChildren(node, row, wrap, depth) {
    if (node._loading || node._loaded) return Promise.resolve(null);
    node._loading = true;
    const script = pageTpl('tplChildren', node.path);
    return pageExec(script).then((txt) => {
      node._loading = false;
      if (!txt) return null;
      let kids = null;
      try { kids = JSON.parse(txt); } catch (e) { kids = null; }
      if (!Array.isArray(kids) || !kids.length) { node.more = 0; node._loaded = true; return null; }
      node.kids = kids;
      node._loaded = true;
      const box = kidsBoxOf(node, depth);
      wrap.appendChild(box);
      row._kidsBox = box;
      /* 子节点插到 </tag> 之前，保持成对 */
      if (row._closeRow) {
        row._closeRow.style.display = '';
        wrap.appendChild(row._closeRow);
      }
      const caret = row.querySelector('.dom-caret');
      if (caret) caret.textContent = '-';
      return box;
    }).catch(() => { node._loading = false; return null; });
  }

  /* HTML 空元素：没有闭合标签，树里显示成 <img … /> */
  const VOID_TAGS = /^(AREA|BASE|BR|COL|EMBED|HR|IMG|INPUT|LINK|META|PARAM|SOURCE|TRACK|WBR)$/;

  function buildTreeNode(node, depth) {
    const wrap = document.createElement('div');
    wrap.className = 'dom-node';
    const row = document.createElement('div');
    row.className = 'dom-row';
    row._path = node.path;
    row._data = node;

    const hasKids = !!(node.kids && node.kids.length && depth < 20);
    const canMore = !hasKids && !!node.more && depth < 20;
    const caret = document.createElement('span');
    caret.className = 'dom-caret';
    caret.textContent = hasKids ? '-' : (canMore ? '+' : '');
    row.appendChild(caret);

    const tag = document.createElement('span');
    tag.className = 'dom-tag';
    tag.textContent = '<' + node.tag;
    row.appendChild(tag);
    /* 属性一律显示在尖括号内：<div id="x" class="a b" style="color:red" src="...">
       ext 是其余属性（meta 的 charset/content、link 的 rel/href…），超出 3 个用 …+N 表示 */
    const attrText = (node.id ? ' id="' + node.id + '"' : '') +
      (node.cls ? ' class="' + node.cls.trim().split(/\s+/).slice(0, 2).join(' ') + '"' : '') +
      (node.st ? ' style="' + node.st + '"' : '') +
      (node.src ? ' src="' + node.src + '"' : '') +
      (node.ext ? ' ' + node.ext : '') +
      (node.extMore ? ' …+' + node.extMore : '');
    if (attrText) {
      const attr = document.createElement('span');
      attr.className = 'dom-attr';
      attr.textContent = attrText;
      /* 悬停看完整属性串（tree 里 style / 长属性会截断） */
      attr.title = attrText;
      row.appendChild(attr);
    }
    const close = document.createElement('span');
    close.className = 'dom-tag';
    const isVoid = VOID_TAGS.test(String(node.tag || '').toUpperCase());
    close.textContent = isVoid ? ' />' : '>';
    row.appendChild(close);
    /* 跨域 iframe：浏览器同源策略下拿不到 contentDocument，明确告知而不是显示成空壳 */
    if (node.frameBlocked) {
      const warn = document.createElement('span');
      warn.className = 'dom-src';
      warn.textContent = ' ⚠ 跨域，内容不可读';
      warn.title = '该 iframe 指向其它域名，受同源策略限制无法读取内部 DOM';
      row.appendChild(warn);
    }
    wrap.appendChild(row);

    /* 结束标记：有内容时在子节点后补 </tag>；空元素写成 <img … />；
       没有子节点的普通元素行内闭合 <div></div>（script / style 也走这条） */
    let closeRow = null;
    if (!isVoid) {
      closeRow = document.createElement('div');
      closeRow.className = 'dom-row dom-close-row';
      const pad = document.createElement('span');
      pad.className = 'dom-caret';
      closeRow.appendChild(pad);
      const label = document.createElement('span');
      label.className = 'dom-tag';
      label.textContent = '</' + node.tag + '>';
      closeRow.appendChild(label);
      row._closeRow = closeRow;
    }

    if (hasKids) {
      const box = kidsBoxOf(node, depth);
      wrap.appendChild(box);
      row._kidsBox = box;
      wrap.appendChild(closeRow);
    } else if (canMore) {
      /* 懒加载的空壳节点：先占位，展开后把子节点插在它前面 */
      closeRow.style.display = 'none';
      wrap.appendChild(closeRow);
    } else if (!isVoid) {
      close.textContent = '></' + node.tag + '>';
    }

    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      const box = row._kidsBox;
      if (!box) {
        /* 空壳节点：首次展开时按需补取子级 */
        if (canMore) lazyLoadChildren(node, row, wrap, depth);
        return;
      }
      const collapsed = box.style.display === 'none';
      box.style.display = collapsed ? '' : 'none';
      caret.textContent = collapsed ? '-' : '+';
      /* 收起时把 </tag> 一起藏掉，避免只剩一对空标签 */
      if (row._closeRow) row._closeRow.style.display = collapsed ? '' : 'none';
    });

    row.addEventListener('click', () => {
      $$('.dom-row').forEach((r) => r.classList.toggle('selected', r === row));
      selectByPath(node.path);
      /* 点击行同样补全：看到的是空壳元素时，点一下就能展开它的子级 */
      if (!row._kidsBox && canMore) lazyLoadChildren(node, row, wrap, depth);
    });
    /* 双击：打开该元素的属性编辑器（增删改属性） */
    row.addEventListener('dblclick', (e) => {
      e.preventDefault();
      $$('.dom-row').forEach((r) => r.classList.toggle('selected', r === row));
      state.selectedPath = node.path;
      el.domPath.textContent = node.path;
      openAttrEditor(node.path);
    });
    return wrap;
  }

  function renderInspectorDetail(info) {
    if (!el.domDetail) return;
    const imgBox = info.src
      ? '<div class="el-preview-box">' +
          '<img class="el-preview" src="' + escapeHtml(info.src) + '" alt="" referrerpolicy="no-referrer" />' +
          '<div class="el-preview-meta">图片：' + (info.natural && info.natural.w ? info.natural.w + ' × ' + info.natural.h + ' px' : '尺寸未知') +
          '<br /><span class="el-preview-url">' + escapeHtml(info.src) + '</span></div>' +
        '</div>'
      : '';
    const html =
      '<dl class="kv">' +
        '<dt>标签</dt><dd><span class="tag-chip">&lt;' + escapeHtml(info.tag) + '&gt;</span></dd>' +
        '<dt>id</dt><dd>' + escapeHtml(info.id || '—') + '</dd>' +
        '<dt>class</dt><dd>' + escapeHtml(info.cls || '—') + '</dd>' +
        '<dt>选择器</dt><dd>' + escapeHtml(state.selectedPath || '') + '</dd>' +
        '<dt>文本</dt><dd>' + escapeHtml(info.text || '—') + '</dd>' +
        '<dt>属性</dt><dd>' + escapeHtml(info.attrs || '—') + '</dd>' +
      '</dl>' + imgBox +
      '<div class="inspector-status">提示：双击树节点可增删改属性，右键树节点可删除元素或文本</div>' +
      '<div class="box-model">尺寸：' + info.rect.w + ' × ' + info.rect.h + ' px　位置：' + info.rect.x + ', ' + info.rect.y + '\n' +
        escapeHtml(info.style || '(样式不可用)') + '</div>' +
      '<div class="box-model">outerHTML（截断）\n' + escapeHtml(info.html) + '</div>';
    el.domDetail.innerHTML = '<h4>&lt;' + escapeHtml(info.tag) + '&gt; 属性</h4>' + html;
    el.domPath.textContent = state.selectedPath || 'document';
  }

  /* ================= 属性编辑（双击查看器节点） ================= */
  let attrEditing = null;   /* { path, list, cssAttrs } 当前正在编辑的元素 */

  /* CSS 属性名（border / color / font-size…）写在 HTML 属性里不会生效，
     编辑器里标个 CSS 徽标提示"保存时会写进 inline style" */
  function attrRowHtml(a, cssSet) {
    const name = escapeHtml(a.name || '');
    const value = escapeHtml(a.value || '');
    const isCss = !!(cssSet && cssSet.has(a.name));
    return '<div class="attr-row" data-orig-name="' + name + '" data-orig-value="' + value + '">' +
      '<input class="attr-name" spellcheck="false" autocomplete="off" placeholder="属性名" value="' + name + '" />' +
      '<input class="attr-val" spellcheck="false" autocomplete="off" placeholder="属性值" value="' + value + '" />' +
      '<span class="attr-badge"' + (isCss ? ' title="CSS 属性：保存时会写入 inline style 才生效"' : '') + '>' + (isCss ? 'CSS' : '') + '</span>' +
      '<button type="button" class="attr-del" title="删除该属性">✕</button>' +
      '</div>';
  }

  function addAttrRow(box, name, value, focus) {
    const rowsBox = box && box.querySelector('.attr-rows');
    if (!rowsBox) return null;
    const tmp = document.createElement('div');
    tmp.innerHTML = attrRowHtml({ name: name, value: value }, null);
    const row = tmp.firstElementChild;
    rowsBox.appendChild(row);
    if (focus) {
      const inp = row.querySelector('.attr-name');
      if (inp) inp.focus();
    }
    return row;
  }

  function renderAttrEditor(path, info) {
    if (!el.domDetail) return;
    const cssAttrs = (info && info.cssAttrs) || [];
    attrEditing = { path: path, list: (info && info.attrList) || [], cssAttrs: cssAttrs };
    const cssSet = new Set(cssAttrs);
    const rows = attrEditing.list.map((a) => attrRowHtml(a, cssSet)).join('');
    el.domDetail.innerHTML =
      '<div class="attr-editor">' +
        '<div class="attr-head"><b>&lt;' + escapeHtml((info && info.tag) || '') + '&gt;</b> 属性编辑' +
          '<span class="attr-tip">Enter 保存 · Esc 取消</span></div>' +
        '<div class="attr-sub">border / color / font-size 等 CSS 属性会写入 inline style 生效（标 CSS 的行）</div>' +
        '<div class="attr-rows">' + rows + '</div>' +
        '<button type="button" class="attr-add">＋ 添加属性</button>' +
        '<div class="attr-actions">' +
          '<button type="button" class="attr-cancel">取消</button>' +
          '<button type="button" class="attr-save primary">保存</button>' +
        '</div>' +
      '</div>';
    const box = el.domDetail.querySelector('.attr-editor');
    if (!box) return;
    if (!attrEditing.list.length) addAttrRow(box, '', '', true);

    box.addEventListener('click', (e) => {
      const t = e.target;
      if (t.classList.contains('attr-del')) {
        const row = t.closest('.attr-row');
        if (row) row.remove();
        return;
      }
      if (t.classList.contains('attr-add')) { addAttrRow(box, '', '', true); return; }
      if (t.classList.contains('attr-cancel')) { closeAttrEditor(path); return; }
      if (t.classList.contains('attr-save')) { saveAttrEditor(box, path); }
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveAttrEditor(box, path); }
      else if (e.key === 'Escape') { e.preventDefault(); closeAttrEditor(path); }
    });
    const first = box.querySelector('.attr-val');
    if (first) { first.focus(); first.select(); }
  }

  function openAttrEditor(path) {
    pageExec(pageTpl('tplDetail', path)).then((txt) => {
      if (!txt) { toast('元素已不存在，无法编辑属性', 'err'); return; }
      let info = null;
      try { info = JSON.parse(txt); } catch (e) { info = null; }
      if (!info) { toast('读取元素属性失败', 'err'); return; }
      renderAttrEditor(path, info);
    }).catch((err) => toast('读取元素属性失败：' + err.message, 'err'));
  }

  function closeAttrEditor(path) {
    attrEditing = null;
    if (path) selectByPath(path, null, { noHighlight: true });
  }

  /* ================= 文本节点编辑（双击文字行） ================= */
  let textEditing = null;

  function openTextEditor(parentPath, ti) {
    /* 树里只显示前 70 字符，编辑必须拿完整原文，否则保存会截断内容 */
    pageExec(pageTpl('tplTextNode', parentPath, { ti: ti, op: 'get' })).then((txt) => {
      let r = null;
      try { r = JSON.parse(txt); } catch (e) { r = null; }
      if (!r || !r.ok) { toast((r && r.error) || '读取文本失败', 'err'); return; }
      if (r.text == null) { toast('文本节点已不存在，请重新载入 DOM', 'err'); return; }
      renderTextEditor(parentPath, ti, r.text);
    }).catch((err) => toast('读取文本失败：' + err.message, 'err'));
  }

  function renderTextEditor(parentPath, ti, text) {
    if (!el.domDetail) return;
    textEditing = { parent: parentPath, ti: ti };
    el.domDetail.innerHTML =
      '<div class="attr-editor">' +
        '<div class="attr-head"><b>#text</b> 文本编辑<span class="attr-tip">Ctrl+Enter 保存 · Esc 取消</span></div>' +
        '<div class="attr-sub">' + escapeHtml(parentPath) + ' 中的文本节点</div>' +
        '<textarea class="text-node-input" spellcheck="false" rows="6">' + escapeHtml(text) + '</textarea>' +
        '<div class="attr-actions">' +
          '<button type="button" class="text-del">删除文本</button>' +
          '<button type="button" class="attr-cancel">取消</button>' +
          '<button type="button" class="attr-save primary">保存</button>' +
        '</div>' +
      '</div>';
    const box = el.domDetail.querySelector('.attr-editor');
    if (!box) return;
    const ta = box.querySelector('.text-node-input');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    box.addEventListener('click', (e) => {
      const t = e.target;
      if (t.classList.contains('attr-cancel')) { closeTextEditor(parentPath); return; }
      if (t.classList.contains('text-del')) { removeTextNode(parentPath, ti); return; }
      if (t.classList.contains('attr-save')) { saveTextNode(parentPath, ti, ta ? ta.value : ''); }
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeTextEditor(parentPath); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveTextNode(parentPath, ti, ta ? ta.value : ''); }
    });
  }

  function closeTextEditor(parentPath) {
    textEditing = null;
    if (parentPath) selectByPath(parentPath, null, { noHighlight: true });
  }

  function afterTextChange(parentPath) {
    textEditing = null;
    buildDomTree(parentPath);
    selectByPath(parentPath, null, { noHighlight: true });
  }

  function saveTextNode(parentPath, ti, value) {
    pageExec(pageTpl('tplTextNode', parentPath, { ti: ti, op: 'set', value: value })).then((txt) => {
      let r = null;
      try { r = JSON.parse(txt); } catch (e) { r = null; }
      if (!r || !r.ok) { toast((r && r.error) || '保存失败', 'err'); return; }
      toast('文本已更新', 'ok');
      afterTextChange(parentPath);
      pushLog('system', '修改文本：' + String(value || '').slice(0, 60));
    }).catch((err) => toast('保存失败：' + err.message, 'err'));
  }

  function removeTextNode(parentPath, ti) {
    pageExec(pageTpl('tplTextNode', parentPath, { ti: ti, op: 'remove' })).then((txt) => {
      let r = null;
      try { r = JSON.parse(txt); } catch (e) { r = null; }
      if (!r || !r.ok) { toast((r && r.error) || '删除失败', 'err'); return; }
      toast('文本已删除', 'ok');
      afterTextChange(parentPath);
      pushLog('system', '删除文本：' + String(r.text || '').trim().slice(0, 60));
    }).catch((err) => toast('删除失败：' + err.message, 'err'));
  }

  /* 收集表单 → 计算最小操作集 → 在页面里执行
     改名的属性 = 删旧名 + 设新名；删行 = remove；值变化 = set */
  function saveAttrEditor(box, path) {
    if (!attrEditing) return;
    const originals = attrEditing.list.map((a) => a.name);
    const present = [];
    Array.prototype.forEach.call(box.querySelectorAll('.attr-row'), (r) => {
      const name = (r.querySelector('.attr-name').value || '').trim();
      if (!name) return;
      present.push({
        name: name,
        value: r.querySelector('.attr-val').value,
        orig: r.dataset.origName || '',
        origValue: r.dataset.origValue || ''
      });
    });

    const ops = [];
    originals.forEach((on) => {
      if (!present.some((p) => p.name === on)) ops.push({ op: 'remove', name: on });
    });
    const seen = new Set();
    present.forEach((p) => {
      if (seen.has(p.name)) return;
      seen.add(p.name);
      if (p.orig === p.name && p.origValue === p.value) return;   /* 完全没改 */
      ops.push({ op: 'set', name: p.name, value: p.value });
    });

    /* 已经存在的 border="..." 这类属性，值没改也会补一次 style 同步：
       否则用户"加完没反应"，只能靠重新填写才生效 */
    (attrEditing.cssAttrs || []).forEach((cn) => {
      const p = present.find((x) => x.name === cn);
      if (!p) return;
      if (ops.some((o) => o.op === 'set' && o.name === cn)) return;
      ops.push({ op: 'set', name: cn, value: p.value });
    });

    if (!ops.length) { closeAttrEditor(path); toast('没有改动', 'ok'); return; }

    pageExec(pageTpl('tplSetAttrs', path, ops)).then((txt) => {
      let r = null;
      try { r = JSON.parse(txt); } catch (e) { r = null; }
      if (!r || !r.ok) { toast((r && r.error) || '保存失败', 'err'); return; }
      attrEditing = null;
      if (r.cssBad && r.cssBad.length) {
        toast('样式值无效，未生效：' + r.cssBad.join('；'), 'err');
      } else if (r.failed && r.failed.length) {
        toast('部分属性未生效：' + r.failed.join('；'), 'err');
      } else if (r.cssApplied && r.cssApplied.length) {
        toast('已更新，CSS 已写入 style（' + r.cssApplied.join('；') + '）', 'ok');
      } else {
        toast('属性已更新', 'ok');
      }
      const newPath = r.path || path;
      state.selectedPath = newPath;
      if (r.detail) renderInspectorDetail(r.detail);
      /* id / class 改变会影响标签显示与路径，重建一次树保证与页面一致 */
      buildDomTree(newPath);
      pushLog('system', '修改属性：' + ops.map((o) => (o.op === 'remove' ? '-' + o.name : o.name + '=' + o.value)).join(' '));
      if (r.cssApplied && r.cssApplied.length) pushLog('system', '已写入 inline style：' + r.cssApplied.join('; '));
    }).catch((err) => toast('保存失败：' + err.message, 'err'));
  }

  function selectByPath(path, snapshot, opts) {
    if (!path) return;
    state.selectedPath = path;
    const row = $$('.dom-row').find((r) => r._path === path);
    $$('.dom-row').forEach((r) => r.classList.toggle('selected', r._path === path));
    if (row) expandRow(row);
    /* 树里没有该元素（深层节点超出默认采样）：定向重建，让选中元素及其内容出现在树中 */
    if (!row) buildDomTree(path);
    /* 只有「从查看器点节点」才在页面上画橙框并滚动定位；
       选取模式点击页面元素时页面已经有悬停框，再画一个就成了多余高亮 */
    if (!(opts && opts.noHighlight)) {
      pageExec(pageTpl('tplHighlight', path)).catch(() => {});
    }
    if (snapshot && snapshot.tag) {
      /* 点击瞬间抓取的快照：动态页面里按路径回读可能扑空，优先用快照 */
      renderInspectorDetail(snapshot);
    } else {
      const detailScript = pageTpl('tplDetail', path);
      pageExec(detailScript).then((txt) => {
        if (!txt) { pushLog('warn', '元素已不存在：' + path); return; }
        renderInspectorDetail(JSON.parse(txt));
      }).catch((err) => pushLog('error', '读取元素详情失败：' + err.message));
    }
    pushLog('system', '已选中元素：' + path);
  }

  function clearSelection(stopHighlight) {
    state.selectedPath = null;
    el.domDetail.innerHTML = '<p class="empty">悬停页面元素或点击左侧节点查看属性</p>';
    el.domPath.textContent = 'document';
    $$('.dom-row').forEach((r) => r.classList.remove('selected'));
    if (stopHighlight !== false) pageExec(el.tplStop.textContent).catch(() => {});
  }

  /* ================= 元素选取 ================= */
  function setInspectButtons() {
    const on = state.inspectMode;
    /* 选取元素入口只保留主工具栏一处 */
    [el.btnInspectMode].forEach((btn) => {
      if (!btn) return;
      btn.classList.toggle('active', on);   /* 只用高亮表示开启状态，文字不变 */
      btn.textContent = '⌖ 选取';
      btn.title = on
        ? '选取中：在页面中悬停元素即可高亮并在查看器定位，点击元素可锁定'
        : '选取元素：开启后在页面中悬停元素即可高亮并在查看器中定位';
    });
  }

  function setInspectMode(on) {
    state.inspectMode = !!on;
    setInspectButtons();
    if (state.inspectPoll) { clearTimeout(state.inspectPoll); state.inspectPoll = null; }
    state.lastHoverPath = null;
    state.hoverSwitched = false;
    /* 选取模式靠页面的 mousemove 做悬停高亮 / DOM 定位，
       而"鼠标→触摸"转换会吞掉 mousemove —— 选取期间临时关掉，退出时恢复 */
    if (desktop.setTouchEmit) desktop.setTouchEmit(!on).catch(() => {});
    if (on) {
      pageExec(el.tplPathOf.textContent + '\n' + el.tplInspect.textContent)
        .then(() => {
          toast('选取模式已开启，点击页面中的元素', 'ok');
          pollInspect();
        })
        .catch((err) => {
          pushLog('error', '无法开启选取：' + err.message);
          state.inspectMode = false;
          setInspectButtons();
        });
    } else {
      pageExec(el.tplStop.textContent).catch(() => {});
    }
  }

  function pollInspect() {
    state.inspectPoll = setTimeout(() => {
      pageExec(el.tplPoll.textContent).then((txt) => {
        const s = JSON.parse(txt);
        if (s.hoverPath && s.hoverPath !== state.lastHoverPath) {
          state.lastHoverPath = s.hoverPath;
          state.hoverPath = s.hoverPath;
          /* 悬停即定位 + 实时显示属性（不需要点击） */
          if (s.hoverSnapshot) renderInspectorDetail(s.hoverSnapshot);
          trackHoverInTree(s.hoverPath);
        }
        if (s.selected && s.path) {
          state.inspectMode = false;
          setInspectButtons();
          state.inspectPoll = null;
          /* 选取结束：恢复"鼠标→触摸"转换（否则地图等移动页面的按钮点不动） */
          if (desktop.setTouchEmit) desktop.setTouchEmit(true).catch(() => {});
          /* 选取点击：不额外画框（悬停框由 tplStop 收尾时隐藏） */
          selectByPath(s.path, s.snapshot, { noHighlight: true });
          toast('已选中元素', 'ok');
          return;
        }
        if (state.inspectMode) pollInspect();
      }).catch(() => { if (state.inspectMode) pollInspect(); });
    }, 180);
  }

  /* ================= 页面事件（主进程转发） ================= */
  desktop.onPageNavigated((d) => {
    const tid = d.tabId || state.devTabId;
    if (tid !== state.devTabId) {
      /* 后台标签换页：清它自己的脚本列表（当前面板不动）；
         控制器/网络记录按「持续」开关决定是否保留 */
      const s = storeFor(tid);
      s.sources = []; s.srcUrl = ''; s.srcScanned = false;
      s.sourceCache.clear();
      if (!state.persistLog && d.full) { s.logs = []; s.requests = []; s.netExtra = {}; }
      return;
    }
    /* 页面发起的跳转（地址栏输入已在 navigate 里清过）也要按「持续」开关处理；
       SPA 站内跳转 / 切标签（full=false）不清记录 */
    const urlChanged = d.full === true && !!d.url && d.url !== state.lastPageUrl;
    if (!state.persistLog && urlChanged) {
      resetDevRecords();
      pushLog('system', '页面已加载：' + (d.display || d.url));
    }
    /* 换页后脚本列表重来：旧的脚本已不属于当前页面 */
    state.sources = [];
    state.srcUrl = '';
    state.srcScanned = false;
    sourceCache.clear();
    if (el.srcCount) el.srcCount.textContent = '0';
    if (state.activeTab === 'sources') renderSourceTree();
    state.lastPageUrl = d.url;
    state.displayUrl = d.display;
    el.addressInput.value = d.display;
    el.btnBack.disabled = !d.canBack;
    el.btnForward.disabled = !d.canForward;
    if (d.title) state.title = d.title;
    el.blockedTip.hidden = true;
    state.pageErrorVisible = false;
    syncPageVisibility();
    updateStarState();
  });

  desktop.onPageTitle((title) => { if (title) state.title = title; });

  /* ================= 多标签页 ================= */
  let tabsList = [];
  function renderTabs(list) {
    tabsList = Array.isArray(list) ? list : [];
    /* 激活标签变化 → DevTools 数据整体换入换出（控制台/网络/调试器跟随标签） */
    const act = tabsList.find((t) => t.active);
    if (act && act.id !== state.devTabId) swapDevState(act.id);
    /* 已关闭标签的 DevTools 数据一并清掉 */
    const alive = new Set(tabsList.map((t) => t.id));
    devStores.forEach((v, k) => { if (!alive.has(k) && k !== state.devTabId) devStores.delete(k); });
    el.tabsScroll.innerHTML = '';
    tabsList.forEach((t) => {
      const item = document.createElement('div');
      item.className = 'page-tab' + (t.active ? ' active' : '');
      item.title = (t.title || '新标签页') + (t.url ? '\n' + t.url : '');

      /* 站点 shortcut icon；未取到图标时显示加载圆环 / 占位点 */
      const iconBox = document.createElement('span');
      iconBox.className = 'tab-icon';
      if (t.icon) {
        const img = document.createElement('img');
        img.className = 'tab-favicon';
        img.src = t.icon;
        img.alt = '';
        iconBox.appendChild(img);
      } else {
        iconBox.textContent = t.loading ? '◌' : '·';
        if (t.loading) iconBox.classList.add('tab-loading');
      }

      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = t.title || '新标签页';
      const close = document.createElement('button');
      close.className = 'tab-close';
      close.textContent = '✕';
      close.title = '关闭标签页';
      close.addEventListener('click', (e) => { e.stopPropagation(); desktop.tabClose(t.id).catch(() => {}); });
      item.addEventListener('click', () => desktop.tabActivate(t.id).catch(() => {}));
      item.appendChild(iconBox);
      item.appendChild(label);
      item.appendChild(close);
      el.tabsScroll.appendChild(item);
      if (t.active) { try { item.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {} }
    });
  }
  desktop.onTabsState(renderTabs);
  /* 内核 / 视口 / 缩放按标签恢复（切标签时主进程推最新环境） */
  desktop.onTabEnv(applyTabEnv);

  desktop.onPageLoading((loading) => {
    el.progressBar.hidden = !loading;
    el.pageLoading.hidden = !loading;
  });

  desktop.onPageError((err) => {
    if (!err) {
      el.blockedTip.hidden = true;
      state.pageErrorVisible = false;
      syncPageVisibility();
      return;
    }
    if (err.tabId && err.tabId !== state.devTabId) return;   /* 后台标签的加载错误不打扰当前面板 */
    state.lastFailedUrl = err.url || state.lastPageUrl;
    el.pageErrorText.textContent = (err.desc || '页面无法加载') + '（错误码 ' + err.code + '）';
    el.blockedTip.hidden = false;
    state.pageErrorVisible = true;
    syncPageVisibility();
    pushLog('error', '页面加载失败：' + (err.desc || '') + ' [' + err.code + '] ' + (err.url || ''));
  });

  desktop.onPageConsole((d) => {
    const lv = d.level === 'warning' ? 'warn' : (d.level || 'info');
    const tid = d.tabId || state.devTabId;
    if (tid !== state.devTabId) {
      /* 后台标签的日志：进它自己的存储，切回去时还在 */
      const s = storeFor(tid);
      const rec = { id: (state.logSeq = (state.logSeq || 0) + 1), level: lv, text: d.text, time: nowTime() };
      if (d.source) rec.source = d.source;
      if (d.line) rec.line = d.line;
      s.logs.push(rec);
      if (s.logs.length > 500) s.logs.shift();
      return;
    }
    pushLog(lv, d.text, { source: d.source, line: d.line });
  });

  /* 网络详情（请求体 / 响应体）：CDP 事件比 webRequest 的列表行先到，
     行还没出现时稍后重试配对；postData 与 body 是同一条请求的两个事件，要合并到一行 */
  function applyNetDetail(d) {
    if (!d) return;
    const tid = d.tabId || state.devTabId;
    const isCur = tid === state.devTabId;
    const store = isCur ? null : storeFor(tid);
    const list = isCur ? state.requests : store.requests;
    const extras = isCur ? state.netExtra : (store.netExtra || (store.netExtra = {}));
    let row = null;
    for (let i = list.length - 1; i >= 0 && !row; i--) {
      if (list[i].url === d.url && (!d.method || list[i].method === d.method) && extras[list[i].id]) row = list[i];
    }
    if (!row) {
      for (let i = list.length - 1; i >= 0 && !row; i--) {
        if (list[i].url === d.url && (!d.method || list[i].method === d.method)) row = list[i];
      }
    }
    if (!row) {
      if ((d._try || 0) < 12) {
        setTimeout(() => applyNetDetail(Object.assign({}, d, { _try: (d._try || 0) + 1 })), 300);
      }
      return;
    }
    const ex = extras[row.id] || (extras[row.id] = {});
    if (d.postData !== undefined) ex.postData = d.postData;
    if (d.body !== undefined) { ex.body = d.body; ex.base64 = d.base64; }
    if (d.bodyNote !== undefined) ex.bodyNote = d.bodyNote;
    if (d.bodyErr !== undefined) ex.bodyErr = d.bodyErr;
    if (d.failReason !== undefined) ex.failReason = d.failReason;
    if (isCur && state.netSelected === row.id) showNetworkDetail(row.id);
  }
  if (desktop.onPageNetworkDetail) desktop.onPageNetworkDetail(applyNetDetail);

  desktop.onPageNetwork((entry) => {    const tid = (entry && entry.tabId) || state.devTabId;
    if (tid !== state.devTabId) {
      const s = storeFor(tid);
      s.requests.push(Object.assign({
        id: ++state.netSeq, time: nowTime(), name: '', url: '', method: 'GET',
        status: 200, type: 'resource', size: 0, duration: 0, error: ''
      }, entry));
      if (s.requests.length > 200) s.requests.shift();
      if (netCategory(entry && entry.type) === 'js' && entry.url) addSourceUrlTo(s, entry.url);
      return;
    }
    addRequest(entry);
    /* 脚本请求直接进调试器文件列表，边加载边出现 */
    if (netCategory(entry && entry.type) === 'js' && entry.url) {
      const before = state.sources.length;
      addSourceUrl(entry.url);
      if (state.sources.length !== before && state.activeTab === 'sources') renderSourceTree();
    }
  });

  desktop.onFullscreenChanged((value) => {
    state.desktopFullscreen = !!value;
    el.btnFullscreen.textContent = value ? '⛶ 退出全屏' : '⛶ 全屏';
  });

  desktop.onMenuAction((action) => {
    switch (action) {
      case 'home': navigate('https://www.baidu.com/'); break;
      case 'refresh': refreshPage(); break;
      case 'vault': openPasswordModal(); break;
      case 'console': toggleDevtools(); break;
      case 'zoom-in': setPageZoom(state.pageZoom + 0.1); break;
      case 'zoom-out': setPageZoom(state.pageZoom - 0.1); break;
      case 'kernel': setKernel(nextKernel()); break;
      /* 原生菜单（快捷键 / 系统菜单）转发过来的清理动作，与自绘菜单走同一套逻辑 */
      case 'clear-cookies': runMenuAction('clear-cookies'); break;
      case 'clear-cache': runMenuAction('clear-cache'); break;
      case 'about':
        desktop.getInfo().then((info) => {
          toast('小浣熊桌面版 v' + info.version + ' ，作者：Jorin　微信：17607648868', 'ok', 6000);
        }).catch(() => toast('小浣熊桌面版，作者：Jorin　微信：17607648868', 'ok', 6000));
        break;
      default: break;
    }
  });

  /* ================= 顶部菜单（文件 / 视图 / 工具 / 帮助） ================= */
  const APP_MENU = {
    文件: [
      { label: '返回主页', hint: 'Alt+Home', action: 'home' },
      { label: '刷新页面', hint: 'Ctrl+R', action: 'refresh' },
      { sep: true },
      { label: '收藏网址（需密码）', hint: 'Ctrl+D', action: 'vault' },
      { sep: true },
      { label: '退出小浣熊', action: 'quit' }
    ],
    视图: [
      { label: '应用内控制台', hint: 'F12', action: 'console' },
      { sep: true },
      { label: '硬件与传感器', action: 'hw' },
      { label: '窗口全屏', action: 'fullscreen' },
      { label: '页面放大', action: 'zoom-in' },
      { label: '页面缩小', action: 'zoom-out' },
      { sep: true },
      { label: '切换模拟内核（iOS / Android / 鸿蒙）', action: 'kernel' }
    ],
    工具: [
      { label: '清除cookie', action: 'clear-cookies' },
      { label: '清除本地缓存', action: 'clear-cache' }
    ],
    帮助: [
      { label: '关于小浣熊', action: 'about' }
    ]
  };

  /* 清理浏览数据：清完刷新当前标签，页面立刻以干净状态重新加载 */
  function clearBrowsingData(action, name) {
    const fn = action === 'clear-cookies' ? desktop.clearCookies : desktop.clearCache;
    if (typeof fn !== 'function') { toast('当前版本不支持该操作', 'err'); return; }
    fn().then((r) => {
      if (!r || !r.ok) {
        toast('清除' + name + '失败：' + ((r && r.error) || '未知错误'), 'err');
        return;
      }
      const detail = r.count != null ? '（' + r.count + ' 项）' : '';
      if (r.warning) pushLog('warn', '清除' + name + '时有项目未清除：' + r.warning);
      toast('已清除' + name + detail + (r.warning ? '（部分项目已跳过）' : '') + '，正在刷新当前页面', 'ok');
      pushLog('system', '已清除' + name + detail + '，正在刷新当前页面');
      desktop.reload().catch(() => {});
    }).catch((err) => {
      toast('清除' + name + '失败：' + ((err && err.message) || err), 'err');
    });
  }

  function runMenuAction(action) {
    switch (action) {
      case 'home': navigate('https://www.baidu.com/'); break;
      case 'refresh': refreshPage(); break;
      case 'vault': openPasswordModal(); break;
      case 'console': toggleDevtools(); break;
      case 'hw': openHwModal(); break;
      case 'fullscreen': desktop.toggleWindowFullscreen().catch(() => {}); break;
      case 'zoom-in': setPageZoom(state.pageZoom + 0.1); break;
      case 'zoom-out': setPageZoom(state.pageZoom - 0.1); break;
      case 'kernel': setKernel(nextKernel()); break;
      case 'clear-cookies': clearBrowsingData('clear-cookies', 'cookie'); break;
      case 'clear-cache': clearBrowsingData('clear-cache', '本地缓存'); break;
      case 'about':
        desktop.getInfo().then((info) => {
          toast('小浣熊桌面版 v' + info.version + ' ，作者：Jorin　微信：17607648868', 'ok', 6000);
        }).catch(() => toast('小浣熊桌面版，作者：Jorin　微信：17607648868', 'ok', 6000));
        break;
      case 'quit': desktop.quit().catch(() => {}); break;
      default: break;
    }
  }

  function closeAppMenu() {
    desktop.popHide();
    $$('.menu-item.open').forEach((b) => b.classList.remove('open'));
  }

  function openAppMenu(btn) {
    const items = APP_MENU[btn.dataset.menu] || [];
    const r = btn.getBoundingClientRect();
    $$('.menu-item.open').forEach((b) => b.classList.remove('open'));
    btn.classList.add('open');
    /* 弹层内容渲染在独立置顶小窗里（窗口内 HTML 会被原生网页视图盖住），
       只把触发按钮的位置传过去；尺寸由小窗渲染后自报 */
    desktop.popShow({
      kind: 'menu',
      menuId: btn.dataset.menu,
      items,
      rect: { x: Math.round(r.left), y: Math.round(r.bottom + 4), w: 10, h: 10 }
    });
  }

  /* 窗口内任何非菜单按钮的按下都收起弹层（弹层本身在独立小窗，收不到这里的事件） */
  document.addEventListener('mousedown', (e) => {
    if (e.target.closest && e.target.closest('.menu-item')) return;
    closeAppMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeAppMenu();
    closeDevicePop();
  });

  /* ================= 硬件与传感器（摄像头 / 麦克风 / 网络 / GPS / 陀螺仪 / 蓝牙） ================= */
  const HW_DEFAULT = {
    net: 'wifi',
    gps: { enabled: true, lat: 39.908823, lng: 116.397470 },
    sensor: { mode: 'still', alpha: 0, beta: 0, gamma: 0 },
    cam: true, mic: true, bt: true, touch: true
  };

  function setSegActive(wrap, attr, value) {
    Array.prototype.forEach.call(wrap.querySelectorAll('.seg'), (b) => b.classList.toggle('active', b.dataset[attr] === value));
  }
  function segValue(wrap, attr) {
    const on = wrap.querySelector('.seg.active');
    return on ? on.dataset[attr] : '';
  }

  function fillHwForm(hw) {
    setSegActive(el.hwNet, 'net', hw.net);
    el.hwGpsOn.checked = !!hw.gps.enabled;
    el.hwLat.value = String(hw.gps.lat);
    el.hwLng.value = String(hw.gps.lng);
    setSegActive(el.hwSensorMode, 'mode', hw.sensor.mode);
    el.hwAlpha.value = String(hw.sensor.alpha);
    el.hwBeta.value = String(hw.sensor.beta);
    el.hwGamma.value = String(hw.sensor.gamma);
    el.hwAngleRow.classList.toggle('hw-angle-hidden', hw.sensor.mode !== 'custom');
    el.hwCam.checked = !!hw.cam;
    el.hwMic.checked = !!hw.mic;
    el.hwBt.checked = !!hw.bt;
    el.hwTouch.checked = hw.touch !== false;
  }

  function openHwModal() {
    desktop.getHw().then((hw) => fillHwForm(hw || JSON.parse(JSON.stringify(HW_DEFAULT))))
      .catch(() => fillHwForm(JSON.parse(JSON.stringify(HW_DEFAULT))))
      .then(() => { el.hwModal.hidden = false; });
  }
  function closeHwModal() { el.hwModal.hidden = true; }

  function readHwForm() {
    return {
      net: segValue(el.hwNet, 'net') || 'wifi',
      gps: {
        enabled: el.hwGpsOn.checked,
        lat: Number(el.hwLat.value) || 0,
        lng: Number(el.hwLng.value) || 0
      },
      sensor: {
        mode: segValue(el.hwSensorMode, 'mode') || 'still',
        alpha: Number(el.hwAlpha.value) || 0,
        beta: Number(el.hwBeta.value) || 0,
        gamma: Number(el.hwGamma.value) || 0
      },
      cam: el.hwCam.checked, mic: el.hwMic.checked, bt: el.hwBt.checked,
      touch: el.hwTouch.checked
    };
  }

  el.btnHw.addEventListener('click', openHwModal);
  el.closeHwBtn.addEventListener('click', closeHwModal);
  el.hwModal.addEventListener('click', (e) => { if (e.target === el.hwModal) closeHwModal(); });
  el.hwNet.addEventListener('click', (e) => {
    const b = e.target.closest('.seg');
    if (b) setSegActive(el.hwNet, 'net', b.dataset.net);
  });
  el.hwGeoPresets.addEventListener('click', (e) => {
    const b = e.target.closest('.seg');
    if (!b) return;
    el.hwLat.value = b.dataset.lat;
    el.hwLng.value = b.dataset.lng;
  });
  el.hwSensorMode.addEventListener('click', (e) => {
    const b = e.target.closest('.seg');
    if (!b) return;
    setSegActive(el.hwSensorMode, 'mode', b.dataset.mode);
    el.hwAngleRow.classList.toggle('hw-angle-hidden', b.dataset.mode !== 'custom');
  });
  el.hwSaveBtn.addEventListener('click', () => {
    desktop.setHw(readHwForm()).then(() => {
      toast('硬件设置已应用，对全部标签页生效', 'ok');
      closeHwModal();
    }).catch(() => toast('设置失败', 'err'));
  });
  el.hwResetBtn.addEventListener('click', () => fillHwForm(JSON.parse(JSON.stringify(HW_DEFAULT))));

  /* ================= 事件绑定 ================= */
  el.addressInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { navigate(el.addressInput.value); el.addressInput.blur(); } });
  el.addressInput.addEventListener('focus', (e) => e.target.select());
  el.btnRefresh.addEventListener('click', refreshPage);
  el.btnVault.addEventListener('click', openPasswordModal);
  el.btnBack.addEventListener('click', () => desktop.goBack().catch(() => {}));
  el.btnForward.addEventListener('click', () => desktop.goForward().catch(() => {}));
  el.btnHome.addEventListener('click', () => navigate('https://www.baidu.com/'));
  el.btnDevtools.addEventListener('click', () => toggleDevtools());
  el.btnInspectMode.addEventListener('click', () => setInspectMode(!state.inspectMode));
  el.btnNewTab.addEventListener('click', () => desktop.tabNew().catch(() => {}));

  /* 顶部菜单条：点击展开下拉菜单（文件 / 视图 / 工具 / 帮助） */
  el.appMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('.menu-item');
    if (!btn) return;
    if (btn.classList.contains('open')) { closeAppMenu(); return; }
    openAppMenu(btn);
  });

  /* ===== 悬停内核按钮 → 弹出该内核的机型菜单（仅展示；点击后才真正切换） =====
     列表渲染在独立置顶小窗里：网页无需隐藏，视频 / 动画照常播放。
     关闭时机统一由主进程管理：按钮/弹层 mouseleave 上报 arm-close，
     弹层内真实 mousemove 上报 hover-in 取消。应用侧不得自设定时器——
     否则弹层内的悬停无法取消应用侧定时器，会出现"移到列表上反而消失"。 */
  function closeDevicePop() {
    desktop.popHide();
  }
  function openDevicePop(btn, kernel) {
    const list = DEVICE_PRESETS[kernel] || [];
    if (!list.length) return;
    const r = btn.getBoundingClientRect();
    /* 只给「当前正在使用的内核 + 机型」打勾（在小窗里渲染），其它内核悬停只展示清单 */
    desktop.popShow({
      kind: 'device',
      kernel,
      head: (list[0] && list[0].label ? list[0].label : kernel) + ' · 选择机型（点击后立即生效）',
      items: list,
      activeKernel: state.kernel,
      activeDevice: state.device,
      rect: { x: Math.round(r.left), y: Math.round(r.bottom + 6), w: 10, h: 10 }
    });
  }
  $$('.seg[data-kernel]').forEach((btn) => {
    /* mouseenter → 仅当「该内核按钮已选中」时才显示其机型列表
       （选中 iOS 时只有悬停 iOS 才弹；选中 Android 时只有悬停 Android 才弹；同理鸿蒙）。 */
    btn.addEventListener('mouseenter', () => {
      if (btn.dataset.kernel === state.kernel) openDevicePop(btn, btn.dataset.kernel);
    });
    btn.addEventListener('mouseleave', () => desktop.popSetButtonOut());
    /* click → 切换内核；若内核发生变化则立即弹出新内核的机型列表
       （例如选中 iOS 时点击鸿蒙，鸿蒙变选中并显示其机型列表）。 */
    btn.addEventListener('click', () => {
      const changed = btn.dataset.kernel !== state.kernel;
      closeDevicePop();
      setKernel(btn.dataset.kernel);
      if (changed) openDevicePop(btn, btn.dataset.kernel);
    });
  });
  /* 弹层小窗里的鼠标进入 / 离开由 popup.html 自己上报（pop-hover-in/out），
     主窗口内任何按下都视为点击外部，收起弹层。
     注意：不能监听 window blur 关闭弹层 —— 点击弹层时弹层窗口会短暂持有
     焦点、主窗口随之 blur，会误杀弹层导致点击无效。 */
  document.addEventListener('mousedown', (e) => {
    if (e.target.closest && e.target.closest('.seg[data-kernel]')) return;
    closeDevicePop();
  });

  /* 持续记录：勾选后刷新/换网址不清空控制器与网络记录 */
  if (el.persistLog) {
    el.persistLog.checked = state.persistLog;
    el.persistLog.parentElement.classList.toggle('on', state.persistLog);
    el.persistLog.addEventListener('change', () => {
      state.persistLog = el.persistLog.checked;
      store.set('ps-persist-log', state.persistLog);
      el.persistLog.parentElement.classList.toggle('on', state.persistLog);
      toast(state.persistLog ? '持续记录已开启：刷新/换网址保留控制器与网络记录'
        : '持续记录已关闭：刷新/换网址会清空控制器与网络记录', 'ok');
      pushLog('system', state.persistLog ? '持续记录已开启' : '持续记录已关闭');
    });
  }

  $$('.seg.vp').forEach((btn) => btn.addEventListener('click', () => {
    const vp = btn.dataset.vp === 'full' ? 'full' : 'phone';
    if (vp === state.viewportMode) return;
    /* 视口宽度只作用于当前标签，切回该标签时自动恢复 */
    applyTabEnv({ kernel: state.kernel, vp: vp, zoom: state.pageZoom });
    desktop.setViewport(vp).catch(() => {});
  }));
  el.pageZoomOut.addEventListener('click', () => setPageZoom(state.pageZoom - 0.1));
  el.pageZoomIn.addEventListener('click', () => setPageZoom(state.pageZoom + 0.1));
  el.btnFullscreen.addEventListener('click', toggleFullscreen);

  el.pwdSubmit.addEventListener('click', submitPassword);
  el.pwdCancel.addEventListener('click', () => { el.pwdModal.hidden = true; });
  el.pwdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPassword(); });
  el.pwdModal.addEventListener('click', (e) => { if (e.target === el.pwdModal) el.pwdModal.hidden = true; });
  el.closeVaultBtn.addEventListener('click', () => { el.vaultModal.hidden = true; });
  el.vaultDoneBtn.addEventListener('click', () => { el.vaultModal.hidden = true; });
  el.vaultModal.addEventListener('click', (e) => { if (e.target === el.vaultModal) el.vaultModal.hidden = true; });
  el.addCurrentBtn.addEventListener('click', addCurrentBookmark);
  el.changePwdBtn.addEventListener('click', () => {
    el.changePwdBox.hidden = !el.changePwdBox.hidden;
    el.pwdChangeError.textContent = '';
  });
  el.savePwdBtn.addEventListener('click', savePassword);
  el.vaultList.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      state.bookmarks.splice(Number(del.dataset.del), 1);
      store.set('ps.bookmarks', state.bookmarks);
      renderVault();
      updateStarState();
      toast('已删除该收藏');
      return;
    }
    const item = e.target.closest('[data-index]');
    if (!item) return;
    const bookmark = state.bookmarks[Number(item.dataset.index)];
    el.vaultModal.hidden = true;
    navigate(bookmark.url);
    toast('正在打开收藏：' + bookmark.title, 'ok');
  });

  /* 标签只负责切换面板；手动切走视为退出选取（悬停跟随的自动切换是代码调用，不经过这里） */
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
    if (state.inspectMode) setInspectMode(false);
    switchTab(tab.dataset.tab);
  }));
  el.btnCloseDevtools.addEventListener('click', () => toggleDevtools(false));
  el.btnClearDevtools.addEventListener('click', () => {
    if (state.activeTab === 'console') { state.logs = []; renderLogs(); }
    else if (state.activeTab === 'network') { state.requests = []; el.networkDetail.innerHTML = '<p class="empty">点击请求查看详情</p>'; renderNetwork(); }
    else if (state.activeTab === 'sources') { state.sources = []; state.srcUrl = ''; renderSourceTree(); el.sourcesBody.innerHTML = '<p class="empty">从左侧选择一个脚本，或点击控制台里的来源文件名直接定位</p>'; el.srcFileLabel.textContent = '未选择文件'; el.srcFileMeta.textContent = ''; }
    else if (state.activeTab === 'elements') { clearSelection(); buildDomTree(); }
    else { clearSelection(); }
    toast('已清空当前面板');
  });
  el.btnRefreshDom.addEventListener('click', () => { buildDomTree(); toast('DOM 树已刷新', 'ok'); });

  /* 点日志右侧的来源文件名 → 打开源码并定位到对应行 */
  el.consoleOutput.addEventListener('click', (e) => {
    const src = e.target.closest('.log-source');
    if (!src || !src.dataset.src) return;
    openInDebugger(src.dataset.src, Number(src.dataset.line) || 0);
  });

  /* 超长日志（长 URL、大段错误信息）：默认折成 4 行，双击展开 / 收起 */
  el.consoleOutput.addEventListener('dblclick', (e) => {
    const t = e.target.closest('.log-text');
    if (!t) return;
    const collapsed = t.classList.contains('clipped');
    const expanded = t.classList.contains('open');
    if (!collapsed && !expanded) return;
    const line = t.closest('.log-line');
    const id = line ? Number(line.dataset.log) : 0;
    e.preventDefault();
    if (collapsed) {
      t.classList.remove('clipped');
      t.classList.add('open');
      if (line) line.classList.remove('long-closed');
      if (id) state.logOpen.add(id);
    } else {
      t.classList.remove('open');
      t.classList.add('clipped');
      if (line) line.classList.add('long-closed');
      if (id) state.logOpen.delete(id);
    }
    const len = t.textContent ? t.textContent.length : 0;
    t.title = '双击' + (collapsed ? '收起' : '展开') + '（共 ' + len + ' 字符）';
  });
  /* 调试器：点文件、折叠目录、筛选、重新扫描 */
  if (el.sourcesTree) {
    el.sourcesTree.addEventListener('click', (e) => {
      const file = e.target.closest('.src-file-row');
      if (file && file.dataset.url) { openInDebugger(file.dataset.url, 0); return; }
      const dir = e.target.closest('.src-dir');
      if (dir) {
        const node = dir.parentElement;
        node.classList.toggle('collapsed');
        const caret = dir.querySelector('.src-caret');
        if (caret) caret.textContent = node.classList.contains('collapsed') ? '▸' : '▾';
      }
    });
  }
  if (el.srcFilter) {
    el.srcFilter.addEventListener('input', () => {
      state.srcFilter = el.srcFilter.value.trim();
      renderSourceTree();
    });
  }
  if (el.btnRefreshSources) {
    el.btnRefreshSources.addEventListener('click', () => scanPageScripts());
  }

  /* 面板宽度变了（窗口缩放 / 停靠切换 / 拖拽分隔条）→ 重新判断哪些日志被截断 */
  window.addEventListener('resize', () => {
    if (state.activeTab === 'console' && !el.devtools.hidden) markClips();
  });
  if (window.ResizeObserver && el.consoleOutput) {
    new ResizeObserver(() => {
      if (state.activeTab === 'console' && !el.devtools.hidden) markClips();
    }).observe(el.consoleOutput);
  }

  /* 控制台级别筛选：点一下隐藏该级别，再点恢复，计数始终显示总数 */
  if (el.logFilters) {
    el.logFilters.addEventListener('click', (e) => {
      const btn = e.target.closest('.log-filter');
      if (!btn || !btn.dataset.kind) return;
      const k = btn.dataset.kind;
      state.logFilter[k] = state.logFilter[k] === false;
      renderLogs();
    });
  }

  el.consoleForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = el.consoleInput.value.trim();
    if (!code) return;
    el.consoleInput.value = '';
    state.cmdHistory.push(code);
    state.cmdIndex = state.cmdHistory.length;
    pushLog('input', '› ' + code);
    runCommand(code);
  });
  el.consoleInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' && state.cmdHistory.length) {
      e.preventDefault();
      state.cmdIndex = Math.max(0, state.cmdIndex - 1);
      el.consoleInput.value = state.cmdHistory[state.cmdIndex] || '';
    } else if (e.key === 'ArrowDown' && state.cmdHistory.length) {
      e.preventDefault();
      state.cmdIndex = Math.min(state.cmdHistory.length, state.cmdIndex + 1);
      el.consoleInput.value = state.cmdHistory[state.cmdIndex] || '';
    }
  });
  el.networkBody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) showNetworkDetail(tr.dataset.id);
  });

  /* 详情区子标签切换：消息头 / Cookie / 请求 / 响应 */
  el.networkDetail.addEventListener('click', (e) => {
    /* 重新发送按钮：位于概要标题内部，要先于标题折叠判断处理 */
    const rs = e.target.closest('.nd-resend');
    if (rs) {
      const rec = state.requests.find((x) => x.id === state.netSelected);
      if (rec) openResendModal(rec);
      return;
    }
    /* 概要不折叠标题：点一下展开 / 收起 */
    const sum = e.target.closest('h4.nd-sum');
    if (sum) {
      state.netSummaryOpen = !state.netSummaryOpen;
      if (state.netSelected) showNetworkDetail(state.netSelected);
      return;
    }
    const btn = e.target.closest('.nd-tab');
    if (btn) {
      state.netDetailTab = btn.dataset.nt || 'headers';
      if (state.netSelected) showNetworkDetail(state.netSelected);
      return;
    }
    /* 长 URL / 所属页面：单击展开完整内容，再次单击收起 */
    const clamp = e.target.closest('.nd-clamp');
    if (clamp) {
      const expanded = clamp.classList.toggle('nd-expanded');
      if (expanded) clamp.removeAttribute('title');
      else clamp.title = clamp.getAttribute('data-full') || clamp.textContent;
    }
  });

  /* ================= 查看器 DOM 树右键菜单（删除元素 / 删除文本） =================
     右键某一行即选中并删除页面里对应的节点；右键落在树的空白处时，
     删除当前已选中的行 —— "先选中再右键"和"直接右键某行"两种习惯都支持。 */
  function removeDomNode(path) {
    pageExec(pageTpl('tplRemoveNode', path)).then((txt) => {
      let r = null;
      try { r = JSON.parse(txt); } catch (e) { r = null; }
      if (!r || !r.ok) { toast((r && r.error) || '删除失败', 'err'); return; }
      toast('已删除元素 <' + (r.tag || '') + '>', 'ok');
      pushLog('system', '删除元素：' + path);
      /* 选中项本身 / 它的后代被删掉后，详情与页面高亮都失效，清掉选择再重建树 */
      const sel = state.selectedPath;
      if (sel && (sel === path || sel.indexOf(path + ' > ') === 0 || sel.indexOf(path + ' >> ') === 0)) {
        clearSelection();
      }
      buildDomTree();
    }).catch((err) => toast('删除失败：' + err.message, 'err'));
  }

  el.domTree.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    let row = e.target.closest('.dom-row');
    /* 结束标签 </div> 不是独立节点：映射到同一节点的主行，删的仍是那个元素 */
    if (row && row.classList.contains('dom-close-row')) {
      const own = row.closest('.dom-node');
      row = own && own.querySelector(':scope > .dom-row');
    }
    if (!row) {
      /* 右键空白处：沿用当前选中的行 */
      row = state.selectedPath
        ? ($$('.dom-row').find((r) => r._path === state.selectedPath) || null)
        : null;
      if (!row) { closeCtxMenu(); return; }
    }

    /* 右键即选中：只同步树里的高亮和路径显示，不画页面高亮框、不滚动页面 */
    $$('.dom-row').forEach((r) => r.classList.toggle('selected', r === row));
    if (row._path) {
      state.selectedPath = row._path;
      el.domPath.textContent = row._path;
    }

    if (row.classList.contains('text-row')) {
      openCtxMenu(e.clientX, e.clientY, [{
        label: '删除文本', hint: '#text', danger: true,
        run: () => removeTextNode(row._parentPath, row._ti)
      }]);
      return;
    }
    if (!row._path) { closeCtxMenu(); return; }
    const tag = (row._data && row._data.tag) || '';
    openCtxMenu(e.clientX, e.clientY, [{
      label: '删除元素', hint: tag ? '<' + tag + '>' : '', danger: true,
      run: () => removeDomNode(row._path)
    }]);
  });
  el.domTree.addEventListener('scroll', () => closeCtxMenu(), true);

  /* ================= 网络请求行右键菜单（复制链接等） ================= */
  const KERNEL_UA = {
    ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
    android: 'Mozilla/5.0 (Linux; Android 14; SM-S931B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36',
    harmony: 'Mozilla/5.0 (Phone; OpenHarmony 7.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 ArkWeb/6.0.0.120 Mobile'
  };

  function closeCtxMenu() { el.ctxMenu.hidden = true; }

  function openCtxMenu(x, y, items) {
    el.ctxMenu.innerHTML = '';
    items.forEach((it) => {
      if (it.sep) {
        const sep = document.createElement('div');
        sep.className = 'menu-sep';
        el.ctxMenu.appendChild(sep);
        return;
      }
      const row = document.createElement('button');
      row.className = it.danger ? 'menu-row danger' : 'menu-row';
      const label = document.createElement('span');
      label.className = 'menu-label';
      label.textContent = it.label;
      row.appendChild(label);
      if (it.hint) {
        const hint = document.createElement('span');
        hint.className = 'menu-hint';
        hint.textContent = it.hint;
        row.appendChild(hint);
      }
      row.addEventListener('click', () => { closeCtxMenu(); it.run(); });
      el.ctxMenu.appendChild(row);
    });
    el.ctxMenu.hidden = false;
    const r = el.ctxMenu.getBoundingClientRect();
    el.ctxMenu.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    el.ctxMenu.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  }

  /* 复制到剪贴板：优先 Clipboard API，失败退回 execCommand */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  function curlOf(rec) {
    const ua = KERNEL_UA[state.kernel] || KERNEL_UA.ios;
    return 'curl \'' + rec.url + '\' \\\n' +
      '  -X ' + (rec.method || 'GET') + ' \\\n' +
      '  -H \'User-Agent: ' + ua + '\'';
  }

  el.networkBody.addEventListener('contextmenu', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) { closeCtxMenu(); return; }
    e.preventDefault();
    const rec = state.requests.find((r) => r.id === Number(tr.dataset.id));
    if (!rec) return;
    $$('#networkBody tr').forEach((t) => t.classList.toggle('selected', t === tr));
    openCtxMenu(e.clientX, e.clientY, [
      {
        label: '重新发送…', hint: 'Resend',
        run: () => openResendModal(rec)
      },
      { sep: true },
      {
        label: '复制链接', hint: 'Copy link',
        run: async () => {
          const ok = await copyText(rec.url || rec.name);
          toast(ok ? '链接已复制' : '复制失败', ok ? 'ok' : 'err');
        }
      },
      {
        label: '复制为 cURL', hint: '含 UA',
        run: async () => {
          const ok = await copyText(curlOf(rec));
          toast(ok ? 'cURL 已复制' : '复制失败', ok ? 'ok' : 'err');
        }
      },
      { sep: true },
      {
        label: '在新标签页打开',
        run: () => { if (/^https?:/i.test(rec.url || '')) desktop.tabNew(rec.url).catch(() => {}); }
      }
    ]);
  });

  /* ================= 重新发送请求 =================
     在页面视图上下文里 fetch：请求走页面会话（带 Cookie / 模拟 UA），
     webRequest 照常抓包 → 自动出现在网络面板，可继续查看详情与响应 */
  let resendRec = null;

  /* fetch 的禁止头（浏览器自动携带或静默丢弃）：预填时剔除，避免"看起来设置了实际没生效" */
  const FORBIDDEN_REQ_HEADERS =
    /^(host|connection|content-length|cookie|origin|referer|user-agent|te|trailer|transfer-encoding|upgrade-insecure-requests|via|accept-encoding|priority|sec-.*)$/i;

  function headersToText(obj) {
    return headerRows(obj || {})
      .filter((r) => !FORBIDDEN_REQ_HEADERS.test(r.name))
      .map((r) => r.name + ': ' + r.value)
      .join('\n');
  }
  function textToHeaders(text) {
    const out = {};
    String(text || '').split('\n').forEach((line) => {
      const i = line.indexOf(':');
      if (i < 0) return;
      const name = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      if (!name || FORBIDDEN_REQ_HEADERS.test(name)) return;
      out[name] = value;
    });
    return out;
  }

  function openResendModal(rec) {
    if (!/^https?:/i.test(rec.url || '')) { toast('该请求没有可发送的 http(s) 地址', 'err'); return; }
    resendRec = rec;
    el.resendMethod.value = (rec.method || 'GET').toUpperCase();
    el.resendUrl.value = rec.url || '';
    el.resendHeaders.value = headersToText(rec.reqHeaders);
    const extra = state.netExtra[rec.id] || {};
    el.resendBody.value = extra.postData ? prettyBody(extra.postData) : '';
    el.resendError.textContent = '';
    el.resendModal.hidden = false;
  }

  function closeResendModal() { el.resendModal.hidden = true; resendRec = null; }

  function sendResend() {
    if (!resendRec) return;
    const method = (el.resendMethod.value || 'GET').toUpperCase();
    const url = el.resendUrl.value.trim();
    if (!/^https?:\/\//i.test(url)) { el.resendError.textContent = '请输入合法的 http(s) 网址'; return; }
    const payload = {
      url: url,
      method: method,
      headers: textToHeaders(el.resendHeaders.value),
      body: (/^(GET|HEAD)$/i.test(method) || !el.resendBody.value.trim()) ? undefined : el.resendBody.value
    };
    el.resendError.textContent = '';
    el.resendSend.disabled = true;
    /* 不用 pageExec（它带 8s 超时）：慢请求会被误判超时；这里等 fetch 真正结束 */
    const code = '(async () => {' +
      'try {' +
      'const p = ' + JSON.stringify(payload) + ';' +
      'const res = await fetch(p.url, { method: p.method, headers: p.headers, body: p.body, credentials: "include" });' +
      'let n = 0; try { n = (await res.text()).length; } catch (e) {}' +
      'return JSON.stringify({ status: res.status, size: n });' +
      '} catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); }' +
      '})()';
    desktop.exec(code).then((r) => {
      el.resendSend.disabled = false;
      if (!r || r.ok === false) {
        toast('发送失败：' + ((r && r.error) || '页面视图不可用'), 'err');
        return;
      }
      let out = {};
      try { out = JSON.parse(r.value); } catch (e) {}
      pushLog('system', '重新发送 ' + method + ' ' + url + (out.status ? ' → ' + out.status : ''));
      if (out.error) {
        /* CORS 拦截读响应，但请求本身已发出并会被记录到网络面板 */
        toast('请求已发出（页面无法读取响应：' + out.error + '），详情见网络面板', 'ok', 4200);
      } else {
        toast('已发送 ' + method + ' ' + (out.status || '') + '，已记录到网络面板', 'ok');
      }
      closeResendModal();
    }).catch((err) => {
      el.resendSend.disabled = false;
      toast('发送失败：' + err.message, 'err');
    });
  }

  el.resendCancel.addEventListener('click', closeResendModal);
  el.resendCloseBtn.addEventListener('click', closeResendModal);
  el.resendSend.addEventListener('click', sendResend);
  el.resendModal.addEventListener('click', (e) => { if (e.target === el.resendModal) closeResendModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.resendModal.hidden) { closeResendModal(); e.stopPropagation(); }
  });

  document.addEventListener('mousedown', (e) => {
    if (!el.ctxMenu.hidden && !e.target.closest('#ctxMenu')) closeCtxMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtxMenu(); });
  window.addEventListener('blur', () => closeCtxMenu());
  el.networkBody.addEventListener('scroll', () => closeCtxMenu(), true);
  el.netFilters.addEventListener('click', (e) => {
    const btn = e.target.closest('.net-filter');
    if (!btn) return;
    state.netFilter = btn.dataset.filter || 'all';
    $$('#netFilters .net-filter').forEach((b) => b.classList.toggle('active', b === btn));
    renderNetwork();
  });
  el.btnOpenNewWindow.addEventListener('click', () => {
    if (state.lastFailedUrl) desktop.openExternal(state.lastFailedUrl).catch(() => {});
  });
  el.btnBackHome.addEventListener('click', () => navigate('https://www.baidu.com/'));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F12') { e.preventDefault(); toggleDevtools(); return; }
    if (e.key === 'Escape') {
      if (state.inspectMode) { setInspectMode(false); return; }
      if (!el.pwdModal.hidden) { el.pwdModal.hidden = true; return; }
      if (!el.vaultModal.hidden) { el.vaultModal.hidden = true; }
    }
  });

  /* ================= 布局与启动 ================= */
  function startLayoutSync() {
    if (window.ResizeObserver) new ResizeObserver(sendLayout).observe(el.pageFrame);
    window.addEventListener('resize', sendLayout);
    requestAnimationFrame(sendLayout);
    setTimeout(sendLayout, 250);
    setTimeout(sendLayout, 800);
  }

  document.body.dataset.kernel = state.kernel;
  const bootDev = currentDevice();
  if (bootDev) el.pageFrame.style.setProperty('--page-w', bootDev.screenW + 'px');
  updateKernelUI();
  updateUaLine();
  el.pageZoomLabel.textContent = '100%';
  desktop.getTabEnv().then(applyTabEnv).catch(() => {});
  updateStarState();
  syncPageVisibility();
  pushLog('system', '小浣熊浏览器就绪 · ' + (bootDev ? bootDev.menuText : '模拟内核'));
  pushLog('system', '按 F12 打开控制台；输入 help 查看可用命令；收藏夹默认密码 123456');
  desktop.getInfo().then((info) => {
    state.serverBase = 'http://127.0.0.1:' + info.port;
    pushLog('system', '页面视图已连接（本地服务端口 ' + info.port + ' · Electron ' + info.electron + '）');
    sendLayout();
  }).catch(() => {});
  startLayoutSync();
})();  
