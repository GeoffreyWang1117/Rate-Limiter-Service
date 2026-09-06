.PHONY: help install stack-up stack-down verify test bench serve clean

help:
	@echo "Local development (no Docker required):"
	@echo "  make install     - install dependencies"
	@echo "  make stack-up    - start Redis + PostgreSQL from the conda env"
	@echo "  make migrate     - apply the schema"
	@echo "  make serve       - build and run the gateway on :3055"
	@echo "  make stack-down  - stop Redis + PostgreSQL"
	@echo ""
	@echo "Verification:"
	@echo "  make verify      - typecheck, lint, build, test with coverage"
	@echo "  make test        - test only (needs stack-up)"
	@echo ""
	@echo "Measurement:"
	@echo "  make bench       - both benchmarks (needs serve)"
	@echo ""
	@echo "Docker equivalent:"
	@echo "  make docker-up / docker-down"

install:
	npm install

stack-up:
	./scripts/devstack.sh up

stack-down:
	./scripts/devstack.sh down

migrate:
	npm run build && . ./scripts/devstack.env.sh && node dist/scripts/migrate.js up

serve:
	./scripts/serve.sh start

verify:
	npm run verify

test:
	npm test

bench:
	./bench/sweep.sh 12
	npm run bench:reservation

docker-secrets:
	@test -f .env && { echo ".env already exists; not overwriting"; exit 1; } || true
	@cp .env.example .env
	@for k in CONTROL_PLANE_API_KEY POSTGRES_PASSWORD REDIS_PASSWORD GRAFANA_ADMIN_PASSWORD; do \
		v=$$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32); \
		sed -i "s|^$$k=.*|$$k=$$v|" .env; \
	done
	@echo "wrote .env with generated secrets (gitignored)"

docker-up:
	docker compose up -d --build

docker-down:
	docker compose down

clean:
	rm -rf dist coverage node_modules bench/results
