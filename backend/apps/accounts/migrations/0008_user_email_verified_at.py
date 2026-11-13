"""Подтверждение владения почтовым ящиком (ADR-168, вход по e-mail с кодом).

Аддитивное nullable-поле, бэкфила нет и быть не может: NULL означает
«адрес никем не подтверждён», и это ровно правда про все адреса, которые
на момент миграции лежат в `User.email` — они вписаны самими пользователями
через PATCH /users/me либо однократно подставлены из Google-связки при
регистрации. Подтверждённость второго случая проверяется не полем, а самой
связкой (`SocialLoginAccount.email`), см. services._resolve_user_for_verified_email:
проставлять им подтверждение задним числом миграцией значило бы записать в
БД факт, которого не было.
"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("accounts", "0007_user_locale")]

    operations = [
        migrations.AddField(
            model_name="user",
            name="email_verified_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
