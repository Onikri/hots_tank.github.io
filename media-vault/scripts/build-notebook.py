"""Generate an output-free Colab notebook with embedded server-source checksums."""
from pathlib import Path
import hashlib
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
FILES = ['server/source_parser.py', 'server/media_download.py', 'server/run_import.py',
         'server/vault_drive.py', 'server/requirements.txt']
HASHES = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FILES}


def markdown(text):
    return {'cell_type': 'markdown', 'metadata': {}, 'source': text.strip().splitlines(keepends=True)}


def code(text):
    return {'cell_type': 'code', 'execution_count': None, 'metadata': {}, 'outputs': [],
            'source': text.strip().splitlines(keepends=True)}


cells = [markdown('''
# MediaVault · серверный импорт в Google Drive

Видео скачивается **на сервер Google Colab**, собирается в MP4, шифруется AES-GCM
и загружается в ваш Drive. Телефон передаёт небольшое задание; видеотрафик при
импорте не идёт через телефон, GitHub Pages или Cloudflare Worker.

1. На сайте MediaVault откройте свою библиотеку → **Импорт**. Укажите публичные
   ссылки, коллекцию и серии, нажмите **Подготовить серверный импорт → Скопировать задание**.
2. Здесь выберите **Среда выполнения → Выполнить всё**. Достаточно бесплатного CPU;
   GPU, Pro, банковская карта и Cloudflare не требуются.
3. Вставьте скопированное задание в появившееся поле. Затем войдите в аккаунт
   владельца и введите фразу библиотеки в скрытом поле `getpass`.
4. После завершения нажмите **Обновить библиотеку** на сайте.

Используется собственный разбор публичного HTML и открытые адаптеры плееров
`anime-dl-core`. API аниме-сайтов, DRM и платный доступ не используются.
Поддерживаются найденные публичные MP4/HLS и плееры Kodik, Aniboom, Sibnet,
Animedia. Если сайт отдаёт только проверку браузера или скрывает список серий,
понадобятся отдельные публичные ссылки; поддержка всех зеркал не гарантируется.

Бесплатные сессии Colab имеют переменную длительность и могут отключаться.
После каждой завершённой серии результат сохраняется в Drive. Повторный запуск
того же задания пропустит уже записанные серии. Временные файлы занимают место
только для текущей серии и удаляются после неё. Пока идёт импорт, не изменяйте
библиотеку с другого устройства. В Drive должно хватать свободного места.

**Не вставляйте пароль Google, Client Secret, токены или секретную фразу в JSON
задания или ячейки кода.** Фраза вводится только в скрытом поле при запуске и
не записывается в блокнот. Не делитесь работающей сессией и её выводом.
'''), code('''
# 1. Подготовка среды. Код загружается и проверяется до входа в Google.
from pathlib import Path
import hashlib, json, shutil, subprocess, sys, urllib.request

SOURCE_HASHES = ''' + repr(HASHES) + '''
BASE = "https://raw.githubusercontent.com/Onikri/hots_tank.github.io/main/media-vault/"
RUNTIME = Path("/content/mediavault-server")
RUNTIME.mkdir(parents=True, exist_ok=True)
for relative, expected in SOURCE_HASHES.items():
    with urllib.request.urlopen(BASE + relative, timeout=45) as response:
        data = response.read(2 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != expected:
        raise RuntimeError("Исходный код обновился. Откройте свежий блокнот по ссылке с сайта.")
    (RUNTIME / Path(relative).name).write_bytes(data)
subprocess.run([sys.executable, "-m", "pip", "-q", "install", "-r", str(RUNTIME / "requirements.txt")], check=True)
if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
    subprocess.run(["apt-get", "-qq", "update"], check=True)
    subprocess.run(["apt-get", "-qq", "install", "-y", "ffmpeg"], check=True)
sys.path.insert(0, str(RUNTIME))
from run_import import validate_job, run_job
from vault_drive import GoogleDriveAdapter, VaultDrive, VaultError
from source_parser import SourceError
print("Среда готова. Платные ресурсы не включались.")
'''), code('''
# 2. Вставь задание кнопкой «Скопировать задание» на сайте (оно копируется одной строкой).
# Здесь нужны только ссылки и ID каталога. Фразу библиотеки сюда вводить нельзя.
job_text = input("Задание MediaVault (JSON): ").strip()
try:
    job = json.loads(job_text)
    validate_job(job)
except Exception:
    job_text = ""
    raise RuntimeError("Некорректное задание. Скопируйте его кнопкой на сайте заново.") from None
job_text = ""
print("Задание проверено. Далее откроется вход в Google.")
'''), code('''
# 3. Вход владельца, открытие библиотеки и серверный импорт.
from google.colab import auth
from getpass import getpass

auth.authenticate_user()
vault = None
phrase = None
try:
    # Адрес Google-аккаунта проверяется до любых записей в Drive.
    vault = VaultDrive(GoogleDriveAdapter.from_adc())
    phrase = getpass("Секретная фраза открытой библиотеки: ")
    try:
        vault.unlock(job["library_id"], phrase)
    except Exception:
        raise VaultError("Не удалось открыть библиотеку. Проверьте ID, аккаунт и секретную фразу.") from None
    finally:
        phrase = None
    result = run_job(job, vault)
    print("Откройте сайт и нажмите «Обновить библиотеку»:")
    print("https://onikri.github.io/hots_tank.github.io/media-vault/?library=" + vault.library_id)
except (SourceError, VaultError) as error:
    print("Импорт остановлен:", str(error))
    print("Завершённые серии сохранены. После исправления причины можно запустить то же задание.")
except KeyboardInterrupt:
    print("Импорт прерван. Завершённые серии сохранены; то же задание можно продолжить.")
except Exception:
    print("Импорт остановлен из-за ошибки сети, доступа Google или квоты.")
    print("Проверьте свободное место и аккаунт. Повторите запуск; готовые серии будут пропущены.")
finally:
    phrase = None
    if vault is not None:
        vault.close()
    vault = None
'''), markdown('''
### Что сохраняется

Drive содержит каталог, зашифрованные блоки по 4 МиБ и зашифрованные манифесты
восстановления. Разделы называются «Аниме», «Манга», «Ранобэ», «Книги», «Музыка»; имена тайтлов и
видео находятся внутри зашифрованного каталога, а папки тайтлов, сезонов/томов и файлов имеют случайные ID.
Совместимость с веб-приложением проверяется тестами Python ↔ Web Crypto.

Фраза и производный ключ используются в памяти текущего процесса. Авторизацией
Google управляет Colab. Завершите сессию через **Среда выполнения → Отключиться
и удалить среду выполнения**, когда импорт закончен. Во время обычного просмотра
на сайте видео, разумеется, скачивается из Drive на устройство зрителя.

[Исходный код и инструкции](https://github.com/Onikri/hots_tank.github.io/tree/main/media-vault)
· [Использованные открытые библиотеки](https://github.com/Onikri/hots_tank.github.io/blob/main/media-vault/THIRD_PARTY.md)
''')]

notebook = {'nbformat': 4, 'nbformat_minor': 5,
            'metadata': {'colab': {'name': 'MediaVault_Server_Import.ipynb', 'provenance': []},
                         'kernelspec': {'display_name': 'Python 3', 'name': 'python3'},
                         'language_info': {'name': 'python'}}, 'cells': cells}
for index, cell in enumerate(cells):
    cell['id'] = f'mediavault-{index + 1}'
text = json.dumps(notebook, ensure_ascii=False, indent=2) + '\n'
target = ROOT / 'notebooks' / 'MediaVault_Server_Import.ipynb'
if '--check' in sys.argv:
    if not target.exists() or target.read_text() != text:
        raise SystemExit('Colab notebook is stale. Run python scripts/build-notebook.py')
    print('PASS: notebook checksums, source and empty outputs match')
else:
    target.parent.mkdir(exist_ok=True)
    target.write_text(text)
    print(target.relative_to(ROOT))
