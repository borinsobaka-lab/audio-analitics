"""Стоимость обработки: смены и дня CRM.

Цена запроса к модели считается сразу, по тарифу той модели, которая его
выполнила: этапы могут идти на разных моделях, а у кэша своя цена — чтение
в десять раз дешевле обычного входа, запись дороже. Общая цена «за
миллион входящих» из настроек врала бы в обе стороны. Здесь только
арифметика, чтобы её можно было проверить тестом без сети и базы.
"""
from dataclasses import dataclass


@dataclass
class CostBreakdown:
    asr_usd: float
    llm_usd: float
    total_usd: float


@dataclass(frozen=True)
class ModelPrice:
    """Тариф модели в долларах за миллион токенов."""

    input: float
    output: float
    # Чтение из кэша — доля цены входа.
    cache_read: float = 0.1
    # Часть моделей дороже на длинных запросах: тариф выбирается по длине
    # всего запроса, включая кэш. 0 — одна цена на любую длину.
    long_threshold: int = 0
    long_input: float = 0.0
    long_output: float = 0.0


# Запись в кэш стоит 1,25 цены входа при хранении 5 минут и 2 — при часе.
CACHE_WRITE_5M = 1.25
CACHE_WRITE_1H = 2.0

# Тарифы Anthropic, октябрь 2026. Модель ищется по началу названия: у
# старых моделей бывает суффикс с датой (claude-haiku-4-5-20251001).
# Модели не из списка считаются по PRICE_LLM_*_PER_MTOK_USD из настроек.
MODEL_PRICES: dict[str, ModelPrice] = {
    "claude-haiku-5-5": ModelPrice(
        0.10, 0.50, long_threshold=100_000, long_input=0.50, long_output=2.50
    ),
    "claude-haiku-4-5": ModelPrice(1.00, 5.00),
    "claude-sonnet-5-5": ModelPrice(2.00, 10.00),
    "claude-sonnet-5": ModelPrice(2.00, 10.00),
    "claude-sonnet-4-6": ModelPrice(3.00, 15.00),
    "claude-sonnet-4-5": ModelPrice(3.00, 15.00),
    "claude-opus-5-5": ModelPrice(4.00, 20.00, cache_read=0.05),
    "claude-opus-5": ModelPrice(5.00, 25.00),
    "claude-opus-4-8": ModelPrice(5.00, 25.00),
    "claude-opus-4-7": ModelPrice(5.00, 25.00),
    "claude-opus-4-6": ModelPrice(5.00, 25.00),
    "claude-fable-5-1": ModelPrice(10.00, 50.00, cache_read=0.025),
    "claude-fable-5": ModelPrice(10.00, 50.00),
}


def price_for(model: str) -> ModelPrice | None:
    """Тариф по названию модели; None — модели нет в списке."""
    name = (model or "").strip().lower().removeprefix("anthropic.")
    if name in MODEL_PRICES:
        return MODEL_PRICES[name]
    # Самый длинный подходящий ключ: claude-sonnet-5-5 не должен уйти в
    # claude-sonnet-5.
    best = max(
        (key for key in MODEL_PRICES if name.startswith(key + "-")),
        key=len,
        default=None,
    )
    return MODEL_PRICES[best] if best else None


def request_cost(
    price: ModelPrice,
    *,
    input_tokens: int = 0,
    cache_write_5m_tokens: int = 0,
    cache_write_1h_tokens: int = 0,
    cache_read_tokens: int = 0,
    output_tokens: int = 0,
) -> float:
    """Цена одного запроса в долларах. Размышления модели приходят в
    output_tokens и стоят как ответ."""
    prompt = input_tokens + cache_write_5m_tokens + cache_write_1h_tokens + cache_read_tokens
    long = bool(price.long_threshold) and prompt > price.long_threshold
    inp = price.long_input if long else price.input
    out = price.long_output if long else price.output
    return (
        max(0, input_tokens) * inp
        + max(0, cache_write_5m_tokens) * inp * CACHE_WRITE_5M
        + max(0, cache_write_1h_tokens) * inp * CACHE_WRITE_1H
        + max(0, cache_read_tokens) * inp * price.cache_read
        + max(0, output_tokens) * out
    ) / 1_000_000


def compute_cost(
    asr_seconds: float | None,
    llm_usd: float,
    price_asr_per_hour_usd: float,
) -> CostBreakdown:
    """Итог в долларах: распознавание по цене часа плюс уже посчитанная
    цена запросов к модели.

    Округление до цента было бы бесполезным: разбор одной смены на дешёвой
    модели стоит меньше цента, и всё превратилось бы в нули. Держим шесть
    знаков — ровно столько, чтобы суммы за месяц складывались без потерь.
    """
    asr_hours = max(0.0, (asr_seconds or 0.0)) / 3600
    asr = asr_hours * price_asr_per_hour_usd
    llm = max(0.0, llm_usd or 0.0)
    return CostBreakdown(
        asr_usd=round(asr, 6),
        llm_usd=round(llm, 6),
        total_usd=round(asr + llm, 6),
    )
