#!/usr/bin/env bash
# Guarantees the microphone usage description ends up in the bundled app.
#
# Without NSMicrophoneUsageDescription macOS never shows the permission
# prompt and silently feeds the app digital silence. Tauri is supposed to
# merge src-tauri/Info.plist, but this step makes it deterministic — and
# re-signs the bundle, because editing Info.plist invalidates the signature.
#
# Аргумент — цель сборки (например universal-apple-darwin). Без аргумента
# берётся обычная сборка под архитектуру текущей машины.
set -euo pipefail

TARGET="${1:-}"
if [ -n "$TARGET" ]; then
  APP="src-tauri/target/$TARGET/release/bundle/macos/Audio Recorder.app"
else
  APP="src-tauri/target/release/bundle/macos/Audio Recorder.app"
fi
PLIST="$APP/Contents/Info.plist"
DESCRIPTION="Приложение записывает разговоры на ресепшене для аналитики качества обслуживания и продаж."

if [ ! -d "$APP" ]; then
  echo "Бандл не найден: $APP" >&2
  exit 1
fi

plutil -replace NSMicrophoneUsageDescription -string "$DESCRIPTION" "$PLIST"

# --deep и проверка — не перестраховка. Со сломанной подписью macOS не может
# понять, кто просит микрофон, и отказывает МОЛЧА: окно с вопросом не
# появляется вовсе, а приложение получает цифровую тишину. Снаружи это
# неотличимо от выключенного микрофона, и ищется полдня.
codesign --force --deep --sign - "$APP"

if ! codesign --verify --strict --verbose=2 "$APP" 2>&1 | grep -q "valid on disk"; then
  echo >&2
  echo "❌ Подпись бандла не прошла проверку — приложение не сможет получить" >&2
  echo "   доступ к микрофону. Вывод codesign:" >&2
  codesign --verify --strict --verbose=2 "$APP" >&2 || true
  exit 1
fi

echo "Info.plist обновлён, приложение переподписано:"
plutil -p "$PLIST" | grep -i microphone
echo "Подпись: проверена"
echo "Архитектуры бандла:"
lipo -archs "$APP/Contents/MacOS/Audio Recorder"
