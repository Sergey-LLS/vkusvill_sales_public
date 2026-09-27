#!/usr/bin/env python3
"""Собирает отчёт из данных, которые сохранила страница (шаг 8 исполнителя).

  python3 .claude/skills/vkusvill-dostavka/make_report.py ~/Downloads/2026-09-23.data.json dostavka/skidki/
  (из корня проекта)

На выходе в папке отчётов: <дата>.md (разделы 1–8 и «На что обратить
внимание», всё из данных) и <дата>.items.json (все строки со ссылками:
для пересбора «6 скидок» и шага «положи в корзину»). Скачанный файл удаляется.
Формат отчёта живёт здесь; менять только по просьбе пользователя.
"""
import json, os, re, sys

def esc(t):
    return str(t if t is not None else '').replace('|', '/')

def pct(price, old):
    return round((1 - price / old) * 100) if price and old else None

def rest_green(g):
    # «7.455 кг» -> «7,46 кг», как fmtRest в scripts.js; целые штуки без изменений
    m = str(g.get('max') or '')
    if re.fullmatch(r'\d+\.\d+', m):
        m = f"{float(m) + 1e-9:.2f}".replace('.', ',')
    return f"{m} {g.get('unit', '')}".strip()

def main():
    src, dst = sys.argv[1], sys.argv[2]
    d = json.load(open(src, encoding='utf-8'))
    h = d.get('h', {})
    rows, six, combos, au = d['rows'], d['six'], d['combos'], d.get('audit')
    n = {k: len(rows[k]) for k in ('card', 'vanish', 'qty')}
    online = sum(1 for x in rows['card'] if x.get('online'))
    total = n['card'] + n['vanish'] + n['qty']
    date = os.path.basename(src).split('.')[0]          # 2026-09-23
    date_ru = '.'.join(reversed(date.split('-')))        # 23.09.2026
    # нет цены и «нет в наличии» (страница товара, 2.10) — закончился по адресу (26.09: какао)
    for o in six:
        if not o.get('price') and 'нет в наличии' in str(o.get('rest', '')) and 'закончил' not in (o.get('six') or ''):
            o['six'] = 'закончился по адресу'
    # «6 скидок» в этом сборе нет (клик не прошёл, шаг пропущен), а за день записаны —
    # не затирать их: следующий сбор сравнивает блок с этими записями (поломка 24.09, 2.9)
    kept6 = False
    if not six:
        try:
            prev = [x for x in json.load(open(os.path.join(dst, date + '.items.json'), encoding='utf-8')) if x.get('type') == 'six']
        except Exception:
            prev = []
        if prev:
            six, kept6 = [dict(x, six='6 скидок') for x in prev], True
    L = []
    P = L.append

    # --- шапка ---
    P(f"# Все скидки ВкусВилла — {date_ru}, {h.get('address', '')}")
    P('')
    # прежние замеры дня — из прежнего отчёта, не со слов исполнителя (26.09 он потерял первый) (2.10)
    prev = []
    try:
        l3 = open(os.path.join(dst, date + '.md'), encoding='utf-8').read().split('\n')[2]
        m = re.match(r'Замер (\d\d:\d\d–\d\d:\d\d)(?: \(пересбор; предыдущие замеры этого дня — (.+?) — заменены\))?', l3)
        if m:
            prev = [t.strip() for t in (m.group(2) or '').split(',') if t.strip()] + [m.group(1)]
    except Exception:
        prev = [t.strip() for t in (h.get('replaces') or '').split(',') if t.strip()]
    prev = [t for t in dict.fromkeys(prev) if t != h.get('time')]
    repl = f" (пересбор; предыдущие замеры этого дня — {', '.join(prev)} — заменены)" if prev else ''
    P(f"Замер {h.get('time', '')}{repl}. Источник: vkusvill.ru в вашем аккаунте (Chrome). "
      f"Режим — доставка, слот «{h.get('slot', '')}». Только товары в наличии по адресу.")
    P('')
    P(f"**{h.get('choice', '')}** — ваш выбор при этом сборе.")
    P('')
    fs, cs = h.get('filtersSame'), h.get('cartSame')   # 2.9: результат проверки, не шаблон
    f_txt = ('После сбора возвращены, проверено по свежей странице.' if fs is True
             else '**После сбора НЕ совпали со снимком — проверьте фильтры на странице акций.**' if fs is False
             else 'Возврат не проверен.')
    c_txt = ('после сбора без изменений.' if cs is True
             else '**после сбора отличается от снимка — проверьте корзину.**' if cs is False else 'сверка после сбора не записана.')
    P(f"Постоянные фильтры аккаунта: {h.get('filters', '')}. {f_txt} "
      f"Корзина на момент замера: {h.get('cart', '')}, из них в подборке «6 скидок» — {len(d.get('sixPlaces', []))}; "
      f"{c_txt}")
    P('')
    P(f"Всего акционных позиций в наличии: **{total}** — по карте {n['card']} (из них {online} с пометкой «только онлайн»), "
      f"«скоро исчезнут» {n['vanish']}, «от нескольких штук» {n['qty']}. Все действуют при доставке. "
      f"Зелёные ценники, «6 скидок» и комбо в это число не входят.")
    P('')
    if d.get('lazyWarn'):
        names = {'cart_green_labels': 'зелёные ценники', '6skidok': '«6 скидок»'}
        P('⚠️ **Сайт изменил загрузку блоков** — ' + '; '.join(
            names.get(w.split(':')[0], w.split(':')[0]) + ' (' + w.split(': ', 1)[-1] + ')' for w in d['lazyWarn'])
          + '. Сработал запасной путь (прокрутка); код сбора нужно обновить.')
        P('')

    # --- красный блок ---
    changed = au and any(au.get(k) for k in ('missing', 'cardMissing', 'cardNew', 'newFilters', 'newNotes', 'newBlocks'))
    if changed:
        P('## 🔴 Изменения в типах скидок'); P('')
        P('Ревизия нашла то, чего нет в реестре. Как это собирать, решаем вместе.'); P('')
        for title, key in (('Не нашлись', 'missing'), ('Пропали с витрины /card/', 'cardMissing'), ('Новое на витрине', 'cardNew'),
                           ('Незнакомые фильтры', 'newFilters'), ('Незнакомые пометки', 'newNotes'), ('Незнакомые блоки', 'newBlocks')):
            if au.get(key):
                P(f"- **{title}:** {'; '.join(esc(x) for x in au[key])}")
        P('')

    # --- 1. зелёные ---
    P('## 1. Зелёные ценники'); P('')
    green = d.get('green', [])
    if not green and d.get('greenState') == 'empty':
        P('**Сегодня их нет.** Блок в корзине загрузился, сайт показал «Зелёных ценников сейчас нет».'); P('')
    elif not green:
        P('**Не прочитаны.** Блок в корзине не ответил — ноль не подтверждён; посмотрите «Зелёные ценники» в корзине на сайте.'); P('')
    else:
        P('| Товар | Цена | Было | Скидка | Остаток |'); P('|---|---|---|---|---|')
        for g in green:
            pr, old = float(g.get('price') or 0), float(g.get('old') or 0)
            P(f"| {esc(g.get('name'))} | {g.get('price')} | {g.get('old')} | −{pct(pr, old) or '?'}% | {rest_green(g)} |")
        P('')

    # --- 2. шесть ---
    P('## 2. «6 скидок» — −20%, персональные'); P('')
    if kept6:
        P('**В этом сборе «6 скидок» не собраны** — ниже записи за день из прошлого сбора; цены и остатки — на время '
          'того замера, пометку в этот раз не проверяли. **Купить со скидкой можно шесть разных товаров.**')
    else:
        note6 = (h.get('sixNote') or 'Подборка запрошена сегодня, оба обновления израсходованы — все 18 кандидатов ниже.').strip()
        note6 = note6[:1].upper() + note6[1:] + ('' if note6.endswith('.') else '.')
        P(f"{note6} "
          "Пометка «6 скидок −20%» проверена поиском по каталогу у каждого. **Купить со скидкой можно шесть разных товаров.**")
    P('')
    P('| # | Набор | Товар | Цена | Было | Выгода | Остаток |'); P('|---|---|---|---|---|---|---|')
    for i, o in enumerate(six, 1):
        name = esc(o['name']) + (' `*`' if o.get('nonFood') else '')
        st = o.get('six') or ''
        if 'закончил' in st: name += ' — закончился'
        elif '6 скидок' not in st: name += ' — пометка не подтвердилась'
        gain = (o['old'] - o['price']) if o.get('price') and o.get('old') else '—'
        P(f"| {i} | {o['set']} | {name} | {o.get('price') or ''} | {o.get('old') or ''} | {gain} | {o.get('rest', '')} |")
    best = sorted([o for o in six if o.get('price') and o.get('old')], key=lambda o: o['old'] - o['price'], reverse=True)[:6]
    if best:
        P('')
        P('Самая большая выгода в рублях: ' + ', '.join(f"{esc(o['name'])} {o['old'] - o['price']} ₽" for o in best)
          + f". Шесть самых выгодных вместе — {sum(o['old'] - o['price'] for o in best)} ₽.")
    low = [f"{esc(o['name'])} ({o['rest']})" for o in six if str(o.get('rest', '')).split(' ')[0] in ('1', '2')]
    if low:
        P('Остаток 1–2 шт: ' + ', '.join(low) + '.')
    P('')

    # --- 3, 4, 5 ---
    def name_of(x):
        return esc(x['name']) + (' `[онлайн]`' if x.get('online') else '') + (' `*`' if x.get('nonFood') else '')
    def price_of(x):
        return f"{x['price']}/{x['unit']}" if x.get('unit') and x['unit'] != 'шт' else str(x['price'])

    P(f"## 3. Скоро исчезнут с полок — красные ценники, {n['vanish']} позиций"); P('')
    P('Срока у этой скидки нет: действует, пока партия не разойдётся. Непродовольственные отмечены `*`.'); P('')
    P('| Товар | Цена | Было | Скидка | Остаток |'); P('|---|---|---|---|---|')
    for x in rows['vanish']:
        P(f"| {name_of(x)} | {price_of(x)} | {x['old']} | −{x['pct']}% | {x['rest']} |")
    P('')
    P(f"## 4. Скидка при покупке нескольких — оранжевые ценники, {n['qty']} позиций"); P('')
    P('Карта лояльности не нужна, скидка считается от количества в корзине.'); P('')
    P('| Товар | Цена | Было | Скидка | Условие | Остаток | До |'); P('|---|---|---|---|---|---|---|')
    for x in rows['qty']:
        P(f"| {name_of(x)} | {price_of(x)} | {x['old']} | −{x['pct']}% | {x.get('cond') or '—'} | {x['rest']} | {x.get('date') or '—'} |")
    P('')
    P(f"## 5. Скидка по карте — жёлтые ценники, {n['card']} позиций"); P('')
    P(f"У {online} из них ВкусВилл приписывает «только онлайн» — они отмечены `[онлайн]`. Для доставки это ничего не меняет: "
      "доставка и есть онлайн-заказ, скидка проходит. Непродовольственные отмечены `*`.")
    P('')
    P('| Товар | Цена | Было | Скидка | Остаток | До |'); P('|---|---|---|---|---|---|')
    for x in rows['card']:
        P(f"| {name_of(x)} | {price_of(x)} | {x['old']} | −{x['pct']}% | {x['rest']} | {x.get('date') or '—'} |")
    P('')

    # --- 6. кабинет ---
    cab = d.get('cabinet', {})
    P('## 6. Программы в личном кабинете'); P('')
    P('| Программа | Состояние на сегодня |'); P('|---|---|')
    fav = rows.get('fav') or []
    if fav:
        x = fav[0]
        until = f", до {x['date']}" if x.get('date') else (f", до {m.group(1)}" if (m := re.search(r'по (\d\d\.\d\d)', cab.get('favorite') or '')) else '')
        P(f"| **Любимый продукт** | {esc(x['name'])} — {x['price']} ₽ вместо {x['old']} ₽ (−{x['pct']}%), в наличии {x['rest']}{until} |")
    else:
        P(f"| **Любимый продукт** | {esc(cab.get('favorite') or 'не выбран')} |")
    P(f"| **ВкусБэк** | {esc(cab.get('vkusback') or 'блок не найден')} |")
    P(f"| **Бонусы** | {cab.get('bonuses') if cab.get('bonuses') is not None else '—'} |")
    P(f"| **Подписка на скидку** | {cab.get('subscription', '')} (490 ₽ на 31 день, −10% на 17 категорий) |")
    P(f"| **Купоны** | {esc(d.get('coupons'))} |")
    P('| **Кешбэк на товары** | проверить нечем: как отметка выглядит в коде карточки, неизвестно, акций с ней не попадалось |')
    codes = d.get('promoCodes') or []
    P(f"| **Промокоды** | {'; '.join(esc(c) for c in codes) if codes else 'не найдены'}. Только для друзей, на их первый онлайн-заказ |")
    P('')

    # --- 7. комбо ---
    instock = lambda k: not str(k.get('rest') or '').startswith(('Завтра', 'не найден', 'Нет'))   # 2.10: «Завтра будет» — не в наличии
    good = [k for k in combos if (k.get('save') or 0) > 0 and not k.get('suspect') and instock(k)]
    P(f"## 7. Комбо-наборы — {len(good)} с посчитанной выгодой"); P('')
    P('Скидка встроена в цену набора. Список — справочник ВкусВилла (категория «Комбинированные наборы») плюс «Кофейные пары»; '
      'суммы «по отдельности» посчитаны поиском составляющих по ценам по адресу.')
    P('')
    P('| Набор | Цена набора | Сумма по отдельности | Выгода | Остаток |'); P('|---|---|---|---|---|')
    for k in sorted(good, key=lambda k: -k['save']):
        P(f"| {esc(k['name'])} | {k['price']} | {k['sum']} | −{k['save']} (−{k['pct']}%) | {k['rest']} |")
    rest = [k for k in combos if k not in good]
    if rest:
        P(''); P('Не вошли в таблицу:'); P('')
        for k in rest:
            if not instock(k):
                why = f"сегодня нет в наличии ({k.get('rest')})" + (f", выгода была бы −{k['save']} ₽" if (k.get('save') or 0) > 0 else '')
            elif k.get('sum') is None:
                why = 'не посчитано (' + '; '.join(k.get('bad') or []) + ')'
            elif k.get('suspect'):
                why = 'подозрительно (' + ' + '.join(k.get('parts') or []) + f" = {k['sum']}), проверить руками"
            else:
                why = f"выгоды нет, по отдельности {k['sum']}" if k.get('sum') else 'составляющие не найдены по адресу'
            P(f"- {esc(k['name'])} — {k['price']} ₽: {why}")
    P('')

    # --- 8. ревизия ---
    if au:
        found = au.get('found') or []
        ok = sum(1 for f in found if f.get('ok'))
        P('## 8. Ревизия акций'); P('')
        P('Сверено с официальной витриной `/card/`: '
          + ('пропали: ' + ', '.join(au['cardMissing']) if au.get('cardMissing') else 'все названия акций на месте')
          + (', новое: ' + ', '.join(au['cardNew']) if au.get('cardNew') else ', нового нет')
          + f". Проверено {au.get('notesChecked', '?')} пометок на карточках, незнакомых {len(au.get('newNotes', []))}; "
          f"фильтров незнакомых {len(au.get('newFilters', []))}; блоков незнакомых {len(au.get('newBlocks', []))}. "
          f"Пунктов реестра найдено {ok} из {len(found)}"
          + (', не нашлись: ' + ', '.join(au['missing']) if au.get('missing') else '')
          + '. Для подписки, кешбэка на товары, купонов и промокодов ревизор подтверждает только существование акции, '
          'их состояние — в разделе 6.')
        P('')

    # --- На что обратить внимание: считается из данных, агент ничего не дописывает ---
    P('## На что обратить внимание'); P('')
    pts = []
    if best:
        pts.append(f"**«6 скидок» — самое выгодное.** Шесть мест, выбирать из {len(six)}. Наибольшая экономия: "
                   + ', '.join(f"{esc(o['name'])} {o['old'] - o['price']} ₽" for o in best[:4])
                   + f". Шесть самых выгодных вместе — {sum(o['old'] - o['price'] for o in best)} ₽.")
    gone = [esc(o['name']) for o in six if 'закончил' in (o.get('six') or '')]
    if gone:
        pts.append('Из кандидатов «6 скидок» по адресу закончились: ' + ', '.join(gone) + '.')
    if good:
        top = sorted(good, key=lambda k: -k['save'])[:2]
        pts.append('**Комбо-наборы:** ' + ', '.join(f"{esc(k['name'])} −{k['save']} ₽" for k in top)
                   + ('. Это больше, чем любая позиция «6 скидок».' if top[0]['save'] > (best[0]['old'] - best[0]['price'] if best else 0) else '.'))
    if rows['vanish']:
        big = [x for x in rows['vanish'] if x['pct'] >= 40]
        pts.append(f"**Красные ценники:** {len(rows['vanish'])} позиций, из них {len(big)} со скидкой 40% и больше — "
                   + ', '.join(esc(x['name']) for x in big[:5]) + ('…' if len(big) > 5 else '') + '.')
    today = date_ru[:5]
    last = [esc(x['name']) for k in ('card', 'qty') for x in rows[k] if x.get('date') == today]
    if last:
        pts.append(f"**Последний день скидки (по {today}), {len(last)} позиций:** " + ', '.join(last) + '.')
    ones = [esc(x['name']) for k in ('vanish', 'qty', 'card') for x in rows[k] if str(x.get('rest', '')).startswith('1 шт')]
    if ones:
        pts.append(f"**Остался 1 шт:** " + ', '.join(ones) + '.')
    if fav:
        pts.append(f"**Любимый продукт:** {esc(fav[0]['name'])} — {fav[0]['price']} ₽ вместо {fav[0]['old']} ₽ (−{fav[0]['pct']}%).")
    off = []
    fav_txt = cab.get('favorite') or ''
    if not fav and ('не было покупок' in fav_txt or 'недоступ' in fav_txt): off.append('Любимый продукт недоступен')
    if str(cab.get('bonuses')) == '0': off.append('бонусов 0')
    if 'пока нет' in str(d.get('coupons')): off.append('купонов нет')
    if 'не подключена' in str(cab.get('subscription')) or 'не упоминается' in str(cab.get('subscription')): off.append('подписки нет')
    pts.append('**Скидки не складываются между собой** — действует та, что выгоднее. '
               + (', '.join(off).capitalize() + ', так что сегодня работают только цветные ценники, «6 скидок», комбо-наборы'
                  + (' и Любимый продукт' if fav else '') + '.' if off else ''))
    for i, t in enumerate(pts, 1):
        P(f"{i}. {t}")
    P('')

    report = '\n'.join(L).rstrip('\n') + '\n'
    open(os.path.join(dst, date + '.md'), 'w', encoding='utf-8').write(report)

    items = []
    for o in six:
        items.append({'type': 'six', 'set': o['set'], 'name': o['name'], 'href': o.get('href'), 'price': o.get('price'), 'old': o.get('old'), 'rest': o.get('rest')})
    for k in ('vanish', 'qty', 'card', 'fav'):
        for x in rows.get(k, []):
            items.append({'type': k, 'name': x['name'], 'href': x.get('href'), 'price': x['price'], 'old': x['old'], 'pct': x['pct'], 'rest': x['rest'], 'note': x.get('note')})
    for g in green:
        items.append({'type': 'green', 'name': g.get('name'), 'id': g.get('id'), 'price': g.get('price'), 'old': g.get('old'), 'rest': rest_green(g), 'href': g.get('href')})
    for k in combos:
        items.append({'type': 'combo', 'name': k['name'], 'href': k.get('href'), 'price': k['price'], 'sum': k.get('sum'), 'save': k.get('save'), 'rest': k['rest'], 'suspect': k.get('suspect')})
    json.dump(items, open(os.path.join(dst, date + '.items.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    os.remove(src)
    print(f"{date}.md: {report.count(chr(10))} строк; {date}.items.json: {len(items)} записей; "
          f"позиций {total}, «6 скидок» {len(six)}, комбо {len(good)}" + ('; 🔴 ИЗМЕНЕНИЯ В ТИПАХ СКИДОК' if changed else ''))

if __name__ == '__main__':
    main()
