"""Регрессия на ловушку расписаний beat: интервал timedelta отсчитывается от
старта beat, а его состояние (celerybeat-schedule) живёт в слое контейнера и
теряется при пересоздании. Для задач с периодом порядка суток это значит
«деплой чаще раза в сутки — задача не выполняется никогда»: так чекпойнт
аудита молча не создавался 30.08–02.09 (вскрыто ops.sh §8.1, строка 5).
Частым задачам (секунды—минуты—час) сброс безвреден, суточным — фатален,
поэтому суточные обязаны сидеть на crontab (фиксированное время суток).
"""

from datetime import timedelta

from celery.schedules import crontab
from django.conf import settings

_DAILY_THRESHOLD = timedelta(hours=12)


def test_long_period_tasks_use_crontab_not_timedelta():
    offenders = [
        name
        for name, entry in settings.CELERY_BEAT_SCHEDULE.items()
        if isinstance(entry["schedule"], timedelta) and entry["schedule"] >= _DAILY_THRESHOLD
    ]
    assert not offenders, (
        f"суточные задачи на timedelta не переживают пересоздание контейнера: {offenders}; "
        "используйте crontab(hour=..., minute=...)"
    )


def test_daily_checkpoint_is_crontab():
    schedule = settings.CELERY_BEAT_SCHEDULE["audit-vault-daily-checkpoint"]["schedule"]
    assert isinstance(schedule, crontab)
