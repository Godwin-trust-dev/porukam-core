.PHONY: up migrate run test lint fmt

COMPOSE_FILE := ../infra/compose/docker-compose.local.yml

up:
	docker compose -f $(COMPOSE_FILE) up -d

migrate:
	uv run manage.py migrate
	uv run manage.py migrate --database=audit

run:
	uv run manage.py runserver 0.0.0.0:8000

test:
	uv run pytest

lint:
	uv run ruff check .
	uv run ruff format --check .
	uv run mypy manage.py config common apps services
	uv run lint-imports

fmt:
	uv run ruff format .
	uv run ruff check --fix .
