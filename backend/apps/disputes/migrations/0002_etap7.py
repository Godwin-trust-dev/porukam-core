"""Этап 7 (docs/plan.md «Споры и гарантия», ADR-131): полный контур
разногласий поверх модели-заглушки Э4.6.

Три ручные операции поверх автогенерации:

1. `Dispute.contract` добавляется НУЛЛАБЕЛЬНЫМ, заполняется из
   `milestone.contract_id` (`backfill_dispute_contract`) и только потом
   становится NOT NULL — иначе миграция не встанет на БД с существующими
   спорами Э4.6. Поле нужно, потому что у гарантийного спора этапа нет.
2. Тот же backfill проставляет `outcome` уже закрытым спорам: новый
   CHECK `dispute_resolved_has_outcome` требует исход у каждой закрытой
   строки, а Э4.6 писала только `resolution_type`.
3. Триггер `dispute_milestone_contract_guard` — БД-инвариант «этап спора
   принадлежит договору спора». CHECK его выразить не может (условие
   ссылается на ДРУГУЮ таблицу) — тот же случай и тот же приём, что
   `milestone_amount_guard` (apps/milestones/migrations/0002), включая
   `USING ERRCODE = '23000'`, чтобы нарушение поднимало `IntegrityError`,
   как остальные БД-инварианты (разбор — milestones/0005).
"""

import common.uuid7
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

_GUARD_FUNCTION = "dispute_milestone_contract_guard"
_GUARD_TRIGGER = "dispute_milestone_contract_guard_trigger"

_GUARD_CREATE_SQL = f"""
CREATE FUNCTION {_GUARD_FUNCTION}() RETURNS trigger AS $$
DECLARE
    milestone_contract_id uuid;
    item_milestone_id uuid;
BEGIN
    IF NEW.milestone_id IS NOT NULL THEN
        SELECT contract_id INTO milestone_contract_id
        FROM milestone WHERE id = NEW.milestone_id;
        IF milestone_contract_id IS DISTINCT FROM NEW.contract_id THEN
            RAISE EXCEPTION
                '{_GUARD_FUNCTION}: этап % не из договора %',
                NEW.milestone_id, NEW.contract_id
                USING ERRCODE = '23000';
        END IF;
    END IF;

    IF NEW.checklist_item_id IS NOT NULL THEN
        SELECT milestone_id INTO item_milestone_id
        FROM checklist_item WHERE id = NEW.checklist_item_id;
        IF item_milestone_id IS DISTINCT FROM NEW.milestone_id THEN
            RAISE EXCEPTION
                '{_GUARD_FUNCTION}: пункт чек-листа % не из этапа %',
                NEW.checklist_item_id, NEW.milestone_id
                USING ERRCODE = '23000';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER {_GUARD_TRIGGER}
    BEFORE INSERT OR UPDATE ON dispute
    FOR EACH ROW
    EXECUTE FUNCTION {_GUARD_FUNCTION}();
"""

_GUARD_DROP_SQL = f"""
DROP TRIGGER IF EXISTS {_GUARD_TRIGGER} ON dispute;
DROP FUNCTION IF EXISTS {_GUARD_FUNCTION}();
"""

# Соответствие «детальный код исхода -> грубая классификация спеки»
# (зеркало apps.disputes.services.RESOLUTION_OUTCOME; в миграции — копией,
# потому что миграции не имеют права зависеть от текущего кода приложения).
_OUTCOME_BY_RESOLUTION = {
    "accepted": "resolved",
    "withdrawn": "resolved",
    "cap_reached": "cap_reached",
}


def backfill_dispute_contract(apps, schema_editor):
    Dispute = apps.get_model("disputes", "Dispute")
    for dispute in Dispute.objects.select_related("milestone").iterator():
        fields = []
        if dispute.contract_id is None and dispute.milestone_id is not None:
            dispute.contract_id = dispute.milestone.contract_id
            fields.append("contract")
        if dispute.status == "resolved" and not dispute.outcome:
            dispute.outcome = _OUTCOME_BY_RESOLUTION.get(dispute.resolution_type, "resolved")
            fields.append("outcome")
        if dispute.status == "resolved" and dispute.resolved_at is None:
            dispute.resolved_at = dispute.opened_at
            fields.append("resolved_at")
        if fields:
            dispute.save(update_fields=fields)


def noop_reverse(apps, schema_editor):
    """Обратный ход: `contract` снова становится нуллабельным операцией
    AlterField ниже, обнулять уже проставленные значения не нужно."""


class Migration(migrations.Migration):

    dependencies = [
        ('contracts', '0008_contract_additional_terms'),
        ('disputes', '0001_initial'),
        ('milestones', '0006_merge_amount_guard_and_tutoring_repoint'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='DiscountAgreement',
            fields=[
                ('id', models.UUIDField(default=common.uuid7.uuid7, editable=False, primary_key=True, serialize=False)),
                ('old_amount', models.DecimalField(decimal_places=2, max_digits=14)),
                ('old_amount_currency', models.CharField(max_length=3)),
                ('new_amount', models.DecimalField(decimal_places=2, max_digits=14)),
                ('new_amount_currency', models.CharField(max_length=3)),
                ('anti_waiver_note', models.TextField()),
                ('status', models.CharField(choices=[('proposed', 'Предложена'), ('accepted', 'Принята'), ('declined', 'Отклонена')], default='proposed', max_length=16)),
                ('decided_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
            ],
            options={
                'verbose_name': 'соглашение о скидке',
                'verbose_name_plural': 'соглашения о скидке',
                'db_table': 'discount_agreement',
                'ordering': ['-created_at'],
            },
        ),
        migrations.CreateModel(
            name='DisputeWindow',
            fields=[
                ('id', models.UUIDField(default=common.uuid7.uuid7, editable=False, primary_key=True, serialize=False)),
                ('kind', models.CharField(choices=[('dispute_response', 'Ответ на разногласие'), ('termination_notice', 'Оспаривание расторжения')], max_length=32)),
                ('subject_ref', models.JSONField(blank=True, default=dict)),
                ('deadline_id', models.UUIDField(blank=True, null=True)),
                ('opened_at', models.DateTimeField(auto_now_add=True)),
                ('deadline_at', models.DateTimeField(blank=True, null=True)),
                ('contested', models.BooleanField(blank=True, null=True)),
                ('contested_at', models.DateTimeField(blank=True, null=True)),
                ('closed_at', models.DateTimeField(blank=True, null=True)),
            ],
            options={
                'verbose_name': 'окно оспаривания',
                'verbose_name_plural': 'окна оспаривания',
                'db_table': 'dispute_window',
                'ordering': ['-opened_at'],
            },
        ),
        migrations.CreateModel(
            name='FixRequest',
            fields=[
                ('id', models.UUIDField(default=common.uuid7.uuid7, editable=False, primary_key=True, serialize=False)),
                ('round', models.PositiveSmallIntegerField()),
                ('comment', models.TextField(blank=True, default='')),
                ('requested_at', models.DateTimeField(auto_now_add=True)),
                ('resubmit_comment', models.TextField(blank=True, default='')),
                ('resubmitted_at', models.DateTimeField(blank=True, null=True)),
            ],
            options={
                'verbose_name': 'раунд исправления',
                'verbose_name_plural': 'раунды исправления',
                'db_table': 'fix_request',
                'ordering': ['dispute_id', 'round'],
            },
        ),
        migrations.AddField(
            model_name='dispute',
            name='cap_deadline_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='dispute',
            name='contract',
            field=models.ForeignKey(null=True, on_delete=django.db.models.deletion.CASCADE, related_name='disputes', to='contracts.contract'),
        ),
        migrations.AddField(
            model_name='dispute',
            name='fix_rounds_used',
            field=models.PositiveSmallIntegerField(default=0),
        ),
        migrations.AddField(
            model_name='dispute',
            name='kind',
            field=models.CharField(choices=[('milestone', 'По этапу'), ('warranty', 'Гарантийный')], default='milestone', max_length=16),
        ),
        migrations.AddField(
            model_name='dispute',
            name='outcome',
            field=models.CharField(blank=True, choices=[('resolved', 'Урегулирован'), ('cap_reached', 'Закрыт по предельному сроку'), ('escalated_to_court', 'Передан в суд')], default='', max_length=32),
        ),
        migrations.AlterField(
            model_name='dispute',
            name='checklist_item',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name='disputes', to='milestones.checklistitem'),
        ),
        migrations.AlterField(
            model_name='dispute',
            name='milestone',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='disputes', to='milestones.milestone'),
        ),
        migrations.AlterField(
            model_name='dispute',
            name='status',
            field=models.CharField(choices=[('open', 'Открыт'), ('awaiting_fix', 'Ожидает исправления'), ('awaiting_discount', 'Ожидает решения по скидке'), ('resolved', 'Закрыт')], default='open', max_length=24),
        ),
        # Данные ДО ужесточения схемы: заполнить contract/outcome у строк Э4.6.
        migrations.RunPython(backfill_dispute_contract, noop_reverse),
        migrations.AlterField(
            model_name='dispute',
            name='contract',
            field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='disputes', to='contracts.contract'),
        ),
        migrations.AddConstraint(
            model_name='dispute',
            constraint=models.CheckConstraint(condition=models.Q(('fix_rounds_used__lte', 2)), name='dispute_fix_rounds_within_cap'),
        ),
        migrations.AddConstraint(
            model_name='dispute',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(('checklist_item__isnull', False), ('kind', 'milestone'), ('milestone__isnull', False)), models.Q(('checklist_item__isnull', True), ('kind', 'warranty'), ('milestone__isnull', True)), _connector='OR'), name='dispute_kind_subject_consistent'),
        ),
        migrations.AddConstraint(
            model_name='dispute',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(('resolved_at__isnull', False), ('status', 'resolved'), models.Q(('outcome', ''), _negated=True)), models.Q(models.Q(('status', 'resolved'), _negated=True), ('outcome', ''), ('resolved_at__isnull', True)), _connector='OR'), name='dispute_resolved_has_outcome'),
        ),
        migrations.AddField(
            model_name='discountagreement',
            name='amendment',
            field=models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='discount_agreements', to='contracts.amendment'),
        ),
        migrations.AddField(
            model_name='discountagreement',
            name='decided_by',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name='+', to=settings.AUTH_USER_MODEL),
        ),
        migrations.AddField(
            model_name='discountagreement',
            name='dispute',
            field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='discount_agreements', to='disputes.dispute'),
        ),
        migrations.AddField(
            model_name='discountagreement',
            name='milestone',
            field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='discount_agreements', to='milestones.milestone'),
        ),
        migrations.AddField(
            model_name='discountagreement',
            name='proposed_by',
            field=models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to=settings.AUTH_USER_MODEL),
        ),
        migrations.AddField(
            model_name='disputewindow',
            name='contested_by',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name='+', to=settings.AUTH_USER_MODEL),
        ),
        migrations.AddField(
            model_name='disputewindow',
            name='contract',
            field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='dispute_windows', to='contracts.contract'),
        ),
        migrations.AddField(
            model_name='disputewindow',
            name='dispute',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='windows', to='disputes.dispute'),
        ),
        migrations.AddField(
            model_name='fixrequest',
            name='dispute',
            field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='fix_requests', to='disputes.dispute'),
        ),
        migrations.AddField(
            model_name='fixrequest',
            name='requested_by',
            field=models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to=settings.AUTH_USER_MODEL),
        ),
        migrations.AddField(
            model_name='fixrequest',
            name='resubmitted_by',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name='+', to=settings.AUTH_USER_MODEL),
        ),
        migrations.AddConstraint(
            model_name='discountagreement',
            constraint=models.CheckConstraint(condition=models.Q(('new_amount__lt', models.F('old_amount'))), name='discount_agreement_reduces_amount'),
        ),
        migrations.AddConstraint(
            model_name='discountagreement',
            constraint=models.CheckConstraint(condition=models.Q(('new_amount__gte', 0)), name='discount_agreement_new_amount_non_negative'),
        ),
        migrations.AddConstraint(
            model_name='discountagreement',
            constraint=models.CheckConstraint(condition=models.Q(('new_amount_currency', models.F('old_amount_currency'))), name='discount_agreement_same_currency'),
        ),
        migrations.AddConstraint(
            model_name='disputewindow',
            constraint=models.CheckConstraint(condition=models.Q(('contested__isnull', True), ('closed_at__isnull', False), _connector='OR'), name='dispute_window_outcome_implies_closed'),
        ),
        migrations.AddConstraint(
            model_name='disputewindow',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(('contested', True), ('contested_at__isnull', False), ('contested_by__isnull', False)), models.Q(('contested', True), _negated=True), _connector='OR'), name='dispute_window_contested_has_author'),
        ),
        migrations.AddConstraint(
            model_name='fixrequest',
            constraint=models.UniqueConstraint(fields=('dispute', 'round'), name='fix_request_round_unique'),
        ),
        migrations.AddConstraint(
            model_name='fixrequest',
            constraint=models.CheckConstraint(condition=models.Q(('round__gte', 1), ('round__lte', 2)), name='fix_request_round_within_cap'),
        ),
        migrations.RunSQL(sql=_GUARD_CREATE_SQL, reverse_sql=_GUARD_DROP_SQL),
    ]
