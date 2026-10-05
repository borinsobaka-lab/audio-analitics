/** Подложка выбранного варианта, которая переезжает к новому выбору.
 *
 *  Контейнер получает класс `slide`, а хук пишет в него координаты кнопки
 *  `.on` CSS-переменными; саму подложку рисует `::before` и анимирует
 *  переход. Без JS-анимации: только положение и ширина, остальное — CSS.
 *
 *  При первом показе подложка встаёт на место без анимации: иначе каждый
 *  переключатель на странице «выезжал» бы слева при загрузке.
 */
import { HTMLAttributes, ReactNode, useEffect, useLayoutEffect, useRef } from "react";

export function useSlider<T extends HTMLElement = HTMLDivElement>(active: unknown) {
  const ref = useRef<T>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const on = el.querySelector<HTMLElement>(":scope > .on");
      if (!on) {
        el.style.setProperty("--thumb-o", "0");
        return;
      }
      el.style.setProperty("--thumb-x", `${on.offsetLeft}px`);
      el.style.setProperty("--thumb-y", `${on.offsetTop}px`);
      el.style.setProperty("--thumb-w", `${on.offsetWidth}px`);
      el.style.setProperty("--thumb-h", `${on.offsetHeight}px`);
      el.style.setProperty("--thumb-o", "1");
    };
    place();
    // Ширины кнопок меняются, когда догружается шрифт или сжимается экран.
    const ro = new ResizeObserver(place);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [active]);

  useEffect(() => {
    const id = requestAnimationFrame(() => ref.current?.setAttribute("data-ready", ""));
    return () => cancelAnimationFrame(id);
  }, []);

  return ref;
}

/** Переключатель с переезжающей подложкой: `<Slider className="seg" active={lang}>`.
 *  `active` — выбранное значение; поменялось — подложка едет к новой `.on`. */
export function Slider({
  active,
  className = "",
  children,
  ...rest
}: { active: unknown; children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  const ref = useSlider<HTMLDivElement>(active);
  return (
    <div ref={ref} className={`${className} slide`.trim()} {...rest}>
      {children}
    </div>
  );
}
