/* 硬件传感器模拟：在页面主世界执行，劫持 deviceorientation / devicemotion 事件，
   按 window.__simSensorCfg 派发模拟数据（still=平放微动 / shake=摇一摇 / custom=固定角度）。
   同时补上 iOS 13+ 的 requestPermission（直接返回 granted）。 */
(function () {
  if (window.__simSensor) return 'ok';
  window.__simSensor = true;
  window.__simSensorCfg = window.__simSensorCfg || { mode: 'still', alpha: 0, beta: 0, gamma: 0 };

  var oHandlers = [], mHandlers = [], oProps = [], mProps = [];
  var origWinAdd = window.addEventListener.bind(window);
  var origWinRm = window.removeEventListener.bind(window);
  var origDocAdd = document.addEventListener.bind(document);

  window.addEventListener = function (t, fn, opt) {
    if (t === 'deviceorientation') {
      if (typeof fn === 'function' && oHandlers.indexOf(fn) < 0) oHandlers.push(fn);
      return;
    }
    if (t === 'devicemotion') {
      if (typeof fn === 'function' && mHandlers.indexOf(fn) < 0) mHandlers.push(fn);
      return;
    }
    return origWinAdd(t, fn, opt);
  };
  document.addEventListener = function (t, fn, opt) {
    if (t === 'deviceorientation' || t === 'devicemotion') {
      var bucket = t === 'deviceorientation' ? oHandlers : mHandlers;
      if (typeof fn === 'function' && bucket.indexOf(fn) < 0) bucket.push(fn);
      return;
    }
    return origDocAdd(t, fn, opt);
  };
  window.removeEventListener = function (t, fn) {
    var bucket = t === 'deviceorientation' ? oHandlers : (t === 'devicemotion' ? mHandlers : null);
    if (bucket) {
      var i = bucket.indexOf(fn);
      if (i >= 0) bucket.splice(i, 1);
      return;
    }
    return origWinRm(t, fn);
  };
  try {
    Object.defineProperty(window, 'ondeviceorientation', {
      configurable: true,
      set: function (fn) { if (typeof fn === 'function' && oProps.indexOf(fn) < 0) oProps.push(fn); },
      get: function () { return oProps[0] || null; }
    });
    Object.defineProperty(window, 'ondevicemotion', {
      configurable: true,
      set: function (fn) { if (typeof fn === 'function' && mProps.indexOf(fn) < 0) mProps.push(fn); },
      get: function () { return mProps[0] || null; }
    });
  } catch (e) {}

  try {
    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission !== 'function') {
      DeviceOrientationEvent.requestPermission = function () { return Promise.resolve('granted'); };
    }
  } catch (e) {}
  try {
    if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission !== 'function') {
      DeviceMotionEvent.requestPermission = function () { return Promise.resolve('granted'); };
    }
  } catch (e) {}

  function fire() {
    var cfg = window.__simSensorCfg || { mode: 'still', alpha: 0, beta: 0, gamma: 0 };
    var t = Date.now() / 1000;
    var alpha, beta, gamma, acc, lin, rot;
    if (cfg.mode === 'shake') {
      alpha = (t * 720) % 360;
      beta = Math.sin(t * 18) * 40;
      gamma = Math.cos(t * 21) * 40;
      lin = { x: (Math.random() - 0.5) * 24, y: (Math.random() - 0.5) * 24, z: (Math.random() - 0.5) * 16 };
      acc = { x: lin.x, y: lin.y, z: 9.8 + lin.z };
      rot = { alpha: (Math.random() - 0.5) * 600, beta: (Math.random() - 0.5) * 600, gamma: (Math.random() - 0.5) * 600 };
    } else if (cfg.mode === 'custom') {
      alpha = Number(cfg.alpha) || 0;
      beta = Number(cfg.beta) || 0;
      gamma = Number(cfg.gamma) || 0;
      lin = { x: 0, y: 0, z: 0 };
      acc = { x: 0, y: 0, z: 9.8 };
      rot = { alpha: 0, beta: 0, gamma: 0 };
    } else {
      alpha = (t * 4) % 360;
      beta = Math.sin(t * 0.8) * 2.5;
      gamma = Math.cos(t * 0.7) * 2.5;
      lin = { x: 0, y: 0, z: 0 };
      acc = { x: 0, y: 0, z: 9.8 };
      rot = { alpha: 0, beta: 0, gamma: 0 };
    }
    var oe = null, me = null;
    try {
      oe = new DeviceOrientationEvent('deviceorientation', { alpha: alpha, beta: beta, gamma: gamma, absolute: false });
    } catch (e) { return; }
    try {
      me = new DeviceMotionEvent('devicemotion', {
        acceleration: lin,
        accelerationIncludingGravity: acc,
        rotationRate: rot,
        interval: 0.0625
      });
    } catch (e2) { return; }
    var i;
    for (i = 0; i < oHandlers.length; i++) { try { oHandlers[i].call(window, oe); } catch (e) {} }
    for (i = 0; i < oProps.length; i++) { try { oProps[i].call(window, oe); } catch (e) {} }
    for (i = 0; i < mHandlers.length; i++) { try { mHandlers[i].call(window, me); } catch (e) {} }
    for (i = 0; i < mProps.length; i++) { try { mProps[i].call(window, me); } catch (e) {} }
  }

  setInterval(fire, 60);
  setTimeout(fire, 30);

  /* Network Information API 兜底：桌面 Chromium 未启用 navigator.connection 时提供模拟值 */
  try {
    var netTypes = { wifi: 'wifi', '4g': '4g', '3g': '3g', offline: 'none' };
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      get: function () {
        var net = (window.__simNetCfg || {}).net || 'wifi';
        return {
          effectiveType: netTypes[net] || 'wifi',
          downlink: net === 'wifi' ? 10 : (net === '4g' ? 12 : 0.75),
          rtt: net === 'wifi' ? 50 : (net === '4g' ? 60 : 300),
          saveData: false,
          onchange: null,
          addEventListener: function () {}, removeEventListener: function () {}, dispatchEvent: function () { return false; }
        };
      }
    });
  } catch (e) {}
  return 'ok';
})()
