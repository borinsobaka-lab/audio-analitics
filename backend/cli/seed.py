"""Seed the database: organization, location, default prompts and sales script.

Usage (from backend/):
    python -m cli.seed --org "Stretching Tbilisi" --location "Центральная студия"

Prints the created location_id — put it into DEVICE_API_KEYS as
"<your-device-key>:<location_id>".
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from app.db import get_sync_db  # noqa: E402
from app.models import (  # noqa: E402
    AnalysisMetric,
    Location,
    Organization,
    PromptTemplate,
    ScriptTemplate,
)
from app.pipeline.llm import DEFAULT_PROMPTS, DEFAULT_SCRIPT_STAGES  # noqa: E402

DEFAULT_METRIC_PROMPT = """Оцени, насколько качественно менеджер провёл продажу.

Метрика применима, только если в диалоге была попытка продажи: клиент интересовался
занятиями/абонементом, менеджер презентовал услугу или предлагал запись.

Эталон успешной продажи (замените на свой скрипт):
1. Приветствие: поздороваться, представиться, узнать имя клиента.
2. Выявление потребности: цель (гибкость/осанка/спорт/здоровье), опыт, ограничения.
3. Презентация: формат занятий под цель клиента, тренеры, результаты, расписание.
4. Работа с возражениями: цена (рассрочка/пробное), время, сомнения.
5. Закрытие: запись на пробное занятие с конкретной датой и временем.
6. Апсейл: предложить абонемент большего объёма или дополнительные услуги.

Оценка 10 — пройдены все этапы и получено согласие/запись; снижай оценку за каждый
пропущенный или скомканный этап; 1-3 — менеджер фактически не пытался продавать.
"""

DEFAULT_SCRIPT_BODY = """1. Приветствие: поздороваться, представиться, узнать имя клиента.
2. Выявление потребности: цель (гибкость/осанка/спорт/здоровье), опыт занятий, ограничения.
3. Презентация: формат занятий под цель клиента, тренеры, результаты, расписание.
4. Работа с возражениями: цена (рассрочка/пробное), время (гибкое расписание), сомнения.
5. Закрытие: запись на пробное занятие с конкретной датой и временем.
6. Апсейл: абонемент большего объёма, дополнительные направления, подарочные сертификаты.
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--org", default="Stretching Studio")
    parser.add_argument("--location", default="Студия 1")
    args = parser.parse_args()

    db = get_sync_db()
    try:
        org = db.scalar(select(Organization).where(Organization.name == args.org))
        if not org:
            org = Organization(name=args.org)
            db.add(org)
            db.flush()
            print(f"Created organization: {org.id}")
        else:
            print(f"Organization exists: {org.id}")

        location = db.scalar(
            select(Location).where(Location.org_id == org.id, Location.name == args.location)
        )
        if not location:
            location = Location(org_id=org.id, name=args.location)
            db.add(location)
            db.flush()
            print(f"Created location: {location.id}")
        else:
            print(f"Location exists: {location.id}")

        for key, spec in DEFAULT_PROMPTS.items():
            existing = db.scalar(
                select(PromptTemplate).where(
                    PromptTemplate.org_id == org.id, PromptTemplate.key == key
                )
            )
            if existing:
                print(f"Prompt '{key}' exists, skipping")
                continue
            db.add(
                PromptTemplate(
                    org_id=org.id,
                    key=key,
                    name=spec["name"],
                    description=spec["description"],
                    content=spec["content"],
                    version=1,
                    active=True,
                    updated_by="seed",
                )
            )
            print(f"Seeded prompt '{key}'")

        metric = db.scalar(
            select(AnalysisMetric).where(AnalysisMetric.org_id == org.id)
        )
        if not metric:
            db.add(
                AnalysisMetric(
                    org_id=org.id,
                    name="Качество продажи",
                    prompt=DEFAULT_METRIC_PROMPT,
                    scale_max=10,
                    active=True,
                    position=1,
                )
            )
            print("Seeded default metric 'Качество продажи'")

        script = db.scalar(select(ScriptTemplate).where(ScriptTemplate.org_id == org.id))
        if not script:
            db.add(
                ScriptTemplate(
                    org_id=org.id,
                    name="Скрипт продаж (базовый)",
                    stages_json=DEFAULT_SCRIPT_STAGES,
                    body=DEFAULT_SCRIPT_BODY,
                    version=1,
                    active=True,
                )
            )
            print("Seeded sales script")
        else:
            print("Sales script exists, skipping")

        db.commit()
        print("\nDone. Add to .env:")
        print(f"DEVICE_API_KEYS=<generate-a-long-random-key>:{location.id}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
