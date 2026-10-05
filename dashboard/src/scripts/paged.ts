/** Порционная подгрузка списка по курсору: первая порция сразу, следующая —
 *  когда низ списка доезжает до экрана (или по кнопке «Показать ещё»).
 *  Хронология растёт с каждой правкой, и тянуть её всю разом незачем.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Page } from "../api";

export function usePaged<T>(load: (cursor: string) => Promise<Page<T>>) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  const fetchPage = useCallback(async (from: string, replace: boolean) => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setError("");
    try {
      const page = await loadRef.current(from);
      setItems((list) => (replace ? page.items : [...list, ...page.items]));
      setCursor(page.next_cursor);
      setDone(!page.next_cursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPage("", true);
  }, [fetchPage]);

  const more = useCallback(() => {
    if (!done && cursor) fetchPage(cursor, false);
  }, [done, cursor, fetchPage]);

  /** Повесить на элемент под списком: дошли до него — грузим дальше. */
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || done || error) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) more();
      },
      { rootMargin: "400px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [more, done, error, items.length]);

  return { items, setItems, loading, error, done, more, sentinel };
}
