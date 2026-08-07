/** Поднять номер версии приложения на единицу.
 *
 *  Приложения на ресепшенах сравнивают свою версию с той, что лежит на
 *  сервере, и обновляются, только если серверная больше. Собрать новую сборку
 *  со старым номером — самая простая и самая обидная ошибка: выложить её
 *  сервер не даст, а понять почему получится не сразу.
 *
 *  Запуск: npm run bump           → 0.1.0 → 0.1.1
 *          npm run bump -- minor  → 0.1.5 → 0.2.0
 */
import { readFileSync, writeFileSync } from "node:fs";

const kind = process.argv[2] ?? "patch";
const CONFIG = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const PACKAGE = new URL("../package.json", import.meta.url);

const config = JSON.parse(readFileSync(CONFIG, "utf8"));
const [major, minor, patch] = String(config.version).split(".").map(Number);
if ([major, minor, patch].some(Number.isNaN)) {
  console.error(`Не понимаю текущую версию «${config.version}» — нужен вид 1.2.3`);
  process.exit(1);
}

const next =
  kind === "major"
    ? `${major + 1}.0.0`
    : kind === "minor"
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;

config.version = next;
writeFileSync(CONFIG, JSON.stringify(config, null, 2) + "\n");

// package.json держим в том же номере — иначе через полгода не понять, какая
// версия настоящая.
const pkg = JSON.parse(readFileSync(PACKAGE, "utf8"));
pkg.version = next;
writeFileSync(PACKAGE, JSON.stringify(pkg, null, 2) + "\n");

console.log(`Версия: ${major}.${minor}.${patch} → ${next}`);
console.log("Теперь соберите: npm run build:mac:universal");
