PORT     ?= 3200
HOST     ?= 127.0.0.1
BASE_URL  = http://$(HOST):$(PORT)
PID_FILE  = .server.pid
LOG_FILE  = server.log

# LaunchAgent (macOS autostart) settings.
AGENT_LABEL = com.mdmcaus.cmd-center
AGENT_PLIST = $(HOME)/Library/LaunchAgents/$(AGENT_LABEL).plist
NODE_BIN   := $(shell command -v node)
WORKDIR    := $(shell pwd)

.PHONY: all install start stop restart status logs open run \
        test test-unit test-security test-ui test-all test-ci \
        lint audit install-agent uninstall-agent agent-status \
        docker-build docker-up docker-down docker-restart docker-logs \
        docker-status docker-shell docker-clean docker-portcheck \
        clean help

all: help

# ── Development ───────────────────────────────────────────────────────────────

# Is the cmd-center container up? The lifecycle targets below ask this first,
# because once the container publishes PORT there is no node process to find and
# the port is held by OrbStack's forwarding helper. Without this check, "status"
# would report that helper as a running server and "stop" would try to kill it.
DOCKER_PS = docker compose ps --status running -q app 2>/dev/null

## Install npm dependencies (also fixes node-pty spawn-helper permissions)
install:
	npm install

## Run the server in the foreground (Ctrl-C to stop)
run:
	PORT=$(PORT) HOST=$(HOST) node server.js

# ── Server ────────────────────────────────────────────────────────────────────

## Start the server in the background (detached, survives closing the terminal)
start:
	@CID=$$($(DOCKER_PS)); \
	if [ -n "$$CID" ]; then \
	  echo "cmd-center is already running in Docker on this machine."; \
	  echo "See 'make docker-status'. Run 'make docker-down' first if you"; \
	  echo "want the node instance instead."; \
	  exit 0; \
	fi; \
	if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
	  echo "Server already running (PID $$(cat $(PID_FILE)))"; exit 0; \
	fi; \
	OTHER=$$(lsof -tiTCP:$(PORT) -sTCP:LISTEN 2>/dev/null); \
	if [ -n "$$OTHER" ]; then \
	  echo "Port $(PORT) is already in use by PID $$OTHER (not started by make)."; \
	  echo "Run 'make stop' to clear it, or start with a different PORT=<n>."; \
	  exit 1; \
	fi; \
	rm -f $(PID_FILE); \
	PORT=$(PORT) HOST=$(HOST) nohup node server.js >> $(LOG_FILE) 2>&1 & \
	NEWPID=$$!; \
	sleep 1; \
	if kill -0 $$NEWPID 2>/dev/null && lsof -tiTCP:$(PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
	  echo $$NEWPID > $(PID_FILE); \
	  echo "Server started (PID $$NEWPID) -> $(BASE_URL)"; \
	else \
	  echo "Server failed to start. Recent log:"; \
	  tail -15 $(LOG_FILE) 2>/dev/null; \
	  exit 1; \
	fi

## Stop the background server (also clears any stray process holding the port)
stop:
	@CID=$$($(DOCKER_PS)); \
	if [ -n "$$CID" ]; then \
	  echo "cmd-center is running in Docker. Stopping the container."; \
	  docker compose down; \
	  exit 0; \
	fi; \
	STOPPED=0; \
	if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
	  kill $$(cat $(PID_FILE)) 2>/dev/null && STOPPED=1; \
	fi; \
	rm -f $(PID_FILE); \
	ORPHAN=$$(lsof -tiTCP:$(PORT) -sTCP:LISTEN 2>/dev/null | head -1); \
	if [ -n "$$ORPHAN" ]; then \
	  CMD=$$(ps -p $$ORPHAN -o comm= 2>/dev/null); \
	  case "$$CMD" in \
	    *node*) \
	      echo "Clearing node process still on port $(PORT): $$ORPHAN"; \
	      kill $$ORPHAN 2>/dev/null; STOPPED=1; ;; \
	    *) \
	      echo "Port $(PORT) is held by PID $$ORPHAN ($$CMD), which this"; \
	      echo "Makefile did not start. Refusing to kill it."; ;; \
	  esac; \
	fi; \
	if [ $$STOPPED -eq 1 ]; then echo "Server stopped"; else echo "Server not running"; fi

## Restart the server
restart: stop start

## Show server status (checks the port, not just the PID file) and last 10 log lines
status:
	@CID=$$($(DOCKER_PS)); \
	if [ -n "$$CID" ]; then \
	  HEALTH=$$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' $$CID); \
	  MAPPED=$$(docker inspect -f '{{range $$p, $$c := .NetworkSettings.Ports}}{{range $$c}}{{.HostIp}}:{{.HostPort}}{{end}}{{end}}' $$CID); \
	  echo "Running in Docker  container $$(echo $$CID | cut -c1-12)  health $$HEALTH"; \
	  echo "url:  http://$$MAPPED"; \
	  echo ""; \
	  echo "--- last 10 container log lines ---"; \
	  docker compose logs --no-log-prefix --tail 10 app 2>/dev/null; \
	  exit 0; \
	fi; \
	LPID=$$(lsof -tiTCP:$(PORT) -sTCP:LISTEN 2>/dev/null); \
	if [ -n "$$LPID" ]; then \
	  echo "Running  PID $$LPID  ->  $(BASE_URL)"; \
	  if [ -f $(PID_FILE) ] && [ "$$(cat $(PID_FILE))" != "$$LPID" ]; then \
	    echo "(note: $(PID_FILE) is stale; port is held by PID $$LPID)"; \
	  fi; \
	else \
	  echo "Stopped"; \
	fi
	@CID=$$($(DOCKER_PS)); \
	if [ -z "$$CID" ] && [ -f $(LOG_FILE) ]; then \
	  echo ""; echo "--- last 10 log lines ---"; \
	  tail -10 $(LOG_FILE); \
	fi

## Tail the server log
logs:
	@CID=$$($(DOCKER_PS)); \
	if [ -n "$$CID" ]; then docker compose logs -f app; exit 0; fi; \
	tail -f $(LOG_FILE)

## Open the app in the default browser
open:
	open $(BASE_URL)

# ── Autostart (macOS LaunchAgent) ─────────────────────────────────────────────

## Install a LaunchAgent so cmd-center starts at login and restarts on crash
install-agent:
	@if [ -z "$(NODE_BIN)" ]; then echo "node not found on PATH"; exit 1; fi
	@mkdir -p $(HOME)/Library/LaunchAgents
	@sed -e "s#__NODE__#$(NODE_BIN)#g" \
	     -e "s#__WORKDIR__#$(WORKDIR)#g" \
	     -e "s#__PORT__#$(PORT)#g" \
	     -e "s#__HOST__#$(HOST)#g" \
	     -e "s#__LABEL__#$(AGENT_LABEL)#g" \
	     launchd/$(AGENT_LABEL).plist.template > $(AGENT_PLIST)
	@launchctl unload $(AGENT_PLIST) 2>/dev/null || true
	@launchctl load $(AGENT_PLIST)
	@echo "LaunchAgent installed and loaded: $(AGENT_PLIST)"
	@echo "Starts at login and restarts on crash. Do not also run 'make start'."
	@echo "Check with 'make agent-status'; remove with 'make uninstall-agent'."

## Stop and remove the LaunchAgent
uninstall-agent:
	@if [ -f $(AGENT_PLIST) ]; then \
	  launchctl unload $(AGENT_PLIST) 2>/dev/null || true; \
	  rm -f $(AGENT_PLIST); \
	  echo "LaunchAgent removed"; \
	else \
	  echo "No LaunchAgent installed"; \
	fi

## Show whether the LaunchAgent is loaded
agent-status:
	@if launchctl list 2>/dev/null | grep -q $(AGENT_LABEL); then \
	  echo "LaunchAgent loaded:"; launchctl list | grep $(AGENT_LABEL); \
	else \
	  echo "LaunchAgent not loaded"; \
	fi

# ── Docker (OrbStack) ─────────────────────────────────────────────────────────
#
# The container runs a linux shell, so make targets that need Xcode, swift,
# codesign or launchctl cannot work inside it. See docker-deploy.md.

DOCKER_HOST_PORT ?= $(shell grep -E '^HOST_PORT=' .env 2>/dev/null | cut -d= -f2)
DOCKER_PORT       = $(or $(DOCKER_HOST_PORT),3201)
DOCKER_URL        = http://127.0.0.1:$(DOCKER_PORT)

## Build the Docker image (compiles node-pty for linux; first build is slow)
docker-build:
	docker compose build

## Start the container in the background (refuses to take a port already in use)
docker-up: docker-portcheck
	docker compose up -d
	@echo "cmd-center container -> $(DOCKER_URL)"

# The host instance lives on 3200 and is the only one that can build the macOS
# projects. Publishing the container onto an occupied port would either fail
# cryptically or, worse, leave you driving the wrong instance without noticing.
docker-portcheck:
	@OTHER=$$(lsof -tiTCP:$(DOCKER_PORT) -sTCP:LISTEN 2>/dev/null | head -1); \
	CID=$$(docker compose ps -q app 2>/dev/null); \
	if [ -n "$$OTHER" ] && [ -z "$$CID" ]; then \
	  echo "Port $(DOCKER_PORT) is already in use by PID $$OTHER."; \
	  echo "The host instance uses 3200. Set HOST_PORT to a free port in .env,"; \
	  echo "or stop whatever holds $(DOCKER_PORT) first."; \
	  exit 1; \
	fi

## Stop and remove the container
docker-down:
	docker compose down

## Rebuild and restart the container
docker-restart: docker-portcheck
	docker compose up -d --build
	@echo "cmd-center container -> $(DOCKER_URL)"

## Tail the container log
docker-logs:
	docker compose logs -f

## Show container state and health
docker-status:
	@docker compose ps 2>/dev/null || true
	@CID=$$(docker compose ps -q app 2>/dev/null); \
	if [ -n "$$CID" ]; then \
	  echo ""; \
	  echo "health: $$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' $$CID)"; \
	  echo "url:    $(DOCKER_URL)"; \
	else \
	  echo "Container not running"; \
	fi

## Open a shell inside the running container
docker-shell:
	docker compose exec app bash

## Remove the container and its image
docker-clean:
	docker compose down --rmi local

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

# ── Static analysis ───────────────────────────────────────────────────────────

## Lint with ESLint + security plugins (0 errors expected; fs warnings are informational)
lint:
	npx eslint .

## Check runtime dependencies for known vulnerabilities
audit:
	npm audit --omit=dev

# ── Housekeeping ──────────────────────────────────────────────────────────────

## Remove logs, pid file, and test artifacts
clean:
	rm -f $(PID_FILE) $(LOG_FILE)
	rm -rf test-results playwright-report

## Show this help
help:
	@echo "cmd-center make targets:"
	@grep -E '^##' -A1 Makefile | grep -E '^[a-zA-Z0-9_-]+:' | sed 's/:.*//' | sort -u | sed 's/^/  make /'
