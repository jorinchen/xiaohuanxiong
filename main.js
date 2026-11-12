'use strict';
/* 小浣熊桌面浏览器主进程：
   - 主窗口渲染浏览器 UI（地址栏 / 收藏 / 刷新在最顶部）
   - WebContentsView 独立渲染网页：真实移动 UA、任意站点可达、原生网络抓包与 Console 捕获 */
const { app, BrowserWindow, Menu, Tray, shell, ipcMain, WebContentsView, session, nativeImage, screen } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/* 触摸屏支持：强制启用页面 touch 事件 API 与触摸输入管道，
   触摸屏设备的双指捏合 / 单指点击以原生 touch 事件直达页面 */
app.commandLine.appendSwitch('touch-events', 'enabled');

const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};
/* 内核 / 真机参数统一放在 page-devices.js：
   main.js（UA + 设备模拟）、page-preload.js（主框架注入）、page-inject.js（所有 frame 注入）
   三处共用同一份，避免加内核时参数不一致 —— 这正是"只改了主框架"类问题的来源 */
const { KERNELS, DEVICE_PRESETS, DEFAULT_DEVICE, presetFor } = require('./page-devices.js');

let mainWindow = null;
let pageView = null;
let pageSession = null;
let localServer = null;
let startUrl = '';
let kernel = 'ios';
let lastLayout = null;
let tray = null;        /* 托盘图标：后台运行入口 */
let quitting = false;   /* true 时点 ✕ 才真正退出 */
const pendingRequests = new Map();

/* ============ 内置静态服务（浏览器 UI + 演示站点） ============ */
function createLocalServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      } catch (e) {
        res.writeHead(400).end('Bad Request');
        return;
      }
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const filePath = path.resolve(ROOT, relative);
      if (!filePath.startsWith(ROOT + path.sep)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store'
        });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function sendToUI(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function sendMenuAction(action) {
  sendToUI('menu-action', action);
}

function toDisplayUrl(url) {
  try {
    const u = new URL(url);
    if (/\/demo\.html$/i.test(u.pathname)) {
      const page = u.searchParams.get('page') || 'home';
      const q = u.searchParams.get('q');
      return 'demo://' + page + (q ? '?q=' + encodeURIComponent(q) : '');
    }
    return u.href;
  } catch (e) { return url; }
}

/* ============ 网络抓包（仅页面视图，独立 session 天然与 UI 隔离） ============ */
function shortName(url) {
  /* 列表里显示"路径 + 查询串"的完整内容（不再只取最后一段文件名、也不再用 … 代表 query），
     宽度不够时由表格的 ellipsis 自行截断 */
  try {
    const u = new URL(url);
    let path = u.pathname || '/';
    try { path = decodeURIComponent(path); } catch (e2) {}
    const name = path + (u.search || '');
    return name.length > 240 ? name.slice(0, 240) : name;
  } catch (e) { return String(url).slice(0, 160); }
}

/* tabs 是 Map，没有 find() —— 以前取主页 URL 时误用 tabs.find 抛 TypeError
   又被空 catch 吞掉，结果 iframe 请求拿不到主页地址（Referer / 主页 Cookie 全丢）。
   统一走这个遍历，顺带防止 webContents 已销毁时抛异常卡住请求。 */
function tabForWebContents(wcId) {
  let found = null;
  tabs.forEach((t) => {
    if (found) return;
    try {
      if (!t.view.webContents.isDestroyed() && t.view.webContents.id === wcId) found = t;
    } catch (e) {}
  });
  return found;
}
function tabIdForWebContents(wcId) {
  const t = tabForWebContents(wcId);
  return t ? t.id : 0;
}
/* 该 webContents 当前的主文档地址（导航中途 getURL() 可能为空，退回 tab.url） */
function mainDocUrlFor(wcId) {
  const t = tabForWebContents(wcId);
  if (!t) return '';
  try {
    const u = t.view.webContents.getURL();
    if (/^https?:\/\//i.test(u)) return u;
  } catch (e) {}
  return /^https?:\/\//i.test(t.url || '') ? t.url : '';
}
function isPageRequest(details) {
  return tabIdForWebContents(details.webContentsId) !== 0;
}

/* 资源类型中文名：控制台的加载失败条目里标出是 JS / CSS / 图片 */
const RES_TYPE_CN = {
  script: 'JS', stylesheet: 'CSS', image: '图片', font: '字体', media: '媒体',
  document: '文档', xhr: 'XHR', fetch: 'Fetch', other: '资源'
};

/* ============ iframe 导航请求头（src 文档请求） ============
   目标：主页用 iframe 嵌套子页面时，子页面的文档请求带上这一组头 ——
     Referer: 主页完整 URL
     Priority: u=4
     Cookie: 主页 URL 下的全部 cookie + 子页面域被剥掉的 cookie
     Sec-Fetch-Dest: iframe
     Sec-Fetch-Mode: navigate
     Sec-Fetch-Site: cross-site
     Sec-Fetch-Storage-Access: none
     Upgrade-Insecure-Requests: 1

   为什么写在主进程而不是页面里：
     Referer / Sec-Fetch-* / Upgrade-Insecure-Requests / Priority 全是 Fetch 规范的
     forbidden request headers（或由浏览器网络栈生成）—— 页面 JS 用
     fetch/setRequestInterceptor 设了会被静默丢弃，XHR/fetch 也拦不到 iframe 的
     文档请求。Cookie 里的 HttpOnly 项页面 JS 更是读不到。
     只有 session.webRequest.onBeforeSendHeaders 处在网络层，能真正改写并发出。

   只作用于 subFrame（iframe / frame 的文档导航）：
     主文档也改成 dest=iframe 会自相矛盾，反而更容易被服务端识破。 */

/* Sec-Fetch-Site 取值方式：
   'fixed'（默认）恒定输出 cross-site —— 对应需求里明确要的那组头。
   'auto' 改为按真实站点关系计算（same-origin / same-site / cross-site）：
   同主域的 iframe 被硬写成 cross-site 时，会与站点看到的 Cookie 行为矛盾，
   排查"改完头反而被判异常"时可把这个开关切成 auto 对比。 */
const IFRAME_SEC_FETCH_SITE_MODE = 'fixed';

/* 子页面文档请求的 Referer：
   'full'（默认）发主页完整 URL —— 对应真机旧内核默认策略（no-referrer-when-downgrade），
     与 page-inject.js 给 iframe 钉住的 referrerpolicy 一致：
     iframe 内 document.referrer 与请求头 Referer 是同一个值，两边不会矛盾。
     仅 https 主页 → http 子页面（降级）时按策略不发。
   'strict' 回到 strict-origin-when-cross-origin 推导（跨源只给 origin），
     排查"改完整 Referer 后被判异常"时可切回来对比。 */
const IFRAME_REFERER_MODE = 'full';

/* 子页面文档请求的优先级头（RFC 9218 的 urgency）：
   Chromium 会在网络层按资源类型自行给出 Priority，这里按抓包里的真机值统一成 u=4。
   设为空字符串即关闭，不影响其它请求。 */
const IFRAME_PRIORITY = 'u=4';

/* 子帧 Cookie 补齐开关：
   按主页 URL 从会话 jar 取出该 URL 会发送的 cookie（含 HttpOnly）并入 Cookie 头，
   与浏览器访问主页时带的完全一致；不按 domain 兜底、也不叠加子页面域的 cookie。
   'on'（默认）补齐；'off' 保持 Chromium 原生行为。 */
const IFRAME_COOKIE_MODE = 'on';

/* 同一个变量取最新的值：
   百度统计 Hm_lvt_* 一类 cookie 会把多次访问的时间戳用逗号拼进同一个值，
   持久化会话里越积越多（1793...,1793...,1793...），与真机新会话的单值不一致。
   'on'（默认）对这种「纯数字时间戳逗号串」只保留最大（最新）的一段再发出；
   jar 里同名 cookie 有多条时也按时间戳取新的那条。
   'off' 原样发送 jar 里的值。只改发出的请求头，不写回 cookie jar。 */
const IFRAME_COOKIE_LATEST_ONLY = 'on';

/* 只认这两种资源类型；用对象做白表时 null/数字等键会被 toString 后命中，
   所以这里显式判断字符串 */
function isIframeNav(details) {
  const t = details && details.resourceType;
  return t === 'subFrame' || t === 'iframe';
}

/* 两段公共后缀近似表（离线打包，不引第三方 eTLD 库）：
   命中时注册域取三段，否则取最后两段。够判断 same-site / cross-site 即可。 */
const TWO_LEVEL_SUFFIXES = [
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp',
  'com.br', 'com.au', 'net.au', 'com.hk', 'com.tw', 'com.sg',
  'co.kr', 'com.mx', 'com.ru', 'co.za', 'com.tr', 'com.ua', 'com.in', 'co.in'
];

/* IP 字面量不做"取末两段"的域名截断：否则 10.0.0.1 与 127.0.0.1 会被算成同一注册域 */
function isIpLike(host) {
  const h = String(host || '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (h.indexOf(':') >= 0) return true;            /* IPv6（URL 里带方括号） */
  return false;
}

function regDomain(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return '';
  if (isIpLike(h)) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join('.');
  if (TWO_LEVEL_SUFFIXES.indexOf(last2) >= 0) return parts.slice(-3).join('.');
  return last2;
}

/* Sec-Fetch-Site 语义三态：same-origin / same-site / cross-site */
function secFetchSite(originUrl, destUrl) {
  if (!originUrl) return 'cross-site';
  let a, b;
  try { a = new URL(originUrl); b = new URL(destUrl); } catch (e) { return 'cross-site'; }
  if (a.protocol === b.protocol && a.host === b.host) return 'same-origin';
  /* 宿主是 data:/about:/blob: 这类不透明来源时，浏览器一律按 cross-site 报 */
  if (!/^https?:$/.test(a.protocol)) return 'cross-site';
  return regDomain(a.hostname) === regDomain(b.hostname) ? 'same-site' : 'cross-site';
}

/* 按 strict-origin-when-cross-origin 推导应当发送的 Referer：
   同源 → 完整 URL（去掉 fragment）；跨源 → 只保留 origin；
   https 降到 http → 不发（strict- 前缀的降协议拦截） */
function strictReferer(originUrl, destUrl) {
  if (!originUrl) return '';
  let from, to;
  try { from = new URL(originUrl); to = new URL(destUrl); } catch (e) { return ''; }
  if (!/^https?:$/.test(from.protocol) || !/^https?:$/.test(to.protocol)) return '';
  if (from.protocol === 'https:' && to.protocol === 'http:') return '';
  if (from.protocol === to.protocol && from.host === to.host) {
    return from.origin + from.pathname + from.search;
  }
  return from.origin + '/';
}

/* iframe 文档请求的 Referer：无条件发主页完整 URL（去掉 fragment）。
   page-inject.js 把 iframe 的 referrerpolicy 钉成 unsafe-url（同样无条件发完整 URL），
   因此子页面里的 document.referrer 与这里写进请求头的值完全相同。 */
function fullPageReferer(originUrl, destUrl) {
  if (!originUrl) return '';
  let from, to;
  try { from = new URL(originUrl); to = new URL(destUrl); } catch (e) { return ''; }
  if (!/^https?:$/.test(from.protocol) || !/^https?:$/.test(to.protocol)) return '';
  from.hash = '';
  return from.href;
}

/* 发起 iframe 请求的宿主页 URL，按可靠程度依次回退：
   1) onBeforeRequest 时随请求记下的主文档地址（同一请求，不受之后导航/切标签影响）；
   2) 该 webContents 当前主文档地址；
   3) webRequest 自带的 referrer / initiator（initiator 通常只到 origin）。
   只认 http(s) 绝对地址：about:/data:/null 之类既不能当 Referer，
   cookies.get 也查不到东西。 */
function iframeHostDocUrl(details) {
  const st = pendingRequests.get(details.id);
  const candidates = [
    st && st.hostDoc,
    mainDocUrlFor(details.webContentsId),
    details.referrer,
    details.initiator
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && /^https?:\/\//i.test(c)) return c;
  }
  return '';
}

/* 大小写不敏感删除：站点脚本可能用小写键，避免留下互相矛盾的重复头 */
function deleteHeaderIgnoreCase(headers, name) {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) delete headers[k];
  }
}

/* 大小写不敏感读取 */
function findHeaderValue(headers, name) {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() !== lower) continue;
    const v = headers[k];
    /* extraHeaders 下个别头可能以 string[] 给出：直接 String(array) 会用「逗号」
       把多个 cookie 粘成一个值，看起来就像"一个变量变成了数组"。
       Cookie 的分隔符是 "; "，这里按它拼开，逗号只保留在值内部。 */
    if (Array.isArray(v)) return v.map((x) => String(x == null ? '' : x)).join('; ');
    return String(v == null ? '' : v);
  }
  return '';
}

/* 逗号分隔的时间戳列表 → 只留最新（数值最大）的一段。
   只认全是 9~13 位纯数字（Unix 秒 / 毫秒）的串；JSON、枚举、含逗号的普通文本
   原样返回，避免把正常 cookie 值截断。末尾多余逗号（"1793794590,"）也顺手去掉。 */
function latestCookieValue(value) {
  const s = String(value == null ? '' : value);
  if (IFRAME_COOKIE_LATEST_ONLY !== 'on' || s.indexOf(',') < 0) return s;
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  if (!parts.length || !parts.every((p) => /^\d{9,13}$/.test(p))) return s;
  let best = parts[0];
  for (const p of parts) if (Number(p) > Number(best)) best = p;
  return best;
}

/* 同名多条比较用的"新旧"：纯时间戳用数值，其它值统一 0（保持先出现的优先） */
function cookieValueRank(v) {
  return /^\d{9,13}$/.test(v) ? Number(v) : 0;
}

/* iframe 子页面请求的 Cookie 合并：
   只取「主页 URL 会发送的 cookie」（cookies.get({url}) 已按协议/域/路径筛好，含 HttpOnly），
   浏览器原本带上的键作为补充；输出标准 name=value; ... 串。
   同一个 name 只留一份，且值取最新：
     · 值本身是逗号时间戳串 → 只留最大（最新）的一段；
     · jar 里同名有多条（不同 domain / path）→ 按时间戳比较，留新的那条。
   不要再按 domain 兜底：那会把同注册域下其它子域 / 其它站点种的 Hm_lvt_* 一起带上。 */
function mergeIframeCookieHeader(existingValue, hostList) {
  const picked = new Map();     /* name → { value, rank } */
  const consider = (name, value) => {
    if (!name) return;
    const v = latestCookieValue(value);
    const rank = cookieValueRank(v);
    const prev = picked.get(name);
    if (!prev || rank > prev.rank) picked.set(name, { value: v, rank: rank });
  };
  for (const c of (hostList || [])) {
    if (!c || !c.name) continue;
    consider(c.name, c.value);
  }
  for (const raw of String(existingValue || '').split(';')) {
    const t = raw.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    consider(t.slice(0, i).trim(), t.slice(i + 1).trim());
  }
  const out = [];
  for (const [name, item] of picked) out.push(name + '=' + item.value);
  return out.join('; ');
}

function attachWebRequestLogging(ses) {
  /* extraHeaders: true —— 不打开的话，details.requestHeaders 里看不到 Cookie /
     Authorization 这类头（Chromium 默认不暴露给 webRequest）。
     补 Cookie 必须先知道浏览器已经带了哪些键，否则同名键会出现两份值。 */
  const filter = { urls: ['http://*/*', 'https://*/*'], extraHeaders: true };
  ses.webRequest.onBeforeRequest(filter, (details, callback) => {
    /* 注意：不要 cancel 站点的 pc-limit 脚本 —— 它是 SPA 的动态 chunk，
       拦截会导致 import 失败、页面显示错误占位页。
       改为在 page-preload.js 中校正 <meta name="v"> 视图标记，从源头避免渲染提示页 */
    if (isPageRequest(details)) {
      pendingRequests.set(details.id, {
        t: Date.now(), url: details.url, method: details.method, type: details.resourceType,
        tabId: tabIdForWebContents(details.webContentsId),
        /* 发起这个请求瞬间的主文档地址：iframe 请求要拿它当主页 URL / 主页 cookie 来源 */
        hostDoc: mainDocUrlFor(details.webContentsId)
      });
    }
    callback({});
  });
  /* 重写 Chromium 自动携带的 Client Hints 请求头（服务端常用它识破 UA 伪装）：
     Android / 鸿蒙 ArkWeb → 报告真机元数据（mobile=1 + 各自的 platform / model）；
     iOS → 整组移除（真实 Safari 不发送 UA-CH 头） */
  ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = details.requestHeaders || {};
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase().startsWith('sec-ch-ua')) delete headers[k];
    }
    if (kernel === 'android' || kernel === 'harmony') {
      const dev = activePreset();
      const brands = (dev.brands || []).map((b) => '"' + b.brand + '";v="' + b.version + '"').join(', ');
      if (brands) headers['sec-ch-ua'] = brands;
      headers['sec-ch-ua-mobile'] = '?1';
      headers['sec-ch-ua-platform'] = '"' + dev.platform + '"';
      headers['sec-ch-ua-model'] = '"' + dev.model + '"';
      headers['sec-ch-ua-platform-version'] = '"' + dev.platformVersion + '"';
    }

    /* ---- iframe 的 src 文档请求：补齐这组头 ----
       放在 UA-CH 改写之后，保证记录到网络面板的是最终真正发出的内容 */
    /* 统一收口：Cookie 补齐要走 ses.cookies.get（异步），
       但 onBeforeSendHeaders 的 callback 必须且只能调用一次，
       否则会卡住整个请求管线。这里用 once 保护，异步分支调完再收口。 */
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      /* 存下**真正发出**的请求头（改写之后的），
         网络面板点开某条请求时要展示"消息头"—— 站点按 UA/UA-CH 拦截时全靠它对照 */
      const st = pendingRequests.get(details.id);
      if (st) st.reqHeaders = Object.assign({}, headers);
      if (process.env.SIM_NET_DEBUG) {
        console.log('[net-dbg] onBeforeSendHeaders id=' + details.id + ' st=' + (st ? 'yes' : 'no') +
          ' keys=' + Object.keys(headers).length);
      }
      callback({ requestHeaders: headers });
    };

    if (isIframeNav(details)) {
      const hostDoc = iframeHostDocUrl(details);
      /* 站点关系判定优先用 initiator（浏览器给出的**发起文档** origin）：
         嵌套 iframe 的外层文档与标签页主文档不同源时，按主文档算会算错。
         initiator 不可用时退回主文档 URL。 */
      const originForSite = (typeof details.initiator === 'string' && details.initiator)
        ? details.initiator
        : hostDoc;
      const site = IFRAME_SEC_FETCH_SITE_MODE === 'fixed'
        ? 'cross-site'
        : secFetchSite(originForSite, details.url);

      deleteHeaderIgnoreCase(headers, 'sec-fetch-dest');
      deleteHeaderIgnoreCase(headers, 'sec-fetch-mode');
      deleteHeaderIgnoreCase(headers, 'sec-fetch-site');
      deleteHeaderIgnoreCase(headers, 'sec-fetch-storage-access');
      deleteHeaderIgnoreCase(headers, 'upgrade-insecure-requests');
      deleteHeaderIgnoreCase(headers, 'priority');

      headers['Sec-Fetch-Dest'] = 'iframe';
      headers['Sec-Fetch-Mode'] = 'navigate';
      headers['Sec-Fetch-Site'] = site;
      headers['Sec-Fetch-Storage-Access'] = 'none';
      headers['Upgrade-Insecure-Requests'] = '1';
      /* Priority 由 Chromium 网络栈按资源类型生成，先删后写，避免留下两个互相矛盾的值 */
      if (IFRAME_PRIORITY) headers['Priority'] = IFRAME_PRIORITY;

      /* Referer 默认发主页完整 URL（与页面侧钉住的 referrerpolicy 一致）；
         'strict' 时回到 strict-origin-when-cross-origin 推导，便于抓包对比。
         只有拿到有效主页 URL 才覆盖；拿不到时保留浏览器原生的 Referer，
         别像以前那样把原有的也一起删掉。 */
      const ref = IFRAME_REFERER_MODE === 'strict'
        ? strictReferer(hostDoc, details.url)
        : fullPageReferer(hostDoc, details.url);
      if (ref) {
        deleteHeaderIgnoreCase(headers, 'referer');
        headers['Referer'] = ref;
      }

      /* Cookie：只加「主页 URL 会发送的 cookie」，拼成标准 name=value; ... 串。
         不按 domain 兜底（会把同注册域其它站点/子域的 Hm_lvt_* 带多、值也不对），
         也不叠加子页面域的 jar（那不是主页的 cookie）。 */
      if (IFRAME_COOKIE_MODE === 'on') {
        try {
          const hostUrl = /^https?:\/\//i.test(hostDoc) ? hostDoc : '';
          const hostJar = hostUrl
            ? ses.cookies.get({ url: hostUrl }).catch(() => [])
            : Promise.resolve([]);
          hostJar
            .then((list) => {
              /* 逐条打印 jar 里的原始值：逗号分隔的多时间戳是站点写进 cookie.value
                 的字符串，不是这里拆出来的数组，调试时可直接对照 */
              if (process.env.SIM_NET_DEBUG) {
                (list || []).forEach((c) => {
                  console.log('[net-dbg] host-cookie name=' + c.name +
                    ' value=' + String(c.value == null ? '' : c.value).slice(0, 160) +
                    ' domain=' + (c.domain || '') + ' path=' + (c.path || ''));
                });
              }
              const merged = mergeIframeCookieHeader(findHeaderValue(headers, 'cookie'), list);
              /* 主页没有 cookie 时保留浏览器原生 Cookie，别把它删成"未携带 Cookie" */
              if (merged) {
                deleteHeaderIgnoreCase(headers, 'cookie');
                headers['Cookie'] = merged;
              }
              if (process.env.SIM_NET_DEBUG) {
                console.log('[net-dbg] iframe-nav headers site=' + site +
                  ' referer=' + (ref || '(none)') +
                  ' priority=' + (IFRAME_PRIORITY || '(none)') +
                  ' hostDoc=' + (hostUrl || '(none)') +
                  ' hostJar=' + ((list || []).length) +
                  ' cookiePairs=' + (merged ? merged.split(';').length : 0) +
                  ' url=' + String(details.url).slice(0, 80));
              }
              end();
            })
            .catch(() => end());
          return;   /* 收口交给 then/catch，这里不能提前 callback */
        } catch (e) { /* 会话已销毁等同步异常 → 落到 end() 正常放行 */ }
      }

      if (process.env.SIM_NET_DEBUG) {
        console.log('[net-dbg] iframe-nav headers site=' + site +
          ' referer=' + (ref || '(none)') +
          ' priority=' + (IFRAME_PRIORITY || '(none)') +
          ' url=' + String(details.url).slice(0, 80));
      }
    }

    end();
  });
  ses.webRequest.onCompleted(filter, (details) => {
    const st = pendingRequests.get(details.id);
    if (!st) return;
    pendingRequests.delete(details.id);
    let size = 0;
    try {
      const headers = details.responseHeaders || {};
      const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-length');
      if (key) size = Number(headers[key][0]) || 0;
    } catch (e) {}
    if (process.env.SIM_NET_DEBUG) {
      console.log('[net-dbg] onCompleted id=' + details.id + ' url=' + String(st.url).slice(0, 50) +
        ' reqH=' + Object.keys(st.reqHeaders || {}).length +
        ' resH=' + Object.keys(details.responseHeaders || {}).length);
    }
    sendToUI('page-network', {
      name: shortName(st.url), url: st.url, method: st.method,
      status: details.statusCode, type: st.type, size: size,
      duration: Date.now() - st.t, tabId: st.tabId,
      /* 消息头 / Cookie 两个标签的数据源 */
      reqHeaders: st.reqHeaders || {},
      resHeaders: details.responseHeaders || {}
    });
    /* 4xx/5xx：DevTools 控制台里的「加载失败」条目属于浏览器级日志，
       Electron 的 console-message 只转发 renderer 的 console API，收不到这类消息，
       因此从网络层补一条带资源类型与地址的错误 */
    if (details.statusCode >= 400) {
      const kind = RES_TYPE_CN[st.type] || '资源';
      sendToUI('page-console', {
        level: 'error',
        text: '加载失败 ' + details.statusCode + ' · ' + kind + ' · ' + st.url,
        source: st.url,
        line: 0,
        tabId: st.tabId
      });
    }
  });
  ses.webRequest.onErrorOccurred(filter, (details) => {
    const st = pendingRequests.get(details.id);
    if (!st) return;
    pendingRequests.delete(details.id);
    sendToUI('page-network', {
      name: shortName(st.url), url: st.url, method: st.method,
      status: 0, type: st.type, size: 0, duration: Date.now() - st.t, error: details.error,
      tabId: st.tabId,
      /* 失败请求同样要带请求头：以前漏了这两个字段，详情里的「消息头」标签
         永远显示"未捕获到请求头"，排查失败原因时正好看不到最关键的信息 */
      reqHeaders: st.reqHeaders || {},
      resHeaders: {}
    });
    /* 中断类错误（切页 / 用户取消）属噪声，不往控制台里刷 */
    if (!/ERR_ABORTED/i.test(details.error || '')) {
      const kind = RES_TYPE_CN[st.type] || '资源';
      sendToUI('page-console', {
        level: 'error',
        text: '请求失败 · ' + (details.error || '未知错误') + ' · ' + kind + ' · ' + st.url,
        source: st.url,
        line: 0,
        tabId: st.tabId
      });
    }
  });
}

/* ================= 网络详情采集：请求体 / 响应体 =================
   webRequest 只能拿到头（请求头 / 响应头），body 必须走 CDP：
     Network.requestWillBeSent → postData（请求体）
     Network.loadingFinished    → Network.getResponseBody（响应体）
   CDP 的 requestId 与 webRequest 的 id 不是一套编号，结果里带上 url+method，
   前端据此与网络列表行配对。 */
function setupNetDetailCdp(wc, tab) {
  if (wc.__netDetailHooked) return;
  wc.__netDetailHooked = true;
  const meta = new Map();
  wc.debugger.on('message', (event, method, params) => {
    try {
      if (method === 'Network.requestWillBeSent') {
        const r = (params && params.request) || {};
        meta.set(params.requestId, { url: r.url, method: r.method });
        if (r.postData) {
          sendToUI('page-network-detail', {
            url: r.url, method: r.method,
            postData: String(r.postData).slice(0, 200000),
            tabId: tab.id
          });
        }
      } else if (method === 'Network.loadingFailed') {
        /* 失败原因：webRequest 的 onErrorOccurred 只有一个 error 字符串，
           分不清"被取消的导航""被 CSP/ORB 拦截""CORS 拒绝"。
           CDP 这里能给出 canceled / blockedReason / corsErrorStatus，
           按 url+method 配对后送到网络面板，任意站点失败都能自己看清原因 */
        const m = meta.get(params.requestId);
        if (!m) return;
        meta.delete(params.requestId);
        const cors = params.corsErrorStatus || null;
        sendToUI('page-network-detail', {
          url: m.url, method: m.method, tabId: tab.id,
          failReason: {
            errorText: String(params.errorText || ''),
            canceled: !!params.canceled,
            blockedReason: String(params.blockedReason || ''),
            corsError: cors ? String(cors.corsError || '') : '',
            corsFailedParameter: cors ? String(cors.failedParameter || '') : ''
          }
        });
      } else if (method === 'Network.loadingFinished') {
        const m = meta.get(params.requestId);
        if (!m) return;
        meta.delete(params.requestId);
        wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId })
          .then((res) => {
            if (!res) return;
            const base64 = !!res.base64Encoded;
            let body = String(res.body || '');
            if (body.length > 200000) body = body.slice(0, 200000) + '\n…（已截断）';
            sendToUI('page-network-detail', {
              url: m.url, method: m.method, body: body, base64: base64, tabId: tab.id
            });
          })
          .catch((err) => {
            /* 取不到正文时把原因带回去，界面显示"为什么没有正文"而不是笼统提示 */
            sendToUI('page-network-detail', {
              url: m.url, method: m.method,
              bodyErr: String((err && err.message) || err), tabId: tab.id
            });
          });
      }
    } catch (e) {}
  });
}

/* ============ 窗口标题 / 图标跟随当前站点 ============ */
/* ============ 窗口图标分档：标题栏 = 站点 shortcut icon，任务栏 = 小浣熊 ============
   Windows 的 WM_SETICON 分两档：ICON_SMALL 决定标题栏左上角，ICON_BIG 决定任务栏 / Alt+Tab。
   Electron 的 setIcon() 两档一起改，所以这里用 koffi 直接调 user32 分别设置。 */
const APP_ICON_PATH = path.join(ROOT, 'assets', 'icon.png');
const faviconCache = new Map();      /* favicon url → nativeImage */
const siteIcoFiles = new Map();      /* favicon url → 临时 ico 文件路径 */
let appBigIcoPath = '';              /* 任务栏小浣熊 ico，一次性生成 */
let lastSmallHicon = null;           /* 上一次的标题栏 HICON，换页后销毁避免泄漏 */

let koffi = null;
try { koffi = require('koffi'); } catch (e) {
  console.log('[小浣熊] koffi 加载失败：标题栏图标不跟随站点（任务栏仍为小浣熊） · ' + ((e && e.message) || e));
}

let user32Api = null;
function user32() {
  if (!koffi) return null;
  if (user32Api) return user32Api;
  try {
    const lib = koffi.load('user32.dll');
    user32Api = {
      load: lib.func('void * LoadImageA(void *hinst, const char *name, uint32_t type, int cx, int cy, uint32_t load)'),
      send: lib.func('void * SendMessageA(void *hwnd, uint32_t msg, uintptr_t wparam, void *lparam)'),
      destroy: lib.func('int DestroyIcon(void *hicon)')
    };
  } catch (e) {
    console.log('[小浣熊] user32 绑定失败：' + ((e && e.message) || e));
    user32Api = null;
  }
  return user32Api;
}

/* PNG 直接包进 ICO 容器（Vista+ 支持 PNG 条目），LoadImage 才能读 */
function pngAsIcoFile(pngBuf, size, file) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);   /* type: icon */
  header.writeUInt16LE(1, 4);   /* count */
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry.writeUInt16LE(1, 4);    /* planes */
  entry.writeUInt16LE(32, 6);   /* bpp */
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12);
  fs.writeFileSync(file, Buffer.concat([header, entry, pngBuf]));
  return file;
}

/* 任务栏图标：黄棕色小浣熊 32×32，只生成一次 */
function prepareTaskbarIcon() {
  if (!koffi || appBigIcoPath) return;
  try {
    const img = nativeImage.createFromPath(APP_ICON_PATH);
    if (img.isEmpty()) return;
    const png = img.resize({ width: 32, height: 32, quality: 'best' }).toPNG();
    appBigIcoPath = pngAsIcoFile(png, 32, path.join(app.getPath('temp'), 'xiaohuanxiong-taskbar.ico'));
  } catch (e) {}
}

function applyWindowTitle(title) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setTitle(String(title || '').trim() || '小浣熊');
}

/* 纯 BMP 结构的 .ico（Chromium 的 nativeImage 解不了）手动转成位图：
   取最大的 32bpp 条目，还原 BGRA 行序，交给 createFromBitmap */
function icoToBitmap(buf) {
  try {
    if (buf.length < 22 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
    const count = buf.readUInt16LE(4);
    let pick = null;
    for (let i = 0; i < count; i++) {
      const e = 6 + i * 16;
      if (e + 16 > buf.length) break;
      const w = buf[e] || 256;
      const off = buf.readUInt32LE(e + 12);
      if (!pick || w > pick.w) pick = { w: w, off: off };
    }
    if (!pick || pick.off + 40 > buf.length) return null;
    const bmp = pick.off;
    const bw = buf.readInt32LE(bmp + 4);
    const bh = buf.readInt32LE(bmp + 8);
    if (buf.readUInt16LE(bmp + 14) !== 32) return null;   /* 只处理 32bpp，其它交给后续候选 */
    const width = bw;
    const height = Math.abs(bh) / 2;   /* ICON 里存的是 XOR + AND 两张图，高度是两倍 */
    const out = Buffer.alloc(width * height * 4);
    const bottomUp = bh > 0;
    for (let y = 0; y < height; y++) {
      const src = bmp + 40 + (bottomUp ? (height - 1 - y) : y) * width * 4;
      for (let x = 0; x < width; x++) {
        const s = src + x * 4;
        const d = (y * width + x) * 4;
        out[d] = buf[s]; out[d + 1] = buf[s + 1]; out[d + 2] = buf[s + 2]; out[d + 3] = buf[s + 3];
      }
    }
    return { width: width, height: height, data: out };
  } catch (e) { return null; }
}

async function fetchIcon(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    let img = nativeImage.createFromBuffer(buf);   /* png / jpeg */
    if (!img.isEmpty()) return img;
    const bmp = icoToBitmap(buf);                  /* 老式 .ico */
    if (bmp) {
      img = nativeImage.createFromBitmap(bmp.data, { width: bmp.width, height: bmp.height });
      if (!img.isEmpty()) return img;
    }
    return null;
  } catch (e) { return null; }
}

/* 读出页面声明的 favicon 候选（shortcut icon 优先） */
async function readIconCandidates(view) {
  try {
    const list = await view.webContents.executeJavaScript(`(function () {
      var out = [];
      function add(h) { if (h && out.indexOf(h) < 0) out.push(h); }
      var links = Array.prototype.slice.call(document.querySelectorAll('link[rel]'));
      /* 首选站点声明的 shortcut icon / icon（浏览器地址栏用的就是它）；
         其次 apple-touch-icon（大尺寸 PNG，兜底更清晰）；最后站点根 favicon.ico */
      links.forEach(function (l) { if ((l.rel || '').toLowerCase().indexOf('shortcut icon') >= 0) add(l.href); });
      links.forEach(function (l) {
        var r = (l.rel || '').toLowerCase();
        if (r.indexOf('icon') >= 0 && r.indexOf('apple-touch-icon') < 0 && r.indexOf('mask-icon') < 0) add(l.href);
      });
      links.forEach(function (l) { if ((l.rel || '').toLowerCase().indexOf('apple-touch-icon') >= 0) add(l.href); });
      try { add(new URL('/favicon.ico', location.href).href); } catch (e) {}
      return out;
    })()`, true);
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

/* 标题栏（ICON_SMALL）用站点图标，任务栏（ICON_BIG）固定小浣熊 */
function setTitlebarIcon(href, icon) {
  if (!mainWindow || mainWindow.isDestroyed() || !koffi) return;
  const api = user32();
  if (!api || !appBigIcoPath) return;
  let icoFile = siteIcoFiles.get(href);
  if (!icoFile) {
    try {
      const small = icon.getSize().width > 16 ? icon.resize({ width: 16, height: 16, quality: 'best' }) : icon;
      const name = 'xhx-site-' + siteIcoFiles.size + '.ico';
      icoFile = pngAsIcoFile(small.toPNG(), 16, path.join(app.getPath('temp'), name));
      if (siteIcoFiles.size > 20) siteIcoFiles.delete(siteIcoFiles.keys().next().value);
      siteIcoFiles.set(href, icoFile);
    } catch (e) { return; }
  }
  try {
    /* getNativeWindowHandle 返回的是"装着 HWND 的 Buffer"，koffi 需要指针值本身 */
    const hwndBuf = mainWindow.getNativeWindowHandle();
    const hwnd = hwndBuf.length >= 8 ? hwndBuf.readBigUInt64LE(0) : BigInt(hwndBuf.readUInt32LE(0));
    const IMAGE_ICON = 1, LR_LOADFROMFILE = 0x10, WM_SETICON = 0x80;
    const hSmall = api.load(null, icoFile, IMAGE_ICON, 0, 0, LR_LOADFROMFILE);
    const hBig = api.load(null, appBigIcoPath, IMAGE_ICON, 0, 0, LR_LOADFROMFILE);
    if (!hSmall || !hBig) return;
    if (lastSmallHicon) { try { api.destroy(lastSmallHicon); } catch (e) {} }
    api.send(hwnd, WM_SETICON, 0, hSmall);   /* ICON_SMALL → 标题栏 */
    api.send(hwnd, WM_SETICON, 1, hBig);     /* ICON_BIG   → 任务栏 */
    lastSmallHicon = hSmall;
  } catch (e) {}
}

/* 取标签页的站点图标：标签栏显示 +（激活标签）标题栏图标 */
const tabIconBusy = new Set();
async function refreshTabIcon(tab) {
  if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (tabIconBusy.has(tab.id)) return;
  tabIconBusy.add(tab.id);
  try {
    const list = await readIconCandidates(tab.view);
    for (const href of list) {
      let icon = faviconCache.get(href);
      if (icon === undefined) {
        icon = await fetchIcon(href);
        if (faviconCache.size > 60) faviconCache.clear();
        faviconCache.set(href, icon);
      }
      if (!icon) continue;   /* svg / 404 会继续试下一个候选 */
      if (!tabs.has(tab.id)) return;

      try {
        /* 标签栏 14px，取 32px 位图，高分屏也清晰 */
        const s = icon.getSize();
        const box = s.width >= s.height ? { width: 32 } : { height: 32 };
        tab.icon = icon.resize(box).toDataURL();
      } catch (e) { tab.icon = ''; }
      pushTabsState();

      if (tab.id === activeTabId) {
        prepareTaskbarIcon();
        setTitlebarIcon(href, icon);
      }
      return;
    }
  } finally {
    tabIconBusy.delete(tab.id);
  }
}

/* ============ 标签页（多个 WebContentsView，同浏览器会话） ============
   pageView 始终指向"当前激活标签"的视图：地址栏 / 前进后退 / F12 等既有
   IPC 全部继续操作它，行为与单标签时一致 */
const tabs = new Map();      /* id → { id, view, title, url, loading } */
let activeTabId = 0;
let nextTabId = 1;

function tabsSnapshot() {
  const out = [];
  tabs.forEach((t) => out.push({
    id: t.id, title: t.title, url: t.url, icon: t.icon || '',
    loading: t.loading, active: t.id === activeTabId
  }));
  return out;
}
function pushTabsState() { sendToUI('tabs-state', tabsSnapshot()); }

/* 内核 / 机型 / 视口 / 缩放都是"每个标签各自一份"：切换只影响当前标签 */
function tabKernel(tab) {
  const k = tab && tab.kernel;
  return KERNELS.indexOf(k) >= 0 ? k : 'ios';
}
/* 机型 id 与内核绑定：跨内核切回时若机型不属于该内核，自动退回该内核默认机型 */
function tabDeviceId(tab) {
  return tab ? presetFor(tabKernel(tab), tab.device).id : DEFAULT_DEVICE.ios;
}
function tabPreset(tab) {
  return tab ? presetFor(tabKernel(tab), tab.device) : presetFor(kernel);
}
/* 网络层改写 UA-CH 时用当前激活标签的机型（每个标签可以是不同机型） */
function activePreset() {
  const t = tabs.get(activeTabId);
  return t ? tabPreset(t) : presetFor(kernel);
}
function applyKernelUATo(tab) {
  if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return;
  tab.view.webContents.setUserAgent(tabPreset(tab).ua);
}
/* 当前标签的环境（UI 用它同步按钮状态与视口宽度） */
function tabEnvSnapshot(tab) {
  const dev = tabPreset(tab);
  return {
    tabId: tab.id,
    kernel: tabKernel(tab),
    device: dev.id,
    deviceName: dev.name,
    deviceWidth: dev.screenW,
    deviceLabel: dev.osLabel,
    badge: dev.badge,
    vp: tab.vp === 'full' ? 'full' : 'phone',
    zoom: Number(tab.zoom) || 1
  };
}
function pushTabEnv(tab) {
  const t = tab || tabs.get(activeTabId);
  if (t) sendToUI('tab-env', tabEnvSnapshot(t));
}

/* 真机参数表见 page-devices.js（屏幕逻辑尺寸 / DPR / Client Hints 元数据）。
   只改 UA 不够 —— navigator.userAgentData 仍会报 mobile:false + Windows 桌面，
   这是站点判断“非手机”最常见的一条证据 */

/* 设备级伪装：屏幕 / 触摸 / 指针 / Client Hints 全部与所模拟的真机一致，
   避免“本站仅支持移动设备访问”类拦截 */
function applyDeviceEmulationTo(tab) {
  if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return Promise.resolve();
  const view = tab.view;
  const wc = view.webContents;
  const dev = tabPreset(tab);
  /* 视口尺寸取页面视图实际大小（避免双重缩放导致排版错乱） */
  let b = null;
  try { b = view.getBounds(); } catch (e) {}
  /* 页面缩放：页面框（UI 侧 .page-frame）随缩放整体变大（390→546），
     内容用 Chromium 原生缩放等比放大，正好铺满放大后的框：
       · 视图（页面框）546 DIP + 原生缩放 1.4 → 可用 CSS 宽度 = 546/1.4 = 390，
         页面按真机宽度排版（文字换行和真机一致），渲染放大 1.4 倍铺满整个框
     关键：**不能下发 Emulation.setDeviceMetricsOverride**。
     它会把布局视口钉死成固定宽高，同时禁掉原生缩放，
     结果是"框变大了、内容却没放大，右侧留白"（实测绿条法测得视觉缩放恒为 1.0）。
     去掉后原生缩放才真正生效（实测 140% 时 100 CSS px = 140 设备 DIP）。
     移动身份不靠它：UA 覆盖 + UA-CH metadata.mobile=true 已经让 Chromium
     继续发送 `Sec-CH-UA-Mobile: ?1` / `Sec-CH-UA-Platform: "iOS"`（实测），
     服务端据此判定移动设备；其余设备特征由 page-preload.js 注入伪装。 */
  const zoom = Math.max(0.5, Math.min(2, Number(tab.zoom) || 1));
  const eff = zoom;
  /* 注意：webContents.enableDeviceEmulation 在当前 Electron 版本会导致进程崩溃，
     因此改用稳定的 CDP Emulation 域（与 DevTools 设备模拟同一路径） */
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    /* 网络详情采集（请求体 / 响应体）：
       webRequest 拿不到 body，必须走 CDP。
       requestId 与 webRequest 的 id 不是一套，前端按 url+method 配对。 */
    try { setupNetDetailCdp(wc, tab); } catch (err) {}
    /* 设备伪装下发到**所有 frame**（含 iframe）：
       站群的"仅支持移动设备访问"提示其实是广告落地页（Vite SPA）跑在 iframe 里，
       它在自己的上下文中检测 window.chrome / bluetooth / Safari 专有 API。
       只伪装主框架 → iframe 内看到的是真实 Chromium → 被判成桌面 → 显示提示页。
       CDP 的 addScriptToEvaluateOnNewDocument 对每个 frame 都生效。 */
    let injectReady = Promise.resolve();
    try {
      const injectSrc = require('./page-inject.js').source(dev);
      /* Page / Network 域必须先 enable，否则 addScriptToEvaluateOnNewDocument
         和 setBlockedURLs 都会被静默忽略（实测：子框架仍是真实桌面环境） */
      injectReady = Promise.resolve()
        .then(() => wc.debugger.sendCommand('Page.enable'))
        .then(() => wc.debugger.sendCommand('Network.enable'))
        /* 清空 URL 阻断表：早期排查时这里阻断过 *://*:2087/*，
           结果同一个会话里首次 attach 的规则会一直生效，
           2087 端口上的站点（页面 + 图片）全部 Network Error。
           显式传空数组，顺便清掉复用 webContents 时残留的旧规则 */
        .then(() => wc.debugger.sendCommand('Network.setBlockedURLs', { urls: [] }))
        /* 摘掉**全部**历史注入脚本：切内核会重复注册，只记一个 id 的话
           旧内核的脚本会残留并继续生效（典型症状：鸿蒙/安卓下
           navigator.userAgentData、window.chrome 被 iOS 那份删掉后不再出现） */
        .then(() => {
          const ids = (tab._injectIds || []).slice();
          if (tab._injectId) ids.push(tab._injectId);
          tab._injectIds = [];
          tab._injectId = null;
          return Promise.all(ids.map((id) =>
            wc.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: id })
              .catch(() => {})
          ));
        })
        .then(() => wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: injectSrc }))
        .then((r) => {
          const id = r && r.identifier;
          tab._injectId = id;
          if (id) tab._injectIds = [id];
        })
        .catch((err) => console.log('[小浣熊] 伪装注入下发失败: ' + ((err && err.message) || err)));
    } catch (err) {}
    wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
      .then(() => wc.debugger.sendCommand('Emulation.setUserAgentOverride', {
        userAgent: dev.ua,
        /* 不要带 q 权重：CDP 会原样塞进 navigator.languages，出现 "zh;q=0.9" 反而不像真机 */
        acceptLanguage: 'zh-CN,zh',
        platform: dev.platform,
        userAgentMetadata: {
          brands: dev.brands,
          fullVersionList: dev.brands.map((x) => ({ brand: x.brand, version: x.version + '.0.0.0' })),
          fullVersion: dev.brands.length ? '146.0.0.0' : '',
          platform: dev.platform,
          platformVersion: dev.platformVersion,
          architecture: dev.arch,
          model: dev.model,
          mobile: true,
          bitness: dev.bitness,
          wow64: false
        }
      }))
      /* 设备模拟之后紧接着把鼠标输入映射成触摸（移动页面只认 touch 事件） */
      .then(() => applyTouchEmulationTo(tab))
      .catch((err) => console.log('[小浣熊] 设备模拟设置失败: ' + ((err && err.message) || err)))
      /* 最后下发原生缩放：内容按倍数放大，铺满放大的页面框 */
      .finally(() => {
        try {
          wc.setZoomFactor(eff);
          let actual = eff;
          try { actual = wc.getZoomFactor(); } catch (e) {}
          console.log('[小浣熊] 页面缩放已应用：' + Math.round(zoom * 100) + '%（实际 ' + Math.round(actual * 100) + '%，视图 ' + (b ? b.width + '×' + b.height : '?') + '）');
        } catch (e) {}
      });
    /* 记在 tab 上：createTab 要用它决定首屏何时 loadURL（但不会无限等） */
    tab.__emulReady = injectReady;
    return injectReady;
  } catch (e) {
    tab.__emulReady = Promise.resolve();
    return tab.__emulReady;
  }
}

function applyDeviceEmulationAll() {
  tabs.forEach((t) => applyDeviceEmulationTo(t));
}

/* 首屏兜底：addScriptToEvaluateOnNewDocument 只对"注册之后创建的文档"生效，
   而冷启动时 preload 的 webFrame.executeJavaScript 偶尔会落在导航前的临时上下文里，
   两者都可能在第一个文档漏注入（表现为首屏是桌面指纹，切一次内核才正常）。
   did-finish-load 时读标记，只有确实漏了 / 内核不符才对当前文档直接补一次。 */
function ensurePageInjection(tab) {
  if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return;
  const wc = tab.view.webContents;
  const dev = tabPreset(tab);
  const tag = dev.kernel + ':' + dev.id;
  wc.executeJavaScript('window.__psInjected || ""')
    .then((cur) => {
      if (cur === tag || wc.isDestroyed()) return;
      const src = require('./page-inject.js').source(dev);
      return wc.executeJavaScript(src, true);
    })
    .catch(() => {});
}

/* full=true 表示真正的跨文档导航（刷新/换网址），false 表示 SPA 站内跳转或仅切换标签。
   UI 的「持续」开关据此决定是否清空控制器 / 网络记录。 */
function pageNavigatedPayload(tab, full) {
  const wc = tab.view.webContents;
  let url = '';
  try { url = wc.getURL(); } catch (e) {}
  return {
    url: url,
    display: toDisplayUrl(url),
    canBack: wc.navigationHistory.canGoBack(),
    canForward: wc.navigationHistory.canGoForward(),
    title: wc.getTitle(),
    tabId: tab.id,
    full: !!full
  };
}
function syncPageState() {
  const tab = tabs.get(activeTabId);
  if (!tab || tab.view.webContents.isDestroyed()) return;
  sendToUI('page-navigated', pageNavigatedPayload(tab, false));
}

function createTab(url, activate) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const id = nextTabId++;
  const view = new WebContentsView({
    webPreferences: {
      session: pageSession,
      preload: path.join(ROOT, 'page-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  view.setBackgroundColor('#ffffff');
  /* 新标签继承当前标签的内核 / 机型 / 视口 / 缩放（只影响新开的这一个，不动已有标签） */
  const base = tabs.get(activeTabId) || null;
  const tab = {
    id: id, view: view, title: '新标签页', url: '', icon: '', loading: true,
    kernel: base ? tabKernel(base) : kernel,
    device: base ? tabDeviceId(base) : (DEFAULT_DEVICE[kernel] || DEFAULT_DEVICE.ios),
    vp: base && base.vp === 'full' ? 'full' : 'phone',
    zoom: base ? (Number(base.zoom) || 1) : 1
  };
  tabs.set(id, tab);
  bindTabEvents(tab);
  applyKernelUATo(tab);
  applyHardwareTo(tab);
  /* 先把视图挂进窗口，CDP target 才稳定：
     以前在 addChildView 之前就发 debugger 命令，挂载时 target 会被重建，
     in-flight 命令报 "target closed"，甚至永久挂起；
     而首屏 loadURL 正好挂在那条命令链上 → 偶发"首次打开默认标签不加载"。
     activateTab 内部会做一次完整的设备模拟下发（含所有 frame 的注入脚本）。 */
  if (activate !== false) activateTab(id);
  else applyDeviceEmulationTo(tab);
  /* 首屏加载不能被 CDP 链卡死：最多等 600ms，超时也照常加载。
     主框架伪装由 page-preload.js 保证，子框架注入在 did-navigate 时会重新下发。 */
  Promise.race([
    Promise.resolve(tab.__emulReady).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 600))
  ]).then(() => {
    try {
      if (!view.webContents.isDestroyed()) view.webContents.loadURL(url || 'about:blank');
    } catch (e) {}
  });
  pushTabsState();
  console.log('[小浣熊] 新标签页 #' + id + ' ← ' + (url || 'about:blank'));
  return id;
}

function bindTabEvents(tab) {
  const wc = tab.view.webContents;
  /* 一个 webContents 上会挂应用自己的导航/加载/控制台等 ~8 个监听，
     再加 Electron debugger 内部注册的几个，稳定在 11 个左右（不随导航增长）。
     Node 默认阈值 10 会误报 "Possible EventEmitter memory leak"，抬高上限即可 */
  wc.setMaxListeners(24);

  /* 页面内所有链接（含 target=_blank / window.open）→ 新标签页打开，不外跳系统浏览器。
     about:blank 弹窗不建标签：站点广告脚本常用它做跳板（先开空白页再用脚本
     location 跳到广告站），拦掉后用户点 <a target=_blank> 的正常跳转不受影响 */
  wc.setWindowOpenHandler(({ url }) => {
    const target = String(url || '');
    if (/^https?:/i.test(target)) createTab(target, true);
    return { action: 'deny' };
  });

  const isActive = () => tab.id === activeTabId;

  wc.on('did-start-loading', () => {
    tab.loading = true;
    if (isActive()) sendToUI('page-loading', true);
    pushTabsState();
  });
  wc.on('did-stop-loading', () => {
    tab.loading = false;
    if (isActive()) sendToUI('page-loading', false);
    pushTabsState();
  });
  wc.on('did-navigate', () => {
    tab.url = wc.getURL();
    /* 后台标签也通知 UI：未勾选「持续」时清掉该标签自己的记录 */
    sendToUI('page-navigated', pageNavigatedPayload(tab, true));
    if (isActive()) sendToUI('page-error', null);
    /* 导航后重新下发模拟参数：CDP 覆盖在跨文档导航时可能被重置 */
    applyDeviceEmulationTo(tab);
    applySensorPatch(tab);   /* 传感器模拟随页面重注入 */
    pushTabsState();
  });
  wc.on('did-navigate-in-page', () => {
    tab.url = wc.getURL();
    if (isActive()) sendToUI('page-navigated', pageNavigatedPayload(tab, false));
    pushTabsState();
  });
  wc.on('page-title-updated', (_e, title) => {
    tab.title = String(title || '').trim() || '新标签页';
    if (isActive()) {
      sendToUI('page-title', tab.title);
      applyWindowTitle(tab.title);
    }
    pushTabsState();
  });
  wc.on('did-finish-load', () => {
    ensurePageInjection(tab);
    if (isActive()) applyWindowTitle(wc.getTitle());
    /* 主文档正文：CDP 的 Network.getResponseBody 对主文档常常取不到
       （导航完成后 Chromium 会释放该资源，报 "No resource with given identifier"），
       这里用 DOM 序列化补一份，网络面板的"响应"标签照样能看到主文档内容 */
    try {
      wc.executeJavaScript('document.documentElement.outerHTML').then((html) => {
        if (!html) return;
        sendToUI('page-network-detail', {
          url: wc.getURL(), method: 'GET', body: String(html).slice(0, 200000),
          bodyNote: 'DOM 序列化结果（主文档原始响应体已释放）', tabId: tab.id
        });
      }).catch(() => {});
    } catch (e) {}
    /* 空白页（about:blank）铺白底：不同主题下也不会露出窗口深色背景 */
    try {
      if (/^about:blank/i.test(wc.getURL())) {
        wc.insertCSS('html,body{background:#ffffff !important;margin:0;height:100%;}');
      }
    } catch (e) {}
    /* 标签栏图标：DOM 就绪后再取（<link rel=icon> 可能由脚本注入，稍后补一次） */
    refreshTabIcon(tab);
    setTimeout(() => refreshTabIcon(tab), 1200);
  });
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) {
      sendToUI('page-error', { code: errorCode, desc: errorDescription, url: validatedURL, tabId: tab.id });
    }
  });
  wc.once('destroyed', () => {
    if (tabs.has(tab.id)) closeTab(tab.id);
  });

  /* 页面控制台：脚本 console.* / 未捕获异常 / 资源加载失败（404 的 js、css）都会从这里出来，
     带上来源文件与行号，UI 侧按级别筛选后展示 */
  wc.on('console-message', (...args) => {
    let level = 'info', message = '', sourceId = '', line = 0;
    /* Electron 37+ 的签名是 (event, details)，较早版本是 (event, level, message, line, sourceId)，
       两种都兼容：优先找带 message 字段的 details 对象 */
    const details = args.find((a) => a && typeof a === 'object' && typeof a.message === 'string' && !Array.isArray(a));
    if (details) {
      level = details.level || 'info';
      message = details.message || '';
      sourceId = details.sourceId || '';
      line = details.lineNumber || 0;
    } else {
      const lv = args[1];
      message = args[2] || '';
      line = args[3] || 0;
      sourceId = args[4] || '';
      level = typeof lv === 'number'
        ? ({ 0: 'debug', 1: 'info', 2: 'warn', 3: 'error' })[lv] || 'info'
        : String(lv || 'info');
    }
    if (level === 'warning') level = 'warn';
    if (level === 'verbose') level = 'debug';
    if (!message) return;
    sendToUI('page-console', {
      level: level,
      text: message,
      source: sourceId,
      line: line,
      tabId: tab.id,
      url: (() => { try { return wc.getURL(); } catch (e) { return ''; } })()
    });
  });

  wc.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      event.preventDefault();
      sendMenuAction('console');
    }
  });
}

function activateTab(id) {
  const tab = tabs.get(id);
  if (!tab || !mainWindow || mainWindow.isDestroyed()) return;
  const old = pageView;
  pageView = tab.view;
  activeTabId = id;
  /* 网络层 UA-CH 改写跟当前激活标签的内核/机型走 */
  kernel = tabKernel(tab);
  if (old && old !== pageView && !old.webContents.isDestroyed()) {
    try { mainWindow.contentView.removeChildView(old); } catch (e) {}
  }
  mainWindow.contentView.addChildView(pageView);
  /* 先定尺寸再发 CDP 命令：视图 0×0 时下发设备模拟容易触发 target 重建 */
  updateViewBounds();
  /* 切回标签时恢复它自己的缩放（缩放走 device metrics 的 scale，这里把原生缩放归一） */
  try { pageView.webContents.setZoomFactor(1); } catch (e) {}
  /* 切回标签时恢复"鼠标→触摸"转换（选取模式的临时关闭不该残留到该标签） */
  tab.__touchEmit = true;
  applyDeviceEmulationTo(tab);
  /* 先推标签状态：UI 收到后才会把 DevTools 数据切到这个标签，
     之后紧跟着的 page-navigated 才会被当作"当前标签"更新地址栏 */
  pushTabsState();
  pushTabEnv(tab);          /* 内核 / 视口 / 缩放按标签恢复 */
  syncPageState();
  applyWindowTitle(tab.title);
  if (!tab.icon) refreshTabIcon(tab);
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  tabs.delete(id);
  const wasActive = id === activeTabId;
  if (!tab.view.webContents.isDestroyed()) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.contentView.removeChildView(tab.view); } catch (e) {}
    }
    try { tab.view.webContents.close(); } catch (e) {}
  }
  if (wasActive) {
    pageView = null;
    const list = Array.from(tabs.keys());
    if (list.length) activateTab(list[list.length - 1]);
    else createTab('about:blank', true);
  } else {
    pushTabsState();
  }
}

let lastViewSize = '';

function updateViewBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || !pageView) return;
  if (lastLayout && lastLayout.width > 0 && lastLayout.height > 0) {
    pageView.setBounds({
      x: lastLayout.x, y: lastLayout.y,
      width: lastLayout.width, height: lastLayout.height
    });
    /* 视口宽度变化（手机/全宽切换、窗口缩放）：重发设备模拟，页面按新宽度排版 */
    const key = lastLayout.width + 'x' + lastLayout.height;
    if (key !== lastViewSize) {
      lastViewSize = key;
      const t = tabs.get(activeTabId);
      if (t) setTimeout(() => applyDeviceEmulationTo(t), 60);
    }
  }
}

/* ============ 主窗口 ============ */
const TITLEBAR_HEIGHT = 36;   /* 自定义标题栏：与 UI 里 .titlebar 高度保持一致 */

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 940,
    minWidth: 980,
    minHeight: 640,
    title: '小浣熊 · 移动内核桌面浏览器',
    icon: path.join(ROOT, 'assets', 'icon.png'),
    backgroundColor: '#0b1020',
    show: false,
    /* 隐藏系统标题栏（不再显示图标 / 页面标题），只保留右上角窗口按钮；
       顶部菜单条由 index.html 自绘，点击后弹出原生 Menu */
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0d1526',
      symbolColor: '#c3d1e8',
      height: TITLEBAR_HEIGHT
    },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  /* UI 页面自己的 <title> 不覆盖窗口标题：窗口标题跟当前网页标题走 */
  mainWindow.webContents.on('page-title-updated', (e) => e.preventDefault());

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    /* 菜单改为 UI 顶部自绘的「文件 / 视图 / 工具 / 帮助」，原生菜单栏不再显示 */
    if (typeof mainWindow.setMenuBarVisibility === 'function') mainWindow.setMenuBarVisibility(false);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[小浣熊] 浏览器窗口已就绪，本地服务端口 ' + (localServer ? localServer.address().port : 0));
  });
  mainWindow.loadURL(url);

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });

  mainWindow.on('resize', updateViewBounds);
  mainWindow.on('enter-full-screen', () => { updateViewBounds(); sendToUI('fullscreen-changed', true); });
  mainWindow.on('leave-full-screen', () => { updateViewBounds(); sendToUI('fullscreen-changed', false); });
  /* 主窗口移动 / 缩放 / 最小化 / 全屏切换时，置顶弹层小窗随之收起 */
  mainWindow.on('move', hidePopWin);
  mainWindow.on('resize', hidePopWin);
  mainWindow.on('minimize', hidePopWin);
  mainWindow.on('hide', hidePopWin);
  /* 点 ✕ 不退出：隐藏到托盘，后台继续运行（托盘菜单 / quit-app 才真正退出） */
  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
    /* 不用系统气泡（标题会显示 exe 名 "Electron"），改成托盘图标的悬停提示 */
    if (tray && !tray.isDestroyed()) tray.setToolTip('小浣熊仍在后台运行 · 单击重新打开，右键退出');
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function toggleWindowFullscreen() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const next = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(next);
  return next;
}

/* ============ 菜单 ============ */
function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '返回主页', accelerator: 'Alt+Home', click: () => sendMenuAction('home') },
        { label: '刷新页面', accelerator: 'Ctrl+R', click: () => sendMenuAction('refresh') },
        { type: 'separator' },
        { label: '收藏网址（需密码）', accelerator: 'Ctrl+D', click: () => sendMenuAction('vault') },
        { type: 'separator' },
        { label: '退出小浣熊', click: () => { quitting = true; app.quit(); } }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '应用内控制台 (F12)', click: () => sendMenuAction('console') },
        { type: 'separator' },
        { label: '窗口全屏', click: () => toggleWindowFullscreen() },
        { label: '页面放大', click: () => sendMenuAction('zoom-in') },
        { label: '页面缩小', click: () => sendMenuAction('zoom-out') },
        { type: 'separator' },
        { label: '切换 iOS / Android 内核', click: () => sendMenuAction('kernel') }
      ]
    },
    {
      label: '工具',
      submenu: [
        { label: '清除cookie', click: () => sendMenuAction('clear-cookies') },
        { label: '清除本地缓存', click: () => sendMenuAction('clear-cache') }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于小浣熊', click: () => sendMenuAction('about') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ============ 浏览数据清理（工具菜单） ============
   只作用于网页会话 persist:phone-pages，浏览器 UI 自己的默认会话
   （收藏夹 / 解锁密码 / DevTools 布局等设置）不受影响。 */
async function clearPageCookies() {
  if (!pageSession) return { ok: false, error: '页面会话尚未就绪' };
  try {
    const list = await pageSession.cookies.get({});
    let removed = 0;
    for (const c of (list || [])) {
      const domain = String(c.domain || '').replace(/^\./, '');
      if (!domain) continue;
      const url = (c.secure ? 'https://' : 'http://') + domain + (c.path || '/');
      try { await pageSession.cookies.remove(url, c.name); removed++; } catch (e) {}
    }
    /* 兜底：会话 jar 里个别无域名 / 分区项可能没被逐条删到。
       clearData 比 clearStorageData 更彻底，两者都失败也不影响逐条删除的结果 */
    try {
      if (pageSession.clearData) await pageSession.clearData({ dataTypes: ['cookies'] });
      else await pageSession.clearStorageData({ storages: ['cookies'] });
    } catch (e) {
      try { await pageSession.clearStorageData({ storages: ['cookies'] }); } catch (e2) {}
    }
    const left = await pageSession.cookies.get({});
    const remaining = (left || []).length;
    console.log('[小浣熊] 清除cookie：' + removed + ' 项，剩余 ' + remaining + ' 项');
    return remaining
      ? { ok: false, error: '仍有 ' + remaining + ' 项未能清除', count: removed }
      : { ok: true, count: removed };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

async function clearPageCache() {
  if (!pageSession) return { ok: false, error: '页面会话尚未就绪' };
  const errors = [];
  let done = 0;
  const attempt = async (label, fn) => {
    try { await fn(); done++; } catch (e) { errors.push(label + '：' + ((e && e.message) || e)); }
  };
  /* HTTP 缓存 + 站点本地数据（localStorage / IndexedDB / CacheStorage /
     ServiceWorker / 文件系统 / WebSQL），不含 cookie —— 清 cookie 有独立菜单项 */
  await attempt('HTTP 缓存', () => pageSession.clearCache());
  await attempt('本地存储', () => pageSession.clearStorageData({
    storages: ['filesystem', 'indexdb', 'localstorage', 'shadercache', 'serviceworkers', 'cachestorage']
  }));
  /* Electron 45+ 的 clearData / 代码缓存 / DNS 缓存属额外补刀，
     接口不存在或个别数据类型不被支持时不影响上面两步的结果 */
  try {
    if (pageSession.clearData) {
      await pageSession.clearData({
        dataTypes: ['cache', 'fileSystems', 'indexedDB', 'localStorage', 'serviceWorkers', 'webSQL']
      });
      done++;
    }
  } catch (e) {}
  try { if (pageSession.clearCodeCaches) await pageSession.clearCodeCaches({ urls: [] }); } catch (e) {}
  try { if (pageSession.clearHostResolverCache) await pageSession.clearHostResolverCache(); } catch (e) {}
  console.log('[小浣熊] 清除本地缓存：' + (done ? '完成' : '失败') +
    (errors.length ? '（' + errors.join('；') + '）' : ''));
  if (!done) return { ok: false, error: errors.join('；') || '清理接口不可用' };
  return errors.length ? { ok: true, warning: errors.join('；') } : { ok: true };
}

ipcMain.handle('clear-cookies', () => clearPageCookies());
ipcMain.handle('clear-cache', () => clearPageCache());

/* ============ 收藏夹 / UI 设置持久化 ============
   浏览器 UI 由 http://127.0.0.1:<随机端口>/index.html 提供，端口每次启动都变，
   localStorage 的 origin 跟着变，收藏等数据重启后就会"消失"。

   收藏网址按要求存到 <安装目录>\Favorites\favorites.json
   （默认安装位置 D:\Program Files\RaccoonQuant\Browser\PcAsMobile）；
   同时在 userData\Favorites\favorites.json 留一份同步备份：安装目录若被
   系统保护（Program Files 且未提权）导致写失败，收藏仍不会丢。
   解锁密码 / 界面布局等其它设置继续存 userData\ui-settings.json。 */
const FAVORITES_KEY = 'ps.bookmarks';
let uiSettings = null;
let favoritesWarned = false;

function uiSettingsFile() {
  return path.join(app.getPath('userData'), 'ui-settings.json');
}
function getUiSettings() {
  if (!uiSettings) {
    try {
      const parsed = JSON.parse(fs.readFileSync(uiSettingsFile(), 'utf8'));
      uiSettings = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (e) {
      uiSettings = {};
    }
  }
  return uiSettings;
}
function saveUiSettings() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(uiSettingsFile(), JSON.stringify(getUiSettings(), null, 2), 'utf8');
  } catch (e) {
    console.error('[小浣熊] UI 设置保存失败：', e);
  }
}

function installDir() {
  /* 打包后 exe 所在目录就是安装目录（也兼容 /D= 自定义位置）；
     源码调试时以项目根目录代替，方便直接查看 Favorites */
  return app.isPackaged ? path.dirname(app.getPath('exe')) : ROOT;
}
function favoritesPaths() {
  return [
    path.join(installDir(), 'Favorites', 'favorites.json'),
    path.join(app.getPath('userData'), 'Favorites', 'favorites.json')
  ];
}
function readFavoritesFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return Array.isArray(JSON.parse(text)) ? text : null;
  } catch (e) { return null; }
}
function writeFavoritesFile(file, text) {
  let tmp = '';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let body = text;
    try { body = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {}
    tmp = file + '.tmp';
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    try { if (tmp) fs.unlinkSync(tmp); } catch (e2) {}
    return false;
  }
}
function getFavoritesRaw() {
  const paths = favoritesPaths();
  for (const file of paths) {
    const text = readFavoritesFile(file);
    if (text !== null) return text;
  }
  /* 兼容上一版：收藏曾与其它设置一起存在 userData\ui-settings.json */
  const all = getUiSettings();
  if (typeof all[FAVORITES_KEY] === 'string') {
    const legacy = all[FAVORITES_KEY];
    delete all[FAVORITES_KEY];
    saveUiSettings();
    setFavoritesRaw(legacy);
    return legacy;
  }
  return null;
}
function setFavoritesRaw(text) {
  const paths = favoritesPaths();
  const written = paths.map((file) => writeFavoritesFile(file, text));
  if (!written[0] && !favoritesWarned) {
    favoritesWarned = true;
    console.warn('[小浣熊] 安装目录不可写，收藏已保存到备份位置：' + paths[1]);
  }
  if (!written.some(Boolean)) {
    const all = getUiSettings();
    all[FAVORITES_KEY] = text;
    saveUiSettings();
    console.error('[小浣熊] 收藏文件写入失败，已临时写入 ui-settings.json');
  }
  return written.some(Boolean);
}

/* 读写都用同步 IPC：收藏后立即关闭窗口也能保证数据已落盘 */
ipcMain.on('ui-setting-get', (event, key) => {
  if (key === FAVORITES_KEY) { event.returnValue = getFavoritesRaw(); return; }
  const all = getUiSettings();
  event.returnValue = (typeof key === 'string' && Object.prototype.hasOwnProperty.call(all, key)) ? all[key] : null;
});
ipcMain.on('ui-setting-set', (event, payload) => {
  event.returnValue = true;
  const key = payload && payload.key;
  const value = payload && payload.value;
  if (typeof key !== 'string' || !key || typeof value !== 'string') return;
  if (key === FAVORITES_KEY) { setFavoritesRaw(value); return; }
  const all = getUiSettings();
  if (all[key] !== value) {
    all[key] = value;
    saveUiSettings();
  }
});

/* ============ IPC ============ */
ipcMain.handle('page-navigate', (_e, url) => {
  if (!pageView || !/^https?:/i.test(String(url || ''))) return false;
  applyKernelUATo(tabs.get(activeTabId));
  pageView.webContents.loadURL(String(url));
  return true;
});
ipcMain.handle('page-back', () => {
  if (pageView && pageView.webContents.navigationHistory.canGoBack()) pageView.webContents.navigationHistory.goBack();
  return true;
});
ipcMain.handle('page-forward', () => {
  if (pageView && pageView.webContents.navigationHistory.canGoForward()) pageView.webContents.navigationHistory.goForward();
  return true;
});
/* preload 同步查询当前内核：UA 覆盖与 preload 执行存在时序竞争，
   靠 navigator.userAgent 判断会拿错内核（Android 被当成 iOS 清理特征） */
ipcMain.on('get-kernel', (e) => {
  let k = kernel;
  tabs.forEach((t) => {
    try {
      if (!t.view.webContents.isDestroyed() && t.view.webContents.id === e.sender.id) k = tabKernel(t);
    } catch (err) {}
  });
  e.returnValue = k;
});
/* preload 同步查询「内核 + 机型」：注入脚本里的屏幕尺寸 / DPR / UA-CH 都按机型走 */
ipcMain.on('get-page-env', (e) => {
  let k = kernel;
  let device = DEFAULT_DEVICE[k] || DEFAULT_DEVICE.ios;
  tabs.forEach((t) => {
    try {
      if (!t.view.webContents.isDestroyed() && t.view.webContents.id === e.sender.id) {
        k = tabKernel(t);
        device = tabDeviceId(t);
      }
    } catch (err) {}
  });
  e.returnValue = { kernel: k, device: device };
});
/* UI 的悬停机型菜单：静态机型表（纯数据，可跨进程序列化） */
ipcMain.on('device-presets', (e) => {
  e.returnValue = { kernels: KERNELS, defaults: DEFAULT_DEVICE, presets: DEVICE_PRESETS };
});

/* 移动判定自检结果（preload 回报）：站点提示"仅支持移动设备访问"时，
   日志里能看到是哪一项判定露馅，便于定点补伪装 */
ipcMain.on('mobile-check', (e, r) => {
  let url = '';
  try { url = e.sender.getURL(); } catch (err) {}
  const line = '[' + new Date().toISOString() + '] ' + url.slice(0, 80) + ' → ' + JSON.stringify(r);
  console.log('[小浣熊][移动自检] ' + line);
  /* 同时落盘：站点提示"仅支持移动设备"时，可直接读这个文件定位是哪一项露馅 */
  try {
    const dir = path.join(__dirname, 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'mobile-check.log'), line + '\n');
  } catch (err) {}
});

/* ============ 硬件接口支持（摄像头 / 麦克风 / WiFi / 数据网络 / 蓝牙 / 重力感应 / GPS / 陀螺仪） ============ */
const hw = {
  cam: true, mic: true, bt: true,
  /* 鼠标点击模拟手指触摸：移动版页面（腾讯地图缩放按钮等）只监听 touch 事件，
     仅靠 maxTouchPoints 不够，必须把鼠标输入转成触摸输入 */
  touch: true,
  net: 'wifi',                                        /* wifi | 4g | 3g | offline */
  gps: { enabled: true, lat: 39.908823, lng: 116.397470, acc: 30 },   /* 默认北京 */
  sensor: { mode: 'still', alpha: 0, beta: 0, gamma: 0 }              /* still | shake | custom */
};
const NET_PROFILES = {
  wifi:    { offline: false, latency: 0,   down: -1,       up: -1,       label: 'WiFi' },
  '4g':    { offline: false, latency: 60,  down: 1500000,  up: 750000,   label: '4G 数据网络' },
  '3g':    { offline: false, latency: 300, down: 93750,    up: 46875,    label: '3G 数据网络' },
  offline: { offline: true,  latency: 0,   down: 0,        up: 0,        label: '离线' }
};
let sensorPatchSrc = '';

function sendTabCmd(tab, method, params) {
  try {
    const dbg = tab.view.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    return dbg.sendCommand(method, params).catch(() => {});
  } catch (e) { return Promise.resolve(); }
}

/* 网络环境（WiFi / 数据网络 / 离线）：CDP 限速 + 断网 */
function applyNetworkProfile(tab) {
  const p = NET_PROFILES[hw.net] || NET_PROFILES.wifi;
  sendTabCmd(tab, 'Network.enable', {});
  sendTabCmd(tab, 'Network.emulateNetworkConditions', {
    offline: p.offline, latency: p.latency,
    downloadThroughput: p.down, uploadThroughput: p.up
  });
  applySensorCfg(tab);   /* 页面里 navigator.connection 的模拟值跟着变 */
}

/* GPS：页面 navigator.geolocation 拿到的就是这里的模拟坐标 */
function applyGeolocation(tab) {
  if (!hw.gps.enabled) { sendTabCmd(tab, 'Emulation.clearGeolocationOverride', {}); return; }
  sendTabCmd(tab, 'Emulation.setGeolocationOverride', {
    latitude: hw.gps.lat, longitude: hw.gps.lng, accuracy: hw.gps.acc
  });
}

/* 下发给页面的模拟变量：姿态传感器配置 + 当前网络环境（navigator.connection 兜底用） */
function simVarsScript() {
  return 'window.__simSensorCfg = ' + JSON.stringify(hw.sensor) + ';' +
    'window.__simNetCfg = ' + JSON.stringify({ net: hw.net }) + ';';
}

/* 鼠标 → 触摸：左键按下/拖动/抬起转成 touchstart/touchmove/touchend，
   这样移动版页面里只绑 touch 的按钮（地图 +/−、圆点菜单等）点得动。
   注意：这个转换会吞掉页面的 mousemove / pointermove（悬停高亮、DevTools 元素选取都会失效），
   所以元素选取模式期间会把它临时关掉（tab.__touchEmit === false）。 */
function applyTouchEmulationTo(tab) {
  const want = !!hw.touch && tab.__touchEmit !== false;
  sendTabCmd(tab, 'Emulation.setEmitTouchEventsForMouse', {
    enabled: want,
    configuration: hw.touch ? 'mobile' : 'desktop'
  });
}
/* 用 CDP 直接派发过双指手势后，触摸模拟器里可能残留"手指仍按着"的状态，
   之后鼠标点击就不再转成 touch —— 重建一次触摸模拟把状态清干净 */
function resetTouchEmulation(tab) {
  sendTabCmd(tab, 'Emulation.setTouchEmulationEnabled', { enabled: false });
  sendTabCmd(tab, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  applyTouchEmulationTo(tab);
}

/* 陀螺仪 / 重力感应：向页面主世界注入 DeviceOrientation / DeviceMotion 模拟器 */
function applySensorPatch(tab) {
  if (!sensorPatchSrc) return;
  try {
    const wc = tab.view.webContents;
    wc.executeJavaScript(sensorPatchSrc, true).catch(() => {});
    wc.executeJavaScript(simVarsScript() + ' "ok"', true).catch(() => {});
  } catch (e) {}
}
function applySensorCfg(tab) {
  try {
    tab.view.webContents.executeJavaScript(simVarsScript() + ' "ok"', true).catch(() => {});
  } catch (e) {}
}
function applyHardwareTo(tab) {
  applyNetworkProfile(tab);
  applyGeolocation(tab);
  applySensorPatch(tab);
}

/* 权限放行：页面请求摄像头 / 麦克风 / 定位 / 蓝牙等直接授权（可用 hw 开关阻止） */
function setupHardwarePermissions() {
  const always = new Set(['fullscreen', 'pointerLock', 'notifications', 'clipboard-sanitized-write', 'midi', 'midiSysex']);
  pageSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    if (permission === 'media') {
      const types = (details && details.mediaTypes) || [];
      if (types.length) return cb(types.every((t) => (t === 'video' ? hw.cam : t === 'audio' ? hw.mic : true)));
      return cb(hw.cam || hw.mic);
    }
    if (permission === 'geolocation') return cb(!!hw.gps.enabled);
    if (permission === 'bluetooth') return cb(!!hw.bt);
    cb(always.has(permission));
  });
  pageSession.setPermissionCheckHandler((wc, permission, origin, details) => {
    if (permission === 'media') {
      const types = (details && details.mediaTypes) || ['video', 'audio'];
      if (types.indexOf('video') >= 0 && !hw.cam) return false;
      if (types.indexOf('audio') >= 0 && !hw.mic) return false;
      return true;
    }
    if (permission === 'geolocation') return !!hw.gps.enabled;
    if (permission === 'bluetooth') return !!hw.bt;
    return always.has(permission);
  });
}

/* Web Bluetooth：requestDevice 时自动选择第一个可用设备（避免无选择界面卡住） */
app.on('select-bluetooth-device', (event, devices, callback) => {
  event.preventDefault();
  const ready = (devices || []).filter((d) => d && d.deviceName);
  if (ready.length) {
    console.log('[小浣熊] 蓝牙：自动连接 ' + ready[0].deviceName + '（共 ' + ready.length + ' 个设备）');
    callback(ready[0].deviceId);
  } else {
    console.log('[小浣熊] 蓝牙：附近没有可用设备');
    callback('');
  }
});

ipcMain.handle('hw-get', () => hw);
ipcMain.handle('hw-set', (_e, patch) => {
  try {
    if (!patch || typeof patch !== 'object') return hw;
    if (patch.net && NET_PROFILES[patch.net]) hw.net = patch.net;
    if (patch.gps && typeof patch.gps === 'object') {
      hw.gps.enabled = !!patch.gps.enabled;
      const lat = Number(patch.gps.lat), lng = Number(patch.gps.lng);
      if (isFinite(lat)) hw.gps.lat = Math.max(-85, Math.min(85, lat));
      if (isFinite(lng)) hw.gps.lng = Math.max(-180, Math.min(180, lng));
      hw.gps.acc = Math.max(1, Number(patch.gps.acc) || 30);
    }
    if (patch.sensor && typeof patch.sensor === 'object') {
      hw.sensor.mode = ['still', 'shake', 'custom'].indexOf(patch.sensor.mode) >= 0 ? patch.sensor.mode : 'still';
      hw.sensor.alpha = Number(patch.sensor.alpha) || 0;
      hw.sensor.beta = Number(patch.sensor.beta) || 0;
      hw.sensor.gamma = Number(patch.sensor.gamma) || 0;
    }
    if (typeof patch.cam === 'boolean') hw.cam = patch.cam;
    if (typeof patch.mic === 'boolean') hw.mic = patch.mic;
    if (typeof patch.bt === 'boolean') hw.bt = patch.bt;
    if (typeof patch.touch === 'boolean') hw.touch = patch.touch;
    tabs.forEach((t) => { applyNetworkProfile(t); applyGeolocation(t); applySensorCfg(t); applyTouchEmulationTo(t); });
    sendToUI('hw-state', hw);
    console.log('[小浣熊] 硬件设置已应用：net=' + hw.net + ' gps=' + hw.gps.enabled + '(' + hw.gps.lat + ',' + hw.gps.lng + ') sensor=' + hw.sensor.mode + ' cam=' + hw.cam + ' mic=' + hw.mic + ' bt=' + hw.bt + ' touch=' + hw.touch);
    return hw;
  } catch (e) { return null; }
});

/* 滚轮 / 触控板双指 → 双指捏合：用 CDP Input.dispatchTouchEvent 派发真实触摸
   （isTrusted=true），移动版地图只认这种事件。
   向上滚 / 双指张开 = 放大，向下滚 / 双指合拢 = 缩小 */

/* 滚轮批次合并：同一批 wheel 里可能出现正负相抵的增量（Chromium 的滚动补偿），
   直接累加会先放大再缩小、互相抵消。改为"静默 140ms 后按这一批的净值决定方向"，
   持续滚动最多等 400ms 强制触发一次。 */
function scheduleWheelPinch(tab, x, y, deltaY) {
  tab.__pinchAcc = (tab.__pinchAcc || 0) + deltaY;
  tab.__pinchX = x; tab.__pinchY = y;
  const now = Date.now();
  if (!tab.__pinchFirst) tab.__pinchFirst = now;
  if (tab.__pinchTimer) clearTimeout(tab.__pinchTimer);
  const wait = Math.max(0, 400 - (now - tab.__pinchFirst));
  tab.__pinchTimer = setTimeout(() => {
    const d = tab.__pinchAcc || 0;
    tab.__pinchAcc = 0; tab.__pinchFirst = 0; tab.__pinchTimer = null;
    if (Math.abs(d) >= 100) pinchViaCDP(tab, tab.__pinchX, tab.__pinchY, d);
  }, wait);
}

/* 关键 1：单次捏合要跨满一整级（两指距离 2 倍 / 0.5 倍）—— 幅度不足一级时
   地图会在手势结束后把分数级舍回原级，表现为"缩了又弹回去"
   关键 2：触摸命令必须按顺序 await 完成，最后 touchEnd 要把手指全部抬起，
   否则两根手指会一直留在屏上，之后的点击都被当成第二根手指（按钮就点不动） */
function pinchViaCDP(tab, x, y, deltaY) {
  if (!tab || !tab.view || tab.view.webContents.isDestroyed() || !hw.touch) return;
  if (tab.__pinching) { tab.__pinchQueued = { x: x, y: y, deltaY: deltaY }; return; }
  tab.__pinching = true;
  const scale = deltaY < 0 ? 2 : 0.5;
  /* 注入坐标用页面 CSS 坐标（原生缩放下 e.clientX 已经是 CSS 坐标）→ 直接使用 */
  const cx = x, cy = y;
  console.log('[小浣熊] 双指捏合：' + (deltaY < 0 ? '放大' : '缩小') + ' @' + Math.round(cx) + ',' + Math.round(cy));
  const HALF = 45, STEPS = 8, STEP_MS = 30;
  const dbg = tab.view.webContents.debugger;
  try { if (!dbg.isAttached()) dbg.attach('1.3'); } catch (e) { tab.__pinching = false; return; }
  const send = (type, pts) => dbg.sendCommand('Input.dispatchTouchEvent', { type: type, touchPoints: pts });
  const T = (d) => [
    { id: 901, x: Math.round(cx - d), y: Math.round(cy) },
    { id: 902, x: Math.round(cx + d), y: Math.round(cy) }
  ];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    try {
      await send('touchStart', T(HALF));
      for (let i = 1; i <= STEPS; i++) {
        await wait(STEP_MS);
        await send('touchMove', T(HALF * (1 + (scale - 1) * (i / STEPS))));
      }
      /* 抬起两根手指：touchEnd 的 touchPoints 列出全部手指即可全部释放 */
      const dEnd = HALF * scale;
      await send('touchEnd', [
        { id: 901, x: Math.round(cx - dEnd), y: Math.round(cy) },
        { id: 902, x: Math.round(cx + dEnd), y: Math.round(cy) }
      ]);
    } catch (err) {
      console.log('[小浣熊] 触摸派发失败：' + ((err && err.message) || err));
    }
    tab.__pinching = false;
    /* 确保"鼠标→触摸"转换仍处于开启状态（点击按钮要用它） */
    applyTouchEmulationTo(tab);
    /* 手势期间又滚动的量，接着再捏一次 */
    const q = tab.__pinchQueued;
    tab.__pinchQueued = null;
    if (q && Math.abs(q.deltaY) >= 100) setTimeout(() => pinchViaCDP(tab, q.x, q.y, q.deltaY), 140);
  })();
}
ipcMain.on('page-wheel', (e, info) => {
  try {
    const p = info || {};
    let target = null;
    tabs.forEach((t) => {
      try {
        if (!t.view.webContents.isDestroyed() && t.view.webContents.id === e.sender.id) target = t;
      } catch (err) {}
    });
    if (target) {
      scheduleWheelPinch(target, Number(p.x) || 0, Number(p.y) || 0, Number(p.deltaY) || 0);
    }
  } catch (err) {}
});


/* ============ 标签页 IPC ============ */
ipcMain.handle('tab-new', (_e, url) => {
  const target = typeof url === 'string' && /^https?:/i.test(url) ? url : 'about:blank';
  createTab(target, true);
  return true;
});
/* UI 就绪时拉一次当前标签的内核 / 视口 / 缩放 */
ipcMain.handle('tab-env-get', () => {
  const tab = tabs.get(activeTabId);
  return tab ? tabEnvSnapshot(tab) : { tabId: 0, kernel: kernel, vp: 'phone', zoom: 1 };
});
ipcMain.handle('tab-close', (_e, id) => { closeTab(Number(id)); return true; });
ipcMain.handle('tab-activate', (_e, id) => { activateTab(Number(id)); return true; });

ipcMain.handle('page-reload', () => {
  if (pageView) pageView.webContents.reloadIgnoringCache();
  return true;
});
/* 切换内核 / 机型：只作用于当前标签（其它标签保持各自内核与机型，互不影响） */
function switchTabDevice(k, deviceId) {
  if (KERNELS.indexOf(k) < 0) return null;
  const tab = tabs.get(activeTabId);
  if (!tab) return null;
  const dev = presetFor(k, deviceId || DEFAULT_DEVICE[k]);
  tab.kernel = k;
  tab.device = dev.id;
  kernel = k;               /* 作为之后新建标签的默认值 */
  applyKernelUATo(tab);
  /* 等新机型的注入脚本注册完成再重载（否则新文档跑的还是上一套脚本），
     但同样设 600ms 上限：CDP 命令偶发挂起时不能把页面卡在旧参数不刷新 */
  Promise.race([
    Promise.resolve(applyDeviceEmulationTo(tab)).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 600))
  ]).then(() => {
    /* 页面需要重新加载，新 UA / 屏幕 / DPR 才会生效（仅当前标签） */
    try {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.reloadIgnoringCache();
    } catch (e) {}
  });
  pushTabEnv(tab);
  pushTabsState();
  console.log('[小浣熊] 标签 #' + tab.id + ' → ' + k + ' / ' + dev.name +
    ' (' + dev.screenW + 'x' + dev.screenH + ' Dpr:' + dev.dpr + ')（其它标签不变）');
  return { ua: dev.ua, width: dev.screenW, device: dev.id };
}
ipcMain.handle('set-kernel', (_e, k) => switchTabDevice(k, null));
ipcMain.handle('set-device', (_e, k, deviceId) => switchTabDevice(k, deviceId));
/* 元素选取模式需要页面收到 mousemove（悬停高亮 + 查看器 DOM 定位），
   而"鼠标→触摸"转换会把 mousemove 吞掉 —— 选取期间临时关掉，退出时恢复 */
ipcMain.handle('set-touch-emit', (_e, enabled) => {
  const tab = tabs.get(activeTabId);
  if (tab) {
    tab.__touchEmit = !!enabled;
    applyTouchEmulationTo(tab);
  }
  return true;
});

/* 页面缩放：只作用于当前标签 */
ipcMain.handle('set-zoom', (_e, factor) => {
  const f = Math.min(2, Math.max(0.5, Number(factor) || 1));
  const tab = tabs.get(activeTabId);
  if (tab) {
    tab.zoom = f;
    /* 先立刻下发原生缩放：内容马上按新倍数放大 */
    try {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.setZoomFactor(f);
    } catch (e) {}
    /* 页面框尺寸随缩放变化（UI 侧 --page-zoom）→ 等 UI 同步完布局、
       视图边界变成新尺寸后，再统一下发一次设备模拟 + 缩放 */
    setTimeout(() => {
      applyDeviceEmulationTo(tab);
      pushTabEnv(tab);
    }, 120);
  }
  return f;
});
/* 视口宽度（手机 / 全宽）：只作用于当前标签 */
ipcMain.handle('set-viewport', (_e, vp) => {
  const mode = vp === 'full' ? 'full' : 'phone';
  const tab = tabs.get(activeTabId);
  if (tab) {
    tab.vp = mode;
    pushTabEnv(tab);
  }
  return mode;
});
ipcMain.handle('page-exec', async (_e, code) => {
  if (!pageView || pageView.webContents.isDestroyed()) return { ok: false, error: '页面视图不可用' };
  try {
    const value = await pageView.webContents.executeJavaScript(String(code || ''), true);
    return { ok: true, value: value };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
/* 读取源文件文本：控制台里点「文件:行号」时用。
   走主进程读，不受渲染进程跨域限制；file:// 直接读盘 */
const MAX_SOURCE = 900 * 1024;
ipcMain.handle('read-source', async (_e, target) => {
  const url = String(target || '').trim();
  if (!url) return { ok: false, error: '缺少地址' };
  try {
    if (/^file:\/\//i.test(url)) {
      let p = decodeURIComponent(new URL(url).pathname);
      if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
      const text = fs.readFileSync(p, 'utf8');
      return { ok: true, text: text.slice(0, MAX_SOURCE), truncated: text.length > MAX_SOURCE };
    }
    if (!/^https?:/i.test(url)) return { ok: false, error: '不支持的地址类型' };
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const text = await res.text();
    return { ok: true, text: text.slice(0, MAX_SOURCE), truncated: text.length > MAX_SOURCE };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.on('page-layout', (_e, rect) => {
  if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.y) && rect.width > 0 && rect.height > 0) {
    lastLayout = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    updateViewBounds();
  }
});
/* ============ 置顶弹层小窗口（顶部菜单 / 机型列表） ============
   网页由原生 WebContentsView 渲染，窗口内 HTML 弹层永远被它盖住；
   之前靠「隐藏网页 + 页面快照」实现置顶，但页面会冻结（视频停格）。
   现改为独立置顶小窗：透明无边框、不抢焦点（focusable:false）、
   归属主窗口（parent）——原生层面始终浮在网页之上，
   网页无需隐藏，视频 / 动画照常播放。 */
let popWin = null;
let popWinReady = false;
let popWinQueue = null;
let popCloseTimer = null;
let popPos = { x: 0, y: 0 };

function hidePopWin() {
  if (popCloseTimer) { clearTimeout(popCloseTimer); popCloseTimer = null; }
  if (popWin && !popWin.isDestroyed() && popWin.isVisible()) popWin.hide();
}

function ensurePopWin() {
  if (popWin && !popWin.isDestroyed()) return popWin;
  popWinReady = false;
  /* 注意：不在此处清空 popWinQueue —— showPopWin 首次调用会先入队再建窗 */
  popWin = new BrowserWindow({
    width: 10, height: 10, show: false, frame: false, transparent: true,
    resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, hasShadow: false,
    /* 不用 focusable:false：Windows 上该样式的窗口 hover 正常但 click 不可靠。
       保持 showInactive 显示（不抢焦点），点击弹层时才短暂激活，
       选中后立即隐藏，焦点自动回到主窗口 */
    parent: mainWindow,
    webPreferences: {
      preload: path.join(ROOT, 'popup-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  popWin.setMenu(null);
  popWin.on('closed', () => { popWin = null; popWinReady = false; });
  /* 弹层获得过焦点后再失去（点到主窗口其它位置或别的应用）→ 收起 */
  popWin.on('blur', hidePopWin);
  popWin.webContents.once('dom-ready', () => {
    popWinReady = true;
    if (popWinQueue) { const queued = popWinQueue; popWinQueue = null; showPopWin(queued); }
  });
  popWin.loadFile(path.join(ROOT, 'popup.html'));
  return popWin;
}

function showPopWin(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!popWin) { popWinQueue = payload; ensurePopWin(); return; }
  if (!popWinReady) { popWinQueue = payload; return; }
  if (popCloseTimer) { clearTimeout(popCloseTimer); popCloseTimer = null; }
  const win = ensurePopWin();
  const b = mainWindow.getContentBounds();
  /* rect 为渲染层 getBoundingClientRect 坐标（隐藏式标题栏，内容即整个窗口） */
  popPos = {
    x: Math.round(b.x + payload.rect.x),
    y: Math.round(b.y + payload.rect.y)
  };
  win.webContents.send('pop-data', payload);
}

/* ============ 弹层关闭：双状态机（与内核、IPC 到达顺序无关） ============
   记录"鼠标是否在触发按钮上(overButton)"与"是否在弹层里(overPopup)"，
   两者都不在时才延时关闭；任一侧有悬停就取消关闭。
   这样在 seg 按钮之间移动（鼠标始终在按钮上、从不在弹层里）也不会误关，
   解决了"悬停非当前内核按钮时列表不显示 / 一移过去就消失"的问题。 */
let overButton = false;
let overPopup = false;
function popMaybeClose() {
  if (overButton || overPopup) {
    if (popCloseTimer) { clearTimeout(popCloseTimer); popCloseTimer = null; }
    return;
  }
  if (popCloseTimer) clearTimeout(popCloseTimer);
  popCloseTimer = setTimeout(hidePopWin, 250);
}
function resetPopHover() { overButton = false; overPopup = false; if (popCloseTimer) { clearTimeout(popCloseTimer); popCloseTimer = null; } }

ipcMain.on('pop-show', (_e, payload) => {
  overButton = true;            /* 触发按钮此刻处于悬停 */
  showPopWin(payload);
  popMaybeClose();
});
ipcMain.on('pop-hide', () => { resetPopHover(); hidePopWin(); });
ipcMain.on('pop-btn-out', () => { overButton = false; popMaybeClose(); });
ipcMain.on('pop-cancel-close', () => { if (popCloseTimer) { clearTimeout(popCloseTimer); popCloseTimer = null; } });
ipcMain.on('pop-hover-in', () => { overPopup = true; popMaybeClose(); });
ipcMain.on('pop-hover-out', () => { overPopup = false; popMaybeClose(); });
ipcMain.on('pop-resize', (_e, size) => {
  if (!popWin || popWin.isDestroyed()) return;
  const wa = screen.getDisplayNearestPoint(popPos).workArea;
  const w = Math.min(Math.max(Math.round(size.w) || 10, 40), wa.width - 8);
  const h = Math.min(Math.max(Math.round(size.h) || 10, 40), wa.height - 8);
  const x = Math.max(wa.x + 4, Math.min(popPos.x, wa.x + wa.width - w - 4));
  const y = Math.max(wa.y + 4, Math.min(popPos.y, wa.y + wa.height - h - 4));
  popPos = { x, y };
  popWin.setBounds({ x, y, width: w, height: h });
  if (!popWin.isVisible()) popWin.showInactive();
});
ipcMain.on('pop-select', (_e, payload) => {
  resetPopHover();
  hidePopWin();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pop-selected', payload);
});

/* 弹层（密码/收藏）需要盖住网页：网页是原生视图，必须临时隐藏它 */
ipcMain.on('page-visible', (_e, visible) => {
  if (!pageView || pageView.webContents.isDestroyed()) return;
  const show = !!visible;
  if (typeof pageView.setVisible === 'function') {
    pageView.setVisible(show);
  } else {
    /* 旧版本 Electron 兜底：移出可视区域 */
    pageView.setBounds(show ? (lastLayout || { x: 0, y: 0, width: 1, height: 1 })
      : { x: -20000, y: -20000, width: 1, height: 1 });
  }
  if (show) updateViewBounds();
  console.log('[小浣熊] 网页视图 ' + (show ? '已显示' : '已隐藏（弹层/错误提示置顶）'));
});
/* 弹层（菜单/机型列表/弹窗）置顶前给页面拍照，渲染层据此铺快照，避免隐藏网页后黑屏 */
ipcMain.handle('page-snapshot', async () => {
  if (!pageView || pageView.webContents.isDestroyed()) return null;
  try {
    const img = await pageView.webContents.capturePage();
    return img && img.toDataURL ? img.toDataURL() : null;
  } catch (e) {
    console.log('[小浣熊] 页面快照失败：' + (e && e.message));
    return null;
  }
});
ipcMain.handle('open-external', (_e, url) => {
  if (/^https?:/i.test(String(url || ''))) shell.openExternal(String(url));
  return true;
});
ipcMain.handle('toggle-fullscreen', () => toggleWindowFullscreen());
ipcMain.handle('app-info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  node: process.versions.node,
  platform: process.platform,
  kernel: kernel,
  port: localServer && localServer.address() ? localServer.address().port : 0
}));
ipcMain.handle('quit-app', () => { quitting = true; app.quit(); return true; });

/* ============ 托盘（后台运行） ============ */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    /* 窗口曾被真正销毁：整个重建 */
    if (localServer) {
      createWindow(startUrl);
      createTab('https://www.baidu.com/', true);
    }
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (tray && !tray.isDestroyed()) tray.setToolTip('小浣熊 · 移动内核桌面浏览器');
}

function createTray() {
  const icon = nativeImage.createFromPath(APP_ICON_PATH);
  tray = new Tray(icon);
  tray.setToolTip('小浣熊 · 移动内核桌面浏览器');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示', click: showMainWindow },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

/* ============ 生命周期 ============ */
/* 任务栏/通知里按应用身份分组，避免系统拿 electron.exe 的名字兜底 */
app.setAppUserModelId('com.jorin.xiaohuanxiong');

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(async () => {
    pageSession = session.fromPartition('persist:phone-pages');
    attachWebRequestLogging(pageSession);
    setupHardwarePermissions();
    try { sensorPatchSrc = fs.readFileSync(path.join(ROOT, 'sensor-patch.js'), 'utf8'); } catch (e) { sensorPatchSrc = ''; }
    localServer = await createLocalServer();
    const port = localServer.address().port;
    startUrl = 'http://127.0.0.1:' + port + '/index.html';
    buildMenu();
    createWindow(startUrl);
    createTab('https://www.baidu.com/', true);
    createTray();
  }).catch((err) => {
    console.error('小浣熊启动失败：', err);
    app.quit();
  });
}

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  if (localServer) {
    try { localServer.close(); } catch (e) {}
    localServer = null;
  }
});
