# cmd-center Test Plan

Import the CSV block below into a spreadsheet. It focuses on the areas flagged as
lower-confidence (PTY lifecycle, node-pty portability, WebSocket security) plus core
functionality.

```csv
ID,Area,Test Case,Steps,Expected Result,Priority
TC01,Discovery,Projects with a Makefile are listed,"Run make start; open http://127.0.0.1:3200","Sidebar lists every directory under the repo root that has a Makefile, sorted by name",High
TC02,Discovery,Directories without a Makefile are excluded,"Note a repo dir that has no Makefile; check the sidebar","That directory does not appear in the list",High
TC03,Discovery,Rescan picks up a new project,"Create a new dir with a Makefile under the repo root; click Rescan","The new project appears without restarting the server",Medium
TC04,Targets,Target buttons match the Makefile,"Select a project that has make targets","One button per target appears, labeled make <target>; inline ## descriptions show next to the name",High
TC05,Targets,Toggle hides and shows target buttons,"Uncheck 'Show quick-run target buttons'; then re-check it","Buttons disappear when unchecked and reappear when checked; state persists across reload",High
TC06,Targets,No-target project shows a message,"Select a project whose Makefile has no ordinary targets","A 'No make targets detected' message shows instead of buttons",Low
TC07,Terminal,Terminal opens in the project directory,"Select a project; in the terminal type pwd and press Enter","The printed path is the selected project's directory",High
TC08,Terminal,Arbitrary command runs,"Type ls -la and press Enter","Directory contents render with colors intact",High
TC09,Terminal,make with any option works,"Type make -n <target> (dry run) and press Enter","make prints the commands it would run without executing them",High
TC10,Terminal,Quick-run button runs make,"Click a target button","make <target> is typed into the terminal and executes; output streams live",High
TC11,Terminal,Ctrl-C interrupts a running command,"Run a long command (e.g. sleep 30); press Ctrl-C","The command is interrupted and the prompt returns",High
TC12,Terminal,Interactive programs work,"Run a pager or editor (e.g. less Makefile); navigate; quit","The full-screen program renders and responds to keys",Medium
TC13,Terminal,Resize reflows the terminal,"Resize the browser window","The terminal reflows; running programs see the new size (e.g. run tput cols)",Medium
TC14,Terminal,Switching projects starts a fresh shell,"Select project A, run cd ..; select project B; type pwd","project B's terminal starts in project B's directory, not A's",High
TC15,Terminal,Process exit is reported,"Type exit in the terminal","A '[process exited]' notice appears",Low
TC16,Security,Foreign Origin is rejected,"From another origin, attempt ws://127.0.0.1:3200/pty?project=<name>","Connection is refused with HTTP 403",High
TC17,Security,Unknown project is rejected,"Open ws /pty?project=does-not-exist with a valid Origin","Connection is refused with HTTP 404",High
TC18,Security,Path traversal is rejected,"Open ws /pty?project=../../etc with a valid Origin","Connection is refused; no shell opens outside the allowlist",High
TC19,Security,Server binds to loopback only,"Run lsof -iTCP -sTCP:LISTEN | grep 3200 (or netstat)","The listener is bound to 127.0.0.1, not 0.0.0.0",High
TC20,Portability,Fresh install keeps PTY working,"Delete node_modules; run make install; make start; open a terminal","The terminal works; spawn-helper has its execute bit (postinstall restored it)",High
TC21,Lifecycle,Closing a tab kills the shell,"Open a project terminal; note the shell PID; close the browser tab; check ps","The node-pty shell process is terminated (no orphan)",Medium
TC22,Automated,Test suites pass,"Run make test-all","Unit, security, and Playwright UI tests all pass",High
```
