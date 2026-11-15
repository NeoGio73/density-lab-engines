/*
 * Density lab: measuring script                                                measure/measure.js
 *
 * Any of the three builds (Unity, three.js, Unreal) can load this file from its page, as the
 * first script in <head>:   <script src="measure.js"></script>
 * It does nothing unless the page address asks for it:
 *
 *   index.html?measure              results panel; runs are started with its buttons
 *   index.html?measure=auto         also plays the benchmark by itself once the lab is usable
 *   &label=unity-rebuild-mac        a name for the build, carried into the results
 *   &code=G9G9S                     (the page's own option) the same unknown for every build
 *   &targets=x,y;x,y;...            only if a build's bench view differs: the eight points the
 *                                   benchmark uses (see TARGETS below), as fractions of the 3D view
 *
 * What it measures
 *   Download size   every file the page fetched, read from the browser's Resource Timing record:
 *                   bytes over the network (headers included), compressed bodies, unpacked bodies.
 *                   This file itself is left out.
 *   Time to usable  from opening the address until the lab reports "configured" (the five pieces
 *                   are on the tray and can be dragged). Engine "ready", the arrival of the last
 *                   file and the end of the opening camera move are recorded as well.
 *   Frame times     the interval between every pair of animation frames over a 60 s run; median,
 *                   95th and 99th percentiles (nearest rank), worst frame, frames per second.
 *   Graphics        the context the lab drew with (webgl2 or webgpu), whether this browser can
 *                   give WebGPU (an adapter is actually requested), and the WebGL renderer.
 *
 * The benchmark plays the lab steps on a fixed 60 s timetable with the inputs a student uses:
 * pointer drags on the 3D view (synthetic pointer and mouse events on the canvas) and the page's
 * own view and reset buttons. Every build gets the same inputs at the same moments. Afterwards
 * each step is checked against the messages the build sent back (pan, added, arrived, reset).
 *
 * The script changes nothing in the page or the build. It listens to the messages they already
 * exchange: window.DensityLab.onUnityEvent (build to page) and the instance's SendMessage (page to
 * build). It knows nothing about any unknown: no metals, densities or code rule.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  if (!params.has('measure') || window.DensityLabMeasure) return;

  var VERSION = '1.0 (2026-11-15)';
  var AUTO = params.get('measure') === 'auto';
  var LABEL = params.get('label') || '';
  var RUN_MS = 60000;
  var SCRIPT_URL = document.currentScript ? document.currentScript.src : '';
  var LATE = document.readyState !== 'loading' || !!window.DensityLab;   // loaded after the page began

  // Where the benchmark presses and lets go, as fractions of the 3D view's width and height in the
  // Bench view (the view keeps a 3:2 shape on every screen). Measured on the published Unity lab on
  // 2026-11-15 by moving the pointer across the tray and reading the build's "hover" messages.
  var TARGETS = {
    slots: [[0.422, 0.72], [0.482, 0.71], [0.548, 0.70], [0.611, 0.70], [0.674, 0.69]],
    pan: [0.205, 0.58],        // let go here to put a piece on the balance pan
    panPick: [0.205, 0.56],    // a piece standing on the pan is looked for around here
    cylinder: [0.871, 0.25],   // let go here, over the mouth of the cylinder
    rest: [0.30, 0.22]         // an empty patch of wall where the pointer waits
  };

  function now() { return performance.now(); }
  function $(id) { return document.getElementById(id); }
  function round(v, places) { var f = Math.pow(10, places); return Math.round(v * f) / f; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function frame() { return new Promise(function (r) { requestAnimationFrame(r); }); }
  async function frames(n) { for (var i = 0; i < n; i++) await frame(); }

  try { performance.setResourceTimingBufferSize(2000); } catch (e) { /* older browsers */ }

  var notes = [];             // plain-language remarks carried into the results

  // A page that is hidden (another tab in front, a minimised window) is slowed down by the browser,
  // so start-up times taken while hidden are not valid. Note whether that happened.
  var hiddenWhileLoading = document.hidden;
  function noteHidden() { if (document.hidden && !usableNow()) hiddenWhileLoading = true; }
  document.addEventListener('visibilitychange', noteHidden);

  // The display's refresh rate, as the browser offers it to the page, read from the frame clock
  // in the first second, before the engine starts drawing. It is read again at rest before each
  // run, and the shorter of the two is taken (the frame clock can run slower than the display,
  // never faster).
  var earlyStamps = [];
  if (!LATE) {
    requestAnimationFrame(function early(t) {
      earlyStamps.push(t);
      if (earlyStamps.length < 241 && t - earlyStamps[0] < 1000) requestAnimationFrame(early);
    });
  }

  // ---- Messages between page and build -----------------------------------------------------------

  var marks = {};             // name -> ms since the address was opened
  var log = [];               // { t, dir: 'in' | 'out', type, ... }
  var hoverCount = 0;
  var listeners = [];
  var hovered = 0;            // the piece the build last said is under the pointer

  function mark(name, t) { if (marks[name] == null) marks[name] = round(t == null ? now() : t, 1); }

  function fromBuild(json) {
    var t = now(), e;
    try { e = typeof json === 'string' ? JSON.parse(json) : json; } catch (err) { return; }
    if (!e || !e.type) return;
    if (e.type === 'hover') { hovered = e.piece || 0; hoverCount += 1; }
    else if (log.length < 3000) {
      var entry = { t: round(t, 1), dir: 'in', type: e.type };
      ['piece', 'view', 'order', 'pieces', 'id'].forEach(function (k) { if (e[k] !== undefined) entry[k] = e[k]; });
      log.push(entry);
    }
    if (e.type === 'ready') mark('ready', t);
    if (e.type === 'configured') mark('configured', t);
    if (e.type === 'arrived' && e.view === 'bench' && marks.configured != null) mark('openingDone', t);
    listeners.slice().forEach(function (fn) { try { fn(e, t); } catch (err) { /* keep going */ } });
  }

  function wrapInstance(instance) {
    if (!instance || typeof instance.SendMessage !== 'function' || instance.__dlmWrapped) return;
    var send = instance.SendMessage;
    instance.SendMessage = function (target, method, value) {
      if (log.length < 3000) {
        var entry = { t: round(now(), 1), dir: 'out', type: String(method) };
        if (method === 'SetView') entry.view = String(value);
        log.push(entry);
      }
      if (method === 'Configure') mark('configureSent');
      return send.apply(this, arguments);
    };
    instance.__dlmWrapped = true;
  }

  function hookLab(lab) {
    if (!lab || lab.__dlmHooked) return;
    try {
      Object.defineProperty(lab, '__dlmHooked', { value: true });
      var onEvent = lab.onUnityEvent;
      if (typeof onEvent === 'function') {
        lab.onUnityEvent = function (json) {
          try { fromBuild(json); } catch (e) { /* never get in the lab's way */ }
          return onEvent.apply(this, arguments);
        };
      }
      var attach = lab.attachUnity;
      if (typeof attach === 'function') {
        lab.attachUnity = function (instance) {
          mark('attached');
          try { wrapInstance(instance); } catch (e) { /* as above */ }
          return attach.apply(this, arguments);
        };
      }
    } catch (e) {
      notes.push('Could not listen to the lab\'s messages: ' + e.message);
    }
  }

  // app.js creates window.DensityLab. If this script runs first, catch that moment; otherwise
  // hook the object that is already there (fine as long as the build has not started yet).
  if (window.DensityLab) {
    hookLab(window.DensityLab);
  } else {
    try {
      Object.defineProperty(window, 'DensityLab', {
        configurable: true, enumerable: true,
        get: function () { return undefined; },
        set: function (value) {
          Object.defineProperty(window, 'DensityLab', { value: value, writable: true, configurable: true, enumerable: true });
          hookLab(value);
        }
      });
    } catch (e) { notes.push('Could not wait for the page script: ' + e.message); }
  }

  // ---- Which graphics context the lab draws with ----------------------------------------------------

  var contexts = [];
  var probing = false;        // true while this script makes its own test contexts
  var getContext = HTMLCanvasElement.prototype.getContext;

  function isLabCanvas(c) { return c.id === 'unity-canvas' || !!(c.closest && c.closest('#stage')); }

  HTMLCanvasElement.prototype.getContext = function (type) {
    var ctx = getContext.apply(this, arguments);
    if (ctx && !probing && /webgl|webgpu/i.test(String(type))) {
      var canvas = this;
      var seen = contexts.some(function (c) { return c.canvas === canvas && c.type === String(type); });
      if (!seen) {
        var entry = { canvas: canvas, canvasId: canvas.id || '', type: String(type), t: round(now(), 1) };
        try {
          if (ctx.getContextAttributes) {
            var a = ctx.getContextAttributes();
            if (a) { entry.antialias = !!a.antialias; entry.alpha = !!a.alpha; }
          }
        } catch (e) { /* not every context answers */ }
        contexts.push(entry);
        if (isLabCanvas(canvas)) mark('context', entry.t);
      }
    }
    return ctx;
  };

  // ---- The cover over the 3D view (a second sign that the lab is usable) -----------------------------

  function watchCover() {
    var cover = $('stage-cover');
    if (!cover) return;
    if (cover.hidden) { if (!LATE) mark('coverLifted'); return; }
    var mo = new MutationObserver(function () {
      if (cover.hidden) { mark('coverLifted'); mo.disconnect(); }
    });
    mo.observe(cover, { attributes: true, attributeFilter: ['hidden'] });
  }

  function usableAt() { return marks.configured != null ? marks.configured : marks.coverLifted; }
  function usableNow() { var c = $('stage-cover'); return usableAt() != null || (!!c && c.hidden); }

  function waitFor(test, ms) {
    return new Promise(function (resolve) {
      var timer = null;
      function fn(e, t) {
        if (!test(e)) return;
        listeners.splice(listeners.indexOf(fn), 1);
        clearTimeout(timer);
        resolve({ event: e, t: t });
      }
      listeners.push(fn);
      timer = setTimeout(function () { listeners.splice(listeners.indexOf(fn), 1); resolve(null); }, ms);
    });
  }

  async function whenUsable(limitMs) {
    var t0 = now();
    while (!usableNow()) {
      if (limitMs && now() - t0 > limitMs) return false;
      await sleep(100);
    }
    return true;
  }

  async function whenOpeningDone(limitMs) {
    var lab = window.DensityLab;
    if (marks.openingDone != null || (lab && lab.view === 'bench' && lab.viewSettled)) return;
    await waitFor(function (e) { return e.type === 'arrived' && e.view === 'bench'; }, limitMs);
  }

  // ---- Download size --------------------------------------------------------------------------

  function shortName(url) {
    var parts = url.pathname.split('/').filter(Boolean);
    var name = parts.slice(-2).join('/') || url.host;
    return url.origin === location.origin ? name : url.host + ' ' + name;
  }

  function fileOf(e) {
    var url = new URL(e.name, location.href);
    var cross = url.origin !== location.origin;
    var f = {
      name: shortName(url),
      kind: e.initiatorType || 'page',
      transfer: e.transferSize || 0,
      encoded: e.encodedBodySize || 0,
      decoded: e.decodedBodySize || 0,
      start: round(e.startTime, 1),
      end: round(e.responseEnd, 1)
    };
    if (e.responseStatus) f.status = e.responseStatus;
    // A real download carries the body plus a few hundred bytes of headers. Less than the body
    // means only headers crossed the network (a 304 "not modified" answer) and the body came
    // from the cache.
    if (f.transfer === 0 && f.encoded > 0) f.source = 'cache';
    else if (f.transfer === 0 && f.encoded === 0 && cross) f.source = 'hidden';
    else if (f.transfer > 0 && f.transfer < f.encoded) f.source = 'revalidated';
    else if (f.transfer > 0 && f.encoded === 0 && (e.responseStatus === 304 || f.decoded === 0)) f.source = 'revalidated';
    else f.source = 'network';
    return f;
  }

  function allFiles() {
    var list = [];
    var nav = performance.getEntriesByType('navigation')[0];
    if (nav) { var page = fileOf(nav); page.kind = 'page'; list.push(page); }
    performance.getEntriesByType('resource').forEach(function (e) {
      if (/^(data|blob|about):/.test(e.name)) return;
      if ((SCRIPT_URL && e.name === SCRIPT_URL) || /\/measure\.js(\?|#|$)/.test(e.name)) return;
      list.push(fileOf(e));
    });
    return list;
  }

  function totals(list) {
    var t = { files: list.length, transfer: 0, encoded: 0, decoded: 0 };
    list.forEach(function (f) { t.transfer += f.transfer; t.encoded += f.encoded; t.decoded += f.decoded; });
    return t;
  }

  function download() {
    var list = allFiles();
    var usable = usableAt();
    var before = usable == null ? list : list.filter(function (f) { return f.end <= usable; });
    var sources = { network: 0, cache: 0, revalidated: 0, hidden: 0 };
    list.forEach(function (f) { sources[f.source] += 1; });
    var last = 0;
    before.forEach(function (f) { if (f.end > last) last = f.end; });
    if (usable != null && before.length) mark('lastFile', last);
    return {
      total: totals(list),
      beforeUsable: totals(before),
      sources: sources,
      files: list
    };
  }

  // ---- Device and graphics --------------------------------------------------------------------

  var device = null, graphics = null, staticDone = false;

  function browserName() {
    var ua = navigator.userAgent, m;
    if ((m = ua.match(/Edg\/([\d.]+)/))) return 'Edge ' + m[1];
    if ((m = ua.match(/Firefox\/([\d.]+)/))) return 'Firefox ' + m[1];
    if ((m = ua.match(/(?:Chrome|CriOS)\/([\d.]+)/))) return 'Chrome ' + m[1];
    if ((m = ua.match(/Version\/([\d.]+).*Safari/))) return 'Safari ' + m[1];
    return 'unknown browser';
  }

  function systemName() {
    var ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/Android/.test(ua)) return 'Android';
    if (/Windows/.test(ua)) return 'Windows';
    if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
    if (/CrOS/.test(ua)) return 'ChromeOS';
    if (/Linux/.test(ua)) return 'Linux';
    return 'unknown system';
  }

  async function deviceInfo() {
    var canvas = labCanvas();
    var d = {
      system: systemName(),
      browser: browserName(),
      userAgent: navigator.userAgent,
      cpuThreads: navigator.hardwareConcurrency || null,
      memoryGB: navigator.deviceMemory || null,
      screen: screen.width + ' x ' + screen.height,
      pixelRatio: window.devicePixelRatio,
      window: window.innerWidth + ' x ' + window.innerHeight,
      touchPoints: navigator.maxTouchPoints || 0,
      reducedMotion: !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
      secureContext: window.isSecureContext
    };
    if (canvas) {
      var r = canvas.getBoundingClientRect();
      d.view3D = Math.round(r.width) + ' x ' + Math.round(r.height) + ' on the page, ' + canvas.width + ' x ' + canvas.height + ' pixels drawn';
    }
    if (navigator.userAgentData) {
      d.mobile = navigator.userAgentData.mobile;
      try {
        var h = await navigator.userAgentData.getHighEntropyValues(['platform', 'platformVersion', 'architecture', 'model', 'fullVersionList']);
        d.platform = h.platform + ' ' + (h.platformVersion || '');
        if (h.architecture) d.architecture = h.architecture;
        if (h.model) d.model = h.model;
        if (h.fullVersionList) d.brands = h.fullVersionList.map(function (b) { return b.brand + ' ' + b.version; }).join(', ');
      } catch (e) { /* not offered */ }
    }
    if (navigator.connection) {
      var c = navigator.connection;
      d.network = { type: c.effectiveType || null, downlinkMbps: c.downlink == null ? null : c.downlink, roundTripMs: c.rtt == null ? null : c.rtt };
    }
    return d;
  }

  function labContexts() {
    return contexts.map(function (c) {
      return { canvas: c.canvasId || '(no id)', lab: isLabCanvas(c.canvas), type: c.type, at: c.t, antialias: c.antialias };
    });
  }

  function labApi() {
    var lab = contexts.filter(function (c) { return isLabCanvas(c.canvas); });
    if (!lab.length) return null;
    var types = lab.map(function (c) { return c.type; });
    if (types.indexOf('webgpu') >= 0) return 'WebGPU';
    if (types.indexOf('webgl2') >= 0) return 'WebGL 2';
    return 'WebGL 1';
  }

  async function graphicsInfo() {
    var g = { webgl2: null, webgpu: null };
    probing = true;
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl2');
      if (gl) {
        var ext = gl.getExtension('WEBGL_debug_renderer_info');
        g.webgl2 = {
          available: true,
          renderer: String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
          vendor: String(ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
          maxSamples: gl.getParameter(gl.MAX_SAMPLES)
        };
        var lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      } else {
        g.webgl2 = { available: false };
      }
    } catch (e) {
      g.webgl2 = { available: false, error: String(e && e.message || e) };
    }
    probing = false;

    var w = { secureContext: window.isSecureContext, api: !!navigator.gpu };
    if (navigator.gpu) {
      try {
        var adapter = await Promise.race([navigator.gpu.requestAdapter(), sleep(5000).then(function () { return 'timeout'; })]);
        if (adapter === 'timeout') {
          w.adapter = false; w.error = 'no answer within 5 s';
        } else if (adapter) {
          w.adapter = true;
          var info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
          if (info) {
            w.vendor = info.vendor || ''; w.architecture = info.architecture || '';
            if (info.description) w.description = info.description;
          }
          w.fallbackAdapter = !!(adapter.isFallbackAdapter || (info && info.isFallbackAdapter));
          w.features = adapter.features ? adapter.features.size : null;
        } else {
          w.adapter = false;
        }
      } catch (e) {
        w.adapter = false; w.error = String(e && e.message || e);
      }
    }
    w.supported = !!w.adapter && !w.fallbackAdapter;
    if (!w.secureContext) w.reason = 'the page is not on https:// or localhost, where browsers keep WebGPU switched off';
    else if (!w.api) w.reason = 'this browser offers no WebGPU';
    else if (!w.adapter) w.reason = 'the browser offers WebGPU but gave no adapter for this device' + (w.error ? ' (' + w.error + ')' : '');
    else if (w.fallbackAdapter) w.reason = 'only a software (fallback) adapter';
    g.webgpu = w;
    return g;
  }

  async function collectStatic() {
    if (staticDone) return;
    staticDone = true;
    device = await deviceInfo();
    graphics = await graphicsInfo();
    render();
  }

  function engineName() {
    if (params.get('engine')) return params.get('engine');
    if (typeof window.createUnityInstance === 'function') return 'Unity';
    if (window.__THREE__) return 'three.js r' + window.__THREE__;
    return 'not detected';
  }

  // ---- Synthetic pointer input ----------------------------------------------------------------

  var pointerDown = false, lastPoint = TARGETS.rest, aborted = false;

  (function readTargets() {
    var text = params.get('targets');
    if (!text) return;
    var pairs = text.split(';').map(function (p) { return p.split(',').map(Number); });
    var ok = pairs.length === 8 && pairs.every(function (p) { return p.length === 2 && p.every(function (v) { return v >= 0 && v <= 1; }); });
    if (!ok) { notes.push('The "targets" in the address were not eight x,y pairs between 0 and 1; the standard ones were used.'); return; }
    TARGETS = { slots: pairs.slice(0, 5), pan: pairs[5], panPick: pairs[6], cylinder: pairs[7], rest: TARGETS.rest };
    notes.push('Benchmark targets taken from the address.');
  })();

  function labCanvas() {
    return $('unity-canvas') || document.querySelector('#stage canvas') || document.querySelector('canvas');
  }

  var MOUSE_OF = { pointerdown: 'mousedown', pointermove: 'mousemove', pointerup: 'mouseup' };

  function fire(type, point, buttons) {
    var canvas = labCanvas();
    if (!canvas) return;
    var r = canvas.getBoundingClientRect();
    var x = r.left + point[0] * r.width, y = r.top + point[1] * r.height;
    var base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x + (window.screenX || 0), screenY: y + (window.screenY || 0),
      button: 0, buttons: buttons
    };
    canvas.dispatchEvent(new PointerEvent(type, Object.assign({
      pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: buttons ? 0.5 : 0
    }, base)));
    canvas.dispatchEvent(new MouseEvent(MOUSE_OF[type], base));
    lastPoint = point;
    if (type === 'pointerdown') pointerDown = true;
    if (type === 'pointerup') pointerDown = false;
  }

  // Look for a piece around the expected spot, using the build's own "hover" messages.
  var SEARCH = [[0, 0], [0, -0.02], [0, 0.02], [0, -0.04], [-0.015, 0], [0.015, 0], [0, -0.06], [-0.015, -0.03], [0.015, -0.03], [0, -0.08]];

  async function findPiece(piece, guess) {
    for (var i = 0; i < SEARCH.length; i++) {
      if (aborted) break;
      var p = [guess[0] + SEARCH[i][0], guess[1] + SEARCH[i][1]];
      fire('pointermove', p, 0);
      await frames(3);
      if (hovered === piece) return { point: p, tries: i + 1 };
    }
    return { point: guess, tries: SEARCH.length, missed: true };
  }

  function ease(f) { return f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2; }

  async function drag(from, to, ms) {
    fire('pointerdown', from, 1);
    await frames(2);
    var t0 = now();
    for (;;) {
      if (aborted) break;
      var f = Math.min(1, (now() - t0) / ms), e = ease(f);
      fire('pointermove', [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e], 1);
      await frame();
      if (f >= 1) break;
    }
    await frames(2);
    fire('pointerup', aborted ? lastPoint : to, 0);
    await frame();
    fire('pointermove', TARGETS.rest, 0);
  }

  function clickView(view) {
    var b = document.querySelector('.view-button[data-view="' + view + '"]');
    if (b) b.click();
    return !!b;
  }

  async function clickReset() {
    var open = $('reset-bench'), yes = $('reset-yes');
    if (!open || !yes) return false;
    open.click();
    await frame();
    yes.click();
    return true;
  }

  // ---- The benchmark timetable (seconds from the start of the 60 s run) --------------------------

  function timetable() {
    var steps = [];
    function piece(at, n) {
      steps.push({ at: at, kind: 'pan', piece: n, what: 'piece ' + n + ' onto the balance' });
      steps.push({ at: at + 2.2, kind: 'cylinder', piece: n, what: 'piece ' + n + ' into the cylinder' });
    }
    [0, 6, 12, 18, 24].forEach(function (at, i) { piece(at, i + 1); });
    steps.push({ at: 30, kind: 'view', view: 'cylinder', what: 'view: cylinder close-up' });
    steps.push({ at: 33, kind: 'view', view: 'hood', what: 'view: fume hood' });
    steps.push({ at: 36.5, kind: 'view', view: 'balance', what: 'view: balance' });
    steps.push({ at: 39, kind: 'view', view: 'bench', what: 'view: bench' });
    steps.push({ at: 40.5, kind: 'reset', what: 'reset bench' });
    [42, 48, 54].forEach(function (at, i) { piece(at, i + 1); });
    return steps;
  }

  async function doStep(step) {
    if (step.kind === 'pan' || step.kind === 'cylinder') {
      var near = step.kind === 'pan' ? TARGETS.slots[step.piece - 1] : TARGETS.panPick;
      var to = step.kind === 'pan' ? TARGETS.pan : TARGETS.cylinder;
      var found = await findPiece(step.piece, near);
      step.searches = found.tries;
      if (found.missed) step.problem = 'the piece was not found under the pointer';
      step.pressedAt = round(now(), 1);
      await drag(found.point, to, step.kind === 'pan' ? 700 : 800);
      step.releasedAt = round(now(), 1);
    } else if (step.kind === 'view') {
      if (!clickView(step.view)) step.problem = 'no view button on the page';
    } else if (step.kind === 'reset') {
      if (!(await clickReset())) step.problem = 'no reset button on the page';
    }
  }

  // After the run: did the build answer each step as a student would see it?
  function confirmSteps(steps) {
    steps.forEach(function (step, i) {
      if (step.startedAt == null) { step.ok = false; step.problem = step.problem || 'not reached in 60 s'; return; }
      var from = step.startedAt;
      var next = steps[i + 1] && steps[i + 1].startedAt != null ? steps[i + 1].startedAt : from + 6000;
      var until = Math.max(next, from + 2500);
      var seen = log.filter(function (e) { return e.dir === 'in' && e.t >= from && e.t <= until; });
      var hit = null;
      if (step.kind === 'pan') hit = seen.filter(function (e) { return e.type === 'pan' && (e.pieces || []).indexOf(step.piece) >= 0; })[0];
      if (step.kind === 'cylinder') {
        hit = seen.filter(function (e) { return e.type === 'added' && e.piece === step.piece; })[0];
        var blocked = seen.filter(function (e) { return e.type === 'blocked' && e.piece === step.piece; })[0];
        if (!hit && blocked) step.problem = 'the build refused it (not weighed)';
      }
      if (step.kind === 'view') hit = seen.filter(function (e) { return e.type === 'arrived' && e.view === step.view; })[0];
      if (step.kind === 'reset') hit = seen.filter(function (e) { return e.type === 'reset'; })[0];
      step.ok = !!hit;
      if (hit) step.answeredAfterMs = round(hit.t - (step.releasedAt || from), 0);
      else if (!step.problem) step.problem = 'no answer from the build';
    });
  }

  // ---- Frame recording ------------------------------------------------------------------------

  function recordFrames(ms, onStart) {
    return new Promise(function (resolve) {
      var stamps = [];
      var hidden = document.hidden;
      function seen() { if (document.hidden) hidden = true; }
      document.addEventListener('visibilitychange', seen);
      requestAnimationFrame(function first(t0) {
        stamps.push(t0);
        if (onStart) onStart(t0);
        requestAnimationFrame(function tick(t) {
          stamps.push(t);
          if (t - t0 >= ms) {
            document.removeEventListener('visibilitychange', seen);
            resolve({ start: t0, stamps: stamps, hidden: hidden || document.hidden });
          } else {
            requestAnimationFrame(tick);
          }
        });
      });
    });
  }

  // The steady pace of a stretch of frames: the mean of the intervals within 25 % of their
  // median. Averaging keeps the precision where a browser rounds its clock to whole milliseconds
  // (a 120 Hz display then shows 8 and 9 ms frames).
  function paceOf(stamps) {
    var d = [];
    for (var i = 1; i < stamps.length; i++) d.push(stamps[i] - stamps[i - 1]);
    if (d.length < 10) return null;
    var s = d.slice().sort(function (a, b) { return a - b; });
    var m = s[Math.floor(s.length / 2)];
    var band = d.filter(function (v) { return Math.abs(v - m) <= 0.25 * m; });
    return band.reduce(function (a, b) { return a + b; }, 0) / band.length;
  }

  function refreshEstimate(restingMs) {
    var early = paceOf(earlyStamps);
    var found = [early, restingMs].filter(function (v) { return v > 0; });
    if (!found.length) return null;
    var interval = Math.min.apply(null, found);
    return {
      intervalMs: round(interval, 2),
      hz: round(1000 / interval, 1),
      beforeEngineMs: early == null ? null : round(early, 2),
      atRestMs: restingMs == null ? null : round(restingMs, 2)
    };
  }

  function frameStats(stamps, refresh) {
    var d = [];
    for (var i = 1; i < stamps.length; i++) d.push(stamps[i] - stamps[i - 1]);
    var n = d.length;
    if (!n) return null;
    var s = d.slice().sort(function (a, b) { return a - b; });
    var sum = d.reduce(function (a, b) { return a + b; }, 0);
    function rank(p) { return s[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))]; }
    var out = {
      frames: n,
      seconds: round(sum / 1000, 3),
      medianMs: round(n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2, 2),
      p95Ms: round(rank(0.95), 2),
      p99Ms: round(rank(0.99), 2),
      worstMs: round(s[n - 1], 2),
      bestMs: round(s[0], 2),
      meanMs: round(sum / n, 2),
      framesPerSecond: round(n / (sum / 1000), 1),
      over33Ms: d.filter(function (v) { return v > 33.4; }).length,
      over50Ms: d.filter(function (v) { return v > 50; }).length,
      // A gap of a whole second means the browser stopped drawing (page hidden, device asleep):
      // the run then measures the pause, not the lab.
      pausesOver1s: d.filter(function (v) { return v > 1000; }).length
    };
    // Dropped frames: intervals longer than 1.5 refresh intervals, i.e. at least one refresh of
    // the display went by without a new frame. Where the median sits at the refresh interval on
    // every engine, this still tells them apart.
    if (refresh) {
      var limit = 1.5 * refresh.intervalMs;
      var dropped = d.filter(function (v) { return v > limit; }).length;
      out.refreshHz = refresh.hz;
      out.refreshIntervalMs = refresh.intervalMs;
      out.droppedLimitMs = round(limit, 2);
      out.droppedFrames = dropped;
      out.droppedPercent = round(100 * dropped / n, 2);
    }
    out.frameTimesMs = d.map(function (v) { return round(v, 2); });
    return out;
  }

  // ---- Runs -----------------------------------------------------------------------------------

  var running = false, lastRun = null, runStartedAt = 0, runKind = '';

  async function prepare() {
    var stage = $('stage') || labCanvas();
    if (stage && stage.scrollIntoView) stage.scrollIntoView({ block: 'center' });
    await sleep(400);
    var lab = window.DensityLab;
    if (!lab || lab.view !== 'bench' || !lab.viewSettled) {
      clickView('bench');
      await waitFor(function (e) { return e.type === 'arrived' && e.view === 'bench'; }, 4000);
    }
    await clickReset();
    var reset = await waitFor(function (e) { return e.type === 'reset'; }, 4000);
    fire('pointermove', TARGETS.rest, 0);
    await sleep(800);
    return { resetConfirmed: !!reset, restingFrameMs: await restingPace() };
  }

  async function restingPace() {
    var idle = await recordFrames(1500);
    var pace = paceOf(idle.stamps);
    return pace == null ? null : round(pace, 2);
  }

  async function run(kind) {
    if (running) return null;
    if (!usableNow()) { status('The lab is not usable yet; wait for the pieces to appear on the tray.'); return null; }
    running = true; runKind = kind; aborted = false;
    showRunning(true);
    status(kind === 'benchmark' ? 'Getting the bench ready…' : 'Recording…');
    var before = kind === 'benchmark' ? await prepare() : { restingFrameMs: await restingPace() };
    if (!staticDone) await collectStatic();

    var steps = kind === 'benchmark' ? timetable() : [];
    var play = null;
    var recording = recordFrames(RUN_MS, function (t0) {
      runStartedAt = t0;
      if (kind === 'benchmark') play = playTimetable(t0, steps);
    });
    var rec = await recording;
    aborted = true;
    if (pointerDown) fire('pointerup', lastPoint, 0);
    if (play) await play;
    var refresh = refreshEstimate(before.restingFrameMs);
    var stats = frameStats(rec.stamps, refresh);

    var result = {
      kind: kind,
      startedAtMs: round(rec.start, 1),
      hiddenDuringRun: rec.hidden,
      restingFrameMs: before.restingFrameMs,
      refresh: refresh,
      stats: stats
    };
    if (kind === 'benchmark') {
      await sleep(2500);                // let the last answers arrive before checking
      confirmSteps(steps);
      result.steps = steps.map(function (s) {
        var out = { at: s.at, what: s.what, ok: s.ok };
        if (s.startedAt != null) out.startedAtS = round((s.startedAt - rec.start) / 1000, 3);
        if (s.searches) out.searches = s.searches;
        if (s.answeredAfterMs != null) out.answeredAfterMs = s.answeredAfterMs;
        if (s.problem) out.problem = s.problem;
        return out;
      });
      result.stepsConfirmed = steps.filter(function (s) { return s.ok; }).length;
      result.stepsTotal = steps.length;
      result.benchResetBefore = before.resetConfirmed;
      // Leave the bench as it was found: pieces back on the tray, Bench view.
      clickView('bench');
      await sleep(900);
      await clickReset();
    }
    lastRun = result;
    running = false;
    showRunning(false);
    status(kind === 'benchmark'
      ? 'Benchmark finished: ' + result.stepsConfirmed + ' of ' + result.stepsTotal + ' steps confirmed by the build.'
      : 'Recording finished.');
    render();
    return result;
  }

  async function playTimetable(t0, steps) {
    for (var i = 0; i < steps.length; i++) {
      var step = steps[i];
      while (!aborted && now() - t0 < step.at * 1000) await frame();
      if (aborted) break;
      step.startedAt = round(now(), 1);
      try { await doStep(step); } catch (e) { step.problem = 'error: ' + (e && e.message || e); }
    }
  }

  // ---- Results --------------------------------------------------------------------------------

  function timing() {
    var nav = performance.getEntriesByType('navigation')[0];
    var fcp = performance.getEntriesByName ? performance.getEntriesByName('first-contentful-paint')[0] : null;
    var t = {
      scriptLoadedLate: LATE,
      pageArrivedMs: nav ? round(nav.responseEnd, 1) : null,
      pageReadyMs: nav && nav.domContentLoadedEventEnd ? round(nav.domContentLoadedEventEnd, 1) : null,
      firstPaintMs: fcp ? round(fcp.startTime, 1) : null,
      pageLoadedMs: nav && nav.loadEventEnd ? round(nav.loadEventEnd, 1) : null,
      contextMs: marks.context == null ? null : marks.context,
      lastFileMs: marks.lastFile == null ? null : marks.lastFile,
      readyMs: marks.ready == null ? null : marks.ready,
      configuredMs: marks.configured == null ? null : marks.configured,
      coverLiftedMs: marks.coverLifted == null ? null : marks.coverLifted,
      openingDoneMs: marks.openingDone == null ? null : marks.openingDone
    };
    t.timeToUsableMs = usableAt() == null ? null : usableAt();
    t.openingState = openingState();
    t.hiddenWhileLoading = hiddenWhileLoading;
    return t;
  }

  // 'finished', 'running' (the camera is still moving in) or 'none' (the lab cut straight to the
  // bench: reduced motion, ?intro=0, or work already under way).
  function openingState() {
    if (marks.openingDone != null) return 'finished';
    var configured = marks.configured;
    if (configured == null) return null;
    var moved = log.some(function (e) { return e.dir === 'in' && e.type === 'view' && e.t >= configured; });
    return moved ? 'running' : 'none';
  }
  function openingText(t) {
    if (t.openingState === 'finished') return secs(t.openingDoneMs);
    if (t.openingState === 'running') return 'not finished yet';
    if (t.openingState === 'none') return 'no opening move';
    return '—';
  }

  function results(withFrames) {
    var dl = download();
    var run = null;
    if (lastRun) {
      run = JSON.parse(JSON.stringify(lastRun));
      if (!withFrames && run.stats) delete run.stats.frameTimesMs;
    }
    return {
      tool: 'Density lab measure.js ' + VERSION,
      label: LABEL,
      engine: engineName(),
      page: location.origin + location.pathname,
      address: location.search,
      measuredAt: new Date().toISOString(),
      device: device,
      graphics: {
        labDrewWith: labApi(),
        contexts: labContexts(),
        webgl2: graphics ? graphics.webgl2 : null,
        webgpu: graphics ? graphics.webgpu : null
      },
      download: dl,
      timing: timing(),
      run: run,
      messages: { fromBuildHoverCount: hoverCount, log: log },
      notes: notes.slice()
    };
  }

  function mb(bytes) { return (bytes / 1e6).toFixed(2) + ' MB'; }
  function whole(n) { return Math.round(n).toLocaleString('en-US'); }
  function secs(ms) { return ms == null ? '—' : (ms / 1000).toFixed(2) + ' s'; }
  function msText(v) { return v == null ? '—' : v.toFixed(2) + ' ms'; }

  function sourceText(dl) {
    var s = dl.sources, parts = [];
    if (s.cache || s.revalidated) {
      var again = [];
      if (s.cache) again.push(s.cache + ' from the browser cache');
      if (s.revalidated) again.push(s.revalidated + ' only re-checked with the server');
      parts.push('Not a first visit: ' + again.join(', ') + '.');
    }
    if (s.hidden) parts.push('Incomplete: ' + s.hidden + ' files came from another site that does not share their sizes (Timing-Allow-Origin), so they count as 0.');
    return parts.length ? parts.join(' ') : 'Every file came over the network.';
  }

  function gpuText(g) {
    if (!g) return 'not checked yet';
    var w = g.webgpu;
    if (w.supported) return 'available' + (w.vendor || w.architecture ? ' (' + [w.vendor, w.architecture].filter(Boolean).join(', ') + ')' : '');
    return 'not available: ' + (w.reason || 'unknown reason');
  }

  function frameText(r) {
    if (!r || !r.stats) return 'No run yet.';
    var s = r.stats;
    var head = r.kind === 'benchmark' ? 'Benchmark, 60 s' : 'Recording without input, 60 s';
    var text = head + ': ' + whole(s.frames) + ' frames; median ' + msText(s.medianMs) + '; 95th percentile ' + msText(s.p95Ms) +
      '; 99th ' + msText(s.p99Ms) + '; worst ' + msText(s.worstMs) + '; average ' + s.framesPerSecond + ' frames/s; ' +
      s.over33Ms + ' frames over 33 ms.';
    if (s.refreshHz) {
      text += ' Display refresh: ' + s.refreshHz + ' Hz (' + msText(s.refreshIntervalMs) + '). Dropped frames (longer than 1.5 refreshes, ' +
        msText(s.droppedLimitMs) + '): ' + whole(s.droppedFrames) + ' (' + s.droppedPercent.toFixed(2) + ' %).';
    } else {
      text += ' Display refresh: not measured.';
    }
    if (r.kind === 'benchmark') text += ' Steps confirmed by the build: ' + r.stepsConfirmed + ' of ' + r.stepsTotal + '.';
    if (r.hiddenDuringRun) text += ' WARNING: the page was hidden during the run, so these numbers are not valid.';
    else if (s.pausesOver1s) text += ' WARNING: the browser stopped drawing for over 1 s (' + s.pausesOver1s + ' times), so these numbers are not valid.';
    return text;
  }

  function summaryText(res) {
    var d = res.device || {}, dl = res.download, t = res.timing, g = res.graphics;
    var lines = [];
    lines.push('Density lab measurement (' + res.tool + ')');
    lines.push('Build: ' + (res.label || '(no label)') + ', engine ' + res.engine + '. Page: ' + res.page);
    lines.push('Measured: ' + new Date(res.measuredAt).toLocaleString());
    if (res.device) {
      lines.push('Device: ' + d.system + ', ' + d.browser + '; screen ' + d.screen + ' at ' + d.pixelRatio + 'x; ' +
        (d.cpuThreads ? d.cpuThreads + ' CPU threads' : 'CPU threads not reported') + (d.memoryGB ? ', about ' + d.memoryGB + ' GB memory' : '') +
        (d.view3D ? '; 3D view ' + d.view3D : '') + '.');
    }
    lines.push('Download: ' + mb(dl.total.transfer) + ' (' + whole(dl.total.transfer) + ' bytes) over the network in ' + dl.total.files +
      ' files; compressed bodies ' + mb(dl.total.encoded) + '; unpacked ' + mb(dl.total.decoded) + '. ' + sourceText(dl));
    if (t.timeToUsableMs != null) {
      lines.push('Time to usable: ' + secs(t.timeToUsableMs) + ' (engine ready ' + secs(t.readyMs) + '; last file arrived ' + secs(t.lastFileMs) +
        '; ' + (t.openingState === 'finished' ? 'opening move finished ' + openingText(t) : t.openingState === 'running' ? 'opening move not finished yet' : 'no opening move') + ').' +
        (t.hiddenWhileLoading ? ' WARNING: the page was hidden while it loaded, so these times are not valid.' : ''));
    } else {
      lines.push('Time to usable: ' + (LATE ? 'not recorded (the script was loaded after the lab had started).' : 'not reached yet.'));
    }
    lines.push('Graphics: the lab drew with ' + (g.labDrewWith || 'an unrecorded context') + '. WebGPU: ' + gpuText(graphics) + '.' +
      (g.webgl2 && g.webgl2.renderer ? ' WebGL renderer: ' + g.webgl2.renderer + '.' : ''));
    lines.push(frameText(res.run));
    if (res.run && res.run.steps) {
      res.run.steps.filter(function (s) { return !s.ok; }).forEach(function (s) {
        lines.push('  Step not confirmed at ' + s.at + ' s, ' + s.what + ': ' + s.problem + '.');
      });
    }
    res.notes.forEach(function (n) { lines.push('Note: ' + n); });
    return lines.join('\n');
  }

  function fullText() {
    var res = results(true);
    return summaryText(res) + '\n\nFull results (JSON):\n' + JSON.stringify(res);
  }

  async function copyResults() {
    var text = fullText();
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        status('Results copied (' + whole(text.length) + ' characters). Paste them into an email or a note.');
        return true;
      }
    } catch (e) { /* fall through to the older way */ }
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(area);
    if (ok) { status('Results copied (' + whole(text.length) + ' characters).'); return true; }
    ui.manual.hidden = false;
    ui.manualText.value = text;
    ui.manualText.select();
    status('This browser would not copy by itself. The results are selected in the box below; copy them by hand.');
    return false;
  }

  function saveResults() {
    var res = results(true);
    var stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    var name = 'density-lab-measure-' + (LABEL || 'build').replace(/[^\w.-]+/g, '-') + '-' + stamp + '.json';
    var url = URL.createObjectURL(new Blob([JSON.stringify(res, null, 1)], { type: 'application/json' }));
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    status('Saved as ' + name + ' in this device\'s downloads.');
  }

  // ---- Results panel --------------------------------------------------------------------------

  var ui = null;

  var PANEL_CSS = [
    '.box{position:fixed;right:12px;bottom:12px;z-index:2147483000;width:min(372px,calc(100vw - 24px));max-height:min(80vh,680px);',
    'overflow:auto;background:#fbfbf8;color:#1d2421;border:1px solid #c5cbc2;border-radius:10px;box-shadow:0 10px 30px rgba(20,30,25,.2);',
    'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;}',
    '.head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid #dde1da;position:sticky;top:0;background:#fbfbf8;}',
    '.head strong{font-size:13.5px;}.who{color:#5b6660;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.body{padding:4px 12px 12px;}.box[data-folded] .body{display:none;}.box[data-folded] .head{border-bottom:0;}',
    'h3{margin:12px 0 4px;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:#4d5a53;}',
    'dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;}dt{color:#5b6660;}dd{margin:0;font-variant-numeric:tabular-nums;}',
    '.big{font-size:15px;font-weight:600;}.warn{color:#9a3412;}.ok{color:#166534;}',
    '.status{margin:8px 0 0;padding:7px 9px;background:#eef2ec;border-radius:6px;}',
    'details{margin-top:4px;}summary{cursor:pointer;color:#1c4c9a;}',
    'table{border-collapse:collapse;width:100%;font-size:11.5px;margin-top:4px;font-variant-numeric:tabular-nums;}',
    'td,th{padding:2px 4px;border-bottom:1px solid #e3e6e0;text-align:right;}td:first-child,th:first-child{text-align:left;word-break:break-all;}',
    '.buttons{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:12px;}',
    'button{font:inherit;padding:7px 8px;border-radius:6px;border:1px solid #b9c0b6;background:#fff;color:#1d2421;cursor:pointer;}',
    'button:hover{background:#f1f4ef;}button.primary{background:#1c4c9a;border-color:#1c4c9a;color:#fff;}button.primary:hover{background:#173f80;}',
    'button:disabled{opacity:.5;cursor:default;}.fold{padding:3px 8px;font-size:12px;}',
    '.fine{margin:10px 0 0;color:#5b6660;font-size:11.5px;}',
    'textarea{width:100%;height:120px;margin-top:8px;font:11px ui-monospace,Menlo,monospace;box-sizing:border-box;}',
    '.pill{padding:8px 12px;font-weight:600;}',
    '@media print{.box{display:none;}}'
  ].join('');

  var PANEL_HTML = [
    '<div class="box" role="region" aria-label="Lab measurement">',
    '<div class="head"><strong>Lab measurement</strong><span class="who"></span><button type="button" class="fold" aria-expanded="true">Hide</button></div>',
    '<div class="pill" hidden></div>',
    '<div class="body">',
    '<p class="status" role="status"></p>',
    '<h3>Download</h3><dl data-sec="download"></dl>',
    '<details><summary>Files</summary><table><thead><tr><th>File</th><th>Network</th><th>Unpacked</th><th>Arrived</th></tr></thead><tbody data-sec="files"></tbody></table></details>',
    '<h3>Time from opening the address</h3><dl data-sec="time"></dl>',
    '<h3>Graphics</h3><dl data-sec="graphics"></dl>',
    '<h3>Frame times</h3><dl data-sec="frames"></dl>',
    '<div class="buttons">',
    '<button type="button" class="primary" data-act="benchmark">Run benchmark (60 s)</button>',
    '<button type="button" data-act="idle">Record 60 s, no input</button>',
    '<button type="button" data-act="copy">Copy results</button>',
    '<button type="button" data-act="save">Save as file</button>',
    '</div>',
    '<div data-sec="manual" hidden><textarea readonly></textarea></div>',
    '<p class="fine">For a first-visit download size, open the address in a new private window. Keep this page in front during a run. ',
    'The benchmark moves the pieces itself, empties the cylinder and clears any volumes typed on this page.</p>',
    '</div></div>'
  ].join('');

  function buildPanel() {
    var host = document.createElement('div');
    host.id = 'density-lab-measure';
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.innerHTML = '<style>' + PANEL_CSS + '</style>' + PANEL_HTML;
    document.body.appendChild(host);
    var q = function (sel) { return root.querySelector(sel); };
    ui = {
      box: q('.box'), who: q('.who'), fold: q('.fold'), pill: q('.pill'), status: q('.status'),
      download: q('[data-sec="download"]'), files: q('[data-sec="files"]'), time: q('[data-sec="time"]'),
      graphics: q('[data-sec="graphics"]'), frames: q('[data-sec="frames"]'),
      manual: q('[data-sec="manual"]'), manualText: q('textarea'),
      buttons: Array.prototype.slice.call(root.querySelectorAll('[data-act]'))
    };
    ui.fold.addEventListener('click', function () { fold(!ui.box.hasAttribute('data-folded')); });
    ui.buttons.forEach(function (b) {
      b.addEventListener('click', function () {
        var act = b.getAttribute('data-act');
        if (act === 'benchmark') run('benchmark');
        if (act === 'idle') run('idle');
        if (act === 'copy') copyResults();
        if (act === 'save') saveResults();
      });
    });
    status(AUTO ? 'Automatic mode: the benchmark starts once the lab is usable.' : 'Waiting for the lab to start…');
    render();
  }

  function fold(folded) {
    if (folded) ui.box.setAttribute('data-folded', ''); else ui.box.removeAttribute('data-folded');
    ui.fold.textContent = folded ? 'Show' : 'Hide';
    ui.fold.setAttribute('aria-expanded', folded ? 'false' : 'true');
  }

  var lastStatus = '';
  function status(text) { lastStatus = text; if (ui) ui.status.textContent = text; }

  var pillTimer = null;
  function showRunning(on) {
    if (!ui) return;
    ui.buttons.forEach(function (b) { b.disabled = on; });
    if (on) {
      fold(true);
      ui.pill.hidden = false;
      var tick = function () {
        var s = runStartedAt ? Math.min(60, Math.floor((now() - runStartedAt) / 1000)) : 0;
        ui.pill.textContent = (runKind === 'benchmark' ? 'Benchmark' : 'Recording') + ' running: ' + (runStartedAt ? s : 0) + ' of 60 s. Please leave the page alone.';
      };
      runStartedAt = 0;
      tick();
      pillTimer = setInterval(tick, 1000);
    } else {
      clearInterval(pillTimer);
      ui.pill.hidden = true;
      fold(false);
    }
  }

  function rows(dl, pairs) {
    dl.textContent = '';
    pairs.forEach(function (p) {
      var dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = p[0]; dd.textContent = p[1];
      if (p[2]) dd.className = p[2];
      dl.appendChild(dt); dl.appendChild(dd);
    });
  }

  function render() {
    if (!ui || running) return;
    var res = results(false);
    var dl = res.download, t = res.timing, g = res.graphics, r = res.run;
    ui.who.textContent = (LABEL ? LABEL + ' · ' : '') + res.engine;

    var fresh = !dl.sources.cache && !dl.sources.revalidated && !dl.sources.hidden;
    rows(ui.download, [
      ['Over the network', mb(dl.total.transfer), 'big'],
      ['', whole(dl.total.transfer) + ' bytes in ' + dl.total.files + ' files'],
      ['Compressed bodies', mb(dl.total.encoded)],
      ['Unpacked', mb(dl.total.decoded)],
      ['Before usable', mb(dl.beforeUsable.transfer) + ' in ' + dl.beforeUsable.files + ' files'],
      ['Count', fresh ? 'first visit, all from the network' : sourceText(dl), fresh ? 'ok' : 'warn']
    ]);
    ui.files.textContent = '';
    dl.files.forEach(function (f) {
      var tr = document.createElement('tr');
      [f.name + (f.source !== 'network' ? ' (' + f.source + ')' : ''), whole(f.transfer), whole(f.decoded), secs(f.end)].forEach(function (v) {
        var td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
      });
      ui.files.appendChild(tr);
    });

    if (t.timeToUsableMs == null && LATE) {
      rows(ui.time, [['Time to usable', 'not recorded: the script loaded after the lab started', 'warn']]);
    } else {
      rows(ui.time, [
        ['Time to usable', secs(t.timeToUsableMs), 'big'],
        ['Page arrived', secs(t.pageArrivedMs)],
        ['First paint', secs(t.firstPaintMs)],
        ['3D context made', secs(t.contextMs)],
        ['Last file arrived', secs(t.lastFileMs)],
        ['Engine ready', secs(t.readyMs)],
        ['Opening finished', openingText(t)],
        t.hiddenWhileLoading ? ['Warning', 'the page was hidden while it loaded; these times are not valid', 'warn'] : null
      ].filter(Boolean));
    }

    var w = graphics ? graphics.webgpu : null;
    rows(ui.graphics, [
      ['Lab drew with', g.labDrewWith || '—'],
      ['WebGPU', w ? (w.supported ? gpuText(graphics) : 'not available') : 'checked once the lab is usable', w ? (w.supported ? 'ok' : 'warn') : ''],
      w && !w.supported ? ['Why', w.reason] : null,
      ['WebGL renderer', graphics && graphics.webgl2 ? (graphics.webgl2.renderer || (graphics.webgl2.available ? 'hidden' : 'WebGL 2 not available')) : '—']
    ].filter(Boolean));

    if (!r || !r.stats) {
      rows(ui.frames, [['', 'Run the benchmark to fill this in.']]);
    } else {
      var s = r.stats;
      var pairs = [
        ['Run', r.kind === 'benchmark' ? 'benchmark, 60 s' : 'no input, 60 s'],
        ['Median', msText(s.medianMs), 'big'],
        ['95th percentile', msText(s.p95Ms), 'big'],
        ['99th percentile', msText(s.p99Ms)],
        ['Worst frame', msText(s.worstMs)],
        ['Frames', whole(s.frames) + ' (' + s.framesPerSecond + ' per second)'],
        ['Over 33 ms', String(s.over33Ms)],
        ['Display refresh', s.refreshHz ? s.refreshHz + ' Hz (' + msText(s.refreshIntervalMs) + ' each)' : 'not measured'],
        ['Dropped frames', s.refreshHz ? whole(s.droppedFrames) + ' (' + s.droppedPercent.toFixed(2) + ' %), longer than ' + msText(s.droppedLimitMs) : '—', 'big']
      ];
      if (r.kind === 'benchmark') pairs.push(['Steps confirmed', r.stepsConfirmed + ' of ' + r.stepsTotal, r.stepsConfirmed === r.stepsTotal ? 'ok' : 'warn']);
      if (r.hiddenDuringRun) pairs.push(['Warning', 'the page was hidden during the run; not valid', 'warn']);
      else if (s.pausesOver1s) pairs.push(['Warning', 'drawing stopped for over 1 s during the run; not valid', 'warn']);
      rows(ui.frames, pairs);
    }
  }

  // ---- Start ----------------------------------------------------------------------------------

  async function start() {
    watchCover();
    buildPanel();
    var refresher = setInterval(render, 1000);
    var usable = await whenUsable(120000);
    if (usable) {
      status('The lab is usable. Waiting for the opening move to finish…');
      await whenOpeningDone(6000);
    } else {
      status('The lab did not become usable within 2 minutes.');
    }
    await collectStatic();
    clearInterval(refresher);
    render();
    if (!usable) return;
    if (AUTO) {
      status('Automatic mode: the benchmark starts in 3 s.');
      await sleep(3000);
      await run('benchmark');
      console.info(summaryText(results(false)));
    } else {
      status(LATE ? 'Ready. (Loaded late: download sizes and frame times work, start-up times were missed.)'
        : 'Ready. Press "Run benchmark" and leave the page alone for about 70 s.');
    }
  }

  window.DensityLabMeasure = {
    version: VERSION,
    targets: function () { return JSON.parse(JSON.stringify(TARGETS)); },
    results: function () { return results(true); },
    summary: function () { return summaryText(results(false)); },
    runBenchmark: function () { return run('benchmark'); },
    recordIdle: function () { return run('idle'); },
    copy: copyResults,
    save: saveResults
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
