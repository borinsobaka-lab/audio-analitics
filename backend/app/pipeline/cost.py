"""Стоимость обработки одной смены.

Расход (минуты распознавания, токены модели) пишется в базу отдельно от
суммы: тарифы меняются, и по расходу прошлые смены можно пересчитать, а по
одной сумме — уже нет. Здесь только арифметика, чтобы её можно было
проверить тестом без сети и базы.
"""
from dataclasses import dataclass


@dataclass
class CostBreakdown:
    asr_usd: float
    llm_usd: float
    total_usd: float


def compute_cost(
    asr_seconds: float | None,
    llm_input_tokens: int,
    llm_output_tokens: int,
    price_asr_per_hour_usd: float,
    price_llm_input_per_mtok_usd: float,
    price_llm_output_per_mtok_usd: float,
) -> CostBreakdown:
    """Стоимость в долларах по расходу и текущим тарифам.

    Округление до цента было бы бесполезным: разбор одной смены стоит
    заметно меньше цента, и всё превратилось бы в нули. Держим шесть знаков —
    ровно столько, чтобы суммы за месяц складывались без потерь.
    """
    asr_hours = max(0.0, (asr_seconds or 0.0)) / 3600
    asr = asr_hours * price_asr_per_hour_usd
    llm = (
        max(0, llm_input_tokens) / 1_000_000 * price_llm_input_per_mtok_usd
        + max(0, llm_output_tokens) / 1_000_000 * price_llm_output_per_mtok_usd
    )
    return CostBreakdown(
        asr_usd=round(asr, 6),
        llm_usd=round(llm, 6),
        total_usd=round(asr + llm, 6),
    )
