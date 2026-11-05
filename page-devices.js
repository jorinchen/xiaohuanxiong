'use strict';
/* 模拟内核 / 真机参数表（主进程、page-preload、page-inject 共用一份，避免三处参数漂移）

   每个内核有一组可选机型：默认机型 + 悬停内核按钮弹出的机型菜单。
   加机型只需要在 SPECS 里补一项，UA / Client Hints / 屏幕 / DPR 会自动生成。 */

const KERNELS = ['ios', 'android', 'harmony'];

const KERNEL_BASE = {
  ios: { label: 'iOS · WebKit', badge: 'WebKit', osName: 'iOS', platform: 'iOS', gpuVendor: 'Apple Inc.', gpuRenderer: 'Apple GPU' },
  android: { label: 'Android · Blink', badge: 'Blink', osName: 'Android', platform: 'Android', gpuVendor: 'Qualcomm', gpuRenderer: 'Adreno (TM) 750' },
  harmony: { label: '鸿蒙 · ArkWeb', badge: 'ArkWeb', osName: 'HarmonyOS', platform: 'HarmonyOS', gpuVendor: 'Huawei', gpuRenderer: 'Maleoon 910' }
};

/* UA 里的 OS / 浏览器版本必须与机型系统版本自洽：
   写成 iOS 18.6 却带 Version/27.2 会被站点判定为伪造 UA。
   ArkWeb 4.1.6.1 对应 Chromium 114，因此鸿蒙各机型共用这组内核标识，只变 OpenHarmony 版本。 */
function iosUa(v) {
  return 'Mozilla/5.0 (iPhone; CPU iPhone OS ' + String(v).replace(/\./g, '_') +
    ' like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/' + v +
    ' Mobile/15E148 Safari/604.1';
}
function androidUa(v, model, chrome) {
  return 'Mozilla/5.0 (Linux; Android ' + v + '; ' + model +
    ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chrome + '.0.0.0 Mobile Safari/537.36';
}
function harmonyUa(v) {
  return 'Mozilla/5.0 (Phone; OpenHarmony ' + v +
    ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile';
}
function chromeBrands(v, chromeFirst) {
  return chromeFirst
    ? [{ brand: 'Google Chrome', version: v }, { brand: 'Chromium', version: v }, { brand: 'Not A(Brand', version: '99' }]
    : [{ brand: 'Chromium', version: v }, { brand: 'Google Chrome', version: v }, { brand: 'Not A(Brand', version: '99' }];
}
function platformVersion(v) {
  const parts = String(v).split('.');
  while (parts.length < 3) parts.push('0');
  return parts.slice(0, 3).join('.');
}

/* 各内核 / 系统版本对应的精确 UA（覆盖默认生成规则，确保与机型版本自洽）
   key 格式： `${kernel}:${ver}` */
const UA_OVERRIDES = {
  'ios:18.6': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  'ios:19.2': 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.2 Mobile/15E148 Safari/604.1',
  'ios:26.4': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1',
  'ios:27.2': 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1',
  'harmony:5.1': 'Mozilla/5.0 (Phone; OpenHarmony 5.1; HarmonyOS 5.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.2 Mobile',
  'harmony:6.1': 'Mozilla/5.0 (Phone; OpenHarmony 6.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 ArkWeb/6.0.0.60 Mobile',
  'harmony:7.0': 'Mozilla/5.0 (Phone; OpenHarmony 7.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 ArkWeb/6.0.0.120 Mobile',
  'harmony:7.1': 'Mozilla/5.0 (Phone; OpenHarmony 7.1; HarmonyOS 7.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 ArkWeb/6.0.0.150 Mobile'
};

/* 鸿蒙各版本对应的 Chromium 版本（用于 Client Hints brands，与 UA 中的 Chrome 版本自洽） */
const HARMONY_CHROME = { '5.1': '114', '6.1': '132', '7.0': '144', '7.1': '146' };

/* 机型清单：w/h 为逻辑分辨率，dpr 为像素比，os 是菜单里显示的原文 */
const SPECS = {
  ios: [
    { id: 'iphone13pro', name: 'iPhone 13 Pro', w: 390, h: 844, dpr: 3, os: 'ios 18.6', ver: '18.6' },
    { id: 'iphone13promax', name: 'iPhone 13 Pro Max', w: 428, h: 926, dpr: 3, os: 'ios 18.6', ver: '18.6' },
    { id: 'iphone15promax', name: 'iPhone 15 Pro Max', w: 430, h: 932, dpr: 3, os: 'ios 18.6', ver: '18.6' },
    { id: 'iphone16', name: 'iPhone 16', w: 393, h: 852, dpr: 3, os: 'ios 26.4', ver: '26.4' },
    { id: 'iphone18pro', name: 'iPhone 18 Pro', w: 402, h: 874, dpr: 3, os: 'ios 27.2', ver: '27.2' },
    { id: 'iphoneair', name: 'iPhone Air', w: 420, h: 912, dpr: 3, os: 'ios 19.2', ver: '19.2' },
    { id: 'iphone18promax', name: 'iPhone 18 Pro Max', w: 440, h: 956, dpr: 3, os: 'ios 27.2', ver: '27.2' }
  ],
  android: [
    { id: 'galaxys25', name: 'Galaxy S25', w: 412, h: 915, dpr: 3, os: 'Android 14', ver: '14', model: 'SM-S931B', chrome: '146' },
    { id: 'pixel9pro', name: 'Pixel 9 Pro', w: 410, h: 915, dpr: 2.6, os: 'Android 14', ver: '14', model: 'Pixel 9 Pro', chrome: '146' },
    { id: 'pixel11pro', name: 'Pixel 11 Pro', w: 410, h: 915, dpr: 3.1, os: 'Android 17', ver: '17', model: 'Pixel 11 Pro', chrome: '150' },
    { id: 'nexus6', name: 'Nexus 6', w: 412, h: 732, dpr: 3.5, os: 'Android 7', ver: '7', model: 'Nexus 6', chrome: '108' }
  ],
  harmony: [
    { id: 'mate80', name: 'Mate 80', w: 366, h: 809, dpr: 3.5, os: 'HarmonyOS 7.0', ver: '7.0', model: 'MRO-AL00' },
    { id: 'mate70', name: 'Mate 70', w: 374, h: 827, dpr: 3.25, os: 'HarmonyOS 6.1', ver: '6.1', model: 'PLR-AL00' },
    { id: 'mate70pro', name: 'Mate 70 Pro', w: 376, h: 809, dpr: 3.5, os: 'HarmonyOS 6.1', ver: '6.1', model: 'PLR-AL10' },
    { id: 'mate60', name: 'Mate 60', w: 374, h: 862, dpr: 3.25, os: 'HarmonyOS 6.1', ver: '6.1', model: 'BRA-AL00' },
    { id: 'mate60pro', name: 'Mate 60 Pro', w: 388, h: 837, dpr: 3.25, os: 'HarmonyOS 6.1', ver: '6.1', model: 'ALN-AL00' },
    { id: 'pura80pro', name: 'Pura 80 Pro', w: 365, h: 814, dpr: 3.5, os: 'HarmonyOS 7.0', ver: '7.0', model: 'HBN-AL00' },
    { id: 'nova14ultra', name: 'nova 14 Ultra', w: 363, h: 817, dpr: 3.5, os: 'HarmonyOS 6.1', ver: '6.1', model: 'NCO-AL00' },
    { id: 'purax_in', name: 'Pura X内', w: 440, h: 707, dpr: 3, os: 'HarmonyOS 6.1', ver: '6.1', model: 'HMP-AL00' },
    { id: 'purax_out', name: 'Pura X外', w: 327, h: 327, dpr: 3, os: 'HarmonyOS 6.1', ver: '6.1', model: 'HMP-AL00' },
    { id: 'matex6_in', name: 'Mate X6内', w: 717, h: 781, dpr: 3.125, os: 'HarmonyOS 6.1', ver: '6.1', model: 'MXP-AL00' },
    { id: 'matex6', name: 'Mate X6', w: 346, h: 781, dpr: 3.125, os: 'HarmonyOS 7.0', ver: '7.0', model: 'MXP-AL10' },
    { id: 'pura70', name: 'Pura 70', w: 372, h: 818, dpr: 3.375, os: 'HarmonyOS 7.0', ver: '7.0', model: 'HBN-AL00' },
    { id: 'pura70pro', name: 'Pura 70 Pro', w: 373, h: 843, dpr: 3.375, os: 'HarmonyOS 7.0', ver: '7.0', model: 'HBN-AL10' },
    { id: 'matex5_in', name: 'Mate X5内', w: 712, h: 799, dpr: 3.125, os: 'HarmonyOS 6.1', ver: '6.1', model: 'ALT-AL00' },
    { id: 'matex5', name: 'Mate X5', w: 346, h: 801, dpr: 3.125, os: 'HarmonyOS 6.1', ver: '6.1', model: 'ALT-AL10' },
    { id: 'pocket2', name: 'Pocket 2', w: 364, h: 861, dpr: 3.125, os: 'HarmonyOS 6.1', ver: '6.1', model: 'LEM-AL00' },
    { id: 'nova13', name: 'nova 13', w: 361, h: 804, dpr: 3, os: 'HarmonyOS 6.1', ver: '6.1', model: 'FIN-AL00' },
    { id: 'nova13pro', name: 'nova 13 Pro', w: 363, h: 823, dpr: 3.375, os: 'HarmonyOS 6.1', ver: '6.1', model: 'FIN-AL10' },
    { id: 'nova12', name: 'nova 12', w: 361, h: 804, dpr: 3, os: 'HarmonyOS 5.1', ver: '5.1', model: 'ADA-AL00' },
    { id: 'nova12pro', name: 'nova 12 Pro', w: 363, h: 823, dpr: 3.375, os: 'HarmonyOS 6.1', ver: '6.1', model: 'ADA-AL10' },
    { id: 'puraxmax_out', name: 'Pura X Max外', w: 460, h: 672, dpr: 2.75, os: 'HarmonyOS 7.1', ver: '7.1', model: 'HMP-AL00' },
    { id: 'puraxmax_in', name: 'Pura X Max内', w: 940, h: 665, dpr: 2.75, os: 'HarmonyOS 7.1', ver: '7.1', model: 'HMP-AL00' },
    { id: 'pura90pro', name: 'Pura 90 Pro', w: 459, h: 939, dpr: 2.875, os: 'HarmonyOS 6.1', ver: '6.1', model: 'HBN-AL00' },
    { id: 'mate90', name: 'Mate 90', w: 445, h: 985, dpr: 2.875, os: 'HarmonyOS 7.0', ver: '7.0', model: 'MRT-AL00' }
  ]
};

/* 三个内核的默认机型 */
const DEFAULT_DEVICE = { ios: 'iphone18pro', android: 'galaxys25', harmony: 'nova12pro' };

function buildDevice(kernel, s) {
  const base = KERNEL_BASE[kernel];
  const isIOS = kernel === 'ios';
  const isAndroid = kernel === 'android';
  const chrome = isAndroid ? (s.chrome || '146') : (isIOS ? '114' : (HARMONY_CHROME[s.ver] || '114'));
  const model = s.model || (isIOS ? 'iPhone' : s.name);
  return {
    id: s.id,
    kernel: kernel,
    name: s.name,
    label: base.label,
    badge: base.badge,
    os: s.os,
    osVersion: s.ver,
    osLabel: s.name + ' · ' + base.osName + ' ' + s.ver + ' · ' + base.badge + ' 模拟内核',
    meta: '(' + s.w + 'x' + s.h + '|Dpr:' + s.dpr + '|' + s.os + ')',
    menuText: s.name + ' (' + s.w + 'x' + s.h + '|Dpr:' + s.dpr + '|' + s.os + ')',
    screenW: s.w, screenH: s.h, dpr: s.dpr,
    ua: UA_OVERRIDES[kernel + ':' + s.ver] ||
        (isIOS ? iosUa(s.ver) : (isAndroid ? androidUa(s.ver, model, chrome) : harmonyUa(s.ver))),
    platform: base.platform,
    platformVersion: platformVersion(s.ver),
    model: model,
    arch: 'arm', bitness: '64',
    gpuVendor: base.gpuVendor, gpuRenderer: base.gpuRenderer,
    brands: isIOS ? [] : chromeBrands(chrome, isAndroid)
  };
}

const DEVICE_PRESETS = {};
KERNELS.forEach((k) => { DEVICE_PRESETS[k] = SPECS[k].map((s) => buildDevice(k, s)); });

/* 兼容旧代码：DEVICES[内核] / UAS[内核] / DEVICE_W[内核] 都取该内核的默认机型 */
const DEVICES = {};
const UAS = {};
const DEVICE_W = {};
KERNELS.forEach((k) => {
  DEVICES[k] = presetFor(k);
  UAS[k] = DEVICES[k].ua;
  DEVICE_W[k] = DEVICES[k].screenW;
});

/* 容错：未知内核 / 未知机型一律退回该内核的默认机型 */
function presetFor(kernel, deviceId) {
  const k = KERNELS.indexOf(kernel) >= 0 ? kernel : 'ios';
  const list = DEVICE_PRESETS[k];
  if (deviceId) {
    const hit = list.find((d) => d.id === deviceId);
    if (hit) return hit;
  }
  return list.find((d) => d.id === DEFAULT_DEVICE[k]) || list[0];
}

module.exports = { UAS, DEVICES, DEVICE_W, KERNELS, DEVICE_PRESETS, DEFAULT_DEVICE, presetFor };
