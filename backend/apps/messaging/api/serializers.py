from __future__ import annotations

from typing import Any

from rest_framework import serializers


class MessageSerializer(serializers.Serializer[Any]):
    """Строка переписки (ADR-112). `mine` фронт вычисляет сам по своему
    актёру — сериализатор отдаёт только факт."""

    id = serializers.UUIDField()
    sender_profile_id = serializers.UUIDField()
    body = serializers.CharField()
    created_at = serializers.DateTimeField()
    read_at = serializers.DateTimeField(allow_null=True)


class MessagesResponseSerializer(serializers.Serializer[Any]):
    items = MessageSerializer(many=True)
    unread_count = serializers.IntegerField()


class MessageCreateSerializer(serializers.Serializer[Any]):
    body = serializers.CharField(max_length=4000)


class ThreadLastMessageSerializer(serializers.Serializer[Any]):
    body = serializers.CharField()
    created_at = serializers.DateTimeField()
    sender_profile_id = serializers.UUIDField()


class ThreadSerializer(serializers.Serializer[Any]):
    contract_id = serializers.UUIDField()
    contract_title = serializers.CharField()
    counterparty_profile_id = serializers.UUIDField()
    last_message = ThreadLastMessageSerializer()
    unread_count = serializers.IntegerField()
