/** Предложения сотрудников — что они просят поправить в скриптах.
 *
 *  Новые (пришедшие после прошлого просмотра этим администратором)
 *  подсвечены; открыть список — значит прочитать, и значок в меню гаснет.
 *  Сделанное отмечают кнопкой — оно остаётся в списке, приглушённым.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, fmtWhen, ScriptSuggestion } from "../api";
import { Empty, Note, Skeleton } from "../components/ui";
import { scriptPath } from "./logic";
import { usePaged } from "./paged";
import { usePlaybook } from "./store";

function SuggestionCard({
  item,
  onChange,
}: {
  item: ScriptSuggestion;
  onChange: (next: ScriptSuggestion) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const done = item.status === "done";
  const { playbook } = usePlaybook();
  const navigate = useNavigate();
  // Скрипт жив — ведём к нему; удалён — остаётся название на момент отправки.
  const live = item.item_id
    ? playbook?.sections
        .map((sec) => ({ sec, it: sec.items.find((i) => i.id === item.item_id) }))
        .find((x) => x.it)
    : undefined;

  async function toggle() {
    setBusy(true);
    setError("");
    try {
      const next = await api.setSuggestionStatus(item.id, done ? "open" : "done");
      onChange({ ...next, unread: item.unread });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`suggestion${item.unread ? " unread" : ""}${done ? " done" : ""}`}>
      <header className="suggestion-head">
        {item.unread && <span className="suggestion-new">Новое</span>}
        <strong>{item.author_name || "—"}</strong>
        <span className="muted num">{fmtWhen(item.created_at)}</span>
        <span className="grow" />
        {done && (
          <span className="suggestion-done-by">
            ✓ Сделано{item.resolved_by ? ` · ${item.resolved_by}` : ""}
            {item.resolved_at ? ` · ${fmtWhen(item.resolved_at)}` : ""}
          </span>
        )}
        <button type="button" className={done ? "ghost small" : "secondary small"}
          disabled={busy} onClick={toggle}>
          {done ? "Вернуть" : "Сделано"}
        </button>
      </header>
      {item.item_title && (
        <div className="suggestion-script">
          <span className="suggestion-script-label">Скрипт</span>
          {live ? (
            <button type="button" className="suggestion-script-link" title="Открыть скрипт"
              onClick={() => navigate(scriptPath(live.sec.id, live.it!.id))}>
              {live.it!.title}
            </button>
          ) : (
            <span className="suggestion-script-gone" title="Скрипт удалён">
              {item.item_title}
            </span>
          )}
          {live && live.sec.title && <span className="muted">· {live.sec.title}</span>}
        </div>
      )}
      <p className="suggestion-text">{item.text}</p>
      {error && <Note kind="error">{error}</Note>}
    </article>
  );
}

export default function Suggestions() {
  const { setUnread } = usePlaybook();
  const { items, setItems, loading, error, done, more, sentinel } = usePaged(
    api.scriptSuggestions
  );

  // Открыли — прочитали: значок гаснет. Подсветка новых в этом списке
  // остаётся до ухода со страницы — видно, что именно пришло.
  useEffect(() => {
    api
      .markSuggestionsSeen()
      .then(() => setUnread(0))
      .catch(() => {});
  }, [setUnread]);

  if (!items.length && loading) return <Skeleton count={3} height={90} />;
  if (!items.length && error) return <Note kind="error">{error}</Note>;
  if (!items.length)
    return (
      <Empty title="Предложений пока нет">
        Сотрудники отправляют их кнопкой «Предложить изменения» над скриптами.
      </Empty>
    );

  return (
    <div className="suggestion-list">
      {items.map((s) => (
        <SuggestionCard
          key={s.id}
          item={s}
          onChange={(next) => setItems((list) => list.map((x) => (x.id === next.id ? next : x)))}
        />
      ))}
      {error && <Note kind="error">{error}</Note>}
      {!done && (
        <div ref={sentinel} className="list-more">
          <button type="button" className="secondary small" disabled={loading} onClick={more}>
            {loading ? "Загружаем…" : "Показать ещё"}
          </button>
        </div>
      )}
    </div>
  );
}
