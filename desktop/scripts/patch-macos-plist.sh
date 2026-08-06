#!/usr/bin/env bash
# Guarantees the microphone usage description ends up in the bundled app.
#
# Without NSMicrophoneUsageDescription macOS never shows the permission
# prompt and silently feeds the app digital silence. Tauri is supposed to
# merge src-tauri/Info.plist, but this step makes it deterministic — and
# re-signs the bundle, because editing Info.plist invalidates the signature.
set -euo pipefail

APP="src-tauri/target/release/bundle/macos/Audio Recorder.app"
PLIST="$APP/Contents/Info.plist"
DESCRIPTION="Приложение записывает разговоры на ресепшене для аналитики качества обслуживания и продаж."

if [ ! -d "$APP" ]; then
  echo "Бандл не найден: $APP" >&2
  exit 1
fi

plutil -replace NSMicrophoneUsageDescription -string "$DESCRIPTION" "$PLIST"
codesign --force --sign - "$APP"

echo "Info.plist обновлён, приложение переподписано:"
plutil -p "$PLIST" | grep -i microphone
