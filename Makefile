PORT     ?= 3200
HOST     ?= 127.0.0.1
BASE_URL  = http://$(HOST):$(PORT)
PID_FILE  = .server.pid
LOG_FILE  = server.log

.PHONY: all install start stop restart status logs open run \
        test test-unit test-security test-ui test-all test-ci \
        clean help

all: help

# ── Development ───────────────────────────────────────────────────────────────

## Install npm dependencies (also fixes node-pty spawn-helper permissions)
install:
	npm install

## Run the server in the foreground (Ctrl-C to stop)
run:
	PORT=$(PORT) HOST=$(HOST) node server.js

# ── Server ────────────────────────────────────────────────────────────────────

## Start the server in the background
start:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
	  echo "Server already running (PID $$(cat $(PID_FILE)))"; \
	else \
	  PORT=$(PORT) HOST=$(HOST) node server.js >> $(LOG_FILE) 2>&1 & \
	  echo $$! > $(PID_FILE); \
	  sleep 1; \
	  echo "Server started (PID $$(cat $(PID_FILE))) -> $(BASE_URL)"; \
	fi

## Stop the background server
stop:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
	  kill $$(cat $(PID_FILE)); \
	  rm -f $(PID_FILE); \
	  echo "Server stopped"; \
	else \
	  echo "Server not running"; \
	  rm -f $(PID_FILE); \
	fi

## Restart the server
restart: stop start

## Show server status and last 10 log lines
status:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
	  echo "Running  PID $$(cat $(PID_FILE))  ->  $(BASE_URL)"; \
	else \
	  echo "Stopped"; \
	fi
	@if [ -f $(LOG_FILE) ]; then \
	  echo ""; echo "--- last 10 log lines ---"; \
	  tail -10 $(LOG_FILE); \
	fi

## Tail the server log
logs:
	@tail -f $(LOG_FILE)

## Open the app in the default browser
open:
	open $(BASE_URL)

# ── Tests ─────────────────────────────────────────────────────────────────────

## Run unit tests (project scan + Makefile target parser)
test-unit:
	node test/unit.js

## Run security tests (origin check, path allowlist, local bind)
test-security:
	node test/security.js

## Run unit + security tests (no browser required)
test: test-unit test-security

## Run browser UI tests (Playwright launches its own server)
test-ui:
	npx playwright test --config=playwright.config.js

## Run every test (unit + security + UI)
test-all: test test-ui

## Alias for test-all
test-ci: test-all

# ── Housekeeping ──────────────────────────────────────────────────────────────

## Remove logs, pid file, and test artifacts
clean:
	rm -f $(PID_FILE) $(LOG_FILE)
	rm -rf test-results playwright-report

## Show this help
help:
	@echo "cmd-center — make targets:"
	@grep -E '^##' -A1 Makefile | grep -E '^[a-zA-Z0-9_-]+:' | sed 's/:.*//' | sort -u | sed 's/^/  make /'
