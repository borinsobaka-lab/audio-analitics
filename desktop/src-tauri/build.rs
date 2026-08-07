fn main() {
    // Адрес сервера и ключ приложения вшиваются в сборку — чтобы у сотрудника
    // на ресепшене осталась одна настройка, «Точка продажи».
    //
    // Задать их можно двумя способами: переменными окружения или файлом
    // build.env рядом с этим файлом. Файл — для того, кто собирает приложение
    // раз в полгода: правится в любом текстовом редакторе, ничего длинного
    // печатать в терминале не нужно, и значение не теряется между сборками.
    //
    // Строки rerun-if обязательны: без них cargo не знает, что от этих
    // значений зависит результат, и после правки соберёт из кеша старое.
    println!("cargo:rerun-if-env-changed=AA_SERVER_URL");
    println!("cargo:rerun-if-env-changed=AA_APP_KEY");
    println!("cargo:rerun-if-changed=build.env");

    if let Ok(text) = std::fs::read_to_string("build.env") {
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let key = key.trim();
            let value = value.trim().trim_matches('"');
            // Переменная окружения важнее файла: так сборочный скрипт может
            // подставить своё значение, не трогая файл.
            if matches!(key, "AA_SERVER_URL" | "AA_APP_KEY")
                && !value.is_empty()
                && std::env::var(key).is_err()
            {
                println!("cargo:rustc-env={key}={value}");
            }
        }
    }

    tauri_build::build()
}
