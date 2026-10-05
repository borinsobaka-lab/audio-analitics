/** Версии приложения записи.
 *
 *  Приложение стоит на компьютерах в студиях, куда владелец не ходит. Раньше
 *  обновление означало собрать сборку, принести её на флешке и обойти точки.
 *  Здесь сборка выкладывается один раз, а приложения сами показывают у себя
 *  «Вышла новая версия» и ставят её по нажатию кнопки.
 *
 *  Файлов два, и второй не формальность: `.sig` — подпись приватным ключом
 *  владельца. Приложение проверяет её вшитым публичным ключом, поэтому даже
 *  подменённый ответ сервера не заставит его установить чужой код.
 */
import { useEffect, useState } from "react";
import { AppRelease, api, fmtSize, fmtWhen } from "../api";
import { ConfirmAction, Empty, Note, PageHead, Skeleton, TableCard } from "../components/ui";

const ARCHIVE_HINT =
  "src-tauri/target/universal-apple-darwin/release/bundle/macos/Audio Recorder.app.tar.gz";

export default function AppPage() {
  const [releases, setReleases] = useState<AppRelease[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = () => {
    api
      .listReleases()
      .then(setReleases)
      .catch((e) => {
        setReleases([]);
        setError(String(e));
      });
  };

  useEffect(load, []);

  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      load();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    }
  };

  return (
    <div>
      <PageHead
        title="Приложение"
        hint="Сборки приложения записи. Выложенную здесь версию приложения на ресепшенах увидят сами — у них появится кнопка «Обновить и перезапустить». Обходить студии не нужно."
      />

      {error && <Note kind="error">{error}</Note>}
      {notice && <Note kind="success">{notice}</Note>}

      <UploadRelease
        onDone={(version) => {
          setNotice(
            `Версия ${version} выложена. Приложения увидят её в течение часа ` +
              "или сразу, если нажать «Проверить обновления» в их настройках."
          );
          setError("");
          load();
        }}
        onError={setError}
      />

      {releases === null && <Skeleton count={2} height={48} />}

      {releases !== null && releases.length === 0 && !error && (
        <Empty title="Сборок пока нет">
          Соберите приложение на маке и выложите два файла из папки сборки —
          архив и подпись рядом с ним.
        </Empty>
      )}

      {releases !== null && releases.length > 0 && (
        <TableCard
          columns={[
            { label: "Версия", className: "col-name" },
            { label: "Платформа" },
            { label: "Размер", num: true },
            { label: "Выложена" },
            { label: "Статус" },
            { label: "", className: "col-row-actions" },
          ]}
        >
          {releases.map((release) => (
            <tr key={release.id}>
              <td className="col-name">
                <strong>{release.version}</strong>
                {release.notes && <div className="muted">{release.notes}</div>}
              </td>
              <td>{release.platform === "darwin" ? "macOS" : release.platform}</td>
              <td className="num-col">{fmtSize(release.size_bytes)}</td>
              <td>
                {fmtWhen(release.created_at)}
                {release.created_by_name && (
                  <span className="muted"> · {release.created_by_name}</span>
                )}
              </td>
              <td>
                <span className={`pill ${release.published ? "sale" : "irrelevant"}`}>
                  {release.published ? "Раздаётся" : "Снята"}
                </span>
              </td>
              <td className="col-row-actions">
                <div className="actions end">
                  <button
                    className="ghost small"
                    title={
                      release.published
                        ? "Перестать раздавать эту версию приложениям"
                        : "Снова раздавать эту версию"
                    }
                    onClick={() =>
                      run(() =>
                        api.updateRelease(release.id, { published: !release.published })
                      )
                    }
                  >
                    {release.published ? "Снять" : "Вернуть"}
                  </button>
                  <ConfirmAction
                    small
                    label="Удалить"
                    confirmLabel="Удалить сборку"
                    title="Удалить архив из хранилища вместе с записью о версии"
                    onConfirm={() => run(() => api.deleteRelease(release.id))}
                  />
                </div>
              </td>
            </tr>
          ))}
        </TableCard>
      )}

      <p className="muted metrics-foot">
        Версия берётся из самой сборки, вручную её вводить не нужно. Чтобы
        приложения увидели обновление, номер версии в <code>tauri.conf.json</code>{" "}
        должен быть выше предыдущего — с тем же номером сервер сборку не примет.
      </p>
    </div>
  );
}

function UploadRelease({
  onDone,
  onError,
}: {
  onDone: (version: string) => void;
  onError: (message: string) => void;
}) {
  const [archive, setArchive] = useState<File | null>(null);
  const [signature, setSignature] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!archive || !signature || busy) return;
    setBusy(true);
    onError("");
    try {
      const form = new FormData();
      form.append("archive", archive);
      form.append("signature_file", signature);
      form.append("platform", "darwin");
      form.append("notes", notes.trim());
      const release = await api.uploadRelease(form);
      setArchive(null);
      setSignature(null);
      setNotes("");
      onDone(release.version);
    } catch (e) {
      onError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet sheet-pad form-card">
      <span className="label form-label">Выложить новую версию</span>

      <div className="field-row">
        <label className="field field-grow">
          <span className="label">Архив сборки — .app.tar.gz</span>
          <input
            type="file"
            accept=".gz,.tgz,application/gzip"
            onChange={(e) => setArchive(e.target.files?.[0] ?? null)}
          />
        </label>
        <label className="field field-grow">
          <span className="label">Подпись — тот же файл с .sig на конце</span>
          <input
            type="file"
            accept=".sig"
            onChange={(e) => setSignature(e.target.files?.[0] ?? null)}
          />
        </label>
      </div>

      <label className="field">
        <span className="label">Что изменилось — увидят на ресепшене</span>
        <input
          type="text"
          value={notes}
          placeholder="Например: видно выбранный микрофон, приложение запускается само"
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>

      <div className="actions">
        <button onClick={submit} disabled={busy || !archive || !signature}>
          {busy ? "Загружаем…" : "Выложить"}
        </button>
      </div>

      <p className="muted form-hint">
        Оба файла лежат рядом, в папке сборки:
        <br />
        <code>{ARCHIVE_HINT}</code>
        <br />и он же с <code>.sig</code> на конце. Загрузка идёт минуту-две —
        архив весит десятки мегабайт.
      </p>
    </div>
  );
}
