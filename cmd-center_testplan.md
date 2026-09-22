# cmd-center Test Plan

Import the CSV block below into a spreadsheet. It focuses on the areas flagged as
lower-confidence (PTY lifecycle, node-pty portability, WebSocket security) plus core
functionality. TC23 onward cover the Docker build, which introduces a second set of
those same risks: a freshly compiled node-pty, an origin check that has to survive a
port remap, and a shell whose identity comes from the image rather than the Mac.

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
TC23,Docker Build,Image builds from a clean cache,"Run docker builder prune -af; run make docker-build","Build completes. node-pty compiles in the build stage (no linux prebuild exists) and the runtime image contains no g++",High
TC24,Docker Run,Container starts and reports healthy,"Run make docker-up; wait 15s; run make docker-status","State is running and health is healthy",High
TC25,Docker Run,Health endpoint answers,"curl -s http://127.0.0.1:3200/api/health","Returns {\"ok\":true}",High
TC26,Docker Discovery,Container lists the same projects as the host,"Start both instances; compare /api/projects from each","Both return the same project names AND the same absolute paths (identical-path bind mount)",High
TC27,Docker Terminal,Terminal opens and lands in the right directory,"Open a project in the container UI; run pwd and uname -s","pwd is the project's real host path; uname -s prints Linux",High
TC28,Docker Terminal,Shell has a resolved identity,"In a container terminal run id -un and echo $HOME","Prints node and /home/node. Prompt shows a username, not I have no name",High
TC29,Docker Terminal,Toolchain is present for portable projects,"In a container terminal run make --version, git --version, node --version","GNU Make, git and Node 22 all report versions",High
TC30,Docker Limits,macOS-only targets fail as documented,"Open scorebar in the container; run make build","Fails with make: swift: No such file or directory, Error 127. This is expected, not a bug",High
TC31,Docker Security,Foreign Origin is rejected,"Open a WebSocket to the container /pty with Origin: http://evil.example.com","Upgrade rejected with 403",High
TC32,Docker Security,Published port origin is allowed,"With the default HOST_PORT=3201, open http://127.0.0.1:3201 and start a terminal","Terminal connects. Without ALLOWED_ORIGINS this would 403 while the page still loaded",High
TC33,Docker Security,Strict mode rejects the container's internal port origin,"With HOST_PORT=3201, open a WebSocket with Origin: http://127.0.0.1:3200","Upgrade rejected with 403 (ALLOWED_ORIGINS_ONLY=1 drops port-derived origins)",Medium
TC34,Docker Security,Published port is loopback only,"Run docker compose ps; from another machine on the LAN try to reach the Mac on HOST_PORT","Port mapping shows 127.0.0.1. The LAN connection is refused",High
TC35,Docker Config,Config edits reach the host,"In the container UI, ignore a project; check config/ignored-projects.json on the Mac","The host file is updated. Un-ignore and confirm it reverts",High
TC36,Docker Config,Ignored project is refused a PTY in the container,"Ignore a project in the container UI; try to open its terminal","Rejected with 404. Ignoring is fail-closed in the container too",High
TC37,Docker Lifecycle,Container survives a restart,"Run docker restart cmd-center; wait; reload the page","App comes back healthy and the project list is intact",Medium
TC38,Docker Coexistence,Host and container run in parallel with no config,"With the host instance running on 3200, run make docker-up with no .env","Container comes up on 3201. Both respond independently. Neither takes the other's port",High
TC41,Docker Coexistence,Port guard refuses an occupied port,"Occupy 3201 with any process; run make docker-up","Fails with a clear message naming the PID and the port. No container is started",High
TC42,Docker Coexistence,Telling the instances apart,"Open a terminal in each instance and run whoami","Host shows your username; container shows node@<container id>",Medium
TC39,Docker Teardown,Down and clean leave nothing behind,"Run make docker-down then make docker-clean; run docker ps -a and docker images","No cmd-center container and no cmd-center image remain",Medium
TC40,Regression,Non-Docker behaviour is unchanged,"With ALLOWED_ORIGINS unset, run make test on the host","29 unit assertions and 21/21 security checks pass. Origin allow set is identical to before",High
```
