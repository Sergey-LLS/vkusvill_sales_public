#!/usr/bin/env python3
"""Все позиции отчёта одной таблицей — от самой большой выгоды в рублях к самой маленькой.

  python3 vygoda.py dostavka/skidki/2026-09-24.items.json [N]

Пишет рядом <дата>.vygoda.md и печатает первые N строк (по умолчанию 20) для чата.
Берёт только <дата>.items.json и шапку <дата>.md; сайт и браузер не нужны.
Весовые товары отдельной таблицей: их цена и выгода — за 1 кг, а покупают
обычно меньше, и в общем списке они стояли бы выше, чем стоят на деле.
"""
import json, os, re, sys

KIND = {'six': '«6 скидок» −20%', 'card': 'Скидка по карте (жёлтый ценник)',
        'vanish': 'Скоро исчезнут с полок (красный ценник)',
        'qty': 'Больше — выгодней (оранжевый ценник)', 'combo': 'Комбо-набор',
        'fav': 'Любимый продукт −20%', 'green': 'Зелёный ценник (уценка)'}

def esc(t):
    return str(t if t is not None else '').replace('|', '/')

def row(x):
    t = x['type']
    if t == 'combo':
        save, old = x.get('save') or 0, x.get('sum')
    else:
        num = lambda v: float(v) if v not in (None, '') else None   # зелёные до 2.9 писались строкой
        p, oldn = num(x.get('price')), num(x.get('old'))
        save = round(oldn - p, 2) if oldn and p is not None else 0
        save = int(save) if save == int(save) else save
        old = x.get('old')
    oldv = float(old) if old not in (None, '') else None
    pct = round(save / oldv * 100) if save and oldv else None
    kind = KIND.get(t, t)
    note = x.get('note') or ''
    if t == 'card' and (x.get('online') or 'только онлайн' in note):
        kind += ', только онлайн'
    cond = []
    if t == 'six':
        cond.append('одно из 6 мест')
    m = re.search(r'При покупке от ([\d.,]+ ?(?:шт|кг))', note)
    if m:
        cond.append('от ' + m.group(1).replace('.', ','))
    d = re.search(r'по (\d\d\.\d\d)', note)
    if d:
        cond.append('до ' + d.group(1))
    if t == 'combo':
        cond.append(f"по отдельности {x.get('sum')} ₽")
    rest = x.get('rest') or '—'
    if str(rest).startswith('Завтра'):
        cond.append('сегодня нет')
    weight = 'кг' in str(rest) and t != 'combo'
    return {'name': esc(x['name']), 'kind': kind,
            'price': x['price'], 'old': old, 'save': save, 'pct': pct, 'rest': rest,
            'cond': '; '.join(cond) or '—', 'weight': weight}

def table(rows, unit=''):
    L = [f'| # | Товар | Вид | Цена{unit} | Было{unit} | Выгода{unit} | Скидка | Остаток | Условия |',
         '|---|---|---|---|---|---|---|---|---|']
    for i, r in enumerate(rows, 1):
        pct = f"−{r['pct']}%" if r['pct'] else '—'
        L.append(f"| {i} | {r['name']} | {r['kind']} | {r['price']} | {r['old']} | {r['save']} ₽ | {pct} | {r['rest']} | {r['cond']} |")
    return L

def main():
    src = sys.argv[1]
    top = int(sys.argv[2]) if len(sys.argv) > 2 else 20
    items = json.load(open(src, encoding='utf-8'))
    items = [x for x in items if not (x['type'] == 'combo' and x.get('suspect'))]
    items = [x for x in items if x.get('price') not in (None, '')]   # без цены — закончился, купить нельзя (2.10.1)
    rows = sorted((row(x) for x in items), key=lambda r: (-r['save'], r['name']))
    piece = [r for r in rows if not r['weight']]
    weight = [r for r in rows if r['weight']]

    base = src[:-len('.items.json')]
    head = open(base + '.md', encoding='utf-8').read().split('\n')
    title = head[0].replace('# Все скидки ВкусВилла', '# Скидки ВкусВилла по выгоде')
    zamer = next((l for l in head if l.startswith('Замер')), '')
    zamer = re.sub(r' \(пересбор;[^)]*\)', '', zamer).split(' Источник:')[0]

    L = [title, '',
         f'{zamer} Та же выборка, что в отчёте за день, одной таблицей: от самой большой выгоды '
         f'в рублях за штуку к самой маленькой. Штучных позиций {len(piece)}, весовых {len(weight)}.', '',
         'Скидки не складываются — действует та, что выгоднее. «6 скидок» дают −20% только на шесть '
         'разных товаров из восемнадцати. У оранжевых выгода — только при покупке от указанного '
         'количества. «Сегодня нет» — товар будет завтра.', '',
         '## Штучные товары', ''] + table(piece)
    if weight:
        L += ['', '## Весовые товары — выгода на 1 кг', '',
              'Товары, которые продаются на вес. Цена и выгода рассчитаны на 1 кг. Скидка действует '
              'на любой вес — меньше или больше килограмма, выгода меняется пропорционально, — если '
              'в колонке «Условия» не указан минимальный вес.', '']
        L += table(weight, ' за кг')
    out = base + '.vygoda.md'
    open(out, 'w', encoding='utf-8').write('\n'.join(L) + '\n')

    print(f'файл: {out}; штучных {len(piece)}, весовых {len(weight)}')
    print('\n'.join(table(piece[:top])))

if __name__ == '__main__':
    main()
