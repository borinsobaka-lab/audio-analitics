import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { api, getToken, Location, Me, onSessionExpired, plural, setToken } from "./api";
import Logo from "./components/Logo";
import { Skeleton } from "./components/ui";
import { NavIcon, NavIcons, sectionIcon } from "./components/navIcons";
import LoginPage from "./pages/LoginPage";
import ErrorBoundary from "./components/ErrorBoundary";
import ScriptsPage from "./pages/ScriptsPage";

/* Скрипты — в основной сборке: их открывают первыми и чаще всего. Остальное
 * («Аналитика», настройки, сотрудники) — отдельными кусками: первое открытие
 * не ждёт кода, который сейчас не нужен. Куски догружаются в фоне сразу после
 * показа страницы (preloadPages), так что переход в них всё равно мгновенный. */
const pageLoaders = {
  dashboard: () => import("./pages/DashboardPage"),
  days: () => import("./pages/DaysPage"),
  dayReport: () => import("./pages/DayReportPage"),
  employees: () => import("./pages/EmployeesPage"),
  app: () => import("./pages/AppPage"),
  locations: () => import("./pages/LocationsPage"),
  metrics: () => import("./pages/MetricsPage"),
  scriptsSettings: () => import("./pages/ScriptsSettingsPage"),
};
const DashboardPage = lazy(pageLoaders.dashboard);
const DaysPage = lazy(pageLoaders.days);
const DayReportPage = lazy(pageLoaders.dayReport);
const EmployeesPage = lazy(pageLoaders.employees);
const AppPage = lazy(pageLoaders.app);
const LocationsPage = lazy(pageLoaders.locations);
const MetricsPage = lazy(pageLoaders.metrics);
const ScriptsSettingsPage = lazy(pageLoaders.scriptsSettings);

function preloadPages() {
  const run = () => Object.values(pageLoaders).forEach((load) => load().catch(() => {}));
  if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 1500);
}
import { totalScripts } from "./scripts/logic";
import { PlaybookProvider, usePlaybook } from "./scripts/store";
import { SessionContext, StudioContext } from "./session";
import { clearCache, readCache, take, writeCache } from "./boot";

const STUDIO_KEY = "aa_studios";
/** Прежний ключ хранил одну студию строкой — переносим выбор молча. */
const LEGACY_STUDIO_KEY = "aa_studio";

function loadStudios(): string[] {
  const saved = localStorage.getItem(STUDIO_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === "string");
    } catch {
      /* испорченное значение — считаем, что выбора не было */
    }
  }
  const legacy = localStorage.getItem(LEGACY_STUDIO_KEY);
  return legacy ? [legacy] : [];
}

/** Выбор студий: галочки, а не выпадающий список.
 *
 *  Список позволял выбрать ровно одну точку, и владельцу двух студий
 *  приходилось смотреть их по очереди, складывая цифры в голове. Галочки
 *  дают все три случая одним контролом: одна студия, несколько, все сразу.
 *
 *  Раскрывается вверх — точнее, просто растёт внутри нижнего блока меню,
 *  который прижат к низу автоматическим отступом. Всплывающее меню здесь
 *  обрезалось бы прокруткой узкой полосы на телефоне.
 */
function StudioPicker({
  locations,
  selected,
  onToggle,
  onAll,
}: {
  locations: Location[];
  selected: string[];
  onToggle: (id: string) => void;
  onAll: () => void;
}) {
  const [open, setOpen] = useState(false);

  const label =
    selected.length === 0
      ? "Все студии"
      : selected.length === 1
        ? locations.find((l) => l.id === selected[0])?.name ?? "Студия"
        : `${selected.length} ${plural(selected.length, "студия", "студии", "студий")}`;

  return (
    <div className="studio">
      <span className="label">Студии</span>
      <button
        className="studio-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="studio-label">{label}</span>
        <span className="studio-caret">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="studio-menu">
          <label className="studio-item">
            <input
              type="checkbox"
              checked={selected.length === 0}
              onChange={onAll}
            />
            Все студии
          </label>
          {locations.map((l) => (
            <label key={l.id} className="studio-item">
              <input
                type="checkbox"
                checked={selected.includes(l.id)}
                onChange={() => onToggle(l.id)}
              />
              <span className="studio-name">{l.name}</span>
              {!l.active && <span className="studio-off">закрыта</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

type Product = "scripts" | "analytics";

/** Переключатель продуктов в шапке меню.
 *
 *  Два продукта — две кнопки, а не выпадающий список: выбор виден сразу и
 *  делается одним нажатием, на телефоне тоже. Каждая кнопка возвращает туда,
 *  где человек был в этом продукте в последний раз, — переключение не должно
 *  сбрасывать открытую смену или раздел скриптов.
 */
function ProductSwitch({
  product,
  lastPath,
  onProductPage,
}: {
  product: Product;
  lastPath: Record<Product, string>;
  /** false — открыт общий раздел (сотрудники), а не страница продукта. */
  onProductPage: boolean;
}) {
  return (
    <div className="product-switch" role="group" aria-label="Продукт">
      <Link
        to={lastPath.scripts}
        className={`product-btn${product === "scripts" ? " on" : ""}`}
        aria-current={onProductPage && product === "scripts" ? "page" : undefined}
      >
        Скрипты
      </Link>
      <Link
        to={lastPath.analytics}
        className={`product-btn${product === "analytics" ? " on" : ""}`}
        aria-current={onProductPage && product === "analytics" ? "page" : undefined}
      >
        Аналитика
      </Link>
    </div>
  );
}

/** Разделы скриптов в боковом меню — оглавление, которое было у документа,
 *  только всегда на виду. */
function ScriptsNav() {
  const { playbook, unread } = usePlaybook();
  const sections = playbook?.sections ?? [];
  return (
    <div className="nav-sections">
      <NavLink to="/scripts" end className="nav-link wrap">
        <NavIcon icon={NavIcons.allScripts} />
        <span className="grow">Все скрипты</span>
        {playbook && <span className="nav-count num">{totalScripts(sections)}</span>}
      </NavLink>
      {sections.map((s) => (
        <NavLink key={s.id} to={`/scripts/${s.id}`} className="nav-link wrap">
          <NavIcon icon={sectionIcon(s.icon)} />
          <span className="grow">{s.title}</span>
          <span className="nav-count num">{s.items.length}</span>
        </NavLink>
      ))}
      {/* Настройки — всем: хронология, предложения и статистика нужны и тем,
          кто скрипты только читает. Править в них может только тот, у кого
          «Скрипты: правка», — остальным всё показывается для просмотра. */}
      <NavLink to="/scripts/settings" className="nav-link wrap nav-settings">
        <NavIcon icon={NavIcons.settings} />
        <span className="grow">Настройки</span>
        {/* Новые предложения сотрудников — у каждого администратора свой
            счётчик, гаснет, когда он сам их открыл. */}
        {unread > 0 && (
          <span className="nav-badge num" title="Новые предложения сотрудников">
            {unread}
          </span>
        )}
      </NavLink>
    </div>
  );
}

export default function App() {
  // null — не вошли; undefined — ещё проверяем сохранённый токен. С токеном
  // и сохранённым «кто я» админка рисуется сразу, а проверка идёт в фоне.
  const [me, setMeState] = useState<Me | null | undefined>(() =>
    getToken() ? readCache<Me>("me") ?? undefined : null
  );
  const setMe = useCallback((value: Me | null) => {
    if (value) writeCache("me", value);
    setMeState(value);
  }, []);
  const [locations, setLocations] = useState<Location[]>(
    () => readCache<Location[]>("locations") ?? []
  );
  // Выбор студий переживает перезагрузку: владелец обычно смотрит один и тот
  // же срез сети несколько дней подряд.
  const [locationIds, setLocationIds] = useState<string[]>(loadStudios);

  // Фоновая проверка входа — один раз при открытии. Отозванная сессия
  // ответит 401 и покажет вход (onSessionExpired ниже); нет связи — остаёмся
  // на сохранённом, если он есть.
  useEffect(() => {
    if (!getToken()) return;
    take("me", api.me)
      .then(setMe)
      .catch(() => {
        if (!getToken()) return;
        setMeState((current) => current ?? null);
      });
  }, [setMe]);

  const signedIn = Boolean(me);
  useEffect(() => {
    if (signedIn) preloadPages();
  }, [signedIn]);
  useEffect(() => {
    if (!signedIn) return;
    api
      .listLocations()
      .then((list) => {
        setLocations(list);
        writeCache("locations", list);
      })
      .catch(() => {});
  }, [signedIn]);

  // Сессию мог отозвать администратор — сбросом пароля или отключением.
  useEffect(
    () =>
      onSessionExpired(() => {
        clearCache();
        setMeState(null);
      }),
    []
  );

  const remember = useCallback((ids: string[]) => {
    setLocationIds(ids);
    if (ids.length) localStorage.setItem(STUDIO_KEY, JSON.stringify(ids));
    else localStorage.removeItem(STUDIO_KEY);
    localStorage.removeItem(LEGACY_STUDIO_KEY);
  }, []);

  const toggleLocation = useCallback(
    (id: string) => {
      remember(
        locationIds.includes(id)
          ? locationIds.filter((x) => x !== id)
          : [...locationIds, id]
      );
    },
    [locationIds, remember]
  );

  const selectAll = useCallback(() => remember([]), [remember]);

  const location = useLocation();
  const lastPath = useRef<Record<Product, string>>({
    scripts: "/scripts",
    analytics: "/analytics",
  });
  const lastProduct = useRef<Product>("scripts");
  // Сотрудники — общий раздел, не продукт: пока он открыт, меню остаётся в
  // том продукте, откуда пришли, чтобы вернуться одним нажатием.
  const shared = location.pathname.startsWith("/users");
  const product: Product = shared
    ? lastProduct.current
    : location.pathname.startsWith("/scripts") || location.pathname === "/"
      ? "scripts"
      : "analytics";
  if (!shared && location.pathname !== "/") {
    lastPath.current[product] = location.pathname + location.search;
    lastProduct.current = product;
  }

  // Точку могли закрыть или удалить, пока выбор лежал в localStorage: без
  // этой чистки списки молча оказались бы пустыми.
  const effectiveIds = useMemo(
    () =>
      locations.length
        ? locationIds.filter((id) => locations.some((l) => l.id === id))
        : locationIds,
    [locationIds, locations]
  );
  const studio = useMemo(
    () => ({ locationIds: effectiveIds, toggleLocation, selectAll, locations }),
    [effectiveIds, toggleLocation, selectAll, locations]
  );

  const signOut = useCallback(() => {
    clearCache();
    setToken(null);
    setMeState(null);
  }, []);

  if (me === undefined) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <Skeleton count={1} height={120} />
        </div>
      </div>
    );
  }

  if (me === null) return <LoginPage onSignedIn={setMe} />;

  return (
    <SessionContext.Provider value={me}>
      <StudioContext.Provider value={studio}>
        <PlaybookProvider enabled={product === "scripts"} watchSuggestions={product === "scripts"}>
          <div className="layout">
            <nav className="sidebar">
              {/* Логотип ведёт на главную — в скрипты, как после входа. */}
              <Link to="/" className="brand" aria-label="Lady Stretch — на главную">
                <Logo className="brand-logo" />
              </Link>
              <ProductSwitch
                product={product}
                lastPath={lastPath.current}
                onProductPage={!shared}
              />

              {product === "scripts" ? (
                <ScriptsNav />
              ) : (
                <>
                  <NavLink to="/analytics" className="nav-link">
                    <NavIcon icon={NavIcons.dashboard} />
                    Дашборд
                  </NavLink>
                  <NavLink to="/days" className="nav-link">
                    <NavIcon icon={NavIcons.days} />
                    {me.can_view_all ? "Смены" : "Мои смены"}
                  </NavLink>
                  {/* Настройки системы видит только тот, кому открыты все записи:
                      показывать раздел, который ответит «недостаточно прав», хуже,
                      чем не показывать его вовсе. */}
                  {me.can_manage && (
                    <>
                      <NavLink to="/metrics" className="nav-link">
                        <NavIcon icon={NavIcons.metrics} />
                        Метрики и анализ
                      </NavLink>
                      <NavLink to="/locations" className="nav-link">
                        <NavIcon icon={NavIcons.studio} />
                        Точки продажи
                      </NavLink>
                      <NavLink to="/app" className="nav-link">
                        <NavIcon icon={NavIcons.app} />
                        Приложение
                      </NavLink>
                    </>
                  )}
                </>
              )}

              <div className="sidebar-foot">
                {/* Выбор студий стоит рядом с именем, а не на страницах:
                    отмечаешь срез один раз и ходишь по разделам, не
                    переставляя фильтр заново. */}
                {product === "analytics" && locations.length > 1 && (
                  <StudioPicker
                    locations={locations}
                    selected={effectiveIds}
                    onToggle={toggleLocation}
                    onAll={selectAll}
                  />
                )}
                {/* Сотрудники — общие для всех продуктов: один вход на всё, а
                    права у каждого продукта свои. Поэтому раздел живёт не в
                    меню продукта, а здесь, рядом с тем, кто вошёл. */}
                {/* Сотрудников — их входы и права — заводит только владелец. */}
                {me.is_owner && (
                  <NavLink to="/users" className="nav-link foot-link">
                    <NavIcon icon={NavIcons.people} />
                    Сотрудники
                  </NavLink>
                )}
                {/* Кто вошёл и «Выйти» — одной строкой: так меню освобождает
                    место под разделы скриптов. */}
                <div className="who-row">
                  <div className="who">
                    <span className="who-name">
                      {me.full_name || me.login || "Пользователь"}
                    </span>
                    <span className="who-role">
                      {me.is_owner
                        ? "владелец"
                        : `${me.can_edit_scripts ? "правит скрипты" : "читает скрипты"} · ${
                            me.can_view_all ? "все смены" : "свои смены"
                          }`}
                    </span>
                  </div>
                  <button className="ghost small who-signout" onClick={signOut}>
                    Выйти
                  </button>
                </div>
              </div>
            </nav>

            <main className="content">
              <ErrorBoundary resetKey={location.pathname + location.search}>
              <Suspense fallback={<Skeleton count={4} height={90} />}>
              <Routes>
                {/* После входа открываются скрипты: ими пользуются каждый час,
                    аналитику смотрят раз в день. */}
                <Route path="/" element={<Navigate to="/scripts" replace />} />
                <Route path="/scripts/settings" element={<ScriptsSettingsPage />} />
                <Route path="/scripts/:sectionId?" element={<ScriptsPage />} />
                <Route path="/analytics" element={<DashboardPage />} />
                <Route path="/days" element={<DaysPage />} />
                <Route path="/days/:id" element={<DayReportPage />} />
                {me.can_manage && <Route path="/metrics" element={<MetricsPage />} />}
                {me.is_owner && <Route path="/users" element={<EmployeesPage />} />}
                {/* Прежний адрес раздела — из закладок и старых ссылок. */}
                <Route path="/employees" element={<Navigate to="/users" replace />} />
                {me.can_manage && <Route path="/locations" element={<LocationsPage />} />}
                {me.can_manage && <Route path="/app" element={<AppPage />} />}
                <Route path="*" element={<Navigate to="/scripts" replace />} />
              </Routes>
              </Suspense>
              </ErrorBoundary>
            </main>
          </div>
        </PlaybookProvider>
      </StudioContext.Provider>
    </SessionContext.Provider>
  );
}
