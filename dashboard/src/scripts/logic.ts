/** Скрипты без React: поиск, выбор текста, копирование.
 *
 *  Отдельно от компонентов, потому что это правила, а не вёрстка: какой
 *  вариант показать, что делать с отсутствующим переводом, что считается
 *  совпадением. Их легко сломать правкой разметки, если они в ней живут.
 */
import type {
  ScriptItem,
  ScriptKind,
  ScriptLang,
  ScriptMessage,
  ScriptSection,
  ScriptVariant,
} from "../api";

export const LANGS: { key: ScriptLang; label: string; name: string; inName: string }[] = [
  { key: "ru", label: "RU", name: "русский", inName: "русском" },
  { key: "en", label: "EN", name: "английский", inName: "английском" },
  // В документе и в речи администраторов — «GE», не ISO-шное «KA».
  { key: "ka", label: "GE", name: "грузинский", inName: "грузинском" },
];

export const KIND_LABELS: Record<ScriptKind, string> = {
  chat: "Чат",
  call: "Звонок",
  task: "Задача",
  info: "Справка",
};

export function langInfo(lang: ScriptLang) {
  return LANGS.find((l) => l.key === lang) ?? LANGS[0];
}

/** Строка для сравнения: регистр и «ё» не должны мешать найти «ещё».
 *
 *  Посимвольно и с сохранением длины: по индексам совпадений в нормальной
 *  строке потом подсвечиваются куски исходной. */
export function normalize(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const lower = c.toLowerCase();
    if (lower.length !== 1) out += c;
    else out += lower === "ё" ? "е" : lower;
  }
  return out;
}

export function searchTerms(query: string): string[] {
  return normalize(query.trim()).split(/\s+/).filter(Boolean);
}

export interface SearchHit {
  item: ScriptItem;
  section: ScriptSection;
}

/** Совпадение — все слова запроса найдены где угодно в скрипте: в названии,
 *  словах для поиска, пояснениях и текстах на любом языке. Сначала идут
 *  скрипты, где слова стоят в названии: «дорого» должно поднимать возражение
 *  «Дорого», а не каждое сообщение, где встречается «недорого». */
export function searchScripts(sections: ScriptSection[], terms: string[]): SearchHit[] {
  if (!terms.length) return [];
  const scored: { hit: SearchHit; score: number; order: number }[] = [];
  let order = 0;
  for (const section of sections) {
    for (const item of section.items) {
      order++;
      const title = normalize(item.title);
      const keywords = normalize(item.keywords);
      const body = normalize(
        [
          section.title,
          item.note,
          item.follow_up,
          ...item.variants.flatMap((v) => [
            v.label,
            ...v.messages.flatMap((m) => [m.label, m.ru, m.en, m.ka]),
          ]),
        ].join("\n")
      );
      let score = 0;
      let all = true;
      for (const term of terms) {
        if (title.includes(term)) score += title.startsWith(term) ? 14 : 10;
        else if (keywords.includes(term)) score += 5;
        else if (body.includes(term)) score += 1;
        else {
          all = false;
          break;
        }
      }
      if (all) scored.push({ hit: { item, section }, score, order });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map((s) => s.hit);
}

/** Студии, для которых у скриптов есть свои варианты текста. */
export function studioLabels(sections: ScriptSection[]): string[] {
  const seen: string[] = [];
  for (const section of sections)
    for (const item of section.items)
      for (const variant of item.variants)
        if (variant.label && !seen.includes(variant.label)) seen.push(variant.label);
  return seen;
}

/** Вариант под выбранную студию; если у скрипта такого нет — первый. */
export function pickVariant(item: ScriptItem, studio: string): ScriptVariant {
  return item.variants.find((v) => v.label && v.label === studio) ?? item.variants[0];
}

export interface ShownText {
  text: string;
  lang: ScriptLang;
  /** Перевода на выбранный язык нет, показан другой. */
  fallback: boolean;
}

/** Текст сообщения на выбранном языке. Перевода нет — показываем другой язык
 *  и говорим об этом прямо: молча подставленный русский в английском чате —
 *  ошибка, которую администратор заметит уже после отправки. */
export function messageText(message: ScriptMessage, lang: ScriptLang): ShownText {
  if (message[lang].trim()) return { text: message[lang], lang, fallback: false };
  const other = LANGS.find((l) => message[l.key].trim());
  return { text: other ? message[other.key] : "", lang: other?.key ?? lang, fallback: true };
}

/** Есть ли у скрипта текст на этом языке хоть в одном сообщении варианта. */
export function variantHasLang(variant: ScriptVariant, lang: ScriptLang): boolean {
  return variant.messages.some((m) => m[lang].trim());
}

/** Копирование в буфер. Clipboard API есть только на https и в фокусе;
 *  запасной путь через выделение textarea — для всего остального. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* ниже — запасной путь */
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

export function totalScripts(sections: ScriptSection[]): number {
  return sections.reduce((n, s) => n + s.items.length, 0);
}

/** Поиск скрипта по названию — для ссылок «…» в пояснениях. */
export function findByTitle(
  sections: ScriptSection[],
  title: string
): { item: ScriptItem; section: ScriptSection } | null {
  const wanted = normalize(title.trim());
  for (const section of sections)
    for (const item of section.items)
      if (normalize(item.title) === wanted) return { item, section };
  return null;
}

export function scriptPath(sectionId: string, itemId?: string): string {
  return itemId ? `/scripts/${sectionId}?item=${itemId}` : `/scripts/${sectionId}`;
}
