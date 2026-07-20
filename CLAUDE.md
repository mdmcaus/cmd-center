# CLAUDE.md

Operating rules for long-running AI coding agents.

Use this file when an agent needs to keep working across context drift, restarts, and handoffs. It biases toward action with verification, not endless planning.

## Tradeoff

These rules bias toward shipping useful work over narrating perfect intent. For tiny one-shot tasks, use judgment.

## 1. Act After Checks

Do not describe a valid action without taking it.

Before acting:

- identify the next concrete action
- gather the minimum current evidence
- use the available tool
- verify the result

If checks pass, act. If checks fail, name the blocker.

Failure shape:

```text
The next step would be to edit the file.
```

Better:

```text
Edit the file, run the test, report the result.
```

## 2. Live Evidence First

Do not present stale memory as current truth.

Use live evidence for:

- files
- tests
- logs
- services
- dependencies
- external facts
- anything that may have changed

Old context is useful only when it changes the next action.

## 3. Keep State Compact

Long sessions need state, not diary.

Use this shape:

```yaml
current_task:
current_state:
last_action:
last_verification:
open_blockers:
next_action:
```

The next agent should understand the session in under one minute.

## 4. Break Loops Early

Repeated no-action cycles are a signal that the session is degrading.

Rules:

- never poll, sleep, or wait more than 5 minutes without checking for actionable work
- after 3 consecutive no-action cycles, reassess the thesis
- every 60 to 90 minutes, refresh the state file
- every 3 hours, create a clean checkpoint
- before ending or restarting, write the next action clearly

A checkpoint is continuity, not death.

## 5. Learn Only What Changes Behavior

Save lessons only when they create a future rule.

Use this shape:

```yaml
type: lesson | skill | observation
shape:
cost_or_benefit:
future_rule:
evidence:
```

If there is no future rule, it is a log, not learning.

## 6. Keep Safety Rails Useful

Safety checks should protect work, not replace judgment.

If a safety check fires repeatedly, write:

```yaml
check_name:
why_it_fired:
was_it_legitimate:
did_it_block_real_work:
permanent_fix:
```

Do not add more checks until the existing check is understood.

## 7. Write unit tests and white and black box security tests

When the app is completed, write well thought out and relevant
- white and black box security tests
- unit tests

And run them until there are no errors.

## 8. Write a .gitignore

Write a relevant .gitignore so the code can be checked in.

## 9. Write a README.md

When completely finished with the task, write a README.md with all relevant information.

## 10. Create a Makefile.template for MacOS apps

It should match the one in the templates directory. Fix it for the current project.

## 11. Copy and adapt SIGNED.md

Copy from templates SIGNED.md. Fix it to line up to the current project. This way, it can be followed to properly set up the app for signing.

## 12. Create an entitlemens file

Copy from the template directory the ntitlements file. Rename it to the current app name so it can be used for signing.

## 13. Embed the end-user documentation from the README.md in every build of the app if it's a XCode or Swift app

Build a renderer that can be moved around for Markdown if needed. Get the end-user documentation from the README and put it in ENDUSER.md and then embed that. Make a note in ENDUSER.md that if the user wants to see the README, go to Github.

## 14. Create an icon appropriate for the app

Create an appropriate app icon and bundle it with the app.

## 15. Create an About box

Create an About box in the app with the icon, the app name, the OS the app is running on, and text at the bottom that states "This app was created entirely by Claude Code with a human doing QA.".

## 16. Create a Resources/screenshots directory

I will drop screenshots in there when the app is complete for you to wire into the README. I will tell you when I am ready.

## 17. Whenever you search, include the current year

If you do a search that includes years, please include 2026.

## 18. Do not put a comment or anything else on the NOTARY_PROFILE line besides the nane or temporary name in the Makefile

## 19. Convert from Imagemagik is deprecated for icons

Use "magick" or "magick convert" instead of "convert".

## 20. No em-dashes in any documentation or anything else that's written that's not code.

## 21. No emojis anywhere in any documentation.

If it's necessary, check with me first and show me the documentation and I will approve or not approve.

## 22. Once you have done your initial write of the app ask yourself these questions.

i. What are you least confident about right now?
ii. What don't I realize?

Give the answers so i can read and we can work on anything that needs any attention.

## 23. Write a test plan for the app as such:

Write a test plan for what i should test and steps on how to test with expected result(s) of the feature. Put it in CSV format and i can import it and work on it. Name the plan APPNAME_testplan.md where APPNAME is the name of the app to be tested.

Focus heavily on anything you said could be an issue with the 2 questions above along with general functionality testing.

## 24. Research and write a file describing external testing if possible.

Research tools and the like for external automated testing of the application, webapp, etc. Write EXTERNAL_TEST.md with very specific details and directions on what you found including tools, what they do, and what tests would be done. FOSS and other free tools are a priority.

After the app, webapp, etc is complete, I will review it and ask for assistance on writing those tests and running them.

These tests need to include:
- Black box security
- White box security
- Functionality
- Smoke tests

## 25. Once you have declared the app done, let's do the following.

You should say Development Complete. Then, from this point forward, any code changes should go into a branch and a PR should be created for my review.

## Versioning
- Version lives in the project's natural place — `package.json` (Node), `Cargo.toml` (Rust), `MARKETING_VERSION` in the `.xcodeproj` (Xcode apps), a Makefile `VERSION = …` variable (SwiftPM/Makefile.template apps, baked into Info.plist), or a `VERSION` file otherwise; keep it in sync with the latest CHANGELOG entry. Make sure the version is referenced wherever the build/bundle/distribution reads it — a Makefile that packages an app should read the canonical version (e.g. MARKETING_VERSION), not hardcode a separate copy.
- Use semver. Bump patch for fixes, minor for new features, major for breaking changes.
- Always update CHANGELOG.md when making changes, grouped under `## [Unreleased]` until a version is tagged. This is part of every change, not a release-time afterthought — add the entry as you make the change.
- Releasing is documented in RELEASING.md. Cut a release with `scripts/release.sh X.Y.Z` (bumps the version, stamps the CHANGELOG, commits, tags). Pushing the tag triggers `.github/workflows/release.yml` to publish a GitHub Release. These files come from the release kit (`templates/release-kit/`).

## Completion

A task is complete when:

- the requested change is made, or the blocker is proven
- verification was run, or the reason it could not run is stated
- the next session can continue from the saved state

Anything else is unfinished.
