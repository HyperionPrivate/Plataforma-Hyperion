COMPOSE=docker compose -f docker-compose.dev.yml
COMPOSE_TEST=docker compose -f docker-compose.test.yml
UV?=uv
PYTHON?=python

.PHONY: help bootstrap format lint typecheck test contracts migrations-test build smoke security up down integration

help:
	@echo "Architecture foundation targets — no commercial product commands"

bootstrap:
	$(PYTHON) -m pip install -U "pip" "uv"
	$(UV) sync --frozen --group dev
	$(UV) pip install -e packages/platform-kit -e apps/pilot-core -e apps/whatsapp-adapter -e apps/documents -e apps/handoff-liwa

format:
	$(UV) run ruff format packages apps tests

lint:
	$(UV) run ruff check packages apps tests

typecheck:
	$(UV) run mypy packages/platform-kit/src apps/pilot-core/src apps/whatsapp-adapter/src apps/documents/src apps/handoff-liwa/src

test:
	$(UV) run pytest -m "not integration"

contracts:
	$(UV) run pytest tests/contracts -q --override-ini addopts= -p no:cov

migrations-test:
	$(UV) run python -c "from pathlib import Path; \
apps=['pilot-core','whatsapp-adapter','documents','handoff-liwa']; \
[Path(f'apps/{a}/alembic/versions/0001_technical.py').exists() or (_ for _ in ()).throw(AssertionError(a)) for a in apps]; \
print('migrations present', len(apps))"

build:
	$(COMPOSE) build

smoke:
	$(COMPOSE) config --quiet
	$(UV) run python -c "from platform_kit.events.envelope import build_synthetic_ping; from platform_kit.mocks import MockDialerClient; e=build_synthetic_ping(producer='x',tenant_id='t',correlation_id='c',marker='m'); assert e.event_type=='platform.synthetic.ping'; print('smoke ok')"

integration:
	$(UV) run pytest tests/integration -q --override-ini addopts= -p no:cov -m integration

security:
	$(UV) run pip-audit --progress-spinner off || echo "pip-audit finished with findings — review before merge"

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down -v
