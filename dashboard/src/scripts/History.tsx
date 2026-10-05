/** Хронология изменений скриптов: кто, когда и что с чего поменял.
 *
 *  Каждая запись — название скрипта, комментарий к правке и только те
 *  поля, что изменились: «было → стало», удалённые слова подсвечены в
 *  «было», новые — в «стало». Подгружается порциями по мере прокрутки.
 */
import { useNavigate } from "react-router-dom";
import { api, fmtWhen, ScriptChange } from "../api";
import { Empty, Note, Skeleton } from "../components/ui";
import { fieldChanges, Piece, wordDiff } from "./diff";
import { scriptPath } from "./logic";
import { usePaged } from "./paged";
import { usePlaybook } from "./store";

const ACTION_LABELS: Record<ScriptChange["action"], string> = {
  created: "Создан",
  updated: "Изменён",
  deleted: "Удалён",
};

function Pieces({ pieces, kind }: { pieces: Piece[]; kind: "del" | "ins" }) {
  if (!pieces.length) return <span className="diff-empty">пусто</span>;
  return (
    <>
      {pieces.map((p, i) =>
        p.changed ? (
          <mark key={i} className={`diff-${kind}`}>
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  );
}

function ChangeEntry({ change }: { change: ScriptChange }) {
  const { playbook } = usePlaybook();
  const navigate = useNavigate();
  const fields = fieldChanges(change);

  // Скрипт ещё жив — название ведёт к нему.
  // Скрипт — по разделу, где он лежит; сценарий звонка — это сам раздел.
  const section = playbook?.sections.find(
    (s) => s.id === change.item_id || s.items.some((i) => i.id === change.item_id)
  );
  const title = change.item_title || "Без названия";

  return (
    <article className={`change change-${change.action}`}>
      <header className="change-head">
        {section && change.item_id ? (
          <button
            type="button"
            className="change-title link"
            title="Открыть скрипт"
            onClick={() =>
              navigate(section.id === change.item_id ? scriptPath(section.id) : scriptPath(section.id, change.item_id!))
            }
          >
            {title}
          </button>
        ) : (
          <span className="change-title">{title}</span>
        )}
        <span className={`change-action change-action-${change.action}`}>
          {ACTION_LABELS[change.action]}
        </span>
        <span className="change-meta">
          <span>{change.author || "—"}</span>
          <span className="num">{fmtWhen(change.created_at)}</span>
        </span>
      </header>
      {change.change_note && change.action === "updated" && (
        <p className="change-note">{change.change_note}</p>
      )}
      {fields.length ? (
        <div className="change-fields">
          {fields.map((f, i) => {
            const d = wordDiff(f.before, f.after);
            return (
              <div className="diff" key={i}>
                <span className="diff-label">{f.label}</span>
                <div className="diff-pair">
                  <div className="diff-side diff-before" aria-label="Было">
                    <Pieces pieces={d.before} kind="del" />
                  </div>
                  <span className="diff-arrow" aria-hidden="true">
                    →
                  </span>
                  <div className="diff-side diff-after" aria-label="Стало">
                    <Pieces pieces={d.after} kind="ins" />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        change.action === "updated" && (
          <p className="muted change-same">Тексты не менялись — сохранено без правок.</p>
        )
      )}
    </article>
  );
}

export default function History() {
  const { items, loading, error, done, more, sentinel } = usePaged(api.scriptChanges);

  if (!items.length && loading) return <Skeleton count={3} height={140} />;
  if (!items.length && error) return <Note kind="error">{error}</Note>;
  if (!items.length)
    return (
      <Empty title="Изменений пока нет">
        Здесь появится каждая правка скриптов: что было, что стало, кто и зачем поменял.
      </Empty>
    );

  return (
    <div className="change-list">
      {items.map((c) => (
        <ChangeEntry key={c.id} change={c} />
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
