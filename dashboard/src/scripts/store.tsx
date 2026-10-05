/** Состояние продукта «Скрипты», общее для меню и страницы.
 *
 *  Разделы показываются в боковом меню, а скрипты — на странице, поэтому
 *  дерево загружается один раз выше обоих. После правки оно перечитывается
 *  целиком: скриптов десятки, и так меню и страница не расходятся.
 */
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, Playbook, PlaybookSettings, ScriptLang } from "../api";
import { readCache, take, writeCache } from "../boot";

interface PlaybookState {
  playbook: Playbook | null;
  /** Настройки подстановки ({админ}, {студия}, свои переменные). null —
   *  ещё грузятся или недоступны: тогда переменные остаются как есть. */
  settings: PlaybookSettings | null;
  setSettings: (settings: PlaybookSettings) => void;
  error: string | null;
  /** Перечитать дерево; старые данные остаются на экране, пока идёт запрос. */
  reload: () => Promise<void>;
  /** Новые предложения сотрудников, которых этот администратор не видел. */
  unread: number;
  setUnread: (count: number) => void;
  /** Открыть ИИ-помощника извне страницы скриптов — из нижней панели на
   *  телефоне. Страница скриптов откроет окно и снимет флаг. */
  assistPending: boolean;
  setAssistPending: (value: boolean) => void;
}

const PlaybookContext = createContext<PlaybookState>({
  playbook: null,
  settings: null,
  setSettings: () => {},
  error: null,
  reload: async () => {},
  unread: 0,
  setUnread: () => {},
  assistPending: false,
  setAssistPending: () => {},
});

/** Как часто проверять новые предложения: раз в минуту хватает, чтобы
 *  значок появился, пока администратор работает в скриптах. */
const UNREAD_POLL_MS = 60_000;

export function PlaybookProvider({
  enabled,
  watchSuggestions,
  children,
}: {
  /** Грузить, только когда раздел открыт: аналитике скрипты не нужны. */
  enabled: boolean;
  /** Следить за новыми предложениями — только у тех, кто правит скрипты. */
  watchSuggestions: boolean;
  children: ReactNode;
}) {
  const [unread, setUnread] = useState(0);
  const [assistPending, setAssistPending] = useState(false);
  // Сохранённое с прошлого раза — сразу на экран; свежее придёт следом.
  const [playbook, setPlaybook] = useState<Playbook | null>(() => readCache<Playbook>("playbook"));
  const [settings, setSettingsState] = useState<PlaybookSettings | null>(() =>
    readCache<PlaybookSettings>("settings")
  );
  const setSettings = useCallback((value: PlaybookSettings) => {
    writeCache("settings", value);
    setSettingsState(value);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const reload = useCallback(async () => {
    try {
      // Первый раз — ответ на запрос, начатый ещё до отрисовки (boot.ts).
      const data = await take("playbook", api.playbook);
      setPlaybook(data);
      writeCache("playbook", data);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Настройки грузятся рядом, но отдельно: без них скрипты всё равно
  // читаются, просто {админ} и {студия} останутся неподставленными.
  const loadSettings = useCallback(() => {
    take("settings", api.playbookSettings)
      .then(setSettings)
      .catch(() => {});
  }, [setSettings]);

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    reload();
    loadSettings();
  }, [enabled, reload, loadSettings]);

  useEffect(() => {
    if (!watchSuggestions) return;
    let alive = true;
    const check = () =>
      api
        .unreadSuggestions()
        .then((r) => alive && setUnread(r.count))
        .catch(() => {});
    check();
    const timer = window.setInterval(check, UNREAD_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [watchSuggestions]);

  const value = useMemo(
    () => ({
      playbook,
      settings,
      setSettings,
      error,
      reload,
      unread,
      setUnread,
      assistPending,
      setAssistPending,
    }),
    [playbook, settings, setSettings, error, reload, unread, assistPending]
  );
  return <PlaybookContext.Provider value={value}>{children}</PlaybookContext.Provider>;
}

export function usePlaybook(): PlaybookState {
  return useContext(PlaybookContext);
}

/* --- Язык и студия: выбираются один раз и запоминаются ------------------ */

const LANG_KEY = "aa_script_lang";
const STUDIO_KEY = "aa_script_studio";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* приватный режим — выбор просто не переживёт перезагрузку */
  }
}

/** Администратор весь день переписывается на одном-двух языках и сидит на
 *  одной студии: переключать их у каждого скрипта заново было бы пыткой.
 *  Поэтому выбор общий для всех карточек и переживает перезагрузку. */
export function useScriptPrefs() {
  const [lang, setLangState] = useState<ScriptLang>(() => {
    const saved = read(LANG_KEY);
    return saved === "en" || saved === "ka" ? saved : "ru";
  });
  const [studio, setStudioState] = useState<string>(() => read(STUDIO_KEY) ?? "");

  const setLang = useCallback((value: ScriptLang) => {
    setLangState(value);
    write(LANG_KEY, value);
  }, []);
  const setStudio = useCallback((value: string) => {
    setStudioState(value);
    write(STUDIO_KEY, value);
  }, []);

  return { lang, setLang, studio, setStudio };
}
