/** «Предложить изменения» к конкретному скрипту: кнопка — на шапке каждой
 *  карточки, и в окне сразу видно, о каком скрипте речь. Писать название
 *  руками не нужно — в настройках предложение придёт уже со ссылкой.
 *
 *  Неудачный текст чаще всего замечают те, кто им пользуется, а прав на
 *  правку у них нет. Предложение уходит в «Настройки» скриптов — там его
 *  видят все, кто правит, со значком непрочитанного у каждого своим.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Note } from "../components/ui";

export default function SuggestDialog({
  item,
  onClose,
}: {
  /** Скрипт, к которому предложение: id для ссылки, название и раздел — для глаз. */
  item: { id: string; title: string; section: string };
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    // showModal ставит фокус на первую кнопку — на «✕»; пишут же сразу в поле.
    field.current?.focus();
  }, []);

  const trimmed = text.trim();

  async function send() {
    if (trimmed.length < 3 || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.suggestScript(trimmed, item.id);
      setSent(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      className="modal modal-narrow"
      aria-labelledby="suggest-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
    >
      <div className="modal-head">
        <div>
          <h2 id="suggest-title">Предложить изменения</h2>
          <p className="muted">
            Увидят те, кто правит скрипты, — в «Настройках».
          </p>
        </div>
        <button
          type="button"
          className="ghost small icon-btn"
          aria-label="Закрыть"
          onClick={() => ref.current?.close()}
        >
          ✕
        </button>
      </div>

      {/* О каком скрипте речь — тёмной плашкой, как шапка карточки. */}
      <div className="suggest-target">
        <span className="suggest-target-label">Скрипт</span>
        <strong className="suggest-target-title">{item.title}</strong>
        {item.section && <span className="suggest-target-section">{item.section}</span>}
      </div>

      {sent ? (
        <div className="modal-body">
          <div className="suggest-sent">
            <strong>Спасибо, отправлено.</strong>
            <span className="muted">Предложение уже в настройках скриптов.</span>
          </div>
          <div className="modal-foot">
            <button type="button" onClick={() => ref.current?.close()}>
              Готово
            </button>
          </div>
        </div>
      ) : (
        <form
          className="modal-body"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <label className="field suggest-field">
            <span className="label">Что вы планируете изменить</span>
            <textarea
              ref={field}
              rows={6}
              maxLength={3000}
              value={text}
              placeholder="Например: добавить ответ про рассрочку, в EN-версии старая цена"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Ctrl/⌘ + Enter — отправить, не дотягиваясь до кнопки.
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  send();
                }
              }}
            />
          </label>
          {error && <Note kind="error">{error}</Note>}
          <div className="modal-foot">
            <button type="button" className="secondary" onClick={() => ref.current?.close()}>
              Отмена
            </button>
            <button type="submit" disabled={busy || trimmed.length < 3}>
              {busy ? "Отправляем…" : "Отправить"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
