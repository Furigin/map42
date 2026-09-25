/* Атлас 42 — карта-галактика. Canvas + d3-force. */
(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const canvas = $("#map");
  const ctx = canvas.getContext("2d");
  const hist = $("#hist");
  const hctx = hist.getContext("2d");

  const TAU = Math.PI * 2;
  const CORE_R = 58;
  const SPIN_PERIOD = 480; // секунд на полный оборот
  const MOBILE = () => innerWidth <= 760;
  const IN_TG = /tgWebApp/.test(location.hash);
  const TOUCH = matchMedia("(pointer: coarse)").matches;

  const nf = new Intl.NumberFormat("ru");
  const cf = new Intl.NumberFormat("ru", { notation: "compact", maximumFractionDigits: 1 });
  const full = (n) => (n == null ? "—" : nf.format(Math.round(n)));
  const cf0 = new Intl.NumberFormat("ru", { notation: "compact", maximumFractionDigits: 0 });
  // 257,5 тыс. → 258 тыс.: дробь оставляем только у мелких значений, чтобы число влезало в ячейку
  const short = (n) => (n == null ? "—" : (Math.abs(n) >= 100_000 && Math.abs(n) < 1e6 ? cf0 : cf).format(n));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");
  const dateFmt = new Intl.DateTimeFormat("ru", { day: "numeric", month: "short", year: "numeric" });
  const dtFmt = new Intl.DateTimeFormat("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  function ago(ts) {
    const s = Date.now() / 1000 - ts;
    if (s < 60) return "только что";
    if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
    if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)} дн назад`;
    return dateFmt.format(ts * 1000);
  }
  const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c; };

  // ---------------------------------------------------------------- состояние
  let W = 0, H = 0, DPR = 1;
  const nets = new Map();      // id → {id, name, color, glow, fog, count}
  const nodes = [];            // точки
  const byId = new Map();
  let ops = new Map();         // id → {id, name, members: Node[], x, y, show}
  let rev = null;

  let view = d3.zoomIdentity;
  // на телефонах и в Telegram вращение по умолчанию выключено — экономим батарею
  let angle = 0, spinning = !TOUCH && !IN_TG && innerWidth > 760, lastT = performance.now();
  let quality = 1;             // 1 — всё красиво, 0 — упрощённо (сам включается на слабых устройствах)
  let perf = 0, perfFrames = 0;
  let filter = new Set();      // пусто = все сети
  let cutoff = Infinity;       // таймлайн
  let tMin = 0, tMax = 0;
  let playing = false;
  let selected = null;         // Node | "core" | null
  let focusOp = null;          // op | null
  let hover = null;            // Node | "core" | op | null
  let pointer = null;
  let dragging = false;
  let solo = false;
  let userMoved = false;
  let anim = { start: 0, dur: 1 };
  let related = null;          // Set узлов, которые не приглушаем
  let fontGen = 0;             // растёт, когда догрузились шрифты — сбрасывает кэш ширин подписей
  let mode = "galaxy";         // galaxy — облака соцсетей, plane — координатная плоскость
  let current = null;          // последние загруженные данные (их правит панель штаба)
  const hooks = {};            // панель штаба подключает сюда свои кнопки и сохранение

  // Плоскость: x — лояльность, y — наше превосходство, обе от −10 до +10
  const PS = 36;               // мировых единиц на деление шкалы
  const LIM = 10;
  const isRated = (n) => n.loy != null && n.sup != null;
  const signed = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + String(Math.abs(v)).replace(".", ",");

  // ---------------------------------------------------------------- спрайты свечения
  function sprite(color, stops) {
    const s = 128, c = document.createElement("canvas");
    c.width = c.height = s;
    const g = c.getContext("2d"), gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    for (const [o, a] of stops) gr.addColorStop(o, rgba(color, a));
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
    return c;
  }
  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const whiteGlow = sprite("#ffffff", [[0, 0.9], [0.25, 0.35], [1, 0]]);

  let stars = null;
  function makeStars() {
    stars = document.createElement("canvas");
    stars.width = W * DPR; stars.height = H * DPR;
    const g = stars.getContext("2d");
    const count = Math.round((W * H) / 2600);
    for (let i = 0; i < count; i++) {
      const x = Math.random() * stars.width, y = Math.random() * stars.height;
      const r = Math.random() ** 3 * 1.4 * DPR + 0.3 * DPR;
      g.fillStyle = `rgba(${200 + Math.random() * 55 | 0},${200 + Math.random() * 55 | 0},255,${0.15 + Math.random() * 0.55})`;
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    }
  }

  // ---------------------------------------------------------------- размеры
  function resize() {
    W = innerWidth; H = innerHeight;
    DPR = quality ? Math.min(TOUCH ? 1.5 : 2, devicePixelRatio || 1) : 1;
    canvas.width = W * DPR; canvas.height = H * DPR;
    const hr = hist.getBoundingClientRect();
    hist.width = Math.max(1, hr.width * DPR); hist.height = Math.max(1, hr.height * DPR);
    makeStars();
    drawHist();
    if (selected && selected !== "core") focusNode(selected, 0, view.k);
    else if (!userMoved && nodes.length) fitView(0);
    invalidate();
  }

  const radius = (n) => 4 + 2.1 * Math.pow(Math.log10((n.audience ?? n.people ?? 0) + 1), 1.55);
  const netOf = (id) => nets.get(id) || nets.get("other");
  const inFilter = (n) => !filter.size || filter.has(n.net);
  const inTime = (n) => n.at <= cutoff;

  // ---------------------------------------------------------------- раскладка
  function clusterCenters(vis) {
    const groups = d3.group(vis, (n) => n.net);
    const list = [...groups].map(([net, arr]) => ({
      net, n: arr.length, R: Math.sqrt(d3.sum(arr, (n) => (n.rg + 3) ** 2)) * 1.25 + 24,
    })).sort((a, b) => b.n - a.n);
    const centers = new Map();
    if (list.length === 1) { centers.set(list[0].net, { x: 0, y: 0, R: list[0].R }); return centers; }
    const gap = 70, maxR = d3.max(list, (d) => d.R) || 0;
    const arc = d3.sum(list, (d) => 2 * d.R + gap);
    const ring = Math.max(CORE_R + 80 + maxR, arc / TAU);
    let acc = 0;
    for (const d of list) {
      const w = (2 * d.R + gap) / arc * TAU;
      const a = -Math.PI / 2 + acc + w / 2;
      acc += w;
      centers.set(d.net, { x: Math.cos(a) * ring, y: Math.sin(a) * ring, R: d.R });
    }
    return centers;
  }

  // перераскладка в текущем режиме
  function relayout(opts = {}) {
    layout(opts); // галактику считаем всегда: из неё берутся позиции при возврате с плоскости
    if (mode === "plane") layoutPlane(opts.dur);
  }

  function layout({ fresh = false, ticks = 300, dur = 1300 } = {}) {
    const vis = nodes.filter(inFilter);
    const centers = clusterCenters(vis);
    solo = centers.size === 1;

    for (const [net, c] of centers) {
      const arr = vis.filter((n) => n.net === net).sort((a, b) => b.rg - a.rg);
      const step = (d3.mean(arr, (n) => n.rg) || 6) * 1.9;
      arr.forEach((n, i) => {
        if (fresh || n.offX == null) {
          if (fresh) {
            const a = i * 2.39996, d = Math.sqrt(i + 0.5) * step;
            n.offX = Math.cos(a) * d; n.offY = Math.sin(a) * d;
          } else {
            const a = Math.random() * TAU, d = c.R * 0.75;
            n.offX = Math.cos(a) * d; n.offY = Math.sin(a) * d;
          }
        }
        n.x = c.x + n.offX; n.y = c.y + n.offY;
        n.vx = n.vy = 0;
      });
    }

    const core = { x: 0, y: 0, fx: 0, fy: 0, rg: CORE_R, core: true };
    const simNodes = solo ? vis : [core, ...vis];
    const cx = (d) => (d.core ? 0 : centers.get(d.net).x), cy = (d) => (d.core ? 0 : centers.get(d.net).y);
    const sim = d3.forceSimulation(simNodes).stop()
      .force("x", d3.forceX(cx).strength(0.085))
      .force("y", d3.forceY(cy).strength(0.085))
      .force("collide", d3.forceCollide((d) => d.rg + (d.core ? 44 : 2.4)).iterations(2).strength(0.9))
      .force("charge", d3.forceManyBody().strength((d) => (d.core ? 0 : -Math.max(6, d.rg * 1.1))).distanceMax(200))
      .alpha(fresh ? 1 : 0.6);
    for (let i = 0; i < ticks; i++) sim.tick();

    const maxD = d3.max(vis, (n) => Math.hypot(n.x, n.y)) || 1;
    for (const n of vis) {
      const c = centers.get(n.net);
      n.offX = n.x - c.x; n.offY = n.y - c.y;
      n.fromX = n.dx ?? 0; n.fromY = n.dy ?? 0;
      n.delay = fresh ? (Math.hypot(n.x, n.y) / maxD) * 700 : 0;
      if (n.dx == null) { n.dx = n.fromX; n.dy = n.fromY; }
    }
    anim = { start: performance.now(), dur, done: false };
    invalidate();
  }

  // Плоскость: точка встаёт в свои координаты, одинаковые оценки чуть расходятся, чтобы не слипаться
  function layoutPlane(dur = 1100) {
    const vis = nodes.filter(inFilter), rated = vis.filter(isRated);
    for (const n of rated) { n.x = n.loy * PS; n.y = -n.sup * PS; n.vx = n.vy = 0; }
    const sim = d3.forceSimulation(rated).stop()
      .force("x", d3.forceX((n) => n.loy * PS).strength(0.6))
      .force("y", d3.forceY((n) => -n.sup * PS).strength(0.6))
      .force("collide", d3.forceCollide((n) => n.r + 0.5).strength(0.35))
      .alpha(0.5);
    const L = LIM * PS;
    for (let i = 0; i < 80; i++) {
      sim.tick();
      for (const n of rated) { n.x = Math.max(-L, Math.min(L, n.x)); n.y = Math.max(-L, Math.min(L, n.y)); } // не за рамку
    }
    for (const n of vis) {
      n.fromX = n.dx ?? 0; n.fromY = n.dy ?? 0; n.delay = 0;
      if (!isRated(n)) { n.x = n.fromX; n.y = n.fromY; }
    }
    anim = { start: performance.now(), dur, done: false, angleFrom: angle };
    invalidate();
  }

  function updatePositions(t) {
    const active = t < anim.start + anim.dur + 750;
    if (!active && anim.done) return false;
    for (const n of nodes) {
      if (!inFilter(n) || n.fromX == null) continue;
      const p = Math.min(1, Math.max(0, (t - anim.start - (n.delay || 0)) / anim.dur));
      const e = d3.easeCubicInOut(p);
      n.dx = n.fromX + (n.x - n.fromX) * e;
      n.dy = n.fromY + (n.y - n.fromY) * e;
    }
    if (anim.angleFrom != null) { // на плоскости оси строго горизонтальны — плавно выпрямляем вращение
      const e = d3.easeCubicInOut(Math.min(1, (t - anim.start) / anim.dur));
      angle = anim.angleFrom * (1 - e);
    }
    anim.done = !active;
    return active;
  }

  // ---------------------------------------------------------------- камера
  function freeArea(withDetail = true) {
    const det = withDetail && !$("#detail").hidden;
    let l = 0, r = 0, t = 0, b = 90;
    if (MOBILE()) { t = $("#side").getBoundingClientRect().bottom; b = det ? H * 0.45 : 80; }
    else { l = 332; if (det) r = 412; }
    return { x: l, y: t, w: Math.max(100, W - l - r), h: Math.max(100, H - t - b) };
  }

  const zoom = d3.zoom().scaleExtent([0.03, 10])
    .on("start", (e) => { if (e.sourceEvent) { dragging = true; canvas.classList.add("dragging"); } })
    .on("zoom", (e) => { view = e.transform; if (e.sourceEvent) userMoved = true; invalidate(); })
    .on("end", () => { dragging = false; canvas.classList.remove("dragging"); });
  d3.select(canvas).call(zoom).on("dblclick.zoom", null);

  function fitView(dur = 900) {
    const vis = nodes.filter(inFilter);
    let R = solo ? 60 : CORE_R + 50;
    if (mode === "plane") R = LIM * PS; // вся плоскость; поля под подписи осей — ниже, в пикселях
    else {
      for (const n of vis) R = Math.max(R, Math.hypot(n.x, n.y) + n.rg);
      if (solo) R += 50; // кольцо операций
    }
    const a = freeArea(false); // общий вид — без учёта карточки, она лишь накрывает край
    if (mode === "plane") { // место под переключатель режимов и подписи осей (слева и снизу)
      const top = MOBILE() ? 8 : 96, bottom = MOBILE() ? 100 : 44, left = 46;
      a.x += left; a.w -= left + 8; a.y += top; a.h -= top + bottom;
    }
    let k = Math.max(0.03, (Math.min(a.w, a.h) / 2 - (mode === "plane" ? 8 : MOBILE() ? 22 : 48)) / R);
    if (!vis.length) k = Math.min(k, 1); // пустая карта: ядро не на весь экран
    const t = d3.zoomIdentity.translate(a.x + a.w / 2, a.y + a.h / 2).scale(k);
    userMoved = false;
    d3.select(canvas).transition().duration(dur).ease(d3.easeCubicInOut).call(zoom.transform, t);
  }

  function rot(x, y) { const c = Math.cos(angle), s = Math.sin(angle); return [x * c - y * s, x * s + y * c]; }
  function toScreen(x, y) { const [rx, ry] = rot(x, y); return [view.x + view.k * rx, view.y + view.k * ry]; }
  function toWorld(sx, sy) {
    const ux = (sx - view.x) / view.k, uy = (sy - view.y) / view.k, c = Math.cos(angle), s = Math.sin(angle);
    return [ux * c + uy * s, -ux * s + uy * c];
  }

  function focusNode(n, dur = 800, keepK = null) {
    const a = freeArea();
    // приблизить так, чтобы точка была ~24px в радиусе, но без резкого наезда
    const k = keepK ?? Math.max(view.k, Math.min(1.6, 24 / n.r));
    const [rx, ry] = rot(n.x, n.y);
    const t = d3.zoomIdentity.translate(a.x + a.w / 2 - rx * k, a.y + a.h / 2 - ry * k).scale(k);
    userMoved = true; // дальше не подгонять камеру автоматически
    d3.select(canvas).transition().duration(dur).ease(d3.easeCubicInOut).call(zoom.transform, t);
  }

  // ---------------------------------------------------------------- отрисовка
  // Рисуем только когда что-то меняется: в покое страница не нагружает ни процессор, ни батарею.
  let drawn = [];
  let rafId = 0, idleTimer = 0;
  function invalidate() {
    if (!rafId) rafId = requestAnimationFrame(frame);
  }
  function frame() {
    rafId = 0;
    const t = performance.now(); // те же часы, что у anim.start и n.born
    const dt = Math.min(0.05, (t - lastT) / 1000);
    lastT = t;
    const spinNow = spinning && mode === "galaxy" && !selected && !focusOp && !hover && !dragging;
    if (spinNow) angle += (dt * TAU) / SPIN_PERIOD;
    stepTimeline(dt);
    const moving = updatePositions(t);
    const tweening = tweenStats(dt);
    const t0 = performance.now();
    const busy = draw(t);
    watchPerf(performance.now() - t0);
    if (moving || tweening || busy || playing) invalidate();
    else if (spinNow) { clearTimeout(idleTimer); idleTimer = setTimeout(invalidate, 33); } // вращение — ~30 кадров/с
  }

  // Если кадр рисуется дольше 18 мс — упрощаем графику, чтобы не было подвисаний
  function watchPerf(ms) {
    if (!quality) return;
    perf = perfFrames ? perf * 0.9 + ms * 0.1 : ms;
    if (++perfFrames > 40 && perf > 18) {
      quality = 0;
      console.info("Атлас: включён облегчённый режим графики");
      resize();
    }
  }

  function computeRelated() {
    if (selected && selected !== "core") {
      related = new Set([selected]);
      for (const id of selected.ops) for (const m of ops.get(id)?.members || []) related.add(m);
    } else if (focusOp) related = new Set(focusOp.members);
    else related = null;
    invalidate();
  }

  function draw(t) {
    let busy = false; // идут ли ещё короткие анимации (появление точек, пинги)
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#040509";
    ctx.fillRect(0, 0, W, H);
    if (stars && stars.width && stars.height) ctx.drawImage(stars, 0, 0, W, H);

    const plane = mode === "plane";
    drawn = [];
    for (const n of nodes) {
      const vis = inFilter(n) && inTime(n) && (!plane || isRated(n)); // на плоскости — только оценённые
      if (vis && !n.wasVisible) n.born = t;
      n.wasVisible = vis;
      if (!vis) continue;
      drawn.push(n);
      if ((n.born != null && t - n.born < 600) || (n.ping && t - n.ping < 6000)) busy = true;
    }

    // облака: центр и размер по фактическим позициям
    const clouds = new Map();
    for (const n of plane ? [] : drawn) {
      let c = clouds.get(n.net);
      if (!c) clouds.set(n.net, (c = { net: n.net, sx: 0, sy: 0, n: 0, list: [] }));
      c.sx += n.dx; c.sy += n.dy; c.n++; c.list.push(n);
    }
    for (const c of clouds.values()) {
      c.x = c.sx / c.n; c.y = c.sy / c.n;
      c.R = 30;
      for (const n of c.list) c.R = Math.max(c.R, Math.hypot(n.dx - c.x, n.dy - c.y) + n.r);
    }

    // хабы операций: на внутреннем кольце вокруг ядра, равномерно, в порядке направления на участников
    const shown = [];
    for (const op of ops.values()) {
      op.live = op.members.filter((m) => m.wasVisible);
      op.show = !plane && op.live.length >= 2;
      if (!op.show) continue;
      op.cx = d3.mean(op.live, (m) => m.dx); op.cy = d3.mean(op.live, (m) => m.dy);
      shown.push(op);
    }
    {
      shown.sort((a, b) => Math.atan2(a.cy, a.cx) - Math.atan2(b.cy, b.cx) || a.id - b.id);
      const base = shown.length ? Math.atan2(shown[0].cy, shown[0].cx) : 0;
      // в соло-режиме ядра нет — кольцо операций обходит облако снаружи
      const ringR = solo ? (clouds.values().next().value?.R || 100) + 46
        : CORE_R + 70 + Math.max(0, shown.length - 6) * 6;
      shown.forEach((op, i) => {
        const a = base + (i * TAU) / shown.length;
        op.x = Math.cos(a) * ringR; op.y = Math.sin(a) * ringR;
      });
    }

    const k = view.k, c = Math.cos(angle), s = Math.sin(angle);
    ctx.setTransform(DPR * k * c, DPR * k * s, -DPR * k * s, DPR * k * c, DPR * view.x, DPR * view.y);
    const dim = related ? 0.13 : 1;
    if (plane) drawPlaneGrid(k);

    // туманности: неподвижные пятна, в облегчённом режиме — одно на облако
    ctx.globalCompositeOperation = "lighter";
    const blobs = quality ? 3 : 0;
    for (const cl of clouds.values()) {
      const net = netOf(cl.net);
      const R = cl.R * 1.15;
      ctx.globalAlpha = (quality ? 0.14 : 0.2) * (related ? 0.5 : 1);
      ctx.drawImage(net.fog, cl.x - R * 1.5, cl.y - R * 1.5, R * 3, R * 3);
      for (let i = 0; i < blobs; i++) {
        const seed = net.seed + i * 1.93;
        const ox = Math.cos(seed) * R * 0.35, oy = Math.sin(seed * 1.7) * R * 0.35, rr = R * 0.85;
        ctx.globalAlpha = 0.15 * (related ? 0.5 : 1);
        ctx.drawImage(net.fog, cl.x + ox - rr, cl.y + oy - rr, rr * 2, rr * 2);
      }
    }

    // лучи от ядра к облакам
    ctx.globalCompositeOperation = "source-over";
    if (!solo) {
      ctx.lineWidth = 1.2 / k;
      ctx.setLineDash([4 / k, 7 / k]);
      for (const cl of clouds.values()) {
        const d = Math.hypot(cl.x, cl.y);
        if (d < CORE_R + cl.R) continue;
        const ux = cl.x / d, uy = cl.y / d;
        const x0 = ux * (CORE_R + 10), y0 = uy * (CORE_R + 10), x1 = cl.x - ux * cl.R * 0.9, y1 = cl.y - uy * cl.R * 0.9;
        ctx.strokeStyle = rgba(netOf(cl.net).color, 0.35);
        ctx.globalAlpha = related ? 0.4 : 1;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // связи операций
    for (const op of ops.values()) {
      if (!op.show) continue;
      const hot = focusOp === op || (selected && selected !== "core" && selected.ops.has(op.id)) || hover === op;
      ctx.lineWidth = (hot ? 1.8 : 1) / k;
      for (const m of op.live) {
        ctx.globalAlpha = hot ? 0.85 : related ? 0.05 : 0.2;
        ctx.strokeStyle = netOf(m.net).color;
        const mx = (op.x + m.dx) / 2 - (m.dy - op.y) * 0.12, my = (op.y + m.dy) / 2 + (m.dx - op.x) * 0.12;
        ctx.beginPath(); ctx.moveTo(op.x, op.y); ctx.quadraticCurveTo(mx, my, m.dx, m.dy); ctx.stroke();
      }
    }

    // траектория выбранной точки на плоскости: как менялась оценка
    if (plane && selected && selected !== "core" && selected.track.length > 1) {
      const pts = selected.track.map((p) => [p.loy * PS, -p.sup * PS]);
      pts[pts.length - 1] = [selected.dx, selected.dy];
      const col = netOf(selected.net).color;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2 / k;
      ctx.setLineDash([6 / k, 5 / k]);
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.setLineDash([]);
      pts.slice(0, -1).forEach(([x, y], i) => {
        ctx.globalAlpha = 0.35 + 0.5 * (i / pts.length);
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(x, y, 4 / k, 0, TAU); ctx.fill();
      });
      ctx.globalAlpha = 1;
    }

    // точки: свечение (мелкие на экране — без свечения, его всё равно не видно)
    ctx.globalCompositeOperation = "lighter";
    const minGlow = quality ? 2.5 : 7;
    for (const n of drawn) {
      if (n.r * k < minGlow) continue;
      const sc = popScale(n, t);
      const r = n.r * sc, g = r * 2.6;
      ctx.globalAlpha = (related && !related.has(n) ? dim : 1) * 0.55;
      ctx.drawImage(netOf(n.net).glow, n.dx - g, n.dy - g, g * 2, g * 2);
    }
    // точки: тело
    ctx.globalCompositeOperation = "source-over";
    for (const n of drawn) {
      const sc = popScale(n, t);
      if (sc <= 0) continue;
      const r = n.r * sc, col = netOf(n.net).color;
      ctx.globalAlpha = related && !related.has(n) ? dim : 1;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(n.dx, n.dy, r, 0, TAU); ctx.fill();
      if (r * k > 5) {
        ctx.fillStyle = "rgba(255,255,255,0.28)";
        ctx.beginPath(); ctx.arc(n.dx - r * 0.3, n.dy - r * 0.3, r * 0.45, 0, TAU); ctx.fill();
      }
      if (n === selected || n === hover) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2 / k;
        ctx.beginPath(); ctx.arc(n.dx, n.dy, r + 4 / k, 0, TAU); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // ---------- экранные слои ----------
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    // пинги новых точек и кольцо выбранной
    for (const n of drawn) {
      const [x, y] = toScreen(n.dx, n.dy), r0 = n.r * k;
      if (n === selected) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.45;
        ctx.beginPath(); ctx.arc(x, y, r0 + 14, 0, TAU); ctx.stroke();
      }
      if (!n.ping || t - n.ping >= 6000 || t < n.ping) continue;
      const p = ((t - n.ping) % 2000) / 2000;
      ctx.strokeStyle = netOf(n.net).color;
      ctx.globalAlpha = (1 - p) * 0.8;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r0 + 4 + p * 36, 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // хабы операций
    for (const op of ops.values()) {
      if (!op.show) continue;
      const hot = focusOp === op || hover === op || (selected && selected !== "core" && selected.ops.has(op.id));
      const [x, y] = toScreen(op.x, op.y), sz = hot ? 7 : 5;
      ctx.globalAlpha = related && !hot ? 0.25 : 1;
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.moveTo(x, y - sz); ctx.lineTo(x + sz, y); ctx.lineTo(x, y + sz); ctx.lineTo(x - sz, y); ctx.closePath(); ctx.fill();
      if (hot || (k > 0.45 && !related)) {
        const fs = hot ? 12 : 11;
        ctx.font = `700 ${fs}px Manrope, system-ui, sans-serif`;
        const half = ctx.measureText(op.name).width / 2 + 6;
        const lx = Math.min(W - half, Math.max(half, x)); // не вылезать за край экрана
        label(op.name, lx, y - sz - 7, hot ? "#fff" : "rgba(255,255,255,0.6)", fs, "700");
      }
    }
    ctx.globalAlpha = 1;

    if (plane) drawPlaneLabels();
    else if (!solo) drawCore();
    drawLabels(clouds, t);
    if (!nodes.length) { // надпись «карта пуста» — под ядром, где бы оно ни было
      const [x, y] = toScreen(0, 0), el = $("#empty");
      el.style.left = x + "px";
      el.style.top = y + CORE_R * view.k * 1.5 + 18 + "px";
    }
    return busy;
  }

  // сетка плоскости (в мировых координатах, угол уже выпрямлен)
  function drawPlaneGrid(k) {
    const L = LIM * PS;
    ctx.globalCompositeOperation = "source-over";
    // четверти: справа сверху — лояльны и мы сильнее, слева снизу — враждебны и мы слабее
    const tint = [[0, -L, "rgba(30,215,96,0.07)"], [-L, 0, "rgba(255,59,59,0.07)"],
      [-L, -L, "rgba(255,210,31,0.035)"], [0, 0, "rgba(255,210,31,0.035)"]];
    ctx.globalAlpha = 1;
    for (const [x, y, c] of tint) { ctx.fillStyle = c; ctx.fillRect(x, y, L, L); }
    for (let i = -LIM; i <= LIM; i++) {
      ctx.strokeStyle = i === 0 ? "rgba(255,255,255,0.55)" : i % 5 === 0 ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.05)";
      ctx.lineWidth = (i === 0 ? 1.6 : 1) / k;
      ctx.beginPath(); ctx.moveTo(i * PS, -L); ctx.lineTo(i * PS, L); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-L, i * PS); ctx.lineTo(L, i * PS); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1 / k;
    ctx.strokeRect(-L, -L, 2 * L, 2 * L);
  }

  // подписи осей — снаружи сетки, в экранных координатах (не мельчают при отдалении и не лезут на точки)
  function drawPlaneLabels() {
    const L = LIM * PS;
    ctx.globalAlpha = related ? 0.5 : 0.95;
    ctx.textBaseline = "middle";
    // деления вдоль рамки
    for (const v of [-10, -5, 0, 5, 10]) {
      const [x0, y0] = toScreen(v * PS, L), [x1, y1] = toScreen(-L, -v * PS);
      label(signed(v) || "0", x0, y0 + 12, "rgba(255,255,255,0.5)", 11, "600");
      label(signed(v) || "0", x1 - 14, y1, "rgba(255,255,255,0.5)", 11, "600");
    }
    const small = "700 11px Manrope, system-ui, sans-serif", big = "700 13px Unbounded, system-ui, sans-serif";
    // ось X — под сеткой
    const [bl, blY] = toScreen(-L, L), [br] = toScreen(L, L), [bc] = toScreen(0, L);
    ctx.font = big; ctx.fillStyle = "#fff"; ctx.textAlign = "center";
    ctx.fillText("ЛОЯЛЬНОСТЬ", bc, blY + 32);
    ctx.font = small; ctx.fillStyle = "#FF7B7B"; ctx.textAlign = "left";
    ctx.fillText("← враждебны", bl, blY + 32);
    ctx.fillStyle = "#4BE38A"; ctx.textAlign = "right";
    ctx.fillText("лояльны →", br, blY + 32);
    // ось Y — слева от сетки, повёрнута
    const [lx, ty] = toScreen(-L, -L), [, by] = toScreen(-L, L), [, cy] = toScreen(-L, 0);
    ctx.save();
    ctx.translate(lx - 36, 0);
    ctx.rotate(-Math.PI / 2);
    ctx.font = big; ctx.fillStyle = "#fff"; ctx.textAlign = "center";
    ctx.fillText("ПРЕВОСХОДСТВО", -cy, 0);
    ctx.font = small; ctx.fillStyle = "#4BE38A"; ctx.textAlign = "right";
    ctx.fillText("мы сильнее →", -ty, 0);
    ctx.fillStyle = "#FF7B7B"; ctx.textAlign = "left";
    ctx.fillText("← мы слабее", -by, 0);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function popScale(n, t) {
    if (n.born == null) return 1;
    const p = Math.min(1, (t - n.born) / 550);
    return p >= 1 ? 1 : d3.easeBackOut.overshoot(2.2)(p);
  }

  function label(text, x, y, color, size, weight = "600") {
    ctx.font = `${weight} ${size}px Manrope, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = "rgba(4,5,9,0.85)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  const RING_TEXT = "ДВИЖЕНИЕ 42 • 5OPKA • ПРЕМИЯ SLAY • СЕЕМ ХАЙП • ";
  function drawCore() {
    const [x, y] = toScreen(0, 0);
    const r = CORE_R * view.k;
    if (x + r * 3 < 0 || y + r * 3 < 0 || x - r * 3 > W || y - r * 3 > H) return;
    const hot = hover === "core" || selected === "core";
    ctx.globalAlpha = related ? 0.35 : 1;

    ctx.globalCompositeOperation = "lighter";
    const g = r * (hot ? 3.5 : 3.2);
    ctx.globalAlpha *= 0.55;
    ctx.drawImage(whiteGlow, x - g, y - g, g * 2, g * 2);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = related ? 0.35 : 1;

    const body = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
    body.addColorStop(0, "#ffffff");
    body.addColorStop(0.45, "#dfe1ea");
    body.addColorStop(1, "#7d8196");
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();

    // вращающееся кольцо
    ctx.strokeStyle = hot ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.45)";
    ctx.lineWidth = Math.max(1, r * 0.025);
    ctx.setLineDash([r * 0.08, r * 0.06]);
    ctx.lineDashOffset = -angle * r * 6;
    ctx.beginPath(); ctx.arc(x, y, r * 1.14, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);

    // текст по кругу
    if (r > 26) {
      const fs = Math.max(8, r * 0.13);
      ctx.font = `800 ${fs}px Manrope, system-ui, sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const rr = r * 1.32, chars = [...RING_TEXT], step = TAU / chars.length;
      const base = -angle * 3;
      for (let i = 0; i < chars.length; i++) {
        const a = base + i * step;
        ctx.save();
        ctx.translate(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
        ctx.rotate(a + Math.PI / 2);
        ctx.fillText(chars[i], 0, 0);
        ctx.restore();
      }
    }

    ctx.fillStyle = "#06070b";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `900 ${r * 0.74}px Unbounded, system-ui, sans-serif`;
    ctx.fillText("42", x, y - r * 0.06);
    if (r > 30) {
      ctx.font = `800 ${r * 0.15}px Manrope, system-ui, sans-serif`;
      ctx.fillStyle = "rgba(6,7,11,0.7)";
      ctx.fillText("5OPKA", x, y + r * 0.45);
    }
    ctx.globalAlpha = 1;
  }

  function drawLabels(clouds) {
    const k = view.k;
    // подписи облаков
    for (const cl of clouds.values()) {
      const net = netOf(cl.net);
      const [x, y] = toScreen(cl.x, cl.y);
      const Rs = cl.R * k;
      if (Rs < 18) continue;
      const ly = y - Rs - 22;
      ctx.globalAlpha = related ? 0.35 : 0.95;
      ctx.font = `700 ${Math.min(15, Math.max(11, Rs * 0.09))}px Unbounded, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = net.color;
      ctx.fillText(net.name.toUpperCase(), x, ly);
      ctx.font = "600 11px Manrope, system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fillText(`${cl.n} ${plural(cl.n, "точка", "точки", "точек")}`, x, ly + 16);
    }
    ctx.globalAlpha = 1;

    // подписи точек — крупные первыми, без наложений
    const cand = drawn.filter((n) => n === selected || n === hover || (related ? related.has(n) : n.r * k >= 9))
      .sort((a, b) => (b === selected || b === hover) - (a === selected || a === hover) || b.r - a.r)
      .slice(0, 160);
    const boxes = [];
    for (const n of cand) {
      const [x, y] = toScreen(n.dx, n.dy);
      if (x < -50 || x > W + 50 || y < -50 || y > H + 50) continue;
      const fs = Math.round(Math.min(15, Math.max(11, n.r * k * 0.42)));
      // ширину подписи меряем один раз на размер шрифта — measureText на каждом кадре дорогой
      if (!n.lab || n.lab.fs !== fs || n.lab.src !== n.title || n.lab.gen !== fontGen) {
        const text = n.title.length > 28 ? n.title.slice(0, 27) + "…" : n.title;
        ctx.font = `700 ${fs}px Manrope, system-ui, sans-serif`;
        n.lab = { fs, src: n.title, gen: fontGen, text, w: ctx.measureText(text).width + 6 };
      }
      const { text, w } = n.lab, h = fs + 4;
      const ly = y + n.r * k * popScale(n, performance.now()) + fs * 0.5 + 6;
      const box = [x - w / 2, ly - h / 2, x + w / 2, ly + h / 2];
      const force = n === selected || n === hover;
      if (!force && boxes.some((b) => b[0] < box[2] && b[2] > box[0] && b[1] < box[3] && b[3] > box[1])) continue;
      boxes.push(box);
      label(text, x, ly, force ? "#fff" : "rgba(255,255,255,0.86)", fs, "700");
    }
  }

  // ---------------------------------------------------------------- наведение и клики
  function hitTest(sx, sy) {
    const [wx, wy] = toWorld(sx, sy);
    const k = view.k;
    let best = null, bestD = Infinity;
    for (let i = drawn.length - 1; i >= 0; i--) {
      const n = drawn[i];
      const d = Math.hypot(n.dx - wx, n.dy - wy) - n.r;
      if (d < 5 / k && d < bestD) { best = n; bestD = d; }
    }
    if (best) return best;
    for (const op of ops.values()) {
      if (op.show && Math.hypot(op.x - wx, op.y - wy) < 9 / k) return op;
    }
    if (mode === "galaxy" && !solo && Math.hypot(wx, wy) < CORE_R * 1.1) return "core";
    return null;
  }

  const tip = $("#tooltip");
  canvas.addEventListener("pointermove", (e) => {
    pointer = [e.clientX, e.clientY];
    if (e.pointerType === "touch" || dragging) return;
    const h = hitTest(e.clientX, e.clientY);
    if (h !== hover) { hover = h; invalidate(); }
    canvas.classList.toggle("pointing", !!h);
    if (!h) { tip.hidden = true; return; }
    let html;
    if (h === "core") html = `<b>Движение 42</b><span>ядро карты · нажми, чтобы увидеть сводку</span>`;
    else if (h.members) html = `<b>🎯 ${esc(h.name)}</b><span>операция · ${h.members.length} ${plural(h.members.length, "точка", "точки", "точек")}</span>`;
    else {
      const net = netOf(h.net);
      html = `<b>${esc(h.title)}</b><span><i style="--c:${net.color}">${esc(net.name)}</i> · 👥 ${short(h.audience)} · ${h.visits.length} ${plural(h.visits.length, "визит", "визита", "визитов")}</span>`
        + (isRated(h) ? `<span>лояльность ${signed(h.loy)} · превосходство ${signed(h.sup)}</span>` : "");
    }
    tip.innerHTML = html;
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.min(W - tw - 8, e.clientX + 16) + "px";
    tip.style.top = Math.min(H - th - 8, e.clientY + 16) + "px";
  });
  canvas.addEventListener("pointerleave", () => { hover = null; tip.hidden = true; invalidate(); });
  canvas.addEventListener("click", (e) => {
    const h = hitTest(e.clientX, e.clientY);
    if (!h) { if (selected || focusOp) closeDetail(); return; }
    if (h === "core") showCore();
    else if (h.members) showOp(h);
    else {
      selectNode(h, { zoom: false });
      // если точку закрыла карточка — аккуратно сдвинуть карту, не меняя масштаб
      const [x, y] = toScreen(h.dx, h.dy), a = freeArea();
      if (x < a.x || x > a.x + a.w || y < a.y || y > a.y + a.h) focusNode(h, 600, view.k);
    }
  });

  // ---------------------------------------------------------------- панели
  const detail = $("#detail"), detailBody = $("#detailBody");

  function openDetail(html) {
    detailBody.innerHTML = html;
    detail.hidden = false;
    detail.scrollTop = 0;
    computeRelated();
  }
  function closeDetail() {
    selected = null; focusOp = null;
    detail.hidden = true;
    computeRelated();
    setUrl(null);
  }
  $("#detailClose").addEventListener("click", closeDetail);

  function setUrl(param) {
    const u = new URL(location.href);
    u.searchParams.delete("p"); u.searchParams.delete("op");
    if (param) u.searchParams.set(param[0], param[1]);
    try { history.replaceState(null, "", u.pathname + u.search + u.hash); } catch { /* file:// */ }
  }

  function selectNode(n, { zoom = true } = {}) {
    if (!inFilter(n)) { filter.clear(); applyFilter(); }
    if (!inTime(n)) setCutoff(Infinity);
    selected = n; focusOp = null;
    const net = netOf(n.net);
    const visits = [...n.visits].reverse();
    const people = d3.sum(n.visits, (v) => v.people || 0);
    openDetail(`
      <div style="--c:${net.color}">
        <div class="d-net"><span class="dot"></span>${esc(net.name)} <span class="id">#${n.id}</span></div>
        <h2><a href="${esc(safeUrl(n.url))}" target="_blank" rel="noopener">${esc(n.title)}</a></h2>
        <div class="d-url">${esc(n.url.replace(/^https?:\/\//, ""))}</div>
        <div class="d-stats">
          <div><b>${short(n.audience)}</b><span>аудитория</span></div>
          <div><b>${n.visits.length}</b><span>${plural(n.visits.length, "визит", "визита", "визитов")}</span></div>
          <div><b>${people ? short(people) : "—"}</b><span>наших было</span></div>
        </div>
        <a class="d-open" href="${esc(safeUrl(n.url))}" target="_blank" rel="noopener">Открыть ${esc(net.name)} ↗</a>
        ${hooks.nodeActions?.(n) || ""}
        ${planeCard(n)}
        <h3>История</h3>
        ${visits.length ? `<ul class="visits">${visits.map((v) => visitHtml(v, n)).join("")}</ul>` : `<p class="pc-none">Визитов пока нет.</p>`}
      </div>`);
    bindPlaneCard(n);
    setUrl(["p", n.id]);
    if (zoom) focusNode(n);
  }

  // ---------- координатная плоскость в карточке ----------
  const PC = 240, PCK = (PC - 36) / (2 * LIM); // размер SVG и масштаб: пикселей на деление
  const pcX = (v) => PC / 2 + v * PCK, pcY = (v) => PC / 2 - v * PCK;
  let cardLock = false; // пока в карточке двигают точку — не перерисовывать её при обновлении данных

  function planeCard(n) {
    const edit = !!hooks.canEdit?.();
    if (!isRated(n) && !edit) return `<h3>Положение</h3><p class="pc-none">Штаб ещё не оценил эту точку.</p>`;
    const lines = [];
    for (let i = -LIM; i <= LIM; i++) {
      const cls = i === 0 ? "ax" : i % 5 === 0 ? "maj" : "min";
      lines.push(`<line class="${cls}" x1="${pcX(i)}" y1="${pcY(-LIM)}" x2="${pcX(i)}" y2="${pcY(LIM)}"/>`,
        `<line class="${cls}" x1="${pcX(-LIM)}" y1="${pcY(i)}" x2="${pcX(LIM)}" y2="${pcY(i)}"/>`);
    }
    const others = nodes.filter((m) => m !== n && isRated(m)).slice(0, 500)
      .map((m) => `<circle cx="${pcX(m.loy).toFixed(1)}" cy="${pcY(m.sup).toFixed(1)}" r="2.3" fill="${netOf(m.net).color}" opacity=".35"/>`).join("");
    const tr = n.track.length > 1
      ? `<polyline class="pc-track" points="${n.track.map((p) => `${pcX(p.loy)},${pcY(p.sup)}`).join(" ")}"/>`
        + n.track.slice(0, -1).map((p) => `<circle class="pc-past" cx="${pcX(p.loy)}" cy="${pcY(p.sup)}" r="3"/>`).join("")
      : "";
    const col = netOf(n.net).color, L = pcX(LIM), Z = pcX(0);
    return `<h3>Положение</h3>
      <div class="pc" data-pc="${n.id}" style="--c:${col}">
        <svg viewBox="0 0 ${PC} ${PC}" class="${edit ? "editable" : ""}" role="img" aria-label="Лояльность и превосходство">
          <rect x="${Z}" y="${pcY(LIM)}" width="${L - Z}" height="${L - Z}" fill="rgba(30,215,96,.09)"/>
          <rect x="${pcX(-LIM)}" y="${Z}" width="${L - Z}" height="${L - Z}" fill="rgba(255,59,59,.09)"/>
          ${lines.join("")}${others}${tr}
          <text x="${L}" y="${Z - 5}" text-anchor="end">лояльность →</text>
          <text x="${Z + 5}" y="${pcY(LIM) + 10}">↑ превосходство</text>
          <g class="pc-me" ${isRated(n) ? "" : "hidden"}>
            <line class="pc-cross" data-x/><line class="pc-cross" data-y/>
            <circle r="7" fill="${col}"/>
          </g>
        </svg>
        <div class="pc-vals"></div>
        ${edit ? `<div class="pc-edit"><button class="pc-btn" data-pc-save hidden>Сохранить положение</button>
          <button class="pc-btn ghost" data-pc-cancel hidden>Отмена</button></div>` : ""}
      </div>`;
  }

  function paintPlaneCard(box, n, pos) {
    const me = box.querySelector(".pc-me"), vals = box.querySelector(".pc-vals");
    if (!pos) {
      me.setAttribute("hidden", "");
      vals.innerHTML = hooks.canEdit?.() ? "Не оценено — нажми на плоскость, чтобы поставить точку" : "";
      return;
    }
    me.removeAttribute("hidden");
    const x = pcX(pos.loy), y = pcY(pos.sup);
    me.querySelector("circle").setAttribute("cx", x);
    me.querySelector("circle").setAttribute("cy", y);
    const [lx, ly] = me.querySelectorAll("line");
    lx.setAttribute("x1", x); lx.setAttribute("x2", x); lx.setAttribute("y1", pcY(0)); lx.setAttribute("y2", y);
    ly.setAttribute("y1", y); ly.setAttribute("y2", y); ly.setAttribute("x1", pcX(0)); ly.setAttribute("x2", x);
    // стрелка «было → стало»: при перетаскивании — от сохранённого значения, иначе — от прошлой оценки
    const prev = box.dataset.dirty ? (isRated(n) ? n : null) : n.track.length > 1 ? n.track[n.track.length - 2] : null;
    const trend = (a, b) => (b == null || a === b ? "" : a > b ? ` <i class="up">▲${String(a - b).replace(".", ",")}</i>` : ` <i class="down">▼${String(b - a).replace(".", ",")}</i>`);
    vals.innerHTML = `Лояльность <b>${signed(pos.loy)}</b>${trend(pos.loy, prev?.loy)} · Превосходство <b>${signed(pos.sup)}</b>${trend(pos.sup, prev?.sup)}`;
  }

  function bindPlaneCard(n) {
    const box = detailBody.querySelector("[data-pc]");
    cardLock = false;
    if (!box) return;
    paintPlaneCard(box, n, isRated(n) ? { loy: n.loy, sup: n.sup } : null);
    if (!hooks.canEdit?.()) return;
    const svg = box.querySelector("svg"), save = box.querySelector("[data-pc-save]"), cancel = box.querySelector("[data-pc-cancel]");
    let pending = null;
    const place = (e) => {
      const r = svg.getBoundingClientRect();
      const q = (v) => Math.max(-LIM, Math.min(LIM, Math.round(v * 2) / 2)); // шаг 0,5
      pending = {
        loy: q(((e.clientX - r.left) / r.width * PC - PC / 2) / PCK),
        sup: q((PC / 2 - (e.clientY - r.top) / r.height * PC) / PCK),
      };
      box.dataset.dirty = "1";
      cardLock = true;
      paintPlaneCard(box, n, pending);
      save.hidden = cancel.hidden = false;
    };
    svg.addEventListener("pointerdown", (e) => { svg.setPointerCapture(e.pointerId); place(e); });
    svg.addEventListener("pointermove", (e) => { if (svg.hasPointerCapture(e.pointerId)) place(e); });
    cancel.addEventListener("click", () => selectNode(n, { zoom: false }));
    save.addEventListener("click", async () => {
      if (!pending) return;
      save.disabled = cancel.disabled = true;
      save.textContent = "Сохраняю…";
      try {
        await hooks.rate(n, pending.loy, pending.sup);
      } catch (err) {
        save.disabled = cancel.disabled = false;
        save.textContent = "Сохранить положение";
        hooks.error?.(err);
      }
    });
  }

  function showUnrated() {
    const list = nodes.filter((n) => inFilter(n) && !isRated(n)).sort((a, b) => (b.audience || 0) - (a.audience || 0));
    selected = null; focusOp = null;
    openDetail(`
      <div class="d-net" style="--c:#fff"><span class="dot"></span>Плоскость</div>
      <h2>Не оценены: ${list.length}</h2>
      <p class="d-url">${hooks.canEdit?.() ? "Открой точку и поставь её на плоскости в карточке." : "Эти точки штаб ещё не расставил по осям."}</p>
      <ul class="op-list">${list.map((m) => `<li><button data-node="${m.id}" style="--c:${netOf(m.net).color}"><span class="dot"></span><span class="t">${esc(m.title)}</span><span class="m">${short(m.audience)}</span></button></li>`).join("")}</ul>`);
  }

  function visitHtml(v, n) {
    const op = v.op != null ? ops.get(v.op) : null;
    const other = v.link && v.link !== n.url ? ` · <a href="${esc(safeUrl(v.link))}" target="_blank" rel="noopener" style="color:inherit">ссылка ↗</a>` : "";
    return `<li>
      <div class="v-top"><span title="${esc(dtFmt.format(v.at * 1000))}">${esc(ago(v.at))}</span>
        ${op ? `<button class="chip" data-op="${op.id}">🎯 ${esc(op.name)}</button>` : ""}
        ${v.people ? `<span class="chip">🙋 ${full(v.people)}</span>` : ""}</div>
      ${v.text ? `<p class="v-text">${esc(v.text)}</p>` : ""}
      <div class="v-meta">${esc(v.unit || "")}${v.by ? " · " + esc(v.by) : ""}${other}</div>
      ${v.proof ? `<button class="v-proof" data-proof="${esc(proofUrl(v.proof))}" aria-label="Открыть пруф"><img src="${esc(proofUrl(v.proof))}" alt="Пруф" loading="lazy"></button>` : ""}
      ${hooks.visitActions?.(v, n) || ""}
    </li>`;
  }

  function showOp(op) {
    selected = null; focusOp = op;
    const people = d3.sum(op.members, (m) => d3.sum(m.visits.filter((v) => v.op === op.id), (v) => v.people || 0));
    const reach = d3.sum(op.members, (m) => m.audience || 0);
    const members = [...op.members].sort((a, b) => (b.audience || 0) - (a.audience || 0));
    openDetail(`
      <div class="d-net" style="--c:#fff"><span class="dot"></span>Операция</div>
      <h2>🎯 ${esc(op.name)}</h2>
      ${hooks.opActions?.(op) || ""}
      <div class="d-stats">
        <div><b>${members.length}</b><span>${plural(members.length, "точка", "точки", "точек")}</span></div>
        <div><b>${short(reach)}</b><span>охват</span></div>
        <div><b>${people ? short(people) : "—"}</b><span>наших было</span></div>
      </div>
      <h3>Где проводили</h3>
      <ul class="op-list">${members.map((m) => `<li><button data-node="${m.id}" style="--c:${netOf(m.net).color}"><span class="dot"></span><span class="t">${esc(m.title)}</span><span class="m">${short(m.audience)}</span></button></li>`).join("")}</ul>`);
    setUrl(["op", op.id]);
  }

  function showCore() {
    selected = "core"; focusOp = null;
    const byNet = d3.rollups(nodes, (v) => v.length, (n) => n.net).sort((a, b) => b[1] - a[1]);
    const max = byNet[0]?.[1] || 1;
    const allVisits = nodes.flatMap((n) => n.visits.map((v) => ({ v, n }))).sort((a, b) => b.v.at - a.v.at).slice(0, 8);
    const opList = [...ops.values()].sort((a, b) => b.members.length - a.members.length).slice(0, 12);
    openDetail(`
      <div class="d-net" style="--c:#fff"><span class="dot"></span>Ядро</div>
      <h2>Движение 42</h2>
      <div class="d-url">за 5opka · премия SLAY</div>
      <div class="d-stats">
        <div><b>${nodes.length}</b><span>точек</span></div>
        <div><b>${short(d3.sum(nodes, (n) => n.audience || 0))}</b><span>охват</span></div>
        <div><b>${ops.size}</b><span>операций</span></div>
      </div>
      <h3>По соцсетям</h3>
      <div class="bars">${byNet.map(([id, c]) => { const net = netOf(id); return `<div style="--c:${net.color}"><b>${esc(net.name)}</b><i style="width:${(c / max) * 100}%"></i><span>${c}</span></div>`; }).join("")}</div>
      ${opList.length ? `<h3>Операции</h3><ul class="op-list">${opList.map((o) => `<li><button data-op="${o.id}" style="--c:#fff"><span class="dot"></span><span class="t">${esc(o.name)}</span><span class="m">${o.members.length}</span></button></li>`).join("")}</ul>` : ""}
      <h3>Последние захваты</h3>
      <ul class="op-list">${allVisits.map(({ v, n }) => `<li><button data-node="${n.id}" style="--c:${netOf(n.net).color}"><span class="dot"></span><span class="t">${esc(n.title)}</span><span class="m">${esc(ago(v.at))}</span></button></li>`).join("")}</ul>`);
    setUrl(null);
  }

  detail.addEventListener("click", (e) => {
    const op = e.target.closest("[data-op]");
    if (op) { const o = ops.get(+op.dataset.op); if (o) showOp(o); return; }
    const nd = e.target.closest("[data-node]");
    if (nd) { const n = byId.get(+nd.dataset.node); if (n) selectNode(n); return; }
    const pr = e.target.closest("[data-proof]");
    if (pr) { const lb = $("#lightbox"); lb.querySelector("img").src = pr.dataset.proof; lb.hidden = false; }
  });
  $("#lightbox").addEventListener("click", (e) => { e.currentTarget.hidden = true; });

  // ---------------------------------------------------------------- фильтр соцсетей
  const netsEl = $("#nets");
  function renderNets() {
    const counts = d3.rollup(nodes, (v) => v.length, (n) => n.net);
    const list = [...counts].sort((a, b) => b[1] - a[1]);
    const max = list[0]?.[1] || 1;
    netsEl.innerHTML = list.map(([id, c]) => {
      const net = netOf(id), on = filter.has(id), off = filter.size && !on;
      return `<li><button data-net="${id}" class="${on ? "on" : ""} ${off ? "off" : ""}" style="--c:${net.color}" aria-pressed="${on}">
        <span class="dot"></span><span class="n">${esc(net.name)}</span>
        <span class="bar"><i style="width:${(c / max) * 100}%"></i></span><span class="c">${c}</span></button></li>`;
    }).join("");
    $("#netsAll").hidden = !filter.size;
  }
  netsEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-net]");
    if (!b) return;
    const id = b.dataset.net;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      filter.has(id) ? filter.delete(id) : filter.add(id);
    } else if (filter.size === 1 && filter.has(id)) {
      filter.clear();
    } else {
      filter = new Set([id]);
    }
    // на телефоне панель закрывает полэкрана — сворачиваем, чтобы облако было видно
    if (MOBILE()) $("#side").classList.add("collapsed");
    applyFilter();
  });
  $("#netsAll").addEventListener("click", () => { filter.clear(); applyFilter(); });

  function applyFilter() {
    if (selected && selected !== "core" && !inFilter(selected)) closeDetail();
    for (const n of nodes) if (!inFilter(n)) { n.fromX = null; n.wasVisible = false; }
    // скрытые раньше точки прилетают из центра своего облака
    for (const n of nodes) if (inFilter(n) && n.dx == null) { n.dx = 0; n.dy = 0; }
    relayout({ ticks: 220, dur: 1000 });
    renderNets();
    setCutoff(cutoff);
    updateUnrated();
    fitView(1000);
  }

  // ---------------------------------------------------------------- режимы: галактика / плоскость
  const PLANE_R = 0.38; // на плоскости кружки мельче, чтобы не закрывать друг друга и стоять точно на своих координатах
  function setModeButtons() {
    document.querySelectorAll("#modes [data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    document.body.classList.toggle("plane-mode", mode === "plane");
  }
  function setMode(m, { fit = true } = {}) {
    if (m === mode) return;
    mode = m;
    setModeButtons();
    for (const n of nodes) { n.r = m === "plane" ? n.rg * PLANE_R : n.rg; n.lab = null; }
    if (m === "plane") layoutPlane(1100);
    else layout({ ticks: 40, dur: 1100 });
    if (selected === "core") closeDetail();
    updateUnrated();
    const u = new URL(location.href);
    m === "plane" ? u.searchParams.set("view", "plane") : u.searchParams.delete("view");
    try { history.replaceState(null, "", u.pathname + u.search + u.hash); } catch { /* file:// */ }
    if (fit) fitView(1000);
  }
  document.querySelectorAll("#modes [data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

  function updateUnrated() {
    const el = $("#unrated"), count = nodes.filter((n) => inFilter(n) && !isRated(n)).length;
    el.hidden = mode !== "plane" || !count;
    el.textContent = `Не оценены: ${count} ${plural(count, "точка", "точки", "точек")}`;
  }
  $("#unrated").addEventListener("click", showUnrated);

  // ---------------------------------------------------------------- поиск
  const search = $("#search"), results = $("#results");
  let resultItems = [], kbIndex = -1;
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    kbIndex = -1;
    if (!q) { results.hidden = true; return; }
    const hits = [];
    for (const op of ops.values()) if (op.name.toLowerCase().includes(q)) hits.push({ op });
    for (const n of nodes) if (n.title.toLowerCase().includes(q) || n.url.toLowerCase().includes(q)) hits.push({ n });
    hits.sort((a, b) => ((b.n?.audience || 0) - (a.n?.audience || 0)));
    resultItems = hits.slice(0, 9);
    results.innerHTML = resultItems.length
      ? resultItems.map((h, i) => h.op
        ? `<li><button data-i="${i}"><span>🎯</span><span class="t">${esc(h.op.name)}</span><span class="m">операция</span></button></li>`
        : `<li><button data-i="${i}"><span class="dot" style="width:9px;height:9px;border-radius:50%;background:${netOf(h.n.net).color}"></span><span class="t">${esc(h.n.title)}</span><span class="m">${short(h.n.audience)}</span></button></li>`).join("")
      : `<li style="padding:8px;color:var(--muted)">Ничего не найдено</li>`;
    results.hidden = false;
  });
  function pickResult(i) {
    const h = resultItems[i];
    if (!h) return;
    results.hidden = true;
    search.blur();
    if (h.op) showOp(h.op); else selectNode(h.n);
    if (MOBILE()) $("#side").classList.add("collapsed");
  }
  results.addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b) pickResult(+b.dataset.i); });
  search.addEventListener("keydown", (e) => {
    const btns = results.querySelectorAll("button");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      kbIndex = Math.max(0, Math.min(btns.length - 1, kbIndex + (e.key === "ArrowDown" ? 1 : -1)));
      btns.forEach((b, i) => b.classList.toggle("kb", i === kbIndex));
    } else if (e.key === "Enter") pickResult(Math.max(0, kbIndex));
    else if (e.key === "Escape") { search.value = ""; results.hidden = true; search.blur(); }
  });

  // ---------------------------------------------------------------- таймлайн
  const range = $("#time");
  function setCutoff(c) {
    cutoff = c;
    const v = c === Infinity ? 1000 : Math.round(((c - tMin) / Math.max(1, tMax - tMin)) * 1000);
    range.value = v;
    range.style.setProperty("--p", v / 10 + "%");
    $("#whenDate").textContent = c === Infinity ? "сейчас" : dateFmt.format(c * 1000).replace(/\s?г\.$/, "");
    const count = nodes.filter((n) => inFilter(n) && inTime(n)).length;
    $("#whenCount").textContent = `${count} ${plural(count, "точка", "точки", "точек")}`;
    updateStats();
    drawHist();
    invalidate();
  }
  range.addEventListener("input", () => {
    stopPlay();
    const v = +range.value;
    setCutoff(v >= 1000 ? Infinity : tMin + ((tMax - tMin) * v) / 1000);
  });
  $("#play").addEventListener("click", () => (playing ? stopPlay() : startPlay()));
  function startPlay() {
    if (!nodes.length) return;
    if (cutoff === Infinity || cutoff >= tMax) setCutoff(tMin);
    playing = true;
    $("#play").textContent = "❚❚";
    closeDetail();
  }
  function stopPlay() { playing = false; $("#play").textContent = "▶"; }
  function stepTimeline(dt) {
    if (!playing) return;
    const span = Math.max(1, tMax - tMin);
    const next = cutoff + (span / 14) * dt; // вся история — за 14 секунд
    if (next >= tMax) { setCutoff(Infinity); stopPlay(); } else setCutoff(next);
  }
  function drawHist() {
    const w = hist.width, h = hist.height;
    hctx.clearRect(0, 0, w, h);
    if (!nodes.length || tMax <= tMin) return;
    const bins = 72, counts = new Array(bins).fill(0);
    for (const n of nodes) if (inFilter(n)) counts[Math.min(bins - 1, Math.floor(((n.at - tMin) / (tMax - tMin)) * bins))]++;
    const max = Math.max(...counts), bw = w / bins;
    const cut = cutoff === Infinity ? bins : ((cutoff - tMin) / (tMax - tMin)) * bins;
    for (let i = 0; i < bins; i++) {
      if (!counts[i]) continue;
      const bh = Math.max(2 * DPR, (counts[i] / max) * h);
      hctx.fillStyle = i < cut ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.18)";
      hctx.fillRect(i * bw + bw * 0.15, h - bh, bw * 0.7, bh);
    }
  }

  // ---------------------------------------------------------------- счётчики
  const statEls = {};
  document.querySelectorAll("#stats [data-k]").forEach((el) => (statEls[el.dataset.k] = { el, cur: 0, target: 0 }));
  function updateStats() {
    const vis = nodes.filter((n) => inFilter(n) && inTime(n));
    let visits = 0, people = 0;
    for (const n of vis) for (const v of n.visits) if (v.at <= cutoff) { visits++; people += v.people || 0; }
    statEls.places.target = vis.length;
    statEls.audience.target = d3.sum(vis, (n) => n.audience || 0);
    statEls.visits.target = visits;
    statEls.people.target = people;
  }
  function tweenStats(dt) {
    let moving = false;
    for (const [k, s] of Object.entries(statEls)) {
      if (s.cur === s.target) continue;
      s.cur += (s.target - s.cur) * Math.min(1, dt * 7);
      if (Math.abs(s.target - s.cur) < 0.5) s.cur = s.target;
      else moving = true;
      s.el.textContent = k === "audience" ? short(s.cur) : full(s.cur);
    }
    return moving;
  }

  // ---------------------------------------------------------------- тосты
  function toast(n) {
    const net = netOf(n.net);
    const el = document.createElement("div");
    el.className = "toast";
    el.style.setProperty("--c", net.color);
    el.innerHTML = `<span class="dot"></span><span>Новая точка: <b>${esc(n.title)}</b> · ${esc(net.name)}</span>`;
    el.addEventListener("click", () => selectNode(n));
    $("#toasts").append(el);
    setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 350); }, 6000);
  }

  // ---------------------------------------------------------------- данные
  function ingest(data, initial) {
    current = data;
    for (const net of [...AtlasNet.NETWORKS, ...(data.networks || [])]) {
      if (!nets.has(net.id)) {
        nets.set(net.id, {
          ...net,
          glow: sprite(net.color, [[0, 0.85], [0.2, 0.3], [0.55, 0.06], [1, 0]]),
          fog: sprite(net.color, [[0, 0.55], [0.4, 0.22], [0.75, 0.05], [1, 0]]),
          seed: [...net.id].reduce((a, ch) => a + ch.charCodeAt(0), 0) * 0.37,
        });
      }
    }
    const seen = new Set(), added = [];
    let structural = initial;
    for (const p of data.places) {
      let n = byId.get(p.id);
      if (!n) {
        n = { id: p.id, ops: new Set() };
        byId.set(p.id, n);
        nodes.push(n);
        if (!initial) { added.push(n); n.dx = 0; n.dy = 0; n.ping = performance.now() + 900; }
        structural = true;
      }
      const oldR = n.rg, oldNet = n.net, oldPos = `${n.loy}|${n.sup}`;
      Object.assign(n, {
        net: p.net, title: p.title, url: p.url, audience: p.audience, at: p.at, visits: p.visits || [],
        loy: p.loy ?? null, sup: p.sup ?? null, track: p.track || [],
      });
      n.people = d3.sum(n.visits, (v) => v.people || 0) || null;
      n.rg = radius(n);
      n.r = mode === "plane" ? n.rg * PLANE_R : n.rg;
      if (oldNet && oldNet !== n.net) { n.offX = null; structural = true; }
      if (oldR && Math.abs(oldR - n.rg) > 0.5) structural = true;
      if (mode === "plane" && oldNet && oldPos !== `${n.loy}|${n.sup}`) structural = true;
      seen.add(p.id);
    }
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (!seen.has(nodes[i].id)) {
        if (selected === nodes[i]) closeDetail();
        byId.delete(nodes[i].id);
        nodes.splice(i, 1);
        structural = true;
      }
    }
    ops = new Map();
    for (const o of data.operations) ops.set(o.id, { id: o.id, name: o.name, members: [] });
    for (const n of nodes) {
      n.ops = new Set();
      for (const v of n.visits) if (v.op != null && ops.has(v.op) && !n.ops.has(v.op)) { n.ops.add(v.op); ops.get(v.op).members.push(n); }
    }
    if (focusOp) focusOp = ops.get(focusOp.id) || null;

    tMin = nodes.length ? d3.min(nodes, (n) => n.at) - 3600 : 0;
    tMax = Math.max(Date.now() / 1000, d3.max(nodes, (n) => n.at) || 0);
    $("#empty").hidden = nodes.length > 0;

    if (structural) {
      if (initial) {
        for (const n of nodes) { n.dx = 0; n.dy = 0; }
        relayout({ fresh: true, ticks: 320, dur: 1600 });
      } else relayout({ ticks: 180, dur: 1400 });
    }
    renderNets();
    setCutoff(cutoff === Infinity ? Infinity : Math.min(cutoff, tMax));
    updateUnrated();
    if (initial) fitView(0);
    else if (!userMoved && structural) fitView(1200);

    // перерисовать открытую карточку (но не мешать, если в ней прямо сейчас двигают точку)
    if (!cardLock) {
      if (selected === "core") showCore();
      else if (selected && byId.has(selected.id)) { const keep = selected; selectNode(keep, { zoom: false }); }
      else if (focusOp) showOp(focusOp);
    }
    computeRelated();
    added.forEach(toast);
    hooks.onData?.(data);
  }

  // ---------------------------------------------------------------- откуда брать данные
  //  • демо (window.ATLAS_DEMO из data.js) — показательная карта, точки прилетают по таймеру;
  //  • GitHub Pages — бот пишет data.json в ветку atlas-data того же репозитория, читаем через API GitHub;
  //  • иначе — локальный сервер бота (data.json рядом со страницей).
  const CFG = window.ATLAS_CONFIG || {};
  const DEMO = window.ATLAS_DEMO || null;
  const SRC = (() => {
    if (DEMO) return { kind: "demo", every: 9000 };
    let repo = CFG.repo;
    const gh = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
    if (!repo && gh) {
      const seg = location.pathname.split("/").filter(Boolean)[0];
      repo = `${gh[1]}/${seg && !seg.includes(".") ? seg : `${gh[1]}.github.io`}`;
    }
    if (repo) {
      const branch = CFG.branch || "atlas-data";
      const apiBase = CFG.apiBase || "https://api.github.com";
      const raw = `${CFG.rawBase || "https://raw.githubusercontent.com"}/${repo}/${branch}/`;
      return {
        kind: "github", every: 20000, raw, repo, branch, apiBase,
        api: `${apiBase}/repos/${repo}/contents/data.json?ref=${encodeURIComponent(branch)}`,
      };
    }
    return { kind: "local", every: 8000 };
  })();
  const proofUrl = (p) => (SRC.kind === "github" && !/^https?:/.test(p) ? SRC.raw + p : p);
  const EMPTY = { rev: 0, places: [], operations: [], networks: [] };

  async function fetchData() {
    if (SRC.kind === "demo") return DEMO;
    if (SRC.kind === "local") {
      const r = await fetch("data.json", { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }
    // API GitHub: браузер сам переспрашивает по ETag, ответы 304 не тратят лимит запросов.
    // Если вошёл штаб — читаем с его ключом: лимит запросов больше и данные свежее.
    try {
      const r = await fetch(SRC.api, {
        headers: { Accept: "application/vnd.github.raw+json", ...(hooks.authHeader?.() || {}) }, cache: "no-cache",
      });
      if (r.status === 404) return EMPTY; // бот ещё ничего не записал
      if (r.ok) return r.json();
    } catch { /* пробуем запасной путь */ }
    const r = await fetch(`${SRC.raw}data.json?t=${Date.now()}`, { cache: "no-store" });
    if (r.status === 404) return EMPTY;
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }

  function prepareDemo() {
    // сдвинуть даты так, будто данные собраны только что
    const shift = Math.floor(Date.now() / 1000) - DEMO.generated;
    for (const p of [...DEMO.places, ...DEMO.live]) {
      p.at += shift;
      for (const v of p.visits) v.at += shift;
    }
  }
  function demoTick() {
    const p = DEMO.live.shift();
    if (!p) return;
    const now = Math.floor(Date.now() / 1000);
    p.at = now;
    for (const v of p.visits) v.at = now;
    DEMO.places.push(p);
    ingest(DEMO, false);
  }

  let loading = false;
  async function load(initial = false) {
    if (loading) return;
    loading = true;
    try {
      const data = await fetchData();
      if (initial || SRC.kind === "demo" || data.rev !== rev) {
        rev = data.rev;
        ingest(data, initial);
      }
    } catch (e) {
      console.warn("Атлас: не удалось загрузить данные", e);
      if (initial) ingest(EMPTY, true);
    } finally {
      loading = false;
    }
  }
  function poll() {
    if (document.hidden) return; // вкладка в фоне — не дёргаем сеть
    if (SRC.kind === "demo") demoTick();
    else load(false);
  }

  // ---------------------------------------------------------------- кнопки
  $("#zoomIn").addEventListener("click", () => d3.select(canvas).transition().duration(300).call(zoom.scaleBy, 1.5));
  $("#zoomOut").addEventListener("click", () => d3.select(canvas).transition().duration(300).call(zoom.scaleBy, 1 / 1.5));
  $("#zoomFit").addEventListener("click", () => fitView(800));
  $("#spin").classList.toggle("on", spinning);
  $("#spin").addEventListener("click", (e) => { spinning = !spinning; e.currentTarget.classList.toggle("on", spinning); invalidate(); });
  $("#sideToggle").addEventListener("click", () => { $("#side").classList.toggle("collapsed"); });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") { $("#lightbox").hidden = true; closeDetail(); }
    if (e.key === "/" && document.activeElement !== search) { e.preventDefault(); search.focus(); }
  });
  addEventListener("resize", resize);

  // Telegram Mini App: развернуть на весь экран
  if (/tgWebApp/.test(location.hash)) {
    const s = document.createElement("script");
    s.src = "https://telegram.org/js/telegram-web-app.js";
    s.onload = () => { try { Telegram.WebApp.ready(); Telegram.WebApp.expand(); } catch { /* вне Telegram */ } };
    document.head.append(s);
  }

  // для отладки из консоли браузера
  window.__atlas = { nodes, get solo() { return solo; }, get view() { return view; }, get quality() { return quality; } };

  // Интерфейс для панели штаба (admin.js)
  window.Atlas = {
    hooks, SRC, netOf, esc, short, signed, plural, ago,
    get data() { return current; },
    get nodes() { return nodes; },
    get operations() { return ops; },
    get selected() { return selected && selected !== "core" ? selected : null; },
    get focusOp() { return focusOp; },
    apply(data) { rev = data.rev; ingest(data, false); },
    reload: () => load(false),
    select(id, zoom = true) { const n = byId.get(id); if (n) selectNode(n, { zoom }); },
    showOp(id) { const o = ops.get(id); if (o) showOp(o); },
    rerender() {
      if (selected === "core") showCore();
      else if (selected) selectNode(selected, { zoom: false });
      else if (focusOp) showOp(focusOp);
      renderNets();
      invalidate();
    },
    close: () => closeDetail(),
    notify,
  };

  function notify(text, kind = "ok") {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.style.setProperty("--c", kind === "error" ? "#FF3B3B" : "#1ED760");
    el.innerHTML = `<span class="dot"></span><span>${esc(text)}</span>`;
    $("#toasts").append(el);
    setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 350); }, kind === "error" ? 8000 : 4000);
  }

  // ---------------------------------------------------------------- старт
  (async () => {
    if (MOBILE()) $("#side").classList.add("collapsed");
    resize();
    // шрифты не ждём: карта рисуется сразу, а когда они догрузятся — просто перерисуем подписи
    document.fonts?.ready.then(() => { fontGen++; invalidate(); });
    if (DEMO) prepareDemo();
    const q = new URLSearchParams(location.search);
    if (q.get("view") === "plane") { mode = "plane"; setModeButtons(); }
    await load(true);
    const pid = +q.get("p"), oid = +q.get("op");
    if (pid && byId.has(pid)) setTimeout(() => selectNode(byId.get(pid)), 1400);
    else if (oid && ops.has(oid)) setTimeout(() => showOp(ops.get(oid)), 1400);
    setInterval(poll, SRC.every);
    // вернулись на вкладку — сразу обновить
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { lastT = performance.now(); poll(); invalidate(); } });
  })();
})();
