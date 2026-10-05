/** Ошибка в одном экране не гасит всю админку.
 *
 *  Без этого любое исключение при отрисовке в React оставляет пустой серый
 *  экран — без меню и без объяснения. Здесь меню остаётся, а на месте
 *  упавшего экрана — что случилось и кнопка «Обновить страницу».
 *  resetKey — адрес страницы: перешли в другой раздел — пробуем снова.
 */
import { Component, ReactNode } from "react";

export default class ErrorBoundary extends Component<
  { resetKey: string; children: ReactNode },
  { error: Error | null; key: string }
> {
  state = { error: null as Error | null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { error: Error | null; key: string }
  ) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error) {
    console.error("Экран упал:", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <h2>Этот экран не открылся</h2>
        <p className="muted">
          Обычно так бывает сразу после обновления: админка уже новая, а сервер ещё старый.
          Обновите страницу через минуту. Если не помогает — сервер нужно передеплоить.
        </p>
        <p className="crash-detail">{this.state.error.message}</p>
        <button type="button" onClick={() => window.location.reload()}>
          Обновить страницу
        </button>
      </div>
    );
  }
}
