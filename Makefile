COMPOSE=docker compose -f docker-compose.dev.yml

.PHONY: up down logs ps build restart help

help:
	@echo "Targets:"
	@echo "  make up              # stack completo"
	@echo "  make up svc=crm      # un microservicio (+ deps)"
	@echo "  make down"
	@echo "  make logs svc=crm"
	@echo "  make ps"
	@echo "  make build"
	@echo "  make restart svc=crm"

up:
ifeq ($(svc),)
	$(COMPOSE) up -d --build
else
	$(COMPOSE) up -d --build $(svc)
endif

down:
	$(COMPOSE) down

logs:
ifeq ($(svc),)
	$(COMPOSE) logs -f --tail=100
else
	$(COMPOSE) logs -f --tail=100 $(svc)
endif

ps:
	$(COMPOSE) ps

build:
ifeq ($(svc),)
	$(COMPOSE) build
else
	$(COMPOSE) build $(svc)
endif

restart:
ifeq ($(svc),)
	$(COMPOSE) restart
else
	$(COMPOSE) restart $(svc)
endif
