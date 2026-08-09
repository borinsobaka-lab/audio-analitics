#!/usr/bin/env bash
# Ключ подписи обновлений — создаётся один раз на всю жизнь приложения.
#
# Приватный ключ остаётся на маке владельца и в репозиторий не попадает.
# Публичный сразу прописывается в tauri.conf.json: именно он вшивается в
# приложение и не даёт установить архив, подписанный кем-то другим.
#
# Потерять приватный ключ — значит потерять возможность обновлять уже
# установленные приложения: они не примут сборку, подписанную новым ключом,
# и их придётся переустанавливать руками. Сделайте копию в менеджере паролей.
set -euo pipefail

cd "$(dirname "$0")/.."

KEY="src-tauri/updater.key"

if [ -f "$KEY" ]; then
  echo "Ключ уже есть: $KEY"
  echo "Создавать новый не нужно — иначе установленные приложения перестанут"
  echo "принимать обновления. Если всё же нужно, удалите файл вручную."
  exit 1
fi

echo "▶ Создаём ключ. На вопрос про пароль просто нажмите Enter два раза —"
echo "  файл ключа и так лежит только на этом компьютере."
npx tauri signer generate -w "$KEY"

PUB=$(cat "$KEY.pub")

# Публичный ключ прописывается в конфиг: править JSON руками — лишний повод
# для опечатки в base64-строке на сотню символов.
node -e '
const fs = require("fs");
const path = "src-tauri/tauri.conf.json";
const config = JSON.parse(fs.readFileSync(path, "utf8"));
config.plugins = config.plugins || {};
config.plugins.updater = config.plugins.updater || {};
config.plugins.updater.pubkey = process.argv[1];
fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
' "$PUB"

echo
echo "✅ Готово."
echo "   Приватный ключ: $PWD/$KEY  (сохраните копию, в git он не попадает)"
echo "   Публичный вписан в src-tauri/tauri.conf.json — его нужно закоммитить."
