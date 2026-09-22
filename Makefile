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

## Start the server in the background (detached, survives closing the terminal)
start:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
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
	@STOPPED=0; \
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
	@LPID=$$(lsof -tiTCP:$(PORT) -sTCP:LISTEN 2>/dev/null); \
	if [ -n "$$LPID" ]; then \
	  echo "Running  PID $$LPID  ->  $(BASE_URL)"; \
	  if [ -f $(PID_FILE) ] && [ "$$(cat $(PID_FILE))" != "$$LPID" ]; then \
	    echo "(note: $(PID_FILE) is stale; port is held by PID $$LPID)"; \
	  fi; \
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
