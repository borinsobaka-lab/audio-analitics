/** Кто вошёл — один источник правды на всё приложение.
 *
 *  Права проверяет сервер, здесь они нужны для другого: не показывать кнопку,
 *  которая всё равно ответит «недостаточно прав». Прятать вместо того, чтобы
 *  ругаться постфактум.
 */
import { createContext, useContext } from "react";
import { Location, Me } from "./api";

export const SessionContext = createContext<Me | null>(null);

/** Выбранная студия — сквозной фильтр смен и дашборда.
 *
 *  Живёт рядом с пользователем, а не внутри страницы: переключаешь студию
 *  один раз внизу меню и ходишь по разделам, не переставляя фильтр заново.
 *  Пустая строка — «все студии».
 */
export interface StudioState {
  locationId: string;
  setLocationId: (id: string) => void;
  locations: Location[];
}

export const StudioContext = createContext<StudioState>({
  locationId: "",
  setLocationId: () => {},
  locations: [],
});

export function useStudio(): StudioState {
  return useContext(StudioContext);
}

export function useSession(): Me {
  const me = useContext(SessionContext);
  if (!me) {
    // До входа дерево страниц не монтируется вовсе, так что сюда попасть
    // можно только из-за ошибки в разметке приложения.
    throw new Error("useSession вызван вне сессии");
  }
  return me;
}
