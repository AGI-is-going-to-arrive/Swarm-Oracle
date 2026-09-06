.PHONY: preflight dev-backend dev-frontend dev help

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

preflight: ## Run preflight checks
	python backend/scripts/preflight.py

dev-backend: ## Start backend dev server
	cd backend && .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 18927 --reload

dev-frontend: ## Start frontend dev server
	cd frontend && npm run dev

dev: ## Start both servers (requires tmux or run in separate terminals)
	@echo "Run 'make dev-backend' and 'make dev-frontend' in separate terminals"
