/* Панель штаба: вход по ключу, добавление и правка точек, оценка на плоскости, журнал и откат.
 *
 * Сервера нет: данные карты — файл data.json в ветке atlas-data репозитория с сайтом.
 * Панель читает и записывает его через API GitHub ключом (токеном) того, кто вошёл.
 * Каждое сохранение — коммит с позывным в описании, поэтому любую правку видно в журнале и её можно откатить.
 */
(() => {
  "use strict";
  const A = window.Atlas, N = window.AtlasNet;
  if (!A) return;
  const $ = (s, root = document) => root.querySelector(s);
  const { esc, SRC } = A;
  const hqEl = $("#hq");

  if (SRC.kind !== "github") return; // демо и локальный просмотр — без панели

  // ---------------------------------------------------------------- сессия
  const STORE = "atlas42.hq";
  let session = null; // { token, name, unit }
  try { session = JSON.parse(localStorage.getItem(STORE) || "null"); } catch { session = null; }
  const saveSession = () => { try { session ? localStorage.setItem(STORE, JSON.stringify(session)) : localStorage.removeItem(STORE); } catch { /* приватный режим */ } };

  // ---------------------------------------------------------------- GitHub
  class HQError extends Error {}
  const API = SRC.apiBase, REPO = SRC.repo, BRANCH = SRC.branch, FILE = "data.json";

  async function gh(method, path, body, token = session?.token, accept = "application/vnd.github+json") {
    let r;
    try {
      r = await fetch(API + path, {
        method, cache: "no-store",
        headers: {
          Authorization: `Bearer ${token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new HQError("Нет связи с GitHub. Проверь интернет и попробуй ещё раз.");
    }
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (r.status === 401) throw new HQError("GitHub не принял ключ: он неверный, отозван или истёк.");
    return { status: r.status, data };
  }

  // base64 ↔ UTF-8 (btoa понимает только латиницу)
  function b64encode(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  const b64text = (str) => b64encode(new TextEncoder().encode(str));
  const unb64text = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

  const blank = () => ({ v: 2, rev: 0, places: [], operations: [], campaigns: [], settings: {}, seq: { place: 0, visit: 0, op: 0, campaign: 0 } });

  /** Свежий data.json и его sha (sha нужен GitHub, чтобы не затереть чужое сохранение). */
  async function readData(ref = BRANCH) {
    const path = `/repos/${REPO}/contents/${FILE}?ref=${encodeURIComponent(ref)}`;
    const r = await gh("GET", path);
    if (r.status === 404) return { data: blank(), sha: null };
    if (r.status !== 200) throw new HQError(`GitHub ответил ${r.status} при чтении карты.`);
    let text;
    if (r.data.content && r.data.encoding === "base64") text = unb64text(r.data.content);
    else text = (await gh("GET", path, null, session.token, "application/vnd.github.raw+json")).data; // файл больше 1 МБ
    const data = typeof text === "string" ? JSON.parse(text) : text;
    return { data: normalize(data), sha: r.data.sha };
  }

  function normalize(d) {
    d.places = (d.places || []).map((p) => ({ ...p, visits: p.visits || [], track: p.track || [] }));
    d.operations = d.operations || [];
    d.campaigns = d.campaigns || [];
    d.settings = d.settings || {};
    const maxOf = (arr) => arr.reduce((m, x) => Math.max(m, x.id || 0), 0);
    d.seq = {
      place: Math.max(d.seq?.place || 0, maxOf(d.places)),
      visit: Math.max(d.seq?.visit || 0, maxOf(d.places.flatMap((p) => p.visits))),
      op: Math.max(d.seq?.op || 0, maxOf(d.operations)),
      campaign: Math.max(d.seq?.campaign || 0, maxOf(d.campaigns)),
    };
    delete d.networks; // список соцсетей теперь живёт в самом сайте
    return d;
  }
  const nextId = (d, kind) => ++d.seq[kind];

  /**
   * Сохранить правку: прочитать свежие данные → применить изменение → записать.
   * Если кто-то успел сохранить раньше (конфликт sha) — перечитать и применить ещё раз.
   */
  let saving = Promise.resolve();
  function commit(message, mutate) {
    const job = saving.then(async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const { data, sha } = await readData();
        const result = mutate(data);
        data.rev = (data.rev || 0) + 1;
        data.updated = Math.floor(Date.now() / 1000);
        const r = await gh("PUT", `/repos/${REPO}/contents/${FILE}`, {
          message: `[${session.name}] ${message}`, branch: BRANCH, content: b64text(JSON.stringify(data)),
          ...(sha ? { sha } : {}),
        });
        if (r.status === 200 || r.status === 201) {
          A.apply(data);
          return result;
        }
        if (r.status === 409 || r.status === 422) continue; // кто-то сохранил одновременно — повторяем
        if (r.status === 403 || r.status === 404) throw new HQError("У ключа нет права записи в репозиторий.");
        throw new HQError(`GitHub не сохранил изменения (${r.status}).`);
      }
      throw new HQError("Не удалось сохранить: данные одновременно меняли несколько человек. Попробуй ещё раз.");
    });
    saving = job.catch(() => {});
    return job;
  }

  /** Загрузить картинку-пруф: ужать до 1600 px, JPEG. Возвращает путь в репозитории. */
  async function uploadProof(file) {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.82));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const path = `proofs/${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.jpg`;
    const r = await gh("PUT", `/repos/${REPO}/contents/${path}`, {
      message: `[${session.name}] пруф`, branch: BRANCH, content: b64encode(bytes),
    });
    if (r.status !== 201 && r.status !== 200) throw new HQError(`Пруф не загрузился (${r.status}).`);
    return path;
  }

  // ---------------------------------------------------------------- вход
  async function login(token, name, unit) {
    const r = await gh("GET", `/repos/${REPO}`, null, token);
    if (r.status === 404) throw new HQError(`Ключ не даёт доступа к репозиторию ${REPO}.`);
    if (r.status !== 200) throw new HQError(`GitHub ответил ${r.status}.`);
    if (!r.data.permissions?.push) throw new HQError("Ключ только для чтения — нужен доступ Contents: Read and write.");
    // ветка с данными: если её ещё нет — создаём от основной
    const ref = await gh("GET", `/repos/${REPO}/git/ref/heads/${BRANCH}`, null, token);
    if (ref.status === 404) {
      const base = await gh("GET", `/repos/${REPO}/git/ref/heads/${r.data.default_branch}`, null, token);
      if (base.status !== 200) throw new HQError("Репозиторий пустой — сначала залей в него файлы сайта.");
      const mk = await gh("POST", `/repos/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: base.data.object.sha }, token);
      if (mk.status !== 201) throw new HQError(`Не удалось создать ветку ${BRANCH} (${mk.status}).`);
    }
    session = { token, name, unit };
    saveSession();
  }

  function logout() {
    session = null;
    saveSession();
    renderHQ();
    A.rerender();
    A.notify("Вышел из штаба");
  }

  // окно (модалка) — общее с картой, объявлено в app.js
  const { openModal, closeModal } = A;

  /** Кнопка отправки формы: блокируем на время сохранения, ошибки показываем в форме. */
  function handleSubmit(form, run) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("[type=submit]", form), err = $(".f-err", form);
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = "Сохраняю…"; err.textContent = "";
      try {
        await run(new FormData(form));
      } catch (ex) {
        err.textContent = ex instanceof HQError ? ex.message : `Ошибка: ${ex.message}`;
        if (!(ex instanceof HQError)) console.error(ex);
      } finally {
        btn.disabled = false; btn.textContent = label;
      }
    });
  }

  function showLogin() {
    const f = openModal(`
      <h2>🔑 Вход для штаба</h2>
      <p class="m-lead">Ключ доступа выдаёт главный админ. Он хранится только на этом устройстве.</p>
      <form class="form" autocomplete="off">
        <label>Ключ доступа<input name="token" type="password" required placeholder="github_pat_…" spellcheck="false" autocomplete="off"></label>
        <label>Позывной<input name="name" required maxlength="32" placeholder="как подписывать тебя в журнале"></label>
        <label>Подразделение<input name="unit" maxlength="40" placeholder="например: 3 рота · 2 взвод"></label>
        <p class="f-err" role="alert"></p>
        <button type="submit" class="btn primary">Войти</button>
      </form>`);
    handleSubmit($("form", f), async (fd) => {
      await login(fd.get("token").trim(), fd.get("name").trim(), fd.get("unit").trim());
      closeModal();
      renderHQ();
      A.notify(`Штаб на связи, ${session.name}`);
      await A.reload();
      A.rerender();
    });
  }

  // ---------------------------------------------------------------- формы точек и визитов
  const netOptions = (sel) => N.NETWORKS.map((n) => `<option value="${n.id}" ${n.id === sel ? "selected" : ""}>${esc(n.name)}</option>`).join("");
  const opsDatalist = () => `<datalist id="ops-list">${[...A.operations.values()].map((o) => `<option value="${esc(o.name)}">`).join("")}</datalist>`;
  const keyOf = (p) => p.key || (() => { try { return N.canonical(p.url).key; } catch { return p.url; } })();
  const num = (v) => { const s = String(v ?? "").trim(); if (!s) return null; const n = N.parseCount(s); if (n == null) throw new HQError(`«${s}» — не число. Пример: 15000, 15к, 1,2 млн.`); return n; };
  const fmtNum = (v) => (v == null ? "" : String(v));

  // слайдеры лояльности и превосходства (пусто = не оценено)
  function rateFields(p) {
    const rated = p && p.loy != null;
    const val = (v) => (v == null ? 0 : v);
    return `<fieldset class="f-rate">
      <legend><label class="f-check"><input type="checkbox" name="rated" ${rated ? "checked" : ""}> Поставить на плоскость</label></legend>
      <div class="f-sliders" ${rated ? "" : "hidden"}>
        <label>Лояльность <output>${A.signed(val(p?.loy))}</output>
          <input type="range" name="loy" min="-10" max="10" step="0.5" value="${val(p?.loy)}"></label>
        <label>Наше превосходство <output>${A.signed(val(p?.sup))}</output>
          <input type="range" name="sup" min="-10" max="10" step="0.5" value="${val(p?.sup)}"></label>
      </div>
    </fieldset>`;
  }
  function bindRate(form) {
    const box = $(".f-sliders", form);
    $("[name=rated]", form).addEventListener("change", (e) => { box.hidden = !e.target.checked; });
    form.querySelectorAll("input[type=range]").forEach((r) => r.addEventListener("input", () => {
      r.parentElement.querySelector("output").textContent = A.signed(+r.value);
    }));
  }
  const readRate = (fd) => (fd.get("rated") ? { loy: +fd.get("loy"), sup: +fd.get("sup") } : null);

  function visitFields(v, withDate) {
    const op = v?.op != null ? A.operations.get(v.op)?.name || "" : "";
    const dt = new Date(((v?.at) || Date.now() / 1000) * 1000);
    const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    return `
      <label>Операция <input name="op" list="ops-list" value="${esc(op)}" placeholder="без операции — или название, например «пресейвы Опуса»"></label>
      ${opsDatalist()}
      <label>Что было<textarea name="text" rows="3" maxlength="600" placeholder="коротко: что сделали">${esc(v?.text || "")}</textarea></label>
      <div class="f-row">
        <label>Сколько наших было<input name="people" inputmode="numeric" value="${fmtNum(v?.people)}" placeholder="например 40"></label>
        ${withDate ? `<label>Когда<input name="when" type="datetime-local" value="${local}"></label>` : ""}
      </div>
      <label>Скрин-пруф<input name="proof" type="file" accept="image/*"></label>
      ${v?.proof ? `<label class="f-check"><input type="checkbox" name="dropProof"> Убрать текущий пруф</label>` : ""}`;
  }

  function findOrCreateOp(d, name) {
    name = String(name || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!name) return null;
    const ex = d.operations.find((o) => o.name.toLowerCase() === name.toLowerCase());
    if (ex) return ex.id;
    const id = nextId(d, "op");
    d.operations.push({ id, name });
    return id;
  }

  const wantVisit = (fd) => fd.get("text")?.trim() || fd.get("people")?.trim() || fd.get("op")?.trim() || fd.get("proof")?.size;

  function showAddPlace() {
    const f = openModal(`
      <h2>＋ Новая точка</h2>
      <form class="form" autocomplete="off">
        <label>Ссылка<input name="link" required placeholder="https://t.me/канал, @канал, youtube.com/@…"></label>
        <p class="f-detect"></p>
        <div class="f-row">
          <label>Название<input name="title" required maxlength="90"></label>
          <label>Соцсеть<select name="net">${netOptions("other")}</select></label>
        </div>
        <label>Аудитория <small>сколько людей в канале</small><input name="audience" placeholder="12к, 1.5м, 12 345"></label>
        ${rateFields(null)}
        <h3>Визит <small>необязательно</small></h3>
        ${visitFields(null, false)}
        <p class="f-err" role="alert"></p>
        <button type="submit" class="btn primary">Сохранить точку</button>
      </form>`);
    const form = $("form", f), det = $(".f-detect", form);
    bindRate(form);
    let found = null, titleTouched = false;
    $("[name=title]", form).addEventListener("input", () => { titleTouched = true; });
    $("[name=link]", form).addEventListener("input", (e) => {
      const link = N.normalize(e.target.value);
      found = null;
      if (!link) { det.textContent = ""; return; }
      const c = N.canonical(link);
      $("[name=net]", form).value = c.net;
      found = A.data?.places.find((p) => keyOf(p) === c.key) || null;
      if (found) {
        det.innerHTML = `♻️ Уже есть точка <b>#${found.id} «${esc(found.title)}»</b> — сохранится как новый визит.`;
        $("[name=title]", form).value = found.title;
      } else {
        det.textContent = `${N.NETWORKS.find((n) => n.id === c.net).name} · ${c.url.replace(/^https:\/\//, "")}`;
        if (!titleTouched) $("[name=title]", form).value = c.handle || c.url.replace(/^https:\/\/(www\.)?/, "");
      }
    });
    handleSubmit(form, async (fd) => {
      const link = N.normalize(fd.get("link"));
      if (!link) throw new HQError("Это не похоже на ссылку.");
      const c = N.canonical(link), audience = num(fd.get("audience")), people = num(fd.get("people")), rate = readRate(fd);
      const proof = fd.get("proof")?.size ? await uploadProof(fd.get("proof")) : null;
      const now = Math.floor(Date.now() / 1000);
      const title = fd.get("title").trim().slice(0, 90);
      const id = await commit(found ? `визит в «${found.title}»` : `добавил «${title}»`, (d) => {
        let p = d.places.find((x) => keyOf(x) === c.key);
        if (!p) {
          p = { id: nextId(d, "place"), key: c.key, net: fd.get("net"), url: c.url, title, audience, at: now, visits: [], track: [] };
          d.places.push(p);
        } else if (audience != null) p.audience = audience;
        if (rate) setRate(p, rate, now);
        if (wantVisit(fd) || proof) {
          p.visits.push({
            id: nextId(d, "visit"), op: findOrCreateOp(d, fd.get("op")), link, text: fd.get("text").trim(),
            people, unit: session.unit, by: session.name, at: now, proof,
          });
        }
        return p.id;
      });
      closeModal();
      A.notify("Точка на карте");
      A.select(id);
    });
  }

  function setRate(p, { loy, sup }, at) {
    if (p.loy === loy && p.sup === sup) return;
    p.loy = loy; p.sup = sup;
    p.track = [...(p.track || []), { at, loy, sup, by: session.name }].slice(-50);
  }

  function showEditPlace(id) {
    const p = A.data.places.find((x) => x.id === id);
    if (!p) return;
    const f = openModal(`
      <h2>✏️ Точка #${p.id}</h2>
      <form class="form" autocomplete="off">
        <label>Ссылка<input name="link" required value="${esc(p.url)}"></label>
        <div class="f-row">
          <label>Название<input name="title" required maxlength="90" value="${esc(p.title)}"></label>
          <label>Соцсеть<select name="net">${netOptions(p.net)}</select></label>
        </div>
        <label>Аудитория<input name="audience" value="${fmtNum(p.audience)}" placeholder="12к, 1.5м, 12 345"></label>
        ${rateFields(p)}
        <p class="f-err" role="alert"></p>
        <div class="f-actions">
          <button type="submit" class="btn primary">Сохранить</button>
          <button type="button" class="btn danger" data-del>Удалить точку</button>
        </div>
      </form>`);
    const form = $("form", f);
    bindRate(form);
    $("[data-del]", form).addEventListener("click", async () => {
      if (!confirm(`Удалить точку «${p.title}» со всеми визитами? Вернуть можно через журнал.`)) return;
      try {
        await commit(`удалил «${p.title}»`, (d) => { d.places = d.places.filter((x) => x.id !== id); });
        closeModal(); A.close(); A.notify("Точка удалена");
      } catch (e) { $(".f-err", form).textContent = e.message; }
    });
    handleSubmit(form, async (fd) => {
      const link = N.normalize(fd.get("link"));
      if (!link) throw new HQError("Это не похоже на ссылку.");
      const c = N.canonical(link), audience = num(fd.get("audience")), rate = readRate(fd);
      const now = Math.floor(Date.now() / 1000);
      await commit(`изменил «${fd.get("title").trim()}»`, (d) => {
        const x = d.places.find((q) => q.id === id);
        if (!x) throw new HQError("Эту точку уже удалили.");
        Object.assign(x, { url: c.url, key: c.key, title: fd.get("title").trim().slice(0, 90), net: fd.get("net"), audience });
        if (rate) setRate(x, rate, now);
        else x.loy = x.sup = null; // снять с плоскости; прошлые оценки остаются в истории
      });
      closeModal();
      A.notify("Сохранено");
    });
  }

  function showVisit(placeId, visitId = null) {
    const p = A.data.places.find((x) => x.id === placeId);
    const v = visitId ? p?.visits.find((x) => x.id === visitId) : null;
    if (!p) return;
    const f = openModal(`
      <h2>${v ? "✏️ Визит" : "＋ Визит"} <small>· ${esc(p.title)}</small></h2>
      <form class="form" autocomplete="off">
        ${visitFields(v, true)}
        <p class="f-err" role="alert"></p>
        <button type="submit" class="btn primary">Сохранить визит</button>
      </form>`);
    handleSubmit($("form", f), async (fd) => {
      const people = num(fd.get("people"));
      const proof = fd.get("proof")?.size ? await uploadProof(fd.get("proof")) : null;
      const at = fd.get("when") ? Math.floor(new Date(fd.get("when")).getTime() / 1000) : Math.floor(Date.now() / 1000);
      await commit(`${v ? "изменил" : "добавил"} визит в «${p.title}»`, (d) => {
        const x = d.places.find((q) => q.id === placeId);
        if (!x) throw new HQError("Эту точку уже удалили.");
        const op = findOrCreateOp(d, fd.get("op"));
        if (v) {
          const y = x.visits.find((q) => q.id === visitId);
          if (!y) throw new HQError("Этот визит уже удалили.");
          Object.assign(y, { op, text: fd.get("text").trim(), people, at });
          if (proof) y.proof = proof;
          else if (fd.get("dropProof")) y.proof = null;
        } else {
          x.visits.push({ id: nextId(d, "visit"), op, link: x.url, text: fd.get("text").trim(), people,
            unit: session.unit, by: session.name, at, proof });
        }
        x.visits.sort((a, b) => a.at - b.at);
      });
      closeModal();
      A.notify("Визит сохранён");
    });
  }

  async function deleteVisit(placeId, visitId) {
    const p = A.data.places.find((x) => x.id === placeId);
    if (!p || !confirm("Удалить этот визит?")) return;
    try {
      await commit(`удалил визит в «${p.title}»`, (d) => {
        const x = d.places.find((q) => q.id === placeId);
        if (x) x.visits = x.visits.filter((v) => v.id !== visitId);
      });
      A.notify("Визит удалён");
    } catch (e) { A.notify(e.message, "error"); }
  }

  function showEditOp(id) {
    const op = A.operations.get(id);
    if (!op) return;
    const f = openModal(`
      <h2>🎯 Операция</h2>
      <form class="form" autocomplete="off">
        <label>Название<input name="name" required maxlength="80" value="${esc(op.name)}"></label>
        <p class="f-err" role="alert"></p>
        <div class="f-actions">
          <button type="submit" class="btn primary">Переименовать</button>
          <button type="button" class="btn danger" data-del>Удалить операцию</button>
        </div>
      </form>`);
    const form = $("form", f);
    $("[data-del]", form).addEventListener("click", async () => {
      if (!confirm(`Удалить операцию «${op.name}»? Визиты останутся, просто без операции.`)) return;
      try {
        await commit(`удалил операцию «${op.name}»`, (d) => {
          d.operations = d.operations.filter((o) => o.id !== id);
          for (const p of d.places) for (const v of p.visits) if (v.op === id) v.op = null;
        });
        closeModal(); A.close(); A.notify("Операция удалена");
      } catch (e) { $(".f-err", form).textContent = e.message; }
    });
    handleSubmit(form, async (fd) => {
      const name = fd.get("name").replace(/\s+/g, " ").trim().slice(0, 80);
      await commit(`переименовал операцию в «${name}»`, (d) => {
        const o = d.operations.find((x) => x.id === id);
        if (o) o.name = name;
      });
      closeModal();
      A.notify("Сохранено");
    });
  }

  // ---------------------------------------------------------------- плановые новости
  const REMIND_OPTS = [0, 5, 15, 30, 60];
  function toLocal(at) {
    const d = new Date((at || Date.now() / 1000 + 3600) * 1000);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  function campaignForm(c) {
    const rm = c?.remindMin ?? 15;
    return `
      <label>Название канала<input name="title" required maxlength="90" value="${esc(c?.title || "")}" placeholder="куда постим — например «Мемы стримеров»"></label>
      <label>Ссылка на канал<input name="link" value="${esc(c?.link || "")}" placeholder="https://t.me/…"></label>
      <div class="f-row">
        <label>Когда постим<input name="when" type="datetime-local" required value="${toLocal(c?.at)}"></label>
        <label>Напомнить за<select name="remindMin">${REMIND_OPTS.map((m) => `<option value="${m}" ${m === rm ? "selected" : ""}>${m ? m + " мин" : "не напоминать"}</option>`).join("")}</select></label>
      </div>
      <label>Текст для вставки <small>его все будут копировать и постить</small>
        <textarea name="text" rows="8" placeholder="Большой текст новости о боссе — с эмодзи, ссылками, как есть">${esc(c?.text || "")}</textarea></label>`;
  }
  function showAddCampaign() {
    const f = openModal(`<h2>📣 Запланировать новость</h2>
      <form class="form" autocomplete="off">${campaignForm(null)}
        <p class="f-err" role="alert"></p>
        <button type="submit" class="btn primary">Запланировать</button></form>`);
    handleSubmit($("form", f), async (fd) => {
      const at = Math.floor(new Date(fd.get("when")).getTime() / 1000);
      if (!at) throw new HQError("Укажи дату и время.");
      await commit(`запланировал новость «${fd.get("title").trim()}»`, (d) => {
        d.campaigns = d.campaigns || [];
        d.campaigns.push({ id: nextId(d, "campaign"), title: fd.get("title").trim().slice(0, 90), link: N.normalize(fd.get("link")) || fd.get("link").trim(),
          at, remindMin: +fd.get("remindMin"), text: fd.get("text"), by: session.name, createdAt: Math.floor(Date.now() / 1000) });
      });
      closeModal(); A.openNews(); A.notify("Новость запланирована");
    });
  }
  function showEditCampaign(id) {
    const c = (A.data.campaigns || []).find((x) => x.id === id);
    if (!c) return;
    const f = openModal(`<h2>✏️ Новость</h2>
      <form class="form" autocomplete="off">${campaignForm(c)}
        <p class="f-err" role="alert"></p>
        <div class="f-actions"><button type="submit" class="btn primary">Сохранить</button>
          <button type="button" class="btn danger" data-del>Удалить</button></div></form>`);
    const form = $("form", f);
    $("[data-del]", form).addEventListener("click", async () => {
      if (!confirm(`Удалить новость «${c.title}»?`)) return;
      try {
        await commit(`удалил новость «${c.title}»`, (d) => { d.campaigns = (d.campaigns || []).filter((x) => x.id !== id); });
        closeModal(); A.openNews(); A.notify("Новость удалена");
      } catch (e) { $(".f-err", form).textContent = e.message; }
    });
    handleSubmit(form, async (fd) => {
      const at = Math.floor(new Date(fd.get("when")).getTime() / 1000);
      await commit(`изменил новость «${fd.get("title").trim()}»`, (d) => {
        const x = (d.campaigns || []).find((q) => q.id === id);
        if (!x) throw new HQError("Эту новость уже удалили.");
        Object.assign(x, { title: fd.get("title").trim().slice(0, 90), link: N.normalize(fd.get("link")) || fd.get("link").trim(),
          at, remindMin: +fd.get("remindMin"), text: fd.get("text") });
      });
      closeModal(); A.openNews(); A.notify("Сохранено");
    });
  }

  function showSettings() {
    const s = A.data.settings || {};
    const f = openModal(`<h2>⚙️ Настройки</h2>
      <form class="form" autocomplete="off">
        <h3>Кнопка вербовки</h3>
        <label>Надпись<input name="recruitLabel" maxlength="40" value="${esc(s.recruitLabel || "Вступай в ряды батальона")}"></label>
        <label>Ссылка<input name="recruitUrl" value="${esc(s.recruitUrl || "https://t.me/propaganda42news")}" placeholder="https://t.me/…"></label>
        <p class="f-err" role="alert"></p>
        <button type="submit" class="btn primary">Сохранить</button></form>`);
    handleSubmit($("form", f), async (fd) => {
      const url = fd.get("recruitUrl").trim();
      if (url && !N.normalize(url)) throw new HQError("Ссылка выглядит неправильно.");
      await commit("изменил настройки", (d) => {
        d.settings = { ...(d.settings || {}), recruitUrl: url, recruitLabel: fd.get("recruitLabel").trim() };
      });
      closeModal(); A.notify("Настройки сохранены");
    });
  }

  // ---------------------------------------------------------------- журнал и откат
  const dtf = new Intl.DateTimeFormat("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  async function showJournal() {
    const f = openModal(`<h2>📜 Журнал изменений</h2><p class="m-lead">Последние сохранения карты. Любое состояние можно вернуть.</p>
      <ul class="journal"><li class="j-wait">Загружаю…</li></ul><p class="f-err" role="alert"></p>`);
    const list = $(".journal", f);
    try {
      const r = await gh("GET", `/repos/${REPO}/commits?sha=${encodeURIComponent(BRANCH)}&path=${FILE}&per_page=40`);
      if (r.status !== 200) throw new HQError(`GitHub ответил ${r.status}.`);
      if (!r.data.length) { list.innerHTML = `<li class="j-wait">Изменений пока не было.</li>`; return; }
      list.innerHTML = r.data.map((c, i) => `
        <li>
          <div><b>${esc(c.commit.message)}</b><span>${esc(dtf.format(new Date(c.commit.author.date)))}${i === 0 ? " · сейчас на карте" : ""}</span></div>
          ${i === 0 ? "" : `<button class="btn small" data-sha="${esc(c.sha)}" data-msg="${esc(c.commit.message)}">↩ Вернуть так</button>`}
        </li>`).join("");
    } catch (e) {
      list.innerHTML = "";
      $(".f-err", f).textContent = e.message;
    }
    list.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-sha]");
      if (!b || !confirm(`Вернуть карту к состоянию после «${b.dataset.msg}»? Всё, что сделано позже, отменится (но останется в журнале).`)) return;
      b.disabled = true; b.textContent = "Возвращаю…";
      try {
        const old = (await readData(b.dataset.sha)).data;
        await commit(`откат к «${b.dataset.msg.replace(/^\[[^\]]*\]\s*/, "")}»`, (d) => {
          const seq = d.seq; // номера не переиспользуем, чтобы старые ссылки ?p= не вели на чужие точки
          Object.assign(d, old, { seq: {
            place: Math.max(seq.place, old.seq.place), visit: Math.max(seq.visit, old.seq.visit),
            op: Math.max(seq.op, old.seq.op), campaign: Math.max(seq.campaign || 0, old.seq.campaign || 0),
          } });
        });
        closeModal();
        A.notify("Карта возвращена");
      } catch (err) {
        b.disabled = false; b.textContent = "↩ Вернуть так";
        $(".f-err", f).textContent = err.message;
      }
    });
  }

  // ---------------------------------------------------------------- кнопки на карте
  A.hooks.canEdit = () => !!session;
  A.hooks.authHeader = () => (session ? { Authorization: `Bearer ${session.token}` } : {});
  A.hooks.error = (e) => A.notify(e.message || String(e), "error");
  A.hooks.rate = async (n, loy, sup) => {
    await commit(`оценил «${n.title}»: лояльность ${A.signed(loy)}, превосходство ${A.signed(sup)}`, (d) => {
      const p = d.places.find((x) => x.id === n.id);
      if (!p) throw new HQError("Эту точку уже удалили.");
      setRate(p, { loy, sup }, Math.floor(Date.now() / 1000));
    });
    A.notify("Положение сохранено");
  };
  A.hooks.nodeActions = (n) => (session ? `<div class="hq-actions">
      <button class="btn small" data-hq="edit-place" data-id="${n.id}">✏️ Изменить</button>
      <button class="btn small" data-hq="add-visit" data-id="${n.id}">＋ Визит</button></div>` : "");
  A.hooks.visitActions = (v, n) => (session ? `<div class="v-actions">
      <button class="link-btn" data-hq="edit-visit" data-id="${n.id}" data-v="${v.id}">изменить</button>
      <button class="link-btn danger" data-hq="del-visit" data-id="${n.id}" data-v="${v.id}">удалить</button></div>` : "");
  A.hooks.opActions = (op) => (session ? `<div class="hq-actions">
      <button class="btn small" data-hq="edit-op" data-id="${op.id}">✏️ Переименовать / удалить</button></div>` : "");

  const ACTIONS = {
    login: showLogin, logout, journal: showJournal, "add-place": showAddPlace, settings: showSettings,
    "edit-place": (b) => showEditPlace(+b.dataset.id),
    "add-visit": (b) => showVisit(+b.dataset.id),
    "edit-visit": (b) => showVisit(+b.dataset.id, +b.dataset.v),
    "del-visit": (b) => deleteVisit(+b.dataset.id, +b.dataset.v),
    "edit-op": (b) => showEditOp(+b.dataset.id),
    news: () => A.openNews(),
    "news-add": showAddCampaign,
    "news-edit": (b) => showEditCampaign(+b.dataset.id),
    "news-del": async (b) => {
      const c = (A.data.campaigns || []).find((x) => x.id === +b.dataset.id);
      if (!c || !confirm(`Удалить новость «${c.title}»?`)) return;
      try { await commit(`удалил новость «${c.title}»`, (d) => { d.campaigns = (d.campaigns || []).filter((x) => x.id !== c.id); }); A.openNews(); A.notify("Новость удалена"); }
      catch (e) { A.notify(e.message, "error"); }
    },
  };
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-hq]");
    if (!b) return;
    if (b.dataset.hq !== "login" && !session) return showLogin();
    e.preventDefault();
    ACTIONS[b.dataset.hq]?.(b);
  });

  function renderHQ() {
    hqEl.innerHTML = session
      ? `<div class="hq-bar">
           <div class="hq-who"><b>🔑 Штаб</b><span>${esc(session.name)}${session.unit ? " · " + esc(session.unit) : ""}</span></div>
           <button class="btn primary small" data-hq="add-place">＋ Точка</button>
           <button class="btn small" data-hq="news-add">📣 Новость</button>
           <div class="hq-links"><button class="link-btn" data-hq="journal">журнал</button>
             <button class="link-btn" data-hq="settings">настройки</button>
             <button class="link-btn" data-hq="logout">выйти</button></div>
         </div>`
      : `<button class="hq-login link-btn" data-hq="login">🔑 Вход для штаба</button>`;
    let fab = $("#hqFab");
    if (session && !fab) {
      fab = document.createElement("button");
      fab.id = "hqFab"; fab.className = "icon-btn hq-fab"; fab.dataset.hq = "add-place";
      fab.title = fab.ariaLabel = "Добавить точку"; fab.textContent = "＋";
      $(".controls").prepend(fab);
    } else if (!session && fab) fab.remove();
  }
  renderHQ();
})();
