#!/usr/bin/env bash
# Сборка приложения записи под macOS — одной командой.
#
# Делает четыре вещи, которые раньше приходилось помнить руками:
#   1. подставляет адрес сервера и ключ приложения из src-tauri/build.env;
#   2. подписывает сборку ключом обновлений, если он лежит рядом;
#   3. чинит Info.plist (без описания микрофона macOS молча пишет тишину)
#      и переподписывает бандл;
#   4. ПЕРЕСОБИРАЕТ архив обновления после этой правки.
#
# Четвёртый пункт — не формальность. Tauri пакует .app.tar.gz сразу после
# сборки, то есть ДО того, как мы правим Info.plist. Без пересборки архива
# обновление разносило бы по студиям версию без разрешения на микрофон:
# приложение открывалось бы и писало тишину.
set -euo pipefail

cd "$(dirname "$0")/.."

# Всегда универсальная сборка: один архив обслуживает и Apple Silicon, и
# Intel. Отдельная сборка под одну архитектуру была бы ловушкой — выложить
# её как обновление значило бы сломать половину студий.
TARGET="universal-apple-darwin"
BUNDLE="src-tauri/target/$TARGET/release/bundle/macos"
APP="$BUNDLE/Audio Recorder.app"
ARCHIVE="$BUNDLE/Audio Recorder.app.tar.gz"
KEY="src-tauri/updater.key"

# --- Ключ подписи обновлений ------------------------------------------------
# Публичный ключ вшивается в приложение и проверяет каждую новую сборку. Без
# него приложение с плагином обновлений не запустится вообще, поэтому пустой
# ключ — это остановка, а не предупреждение: лучше десять секунд на keygen,
# чем сборка, которая не откроется на ресепшене.
PUBKEY=$(node -e '
const c = require("./src-tauri/tauri.conf.json");
process.stdout.write((c.plugins && c.plugins.updater && c.plugins.updater.pubkey) || "");
')
if [ -z "$PUBKEY" ]; then
  echo "❌ В src-tauri/tauri.conf.json не прописан публичный ключ обновлений."
  echo "   Выполните один раз: npm run keygen"
  exit 1
fi

if [ -f "$KEY" ]; then
  export TAURI_SIGNING_PRIVATE_KEY="$PWD/$KEY"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
  SIGNING=1
else
  echo "⚠️  $KEY не найден — сборка будет без подписи обновления."
  echo "   Приложение соберётся и запишет смену, но выложить такую сборку в"
  echo "   админку не выйдет: студии не примут архив без подписи."
  echo "   Приватный ключ лежит на маке, где делали keygen. Если он потерян,"
  echo "   обновление по кнопке уже не поднять — придётся обойти студии."
  SIGNING=0
fi

echo "▶ Сборка ($TARGET). В первый раз это 10–25 минут."
npx tauri build --target "$TARGET"

# --- Разрешение на микрофон -------------------------------------------------
bash scripts/patch-macos-plist.sh "$TARGET"

# --- Архив обновления -------------------------------------------------------
if [ "$SIGNING" = "1" ]; then
  echo "▶ Пересобираем архив обновления после правки Info.plist"
  rm -f "$ARCHIVE" "$ARCHIVE.sig"
  # tar запускается из папки бандла, чтобы внутри архива лежал сам .app,
  # а не цепочка родительских папок.
  tar -czf "$ARCHIVE" -C "$BUNDLE" "Audio Recorder.app"
  npx tauri signer sign \
    --private-key-path "$PWD/$KEY" \
    --password "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" \
    "$PWD/$ARCHIVE"

  VERSION=$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist")
  echo
  echo "✅ Готово. Версия $VERSION."
  echo
  echo "Чтобы студии обновились сами, выложите в админке (раздел «Приложение»)"
  echo "эти два файла:"
  echo "   $PWD/$ARCHIVE"
  echo "   $PWD/$ARCHIVE.sig"
else
  echo
  echo "✅ Готово, но без архива обновления."
fi

echo
echo "Само приложение: $PWD/$APP"
