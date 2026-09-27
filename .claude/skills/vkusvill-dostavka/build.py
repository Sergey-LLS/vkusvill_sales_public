#!/usr/bin/env python3
"""Собирает печатаемые копии из scripts.js:
  scripts.min.js — весь файл без комментариев и пустых строк;
  cart-kit.js    — только функции, нужные на /cart/ (шаг 1 исполнителя).
Последняя строка каждой копии сверяет отпечаток вставленного кода с эталоном
(vvFingerprint) и отвечает «check: ok» или «check: ИСКАЖЁН». Эталон считается
здесь же запуском копии в Node — для сборки нужен node, для работы скилла нет.
Запуск: python3 build.py (из папки скилла). Правишь scripts.js — пересобери.
"""
import json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'scripts.js')
CART_FUNCS = ['vvGet', 'vvT', 'vvNum', 'vvSave', 'vvLoad', 'headerInfo',
              'loadLazy', 'lazyWarn', 'lazyWarnings', 'greenEmpty', 'waitGreen', 'readGreen', 'couponsText', 'readBasket', 'cartSnapshot',
              'cartDiff', 'cartSixPlaces', 'cartStep', 'vvFingerprint']
SKIP = {'COMBO_EXTRA'}   # задаётся исполнителем, в отпечаток не входит

def check_escapes(text, name):
    # u-escape: инструмент вставки превращает \uXXXX и \xXX в сам символ — отпечаток расходится (26.09)
    bad = re.findall(r'\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}', text)
    if bad:
        sys.exit(f'build.py: в {name} есть {bad[:3]} — писать без экранирования символов')

def strip_comments(text):
    out = []
    for line in text.split('\n'):
        if re.match(r'^\s*//', line) or not line.strip():
            continue
        out.append(re.sub(r'\s+// .*$', '', line))   # хвостовой комментарий «  // …»
    return '\n'.join(out) + '\n'

def extract(text, name):
    """Оператор `window.NAME = …` целиком: от его строки до следующей строки,
    начинающейся с `window.`, `//` или `'vkusvill` в первой колонке.
    Файл написан так, что каждая функция — один такой блок."""
    lines = text.split('\n')
    start = next((i for i, l in enumerate(lines) if re.match(r'^window\.' + re.escape(name) + r'\s*=', l)), None)
    if start is None:
        sys.exit(f'build.py: в scripts.js нет window.{name}')
    end = start + 1
    while end < len(lines) and not re.match(r"^(window\.|//|'vkusvill)", lines[end]):
        end += 1
    return '\n'.join(lines[start:end]).rstrip('\n')

NODE_FP = r"""
const vm = require('vm'), fs = require('fs');
const [file, names] = [process.argv[1], JSON.parse(process.argv[2])];
const st = () => { const m = {}; return { getItem: k => m[k] ?? null, setItem: (k, v) => { m[k] = String(v); } }; };
const ctx = { document: { querySelector: () => null, querySelectorAll: () => [] }, sessionStorage: st(),
  localStorage: st(), location: { origin: 'https://vkusvill.ru', href: 'https://vkusvill.ru/' }, console };
ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
process.stdout.write(vm.runInContext('vvFingerprint(' + JSON.stringify(names) + ')', ctx));
"""

def seal(path, names, last):
    """Дописать строку сверки: эталон отпечатка считается запуском файла в Node."""
    body = open(path, encoding='utf-8').read()
    open(path, 'w', encoding='utf-8').write(body + last.replace('HASH', '0') + '\n')
    fp = subprocess.run(['node', '-e', NODE_FP, path, json.dumps(names)],
                        capture_output=True, text=True, check=True).stdout.strip()
    open(path, 'w', encoding='utf-8').write(body + last.replace('HASH', fp) + '\n')
    return fp

def minify(code, name):
    """Сжатие для печати (2.10): terser только с переименованием локальных имён — без
    переписывания логики (--compress выключен), русский текст как есть, строки не длиннее
    ~400 знаков (длинную строку инструмент чтения обрезал бы). Нет terser — копия без сжатия."""
    import tempfile
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as f:
        f.write(code); tmp = f.name
    try:
        out = subprocess.run(['npx', '--no-install', 'terser', tmp, '--mangle',
                              '-f', 'ascii_only=false,comments=false,max_line_len=400'],
                             capture_output=True, text=True, check=True).stdout
    except Exception as e:
        print(f'build.py: terser недоступен ({e}) — {name} без сжатия'); return code
    finally:
        os.unlink(tmp)
    check_escapes(out, name + ' (после terser)')
    return out.rstrip('\n') + '\n'

def check_expr(names):
    return f"(vvFingerprint({json.dumps(names, ensure_ascii=False)}) === 'HASH' ? 'ok' : 'ИСКАЖЁН')"

# --check: собрать, сравнить с лежащими копиями и вернуть их как были — забытая пересборка
# после правки scripts.js иначе дала бы «check: ok» на старом коде (2.10)
CHECK = '--check' in sys.argv
COPIES = ['scripts.min.js', 'cart-kit.js']
before = {f: open(os.path.join(HERE, f), encoding='utf-8').read() for f in COPIES} if CHECK else {}
src = open(SRC, encoding='utf-8').read()
names = [n for n in re.findall(r'^window\.([A-Za-z_$][\w$]*)\s*=', src, re.M) if n not in SKIP]

check_escapes(strip_comments(src), 'scripts.js')
mini = strip_comments(src).rstrip('\n').split('\n')
last = mini.pop()                                   # 'vkusvill scripts loaded …' + vvCheck()
assert last.startswith("'vkusvill scripts loaded"), last
p = os.path.join(HERE, 'scripts.min.js')
open(p, 'w', encoding='utf-8').write(minify('\n'.join(mini) + '\n', 'scripts.min.js'))
fp_min = seal(p, names, last.rstrip(';') + " + ', check: ' + " + check_expr(names) + ';')

kit = '\n'.join(strip_comments(extract(src, n)).rstrip('\n') for n in CART_FUNCS)
kit += ("\nwindow.vvCheckCart = () => " + json.dumps(CART_FUNCS)
        + ".filter(f => typeof window[f] !== 'function');\n")
p = os.path.join(HERE, 'cart-kit.js')
open(p, 'w', encoding='utf-8').write(minify(kit, 'cart-kit.js'))
fp_kit = seal(p, CART_FUNCS, "'vkusvill cart-kit loaded, missing: ' + JSON.stringify(vvCheckCart()) + ', check: ' + "
              + check_expr(CART_FUNCS) + ';')

size = lambda f: os.path.getsize(os.path.join(HERE, f))
print(f"scripts.min.js {size('scripts.min.js')} байт (отпечаток {fp_min}), cart-kit.js {size('cart-kit.js')} байт (отпечаток {fp_kit})")
if CHECK:
    stale = [f for f in COPIES if open(os.path.join(HERE, f), encoding='utf-8').read() != before[f]]
    for f in COPIES:
        open(os.path.join(HERE, f), 'w', encoding='utf-8').write(before[f])
    print(f'build.py --check: не пересобраны {stale} — запустить python3 build.py' if stale else 'build.py --check: копии совпадают с исходником')
    sys.exit(1 if stale else 0)
