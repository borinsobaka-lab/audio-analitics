/** Кто вошёл — один источник правды на всё приложение.
 *
 *  Права проверяет сервер, здесь они нужны для другого: не показывать кнопку,
 *  которая всё равно ответит «недостаточно прав». Прятать вместо того, чтобы
 *  ругаться постфактум.
 */
import { createContext, useContext } from "react";
import { Me } from "./api";

export const SessionContext = createContext<Me | null>(null);

export function useSession(): Me {
  const me = useContext(SessionContext);
  if (!me) {
    // До входа дерево страниц не монтируется вовсе, так что сюда попасть
    // можно только из-за ошибки в разметке приложения.
    throw new Error("useSession вызван вне сессии");
  }
  return me;
}
