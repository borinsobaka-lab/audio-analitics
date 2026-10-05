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
import { api, Playbook, ScriptLang } from "../api";

interface PlaybookState {
  playbook: Playbook | null;
  error: string | null;
  /** Перечитать дерево; старые данные остаются на экране, пока идёт запрос. */
  reload: () => Promise<void>;
}

const PlaybookContext = createContext<PlaybookState>({
  playbook: null,
  error: null,
  reload: async () => {},
});

export function PlaybookProvider({
  enabled,
  children,
}: {
  /** Грузить, только когда раздел открыт: аналитике скрипты не нужны. */
  enabled: boolean;
  children: ReactNode;
}) {
  const [playbook, setPlaybook] = useState<Playbook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const reload = useCallback(async () => {
    try {
      const data = await api.playbook();
      setPlaybook(data);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    reload();
  }, [enabled, reload]);

  const value = useMemo(() => ({ playbook, error, reload }), [playbook, error, reload]);
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
