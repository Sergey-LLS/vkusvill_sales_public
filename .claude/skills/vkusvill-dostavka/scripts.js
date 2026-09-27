// Скрипты для vkusvill.ru. Вставлять через javascript_tool на открытой странице сайта
// (кроме read6/push6/sixStep — те только на /offers/, где блок «6 скидок»).
// Всё только читает страницу и делает GET-запросы; кнопки нажимаются отдельно.
// Версия 2.10 (26.09.2026).
// Это исходник с комментариями. В страницу печатаются собранные копии:
//   cart-kit.js    — функции для /cart/ (список CART_FUNCS в build.py, ~7 КБ)
//   scripts.min.js — весь файл без комментариев (для /offers/)
// Собрать после правки: python3 build.py (в папке скилла).
//
// Функции (порядок шагов — в .claude/agents/vkusvill-sborshik-dostavka.md):
//   Цепочки шагов (одно обращение на шаг): cartStep() на /cart/; offersStep(), sixStep(rows),
//   startCollect(brandOnly), collectStatus(), finishCollect(), finalStep(h, name) на /offers/.
//   Ниже — из чего они состоят (не полный список: остальное — по коду).
//   headerInfo()             адрес и слот из шапки сайта
//   readFilters()            состояние постоянных фильтров аккаунта (на /offers/) -> снимок
//   cartSnapshot()           снимок корзины -> __cart0 (и sessionStorage);  cartDiff();  cartSixPlaces()
//   loadLazy(code)           ленивый блок функцией сайта, без прокрутки; lazyWarn/lazyWarnings — если не сработал
//   waitGreen() / readGreen() / greenEmpty()  зелёные ценники (на /cart/);  couponsText()
//   vvCheck()                после вставки: список функций, которых не хватает (должен быть пуст)
//   sixRun(rows) — «6 скидок» запросами (основной путь); sixStep(rows) -> sixCheck — запасной; start6() / push6() наборы блока «6 скидок» -> __sets;  loadSixState(rows) при пересборе;
//                            verify18() в фоне -> __verified
//   scanOffers(opts)         фон, ждать scanStatus().finished; summarizeOffers() -> __all, __rows
//   cabinetInfo()            бонусы, покупки за два дня, Любимый продукт, ВкусБэк, подписка
//   COMBO_EXTRA, findCombos() -> __combos
//   saveData(h, name)        собрать данные отчёта в странице и сохранить одним файлом <дата>.data.json в «Загрузки»
//   auditPromos()            ревизия реестра (после summarizeOffers и findCombos)
//   restoreFilters(snapshot) вернуть фильтры и проверить по свежему HTML
//
// Данные между переходами по страницам живут в sessionStorage (vvSave/vvLoad):
// __sets, __cart0 переживают navigate, остальное — нет.

// ---------- Общее ----------

window.vvGet = async u => new DOMParser().parseFromString(
  await (await fetch(u, { credentials: 'include' })).text(), 'text/html');
window.vvT = (c, s) => c.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() || '';
window.vvNum = s => +String(s ?? '').replace(/\s/g, '').replace(',', '.') || null;
window.vvSave = (k, v) => { try { sessionStorage.setItem('vv_' + k, JSON.stringify(v)); } catch (e) {} return v; };
window.vvLoad = k => { try { return JSON.parse(sessionStorage.getItem('vv_' + k)); } catch (e) { return null; } };

// Адрес и слот доставки из шапки.
window.headerInfo = () => (document.querySelector('header')?.innerText || '').replace(/\s+/g, ' ').slice(0, 120);

// ---------- «6 скидок» ----------

// Шесть карточек текущего набора: href, полное имя из title, короткий текст с ценами.
// Только внутри блока (VV23_6ProdsAuthorized__Inner): после выбора шести мест блок может
// показывать меньше шести карточек — нельзя уходить вверх по странице к общему списку.
window.read6 = () => {
  const box = document.querySelector('.VV23_6ProdsAuthorized__Inner');
  if (!box) return null;
  return [...box.querySelectorAll('.ProductCard')].slice(0, 6).map(c => {
    const a = c.querySelector('a[href*="/goods/"]');
    const t = c.innerText.split('\n').map(s => s.trim()).filter(Boolean);
    return {
      href: (a?.getAttribute('href') || '').split('?')[0],
      name: (a?.getAttribute('title') || '').trim(), // текст ссылки в блоке обрезан, title полный
      txt: t.join(' | ').replace(/ \| В корзину/, ''),
    };
  });
};

// Первый набор: __sets = [read6()], с сохранением в sessionStorage.
window.start6 = () => { const s = read6(); if (!s) return null; window.__sets = [s]; vvSave('sets', __sets); return { sets: 1, s }; };

// После «Обновить товары»: добавить набор, если он новый. Возвращает, сменился ли.
window.push6 = () => {
  const s = read6();
  if (!window.__sets) window.__sets = vvLoad('sets') || [];
  // блок ещё перерисовывается (нет карточек или заглушки без ссылок) — не записывать (2.9)
  if (!s || !s.length || s.some(x => !x.href)) return { state: 'loading', changed: false, sets: __sets.length };
  const last = __sets[__sets.length - 1] || [];
  const same = s.every((x, i) => x.href === last[i]?.href);
  if (!same) __sets.push(s);
  vvSave('sets', __sets);
  return { changed: !same, sets: __sets.length, s };
};

// Что сейчас в блоке «6 скидок» против записанного в файле за сегодня
// (записи type "six" из items.json; файла нет — пустой массив). Решает, листать ли:
//   button — видна «Получить скидки»: нажать (безопасно — при готовой подборке сайт
//            просто снова показывает последний набор) и спросить ещё раз;
//   same   — не меньше 3 из 6 видимых есть среди записанных за сегодня → та же подборка,
//            18 из файла, кнопки не трогать (мягко: закончившийся товар блок может заменить;
//            подборки разных дней не пересекаются — 23.09 и 24.09 ноль общих);
//   other  — на странице товаров из файла нет → новая подборка: записать и листать сколько даст;
//   loading — блок рисует заглушки (карточки без ссылок): не загрузился. sixStep сначала
//             грузит его функцией сайта (loadLazy); прокрутка — запасной путь исполнителя;
//   none   — блок не найден.
window.sixCheck = (arr = []) => {
  const get = [...document.querySelectorAll('[class*="VV23_6Prods"] button, .js-inset-6prods-get')].find(b => /Получить скидки/.test(b.textContent) && b.offsetParent);
  if (get) return { state: 'button' };
  const s = read6();
  if (!s || !s.length || s.some(x => !x.href))   // заглушки: блок есть, товаров нет
    return { state: document.querySelector('[class*="VV23_6Prods"]') ? 'loading' : 'none' };
  const known = new Set(arr.filter(x => !x.type || x.type === 'six').map(x => x.href));
  const match = s.filter(x => known.has(x.href)).length;
  // та же подборка: большинство видимых — из записанных (после выбора шести мест карточек может быть меньше)
  return { state: match >= Math.min(3, s.length) && match > 0 ? 'same' : 'other', match, shown: s.length, visible: s.map(x => x.name.slice(0, 40)) };
};

// sixCheck после загрузки блока без прокрутки: loadLazy('6skidok') и ждать до max мс,
// пока блок не покажет товары или «Получить скидки». Состояния — как у sixCheck.
window.sixStep = async (arr = [], max = 10000) => {
  const lazy = loadLazy('6skidok');
  const t0 = Date.now();
  let r = sixCheck(arr);
  while (r.state === 'loading' && Date.now() - t0 < max) {
    await new Promise(res => setTimeout(res, 500));
    r = sixCheck(arr);
  }
  if (r.state === 'loading' || r.state === 'none') lazyWarn('6skidok', lazy ? 'функция сайта не загрузила блок' : 'заглушка или функция загрузки не найдены');
  else if (lazy) lazyWarn('6skidok', null);
  return { ...r, lazy };
};

// Пересбор в тот же день: наборы из файла отчёта. rows = [{set, href, name}, …].
window.loadSets = rows => {
  const by = {};
  for (const r of rows) (by[r.set] ??= []).push({ href: r.href, name: r.name, txt: r.name });
  window.__sets = Object.keys(by).sort((a, b) => a - b).map(k => by[k]);
  vvSave('sets', __sets);
  return __sets.map(s => s.length);
};

// Проверка всех собранных товаров через поиск по каталогу (по id из href).
// 18 запросов по шесть параллельно, ~10–15 с: запускать в фоне — window.__v = null; verify18().then(r => __v = r) —
// и опрашивать __v; await прямо в javascript_tool упирается в тайм-аут 45 с.
window.verify18 = async () => {
  if (!window.__sets) window.__sets = vvLoad('sets') || [];
  const jobs = __sets.flatMap((set, si) => set.map(x => ({ si, x })));
  const one = async ({ si, x }) => {
      let q = (x.name || x.txt || '').split(' | ').slice(-1)[0].replace(/\.\.\..*$/, '').replace(/[",]/g, ' ').trim();
      const m = (x.href || '').match(/-(\d+)\/?$/);
      if (!q && x.href) { // пересбор по скрытой строке: имени нет — берём заголовок страницы товара
        try { q = vvT(await vvGet(x.href), 'h1').replace(/[",]/g, ' ').trim(); x.name = q; } catch (e) {}
      }
      if (!q) return { set: si + 1, href: x.href, name: '', price: '', old: '', six: 'нет ни имени, ни ссылки', rest: '' };
      const d = await vvGet('/search/?type=products&q=' + encodeURIComponent(q));
      const cards = [...d.querySelectorAll('.ProductCard')];
      // ё=е, без кавычек, скобок и знаков; сравнение по словам от 3 букв
      const norm = t => t.toLowerCase().replace(/ё/g, 'е').replace(/[«»"'.,()~]/g, ' ').replace(/\s+/g, ' ').trim();
      const toks = t => norm(t).split(' ').filter(w => w.length >= 3);
      const score = c => { const w = toks(q), n = norm(cardName(c)); return w.filter(x => n.includes(x)).length / (w.length || 1); };
      // по id из href; если ссылки нет (пересбор из отчёта) — по совпадению названия
      const c = m ? cards.find(c => (c.querySelector('.ProductCard__link')?.getAttribute('href') || '').includes('-' + m[1] + '/'))
        : cards.find(c => norm(cardName(c)) === norm(q))
          || cards.map(c => ({ c, s: score(c) })).filter(h => h.s >= 0.6).sort((a, b) => b.s - a.s)[0]?.c;
      if (c && !m) x.href = (c.querySelector('.ProductCard__link')?.getAttribute('href') || '').split('?')[0];
      // в поиске нет (первая страница) — страница товара: пометка и остаток там же (2.10)
      if (!c && x.href) try {
        const t = (await vvGet(x.href)).body.textContent.replace(/\s+/g, ' ');
        const r = t.match(/В наличии ([\d.,]+ (?:шт|кг)) (\d[\d ]*?) руб\/(?:шт|кг) (\d[\d ]*?) руб/);
        const six = (t.match(/6 скидок -\d+%/) || [])[0];
        if (r || six) return { set: si + 1, href: x.href, name: q, price: r ? r[2].replace(/ /g, '') : '', old: r ? r[3].replace(/ /g, '') : '',
          six: six || '—', rest: r ? 'В наличии ' + r[1] : 'нет в наличии', cat: '' };
      } catch (e) {}
      const T = s => c ? vvT(c, s) : '';
      return {
        set: si + 1, href: x.href,
        name: c ? cardName(c) : q,
        price: T('.js-datalayer-catalog-list-price'),
        old: T('.js-datalayer-catalog-list-price-old'),
        // поиск отдаёт только то, что есть по адресу: «не найден» = скорее всего закончился
        six: c ? (c.textContent.match(/6 скидок -\d+%/) || ['—'])[0] : 'не найден в поиске — вероятно, закончился',
        rest: T('.ProductCard__Rest'),
        cat: T('.js-datalayer-catalog-list-category').split('//')[0],
      };
  };
  const out = [];
  for (let i = 0; i < jobs.length; i += 6) out.push(...await Promise.all(jobs.slice(i, i + 6).map(one))); // по шесть параллельно
  window.__verified = out;
  vvSave('sets', __sets);
  return out.map(o => [o.set, o.name.slice(0, 50), o.price + '←' + o.old, o.six, o.rest].join(' | ')).join('\n');
};

// Пересбор в тот же день: записи type "six" из items.json (функция сама фильтрует по type).
window.loadSixState = arr => loadSets(arr.filter(x => !x.type || x.type === 'six').map(x => ({ set: x.set, href: x.href, name: x.name || '' })));

// ---------- «6 скидок» запросами (2.10) ----------
// Кнопки блока — это запросы POST /ajax/inset_6prods.php (найдено в коде сайта 26.09):
//   «Получить скидки» (.js-inset-6prods-get)   command=getTovAbonement — только показ текущего набора;
//   «Обновить товары» (.js-inset-6prods-update) command=updTovAbonement — тратит одно из двух
//   обновлений дня; лимит кончился — success "N" и error_text «…до 2 раз в день».
// Ответ — JSON {success, html, error_text}; в html шесть .ProductCard. Блок на странице не нужен.
window.sixApi = async cmd => {
  const uid = document.querySelector('#lk-user-id')?.value || '';
  const r = await fetch('/ajax/inset_6prods.php', { method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
    body: new URLSearchParams({ USER_ID: uid, command: cmd }) });
  const j = await r.json();
  const d = new DOMParser().parseFromString(j.html || '', 'text/html');
  const set = [...d.querySelectorAll('.ProductCard')].slice(0, 6).map(c => {
    const a = c.querySelector('a[href*="/goods/"]');
    const name = (a?.getAttribute('title') || '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    return { href: (a?.getAttribute('href') || '').split('?')[0], name, txt: name };
  });
  return { ok: j.success === 'Y', set, err: (j.error_text || '').trim() };
};
// Записи дня — и в localStorage (данные, не код) по USER_ID и дате: повторный сбор в том же
// браузере не требует перепечатывать 18 записей из файла (2.10).
window.sixKey = () => 'vv6_' + (document.querySelector('#lk-user-id')?.value || '') + '_' + new Date().toLocaleDateString('sv');
window.sixStore = () => { try { localStorage.setItem(sixKey(), JSON.stringify(__sets)); } catch (e) {} };
window.sixCached = () => { try { return JSON.parse(localStorage.getItem(sixKey())) || null; } catch (e) { return null; } };
// Весь шаг «6 скидок» одним вызовом. arr — записи six из файла дня; не передан — берутся из
// localStorage; нет и там — {state:'need_records'} (исполнитель берёт их из файла; нет файла — []).
//   same  — ≥3 из 6 текущих есть среди записей: 18 из записей, новые товары набора дописаны;
//   other — подборка новая: записать и дважды «Обновить» (стандарт пользователя), log — что вышло;
//   none  — запрос не ответил: исполнитель идёт старым путём (sixStep и клики).
window.sixRun = async (arr) => {
  let rows = arr;
  if (!rows) {
    const cached = sixCached();
    if (cached) rows = cached.flatMap((set, i) => set.map(x => ({ set: i + 1, href: x.href, name: x.name })));
    else return { state: 'need_records' };
  }
  let g; try { g = await sixApi('getTovAbonement'); } catch (e) { g = { ok: false, set: [], err: String(e) }; }
  if (!g.ok || !g.set.length || g.set.some(x => !x.href)) {
    lazyWarn('inset_6prods', 'запрос подборки не ответил: ' + (g.err || 'пусто'));
    return { state: 'none', err: g.err };
  }
  lazyWarn('inset_6prods', null);
  const known = new Set(rows.filter(x => !x.type || x.type === 'six').map(x => x.href));
  const match = g.set.filter(x => known.has(x.href)).length;
  if (match >= Math.min(3, g.set.length)) {
    loadSixState(rows);
    const extra = g.set.filter(x => !known.has(x.href));   // блок заменил закончившийся товар
    if (extra.length && __sets.length) __sets[__sets.length - 1].push(...extra);
    vvSave('sets', __sets); sixStore();
    return { state: 'same', match, sets: __sets.map(s => s.length), from: arr ? 'файл' : 'браузер' };
  }
  window.__sets = [g.set];
  const log = [];
  for (let i = 1; i <= 2; i++) {
    let u; try { u = await sixApi('updTovAbonement'); } catch (e) { u = { ok: false, set: [], err: String(e) }; }
    const last = __sets[__sets.length - 1];
    if (!u.ok) { log.push(`обновление ${i}: ${u.err || 'не прошло'}`); break; }
    if (!u.set.length || u.set.every((x, k) => x.href === last[k]?.href)) { log.push(`обновление ${i}: набор не сменился`); break; }
    __sets.push(u.set);
  }
  vvSave('sets', __sets); sixStore();
  return { state: 'other', match, sets: __sets.length, log };
};

// ---------- Зелёные ценники (на /cart/) ----------
// Ленивые блоки сайта («Зелёные ценники» на /cart/, «6 скидок» на /offers/) — заглушки
// .js-section-block-lazy._ni с data-code. Сайт грузит их, когда заглушка попадает на
// экран (IntersectionObserver): в скрытом окне и при другой раскладке это не срабатывает,
// отсюда ложные нули 24–25.09. loadLazy вызывает ту же функцию сайта напрямую
// (data-func или updateLazyItems) — блок встаёт на страницу с кнопками, без прокрутки
// и без видимости окна (проверено 25.09 в скрытой вкладке). false — заглушки нет
// (блок уже загружен или сайт поменял разметку).
window.loadLazy = code => {
  const el = document.querySelector(`.js-section-block-lazy._ni[data-code="${code}"]`);
  if (!el || !window.jQuery) return false;
  const f = el.dataset.func;
  const fn = f && typeof window[f] === 'function' ? window[f] : typeof window.updateLazyItems === 'function' ? window.updateLazyItems : null;
  if (!fn) return false;   // метку _ni не трогаем — запасная прокрутка ещё сработает (2.9)
  el.classList.remove('_ni');   // чтобы наблюдатель сайта не загрузил второй раз
  try { fn(jQuery(el)); } catch (e) { el.classList.add('_ni'); return false; }
  return true;
};
// Основной способ (loadLazy) не дал блок — записать предупреждение «сайт изменил загрузку»;
// msg = null — способ сработал, снять. Живёт 20 мин (sessionStorage вкладки переживает сборы).
window.lazyWarn = (code, msg) => {
  const w = vvLoad('lazyWarn') || {};
  if (msg) w[code] = { msg, t: Date.now() }; else delete w[code];
  return vvSave('lazyWarn', w);
};
window.lazyWarnings = () => Object.entries(vvLoad('lazyWarn') || {})
  .filter(([, v]) => Date.now() - v.t < 20 * 60000).map(([k, v]) => `${k}: ${v.msg}`);
// Карточки зелёных — элементы data-is-green="Y" (по два на товар). Загрузился пустым —
// сайт показывает #js-Delivery__Order-green-state-empty: это настоящий «сегодня нет».
window.greenEmpty = () => {
  const e = document.querySelector('#js-Delivery__Order-green-state-empty');
  return !!e && !e.classList.contains('hidden');
};
// Ждать карточек или признака «пусто» до max мс; вернуть число карточек.
window.waitGreen = async (max = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < max) {
    if (document.querySelector('[data-is-green="Y"]') || greenEmpty()) break;
    await new Promise(r => setTimeout(r, 500));
  }
  return document.querySelectorAll('[data-is-green="Y"]').length;
};

// Поля из разметки карточки (не из innerText — он зависит от отрисовки).
window.readGreen = () => {
  const seen = new Set();
  return vvSave('green', [...document.querySelectorAll('[data-is-green="Y"]')]
    .filter(e => e.dataset.productId && !seen.has(e.dataset.productId) && seen.add(e.dataset.productId))
    .map(e => {
      const c = e.closest('.ProductCard') || e.parentElement;
      const a = c.querySelector('a[href*="/goods/"]');
      const num = sel => (c.querySelector(sel)?.textContent || '').replace(/\s/g, '');
      return {
        id: e.dataset.productId,
        name: [(c.querySelector('a[title]')?.getAttribute('title') || a?.textContent || '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()]   // в title пробел кодом (26.09)
          .map(n => { const w = (c.querySelector('.ProductCard__linkWeight')?.textContent || '').replace(/\s+/g, ' ').trim();
            return w && !n.endsWith(w) ? n + ', ' + w : n; })[0],   // вес — отдельное поле, если его нет в названии (2.10)
        href: (a?.getAttribute('href') || '').split('?')[0],
        price: vvNum(num('.js-datalayer-catalog-list-price')), old: vvNum(num('.js-datalayer-catalog-list-price-old')),
        unit: /\/кг/.test(c.querySelector('.Price')?.textContent || '') ? 'кг' : 'шт',
        max: e.dataset.max,
      };
    }));
};

// Купоны: текст лежит в HTML /cart/ всегда, клик по вкладке не нужен. Возвращает
// «Купонов пока нет» или текст блока с купонами (структура списка не проверена —
// купонов на аккаунте не было).
window.couponsText = async () => {
  const d = await vvGet('/cart/');
  const t = (d.body.textContent || '').replace(/\s+/g, ' ');
  if (/Купонов пока нет/.test(t)) return vvSave('coupons', 'Купонов пока нет');
  const el = [...d.querySelectorAll('[class*="oupon"], [class*="upon"]')].find(e => /купон/i.test(e.textContent));
  return vvSave('coupons', el ? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 600) : 'блок купонов не найден — проверить руками');
};

// ---------- Все акции /offers/ (фоном; ждать __st.finished) ----------

// Карточка без названия или цены — заготовка, не товар (23.09 их было 48 на 183).
// Имя — из span.js-product-v-tizer__title-text внутри ссылки: сам текст ссылки
// склеивает имя с граммовкой/ценой за кг («…, 150 г, 150 г», «…, 2 708 ₽ / кг»),
// а атрибут title — без граммовки.
window.cardName = c => vvT(c, '.js-product-v-tizer__title-text') || vvT(c, '.ProductCard__link');
window.parseList = d => {
  const T = (c, s) => vvT(c, s);
  return [...d.querySelectorAll('.ProductCard')].map(c => ({
    name: cardName(c),
    price: vvNum(T(c, '.js-datalayer-catalog-list-price')),
    old: vvNum(T(c, '.js-datalayer-catalog-list-price-old')),
    unit: (T(c, '.Price').match(/\/(\S+)/) || [])[1] || '',
    note: T(c, '.ProductCard__notice'),
    rest: T(c, '.ProductCard__Rest'),
    cat: T(c, '.js-datalayer-catalog-list-category').split('//')[0],
    href: (c.querySelector('.ProductCard__link')?.getAttribute('href') || '').split('?')[0],
  })).filter(x => x.name && x.price);
};

// Фильтры страницы акций. Работают ТОЛЬКО вместе с sf4=Y — без него сервер
// их молча игнорирует. Постоянные фильтры (DEF_*) хранятся на аккаунте и
// применяются к голому /offers/, поэтому перед замером их надо прочитать,
// а после — вернуть как было: любой запрос с sf4=Y перезаписывает набор.
window.VV_FILTER = {
  today: 'F%5BDEF_2%5D=1',      // можно заказать сейчас (8 страниц вместо 32)
  brandOnly: 'F%5BDEF_3%5D=1',  // только товары «ВкусВилл», без партнёрских
  vegan: 'F%5BDEF_5%5D=1',
  noSugar: 'F%5BDEF_6%5D=1',
  vanish: 'F%5B212%5D%5B%5D=284',  // красные
  card: 'F%5B212%5D%5B%5D=278',    // жёлтые
  qty: 'F%5B212%5D%5B%5D=281',     // оранжевые
};

// Состояние постоянных фильтров — читать ПЕРЕД замером (страница /offers/).
// Можно передать документ из fetch: readFilters(await vvGet('/offers/')).
window.readFilters = (doc = document) => Object.fromEntries(
  [...doc.querySelectorAll('input[name^="F[DEF"]')].map(e => [e.id, e.checked]));

// offersUrl({today:true, brandOnly:false}) -> '/offers/?F[DEF_2]=1&sf4=Y'
window.offersUrl = (o = {}) => {
  const parts = Object.keys(o).filter(k => o[k] && VV_FILTER[k]).map(k => VV_FILTER[k]);
  return '/offers/?' + (parts.length ? parts.join('&') + '&' : '') + 'sf4=Y';
};

// Вернуть постоянные фильтры к состоянию st (результат readFilters).
// Возвращает { same, now }: now — фильтры по свежему HTML /offers/, same — совпали ли со снимком.
// Адрес запроса в ответ не кладём: инструмент блокирует вывод со строкой запроса.
window.restoreFilters = async (st) => {
  st = st || window.__snap || vvLoad('snap');
  if (!st || !Object.keys(st).length) return { same: false, now: null, err: 'нет снимка фильтров — не трогал' };
  const map = { FILTER4_2: 'today', FILTER4_3: 'brandOnly', FILTER4_5: 'vegan', FILTER4_6: 'noSugar' };
  const o = {}; Object.entries(map).forEach(([id, k]) => { if (st[id]) o[k] = true; });
  await fetch(offersUrl(o), { credentials: 'include' });
  const now = readFilters(await vvGet('/offers/'));
  const same = Object.keys(map).every(id => !!now[id] === !!st[id]);
  return { same, now };
};

// Число страниц уточняется на каждой странице: пагинация может не показывать последнюю.
window.scanOffers = (opts) => {
  const base = opts ? offersUrl(opts) : '/offers/';
  window.__st = { done: 0, max: 1, cards: 0, err: null, finished: false, base };
  window.__pages = {};
  (async () => {
    try {
      for (let p = 1; ; p++) {
        const sep = base.includes('?') ? '&' : '?';
        const url = base + (p > 1 ? sep + 'PAGEN_1=' + p : '');
        // ответ с ошибкой или пустая страница посреди списка — повторить раз, потом ошибка (2.9)
        const page = async () => {
          const r = await fetch(url, { credentials: 'include' });
          if (!r.ok) throw new Error('страница ' + p + ': ответ ' + r.status);
          return new DOMParser().parseFromString(await r.text(), 'text/html');
        };
        let d; try { d = await page(); } catch (e) { await new Promise(r => setTimeout(r, 1500)); d = await page(); }
        if (p > 1 && p < __st.max && !parseList(d.querySelector('.ProductCards__list.js-log-place') || d).length) {
          await new Promise(r => setTimeout(r, 1500)); d = await page();
          if (!parseList(d.querySelector('.ProductCards__list.js-log-place') || d).length) throw new Error('страница ' + p + ' из ' + __st.max + ' пустая');
        }
        const links = [...d.querySelectorAll('a[href*="PAGEN_1="]')]
          .map(a => +new URL(a.getAttribute('href'), location.origin).searchParams.get('PAGEN_1'));
        __st.max = Math.max(__st.max, ...links);
        __pages[p] = parseList(d.querySelector('.ProductCards__list.js-log-place') || d);
        __st.cards += __pages[p].length;
        __st.done = p;
        if (p >= __st.max || !__pages[p].length) break;
        await new Promise(r => setTimeout(r, 100));
      }
    } catch (e) { __st.err = String(e); }
    __st.finished = true;
  })();
  return 'started';
};

// Статус обхода без адреса запроса: инструмент блокирует вывод, если в нём есть строка запроса.
window.scanStatus = () => ({ done: __st.done, max: __st.max, cards: __st.cards, finished: __st.finished, err: __st.err });

window.NON_FOOD = /Косметик|Бытов|Товары для дома|Канцтов|Зоотов|Товары для детей|Выбор родителей|1000 мелоч|Идеи для подарк|Аптек|Здоровье/;
window.kindOf = x => /Любимый продукт/.test(x.note) ? 'fav' : /Исчезающ/.test(x.note) ? 'vanish' : /карте лояльности/i.test(x.note) ? 'card'
  : /При покупке от/.test(x.note) ? 'qty' : 'other';
window.pctOf = x => x.old && x.price ? Math.round((1 - x.price / x.old) * 100) : 0;
// «В наличии 0.855 кг» -> «0,86 кг»
window.fmtRest = r => (r || '').replace('В наличии ', '')
  .replace(/\d+\.\d+/, m => (+m).toFixed(2).replace('.', ','));

// Сводка: ВСЕ позиции в наличии, без порога по проценту и без выбрасывания
// непродовольственных — так требует отчёт. Результат в __all и __rows.
window.summarizeOffers = ({ minCardPct = 0 } = {}) => {
  const seen = new Set(), all = [];
  for (const p of Object.keys(__pages).sort((a, b) => a - b))
    for (const x of __pages[p]) if (!seen.has(x.href)) { seen.add(x.href); all.push(x); }
  window.__all = all;
  const inStock = x => /В наличии/.test(x.rest);
  const counts = {};
  for (const x of all) {
    const k = kindOf(x); counts[k] ??= { n: 0, inStock: 0, online: 0, nonFood: 0 };
    counts[k].n++;
    if (inStock(x)) {
      counts[k].inStock++;
      if (/только онлайн/i.test(x.note)) counts[k].online++;
      if (NON_FOOD.test(x.cat)) counts[k].nonFood++;
    }
  }
  window.rows = k => all.filter(x => kindOf(x) === k && inStock(x) && (k !== 'card' || pctOf(x) >= minCardPct))
    .sort((a, b) => pctOf(b) - pctOf(a));
  window.__rows = { vanish: rows('vanish'), qty: rows('qty'), card: rows('card'), fav: rows('fav') };
  return { total: all.length, inStock: all.filter(inStock).length, counts,
    rows: Object.fromEntries(Object.entries(__rows).map(([k, v]) => [k, v.length])) };
};

// Шаг 1 одним вызовом (на /cart/ после вставки cart-kit): зелёные, купоны, снимок корзины, шапка.
// greenState: loaded — карточки есть; empty — сайт сказал «сегодня нет»; unknown — блок не
// ответил (ноль не подтверждён: исполнитель прокручивает и повторяет).
window.cartStep = async () => {
  const lazy = loadLazy('cart_green_labels');
  const n = await waitGreen();
  const greenState = vvSave('greenState', n ? 'loaded' : greenEmpty() ? 'empty' : 'unknown');
  // повторный вызов после запасной прокрутки (lazy false) предупреждение не снимает
  if (greenState === 'unknown') lazyWarn('cart_green_labels', lazy ? 'функция сайта не загрузила блок' : 'заглушка или функция загрузки не найдены');
  else if (lazy) lazyWarn('cart_green_labels', null);
  return { width: innerWidth, header: headerInfo(), green: readGreen().length, greenState, lazy, coupons: await couponsText(), cart: await cartSnapshot() };
};
// Шаг 2 одним вызовом (на /offers/ после вставки scripts.min.js): шапка и снимок фильтров.
// Снимок фильтров живёт и в sessionStorage — переживает navigate (2.9). snapOk false — на
// странице нет всех четырёх фильтров: сбор не начинать (вернуть их было бы не к чему).
window.FILTER_WORDS = { FILTER4_2: 'сегодня', FILTER4_3: 'только ВкусВилл', FILTER4_5: 'веганское', FILTER4_6: 'без сахара' };
window.offersStep = async () => {
  window.__snap = vvSave('snap', readFilters());
  const missing = Object.keys(FILTER_WORDS).filter(k => !(k in __snap));
  const on = Object.keys(FILTER_WORDS).filter(k => __snap[k]).map(k => FILTER_WORDS[k]);
  const off = Object.keys(FILTER_WORDS).filter(k => k in __snap && !__snap[k]).map(k => FILTER_WORDS[k]);
  window.__sets = null; vvSave('sets', null);   // наборы прошлого прогона в этой вкладке не нужны
  return { width: innerWidth, header: headerInfo(), snapOk: !missing.length, missing,
    filters: `включено: ${on.join(', ') || 'ничего'}; выключено: ${off.join(', ') || 'ничего'}` };
};
// Шаг 5 исполнителя одним запуском: всё в фоне. Опрашивать collectStatus().
// Обход акций — фоном с шага 4 (startScan), пока идут комбо; startCollect его не повторяет,
// если он уже идёт с тем же ассортиментом (2.9). После кликов «6 скидок»: обход меняет
// сохранённые фильтры аккаунта (sf4), а влияют ли они на блок — не проверено.
window.startScan = (brandOnly) => {
  const base = offersUrl({ today: true, brandOnly: !!brandOnly });
  if (window.__st && __st.base === base && !__st.err) return 'already';
  return scanOffers({ today: true, brandOnly: !!brandOnly });
};
window.startCollect = (brandOnly) => {
  window.__v = null; verify18().then(r => __v = r).catch(e => __v = 'ERR ' + e);
  startScan(brandOnly);
  window.__cr = null; findCombos().then(r => __cr = r).catch(e => __cr = 'ERR ' + e);
  return 'started';
};
window.collectStatus = () => ({
  six: window.__verified ? __verified.length : (typeof __v === 'string' ? __v : 'running'),   // строка — итог verify18 или 'ERR …'
  scan: scanStatus(),
  combos: window.__combos ? __combos.length : (typeof __cr === 'string' ? __cr : 'running'),
  // ERR у «6 скидок» или комбо — тоже конец ожидания: дальше без них, записать в сбоях (2.9)
  done: !!((window.__verified || typeof __v === 'string') && __st.finished && (window.__combos || typeof __cr === 'string')),
  err: [__v, __cr].filter(x => typeof x === 'string' && /^ERR/.test(x)).concat(__st.err || []),   // только сбои, не итоги verify18
});
// Шаг 6 исполнителя одним вызовом: summarizeOffers, auditPromos, короткие итоги.
window.finishCollect = async () => {
  const sum = summarizeOffers();
  window.__au = await auditPromos();
  const a = __au;
  const changed = !!(a.missing.length || a.cardMissing.length || a.cardNew.length || a.newFilters.length || a.newNotes.length || a.newBlocks.length);
  return { changed, lazyWarn: lazyWarnings(), rows: sum.rows, online: sum.counts.card?.online ?? 0, sixOk: (__verified || []).filter(o => /6 скидок/.test(o.six)).length,
    combosOk: (__combos || []).filter(k => k.save > 0 && !k.suspect).length,
    audit: { missing: a.missing, cardMissing: a.cardMissing, cardNew: a.cardNew, newFilters: a.newFilters, newNotes: a.newNotes, newBlocks: a.newBlocks, notes: a.notesChecked },
  };   // changed и lazyWarn — в начале ответа: длинный хвост ревизии может обрезаться (2.10)
};
// Шаг 7 исполнителя одним вызовом: сохранить файл, вернуть фильтры, сверить корзину.
// Сначала фильтры (упадёт сохранение — аккаунт уже вернули), затем сохранение с фактами (2.9).
window.finalStep = async (h, name) => {
  const f = await restoreFilters();
  const c = await cartDiff();
  h = window.__h = { ...h, filtersSame: f.same, cartSame: c.same === true };   // __h — для повтора saveData
  let saved; try { saved = await saveData(h, name); } catch (e) { saved = 'ERR ' + e; }
  return { saved, filtersSame: f.same, filtersNow: f.now, filtersErr: f.err, cartSame: c.same, cartAdded: c.added, cartRemoved: c.removed };
};

// Готовые поля раздела 6: бонусы, покупки за два дня, Любимый продукт, ВкусБэк, подписка.
window.cabinetInfo = async () => {
  const d = await vvGet('/personal/');
  const t = d.querySelector('main')?.textContent.replace(/\s+/g, ' ') || '';
  // Любимый продукт — своя колонка; после выбора слов «Любимый продукт» в ней нет (24.09)
  const lp = d.querySelector('.VV22_LKSpecialsTills__Col._LP')?.textContent.replace(/\s+/g, ' ').trim();
  const around = (re, n) => { const i = t.search(re); return i < 0 ? null : t.slice(i, i + n); };
  return {
    // баланс — поле карточки; тысячи сайт делит узким пробелом («2 900», 26.09) — пробелы убрать
    bonuses: (d.querySelector('.VV_PersonalSB20Card._bonuses .VV_PersonalSB20Card__Desc')?.textContent.replace(/\s/g, '')
      || (t.match(/Бонусы (\d+)/) || [])[1]) ?? null,
    twoDays: (t.match(/Покупки за два дня ([\d\s]+)руб/) || [])[1]?.trim() ?? null,
    favorite: lp ? lp.slice(0, 200) : around(/Любимый продукт/, 180),
    vkusback: around(/ВкусБэк/, 200),
    subscription: /Подписка на скидку/i.test(t) ? 'упоминается в кабинете — проверить' : 'в кабинете не упоминается (не подключена)',
  };
};

// Промокоды: коды вида ABC123456 с текстом рядом (сумма, порог, срок).
window.promoCodes = async () => {
  const t = (await vvGet('/personal/my_promocodes/')).querySelector('main')?.textContent.replace(/\s+/g, ' ') || '';
  const codes = [...new Set(t.match(/\b[A-Z]{2,4}\d{5,8}\b/g) || [])];   // 2–4 латинские буквы и 5–8 цифр
  return codes.map(c => { const i = t.indexOf(c); return c + ': ' + t.slice(i + c.length, i + c.length + 110).trim(); });
};

// ---------- Корзина: снимок до работы и сверка после ----------
// Пустой корзина быть не обязана. basketPageData лежит в HTML /cart/ как
// JSON.parse('…') — читается без перехода на страницу. Проверено 23.09 с товаром
// в корзине: пустая корзина — basket: [] (массив), непустая — basket: объект
// с ключами «<PRODUCT_ID>_0». Поля позиции: PRODUCT_ID, Q (количество), NAME,
// PRICE (со скидкой), BASE_PRICE, DIFF_PRICE, UNIT, MAX_Q, IS_GREEN (0/1),
// IS_LP ("N"/"Y"), PRICE_LABEL, CAN_BUY, CATEGORY.

window.readBasket = async () => {
  const h = await (await fetch('/cart/', { credentials: 'include' })).text();
  const m = h.match(/basketPageData\s*=\s*JSON\.parse\('((?:[^'\\]|\\.)*)'\)/);
  if (!m) return null;
  const data = JSON.parse(JSON.parse('"' + m[1].replace(/\\'/g, "'") + '"'));
  const items = Array.isArray(data.basket) ? data.basket : Object.values(data.basket || {});
  return items.map(b => ({
    id: String(b.PRODUCT_ID ?? ''), q: +(b.Q ?? b.QUANTITY) || 1,
    name: b.NAME ?? '', price: b.PRICE, base: b.BASE_PRICE, diff: b.DIFF_PRICE,
    green: !!+b.IS_GREEN, lp: b.IS_LP === 'Y', label: b.PRICE_LABEL,
  }));
};
window.cartSnapshot = async () => {
  window.__cart0 = await readBasket();
  vvSave('cart0', __cart0);
  return __cart0 ? `${__cart0.length} позиций` + (__cart0.length ? ': ' + __cart0.map(b => `${b.name.slice(0, 30)} ×${b.q} по ${b.price}` + (b.diff ? ` (−${b.diff})` : '')).join('; ') : '')
    : 'basketPageData не найден';
};
window.cartDiff = async () => {
  const now = await readBasket();
  if (!window.__cart0) window.__cart0 = vvLoad('cart0');
  if (!now || !window.__cart0) return 'нет снимка или basketPageData';
  const key = b => b.id + '×' + b.q;
  const a = new Set(__cart0.map(key)), b = new Set(now.map(key));
  return { same: a.size === b.size && [...a].every(x => b.has(x)),
    added: now.filter(x => !a.has(key(x))).map(x => x.name),
    removed: __cart0.filter(x => !b.has(key(x))).map(x => x.name) };
};
// Товары корзины из подборки «6 скидок» — они занимают места. Нужны __cart0 и __sets.
window.cartSixPlaces = () => {
  if (!window.__cart0) window.__cart0 = vvLoad('cart0');
  if (!window.__sets) window.__sets = vvLoad('sets');
  if (!__cart0 || !__sets) return null;
  return __cart0.filter(b => __sets.flat().some(x => x.href.includes('-' + b.id + '/'))).map(b => b.name);
};

// ---------- Данные для отчёта: собирает страница, сохраняет в «Загрузки» ----------
// Страница отдаёт только данные одним файлом <дата>.data.json; отчёт из них
// собирает make_report.py на диске. Модель ничего не перепечатывает.
// Нужны: __rows (summarizeOffers), __verified (verify18), __combos (findCombos),
// __au (auditPromos), с /cart/ — сохранённые readGreen и couponsText.

window.reportData = async h => ({
  version: '2.10', h,
  green: vvLoad('green') || [], greenState: vvLoad('greenState') || 'unknown', lazyWarn: lazyWarnings(), coupons: vvLoad('coupons') || 'не проверено',
  cabinet: await cabinetInfo(), promoCodes: await promoCodes(),
  six: (window.__verified || []).map(o => ({ set: o.set, name: o.name, href: o.href, price: vvNum(o.price), old: vvNum(o.old), rest: fmtRest(o.rest), six: o.six, nonFood: !!(o.cat && NON_FOOD.test(o.cat)) })),
  sixPlaces: cartSixPlaces() || [],
  rows: Object.fromEntries(['vanish', 'qty', 'card', 'fav'].map(k => [k, ((window.__rows || {})[k] || []).map(x => ({
    name: x.name, href: x.href, price: x.price, old: x.old, pct: pctOf(x), rest: fmtRest(x.rest),
    unit: /кг/.test(x.rest) ? 'кг' : x.unit, note: x.note, online: /только онлайн/i.test(x.note), nonFood: NON_FOOD.test(x.cat),
    date: (x.note.match(/по (\d\d\.\d\d)/) || [])[1] || '', cond: ((x.note.match(/(от [\d.,]+ ?(?:шт|кг))/) || [])[1] || '').replace('.', ','),
  }))])),
  combos: (window.__combos || []).map(k => ({ name: k.name, href: k.href, price: k.price, sum: k.sum, save: k.save, pct: k.pct, rest: fmtRest(k.rest), suspect: !!k.suspect, bad: k.bad || [], parts: (k.parts || []).map(p => p.name + ' ' + p.price) })),
  audit: window.__au ? { missing: __au.missing, cardMissing: __au.cardMissing, cardNew: __au.cardNew, newFilters: __au.newFilters, newNotes: __au.newNotes, newBlocks: __au.newBlocks, notesChecked: __au.notesChecked, found: __au.found } : null,
});

// Сохранить текст в «Загрузки» (браузер делает это сам). Chrome разрешает сайту
// одну автоматическую загрузку — поэтому всё в одном файле.
window.saveText = (name, text) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  return { name, bytes: new TextEncoder().encode(text).length };
};
window.saveData = async (h, name) => saveText(name, JSON.stringify(await reportData(h)));

// ---------- Ревизия реестра акций ----------
// Проверяет, что все известные акции на месте, и ищет незнакомые.
// Нумерация = таблица «Реестр акций» в SKILL.md. exists:true — тест доказывает
// только, что акция существует на сайте, а не что она у пользователя действует.

window.PROMO_REGISTRY = [
  { n: 1, id: 'green', name: 'Зелёные ценники', test: (cart) => /Зел[её]ные ценники/.test(cart) },
  { n: 2, id: 'six', name: '6 скидок', test: (cart, pers) => /6 скидок|Скидка 20% на 6 товаров/.test(pers) },
  { n: 3, id: 'vanish', name: 'Скоро исчезнут с полок',
    test: (c, p, filters) => filters.includes('Скоро исчезнут с полок') },   // день без таких товаров — не пропажа акции (2.10)
  { n: 4, id: 'qty', name: 'Скидка от нескольких товаров',
    test: (c, p, filters) => filters.includes('Скидка от нескольких товаров') },
  { n: 5, id: 'card', name: 'Скидка по карте',
    test: (c, p, filters, notes) => filters.includes('Скидка по вашей карте') && notes.some(t => /карте лояльности/.test(t)) },
  { n: 6, id: 'fav', name: 'Любимый продукт', test: (c, pers) => /Любимый продукт/.test(pers) },
  // Подписки НЕТ на /card/ — она живёт на своей странице (найдено субагентом 23.09).
  { n: 7, id: 'sub', name: 'Подписка на скидку', exists: true,
    test: (c, p, f, n, k, card, sub) => /Подписка на скидку/i.test(sub) },
  { n: 8, id: 'cashback', name: 'ВкусБэк', test: (c, pers) => /ВкусБэк/.test(pers) },
  // Признак отметки на карточке неизвестен — проверяется лишь упоминание на /card/.
  { n: 9, id: 'goods_cashback', name: 'Кешбэк на товары', exists: true,
    test: (c, p, f, n, k, card) => /Кешб[эе]ка?/i.test(card) },
  { n: 10, id: 'coupon', name: 'Купоны', exists: true, test: (cart) => /купон/i.test(cart) },
  { n: 11, id: 'promo', name: 'Промокоды', exists: true, test: (c, pers) => /Промокод/.test(pers) },
  { n: 12, id: 'bonus', name: 'Бонусы', test: (c, pers) => /Бонусы/.test(pers) },
  { n: 13, id: 'combo', name: 'Комбо-наборы', test: (cart, pers, filters, notes, combos) => combos > 0 },
];

// Официальная витрина всех постоянных акций — /card/. Если ВкусВилл переименует
// акцию, добавит или уберёт, здесь это видно раньше, чем в каталоге.
window.CARD_PROMOS = ['Любимый продукт', 'Жёлтых ценников', 'Оранжевых ценников',
  '6 скидок', 'ВкусБэка', 'Кешбэка', 'Купонов', 'Промокодов', 'Бонусов',
  'Зелёных ценников', 'Красных ценников', 'Синих ценников'];

// Карточки комбо-наборов. На сайте категории «Комбинированные наборы» нет (у
// «Набор: Салат Витаминный + Плов» в хлебных крошках «Особое питание»), а поиск
// по слову нестабилен. Эталонный список — MCP: vkusvill_products_search с
// category_id=250 («Комбинированные наборы»), q «набор» и «комбо», vvonly=0.
// Его id и названия положить в window.COMBO_EXTRA = { '35710': 'Набор: …', … }
// ДО вызова; здесь по каждому id берутся цена и остаток по адресу. Без MCP
// остаётся поиск «комбо»/«набор» по названиям «Комбо…» и «Набор…».
window.COMBO_EXTRA = window.COMBO_EXTRA || {};
window.comboCards = async () => {
  const seen = new Set(), out = [];
  const idOf = h => (h.match(/-(\d+)\/?$/) || [])[1];
  const take = x => { if (!seen.has(x.href)) { seen.add(x.href); out.push(x); } };
  for (const q of ['комбо', 'набор']) {
    const d = await vvGet('/search/?type=products&q=' + encodeURIComponent(q));
    for (const x of parseList(d))
      if (/Комбо/i.test(x.name) || /^Набор\b/i.test(x.name) || COMBO_EXTRA[idOf(x.href)]) take(x);
  }
  for (const [id, name] of Object.entries(COMBO_EXTRA)) {
    if ([...seen].some(h => idOf(h) === id)) continue;
    const q = name.replace(/&nbsp;/g, ' ').replace(/,?\s*\d+\s*(г|мл|кг|л)\s*$/i, '').replace(/["«»]/g, ' ').trim();
    const d = await vvGet('/search/?type=products&q=' + encodeURIComponent(q));
    const x = parseList(d).find(x => idOf(x.href) === id);
    if (x) take(x); else out.push({ name, price: null, old: null, unit: '', note: '', rest: 'не найден по адресу', cat: '', href: '/goods/-' + id + '/' });
  }
  return out;
};

window.auditPromos = async () => {
  const get = vvGet;
  const txt = d => (d.querySelector('main') || d.body).textContent.replace(/\s+/g, ' ');
  const off = await get('/offers/'), per = await get('/personal/'), cart = await get('/cart/');
  const filters = [...off.querySelectorAll('input[name="F[212][]"]')]
    .map(i => (i.closest('label')?.textContent || '').replace(/\s+/g, ' ').trim());
  let notes = window.__all ? __all.map(x => x.note) : [];
  if (!notes.length) for (let p = 1; p <= 4; p++) {
    const d = p === 1 ? off : await get('/offers/?PAGEN_1=' + p);
    notes.push(...[...d.querySelectorAll('.ProductCard__notice')].map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  }
  const cartT = txt(cart), persT = txt(per) + txt(off) + (per.querySelector('.VV22_LKSpecialsTills__Col._LP') ? ' Любимый продукт' : '');
  const combos = window.__combos ? __combos.length : (await comboCards()).length;
  const card = await get('/card/');
  const cardT = txt(card);
  let subT = '';
  try { subT = txt(await get('/offers/podpiska-na-skidku.html')); } catch (e) { subT = ''; }
  const cardHeads = [...card.querySelectorAll('h2,h3,[class*="itle"]')]
    .map(e => e.textContent.replace(/\s+/g, ' ').trim()).filter(t => t.length > 2 && t.length < 40);
  const found = PROMO_REGISTRY.map(r => ({ n: r.n, name: r.name, exists: !!r.exists,
    ok: !!r.test(cartT, persT, filters, notes, combos, cardT, subT) }));
  const knownFilters = ['Скоро исчезнут с полок', 'Скидка по вашей карте', 'Скидка от нескольких товаров', 'Любимый продукт и замена'];
  const knownNote = /Исчезающ|карте лояльности|При покупке от|6 скидок|Любимый продукт/;
  const kw = /скидк|кешб[эе]к|бонус|акци|ценник|промо|выгод|комбо|%/i;
  // блок оплаты в непустой корзине («Списать бонусы», «Вернется бонусами»…) — не акции, 2.6
  const knownHead = /Любимый продукт|6 скидок|Скидка 20% на 6|ВкусБэк|Бонусы|Промокод|Скидки по вашей карте|Зел[её]ные ценники|Зелёных ценников сейчас нет|Сегодня со скидкой от 40%|Скидки и акции|Ваши скидки|Покупки вчера|Накопите кешбэк|Увеличьте кешбэк|Категории кешбэка|Рекомендуйте|Получайте|Выгодное комбо|Списать бонусы|Верн[её]тся бонусами|У вас \d+ бонус|Скидки по карте/;
  const heads = d => [...d.querySelectorAll('main h1,main h2,main h3,main h4,main [class*="Title"],main [class*="title"]')]
    .filter(e => e.children.length <= 2 && !e.closest('[class*="Charity"]') && !e.closest('.ProductCard'))   // названия товаров — не блоки (2.9)   // окно фонда в корзине: составы наборов, не акции
    .map(e => e.textContent.replace(/\s+/g, ' ').trim())
    .filter(t => t.length > 3 && t.length < 70 && kw.test(t) && !knownHead.test(t) && !/#/.test(t));
  return {
    found,
    missing: found.filter(x => !x.ok).map(x => x.name),
    // эти акции ревизор видит только как «существуют на сайте»; их состояние — из кабинета и корзины
    existsOnly: found.filter(x => x.exists && x.ok).map(x => x.name),
    newFilters: filters.filter(x => x && !knownFilters.includes(x)),
    newNotes: [...new Set(notes.filter(t => t && !knownNote.test(t))
      .map(t => t.replace(/\d\d\.\d\d/g, 'ДД.ММ').replace(/\d+/g, 'N')))].slice(0, 15),
    newBlocks: [...new Set([...heads(per), ...heads(cart)])].slice(0, 15),
    // чего нет на /card/ из известного и что там появилось нового
    cardMissing: CARD_PROMOS.filter(x => !cardT.includes(x)),
    cardNew: [...new Set(cardHeads.filter(t => kw.test(t) && !CARD_PROMOS.some(k => t.includes(k))))].slice(0, 10),
    combos,
    notesChecked: notes.length,
  };
};

// ---------- Комбо-наборы ----------
// Отдельные товары; скидка встроена в цену, пометок на сайте нет. findCombos()
// возвращает наборы (см. comboCards), для каждого ищет составляющие поиском по
// кускам названия и считает выгоду. Составляющие подбираются по названию,
// поэтому результат сверять глазами. В отчёт идут только наборы с save > 0;
// «не посчитано» — досчитать руками.

window.findCombos = async () => {
  const card = c => ({ name: c.name, price: c.price, rest: c.rest, href: c.href });
  // Токены для сравнения: слова и числа от 3 знаков (объём «300» важен: 0,3 vs 0,4).
  const norm = s => s.toLowerCase().replace(/[«»"',.]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
  // \b не работает после кириллицы — граница через (?![а-яё]).
  const strip = s => s.replace(/,?\s*\d+[.,]?\d*\s*(гр|кг|мл|л|г)(?![а-яё])\.?/gi, ' ')
    .replace(/["«»]/g, ' ').replace(/\s+/g, ' ').trim();

  const combos = (await comboCards()).map(card);

  await Promise.all(combos.map(async k => { // наборы параллельно, составляющие внутри набора по очереди
    let parts;
    const pair = k.name.match(/Кофейная пара"?\s*([А-Яа-яЁё\- ]+?)\s*(\d)\s*[хx×]\s*(\d+)\s*мл/i);
    if (pair) parts = [{ q: pair[1].trim() + ' ' + pair[3] + ' мл кафе', mult: +pair[2] }];
    else parts = strip(k.name.replace(/&nbsp;/g, ' ')).replace(/^(Комбо[- ]?набор|Набор)\s*:?\s*/i, '')
      .split(/\s+и\s+|\s*\+\s*|\s*\/\s*/)
      .map(s => ({ q: s.trim(), mult: 1 })).filter(x => x.q.length > 3);
    k.parts = []; k.bad = [];
    for (const { q, mult } of parts) {
      const dd = await vvGet('/search/?type=products&q=' + encodeURIComponent(q));
      const want = norm(q);
      const cand = parseList(dd)
        .filter(x => x.href !== k.href && !/Комбо/i.test(x.name) && !/Комбинированн/i.test(x.cat)
          && !/\bвес\b|вес СП|ВЕС/i.test(x.name))
        .map(x => ({ x, score: want.filter(w => x.name.toLowerCase().includes(w)).length / want.length }))
        .filter(h => h.score >= 0.75)
        .sort((a, b) => b.score - a.score || a.x.name.length - b.x.name.length)[0];
      if (cand) k.parts.push({ name: cand.x.name, price: cand.x.price, mult }); else k.bad.push(q);
      await new Promise(r => setTimeout(r, 200));
    }
    k.sum = k.bad.length || !k.price ? null : k.parts.reduce((a, x) => a + x.price * x.mult, 0);
    k.save = k.sum && k.price ? k.sum - k.price : null;
    k.pct = k.save ? Math.round(k.save / k.sum * 100) : null;
    // выгода больше 35% или составляющая дороже набора — скорее всего, подобрана не та: в таблицу не идёт
    k.suspect = k.pct > 35 || k.parts.some(x => x.price >= k.price);
  }));
  window.__combos = combos;
  return combos.map(k => [k.name.slice(0, 46), k.price, k.sum ?? ('не посчитано: ' + k.bad.join('; ')),
    k.save != null ? (k.save > 0 ? '-' + k.save + ' (-' + k.pct + '%)' : 'выгоды нет (' + k.save + ')') : '—', k.rest,
    k.parts.map(p => (p.mult > 1 ? p.mult + '× ' : '') + p.name.slice(0, 24) + ' ' + p.price).join(' + ')].join(' | '));
};
// Занимает ~10–15 с. Запускать в фоне: window.__cr=null;
// findCombos().then(r=>window.__cr=r); затем опрашивать __cr.
// «не посчитано» — честный признак, что составляющая не найдена уверенно.

// Отпечаток вставленного кода: исходники функций и значения констант, пробелы
// схлопнуты. build.py считает эталон тем же способом и ставит сверку в последнюю
// строку собранных копий: «check: ok» — код вставлен без искажений.
window.vvFingerprint = names => {
  const ser = v => typeof v === 'function' || v instanceof RegExp ? String(v)
    : Array.isArray(v) ? '[' + v.map(ser).join(',') + ']'
    : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => k + ':' + ser(v[k])).join(',') + '}'
    : JSON.stringify(v);
  const s = names.map(n => n + '=' + ser(window[n])).join(';').replace(/\s+/g, ' ');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
};

// Самопроверка вставки: файл печатается в страницу как текст, опечатка ломает функцию молча.
window.vvCheck = () => ['vvGet', 'vvT', 'vvNum', 'vvSave', 'vvLoad', 'headerInfo', 'read6', 'start6', 'push6', 'sixCheck', 'loadSets',
  'verify18', 'loadSixState', 'promoCodes', 'readGreen', 'couponsText', 'cardName', 'parseList', 'readFilters',
  'offersUrl', 'restoreFilters', 'scanOffers', 'scanStatus', 'kindOf', 'pctOf', 'fmtRest',
  'summarizeOffers', 'cabinetInfo', 'readBasket', 'cartSnapshot', 'cartDiff', 'cartSixPlaces', 'waitGreen',
  'reportData', 'saveText', 'saveData', 'loadLazy', 'lazyWarn', 'lazyWarnings', 'greenEmpty', 'sixStep', 'sixApi', 'sixKey', 'sixStore', 'sixCached', 'sixRun', 'startScan', 'cartStep', 'offersStep', 'startCollect', 'collectStatus', 'finishCollect', 'finalStep',
  'comboCards', 'auditPromos', 'findCombos', 'vvFingerprint'].filter(f => typeof window[f] !== 'function');

'vkusvill scripts loaded 2.10, missing: ' + JSON.stringify(vvCheck());
