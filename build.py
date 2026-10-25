#!/usr/bin/env python3
"""Finovo — общая сборка: сайт + кабинет в одну папку dist/ для Netlify.

  1. kabinet/make_app.py  → кабинет (kabinet/out/kabinet) и демо для сайта (kabinet/out/demo.html)
  2. демо копируется в site/src/demo/index.html
  3. site/build.py        → сайт (site/dist)
  4. dist/ = сайт, кабинет лежит в dist/app/

Запуск:  python3 build.py   (на Netlify это делает netlify.toml)
Нужен только Python 3, без пакетов.
"""
import shutil, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).parent
DIST = ROOT / 'dist'
APP_DIR = 'app'   # адрес кабинета на сайте: /app/

def run(script: Path):
    subprocess.run([sys.executable, script.name], cwd=script.parent, check=True)

run(ROOT / 'kabinet' / 'make_app.py')
shutil.copy(ROOT / 'kabinet' / 'out' / 'demo.html', ROOT / 'site' / 'src' / 'demo' / 'index.html')
run(ROOT / 'site' / 'build.py')

if DIST.exists(): shutil.rmtree(DIST)
shutil.copytree(ROOT / 'site' / 'dist', DIST)
app = DIST / APP_DIR
shutil.copytree(ROOT / 'kabinet' / 'out' / 'kabinet', app)
# у кабинета свои _headers / robots.txt рассчитаны на отдельный сайт — переносим их правила в общий файл
(app / '_headers').unlink(missing_ok=True)
(app / 'robots.txt').unlink(missing_ok=True)

with open(DIST / '_headers', 'a', encoding='utf-8') as f:
    f.write(f'''# кабинет: не индексируется, свежий index.html и service worker
/{APP_DIR}/*
  X-Robots-Tag: noindex, nofollow
/{APP_DIR}/
  Cache-Control: no-cache
/{APP_DIR}/index.html
  Cache-Control: no-cache
/{APP_DIR}/sw.js
  Cache-Control: no-cache
''')

with open(DIST / '_redirects', 'a', encoding='utf-8') as f:
    f.write(f'''# кабинет на поддомене (когда app.finovo.com.pl будет добавлен в Netlify → Domain management)
https://app.finovo.com.pl/*  /{APP_DIR}/:splat  200!
''')

print('Готово: dist/ (сайт) + dist/%s/ (кабинет)' % APP_DIR)
