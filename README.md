# Mindless

A compact 580 × 580 Tauri v2 macOS focus lock styled after a tactile industrial control surface.

## Run

```bash
npm install
npm run tauri dev
```

Build a local app and DMG:

```bash
npm run tauri build
```

Debug bundles are currently available under `src-tauri/target/debug/bundle/`.

## How enforcement works

Starting a session requests administrator approval and installs `com.mindless.guard` as a root LaunchDaemon. Until the selected deadline it:

- terminates selected app executables once per second using both executable-path and process-name checks;
- tolerates malformed or nonstandard app property lists and resolves Steam launcher shortcuts to their real game executables;
- adds IPv4 and IPv6 entries for selected domains to `/etc/hosts` and restores them if changed;
- resolves blocked domains into macOS Packet Filter rules, refreshes them as DNS changes, and kills existing connections;
- applies machine-level `URLBlocklist` policies to Brave, Chrome, and Edge, restoring prior policy files after the final lock expires;
- keeps browsers and unrelated tabs open while network and policy changes take effect;
- supports recurring daily, weekday, weekend, and custom-day schedules that run while the UI is hidden or quit;
- persists if the Mindless UI closes;
- automatically removes its host entries when time expires;
- accepts durations from 1 minute through 12 hours.

The main screen deliberately contains only group selection, individual targets, the duration dial, and Lock Now. It provides no early-unlock command or extra confirmation step. Multiple locks can overlap and each appears beneath the clock with its own expiration time and exact targets.

Settings contains recurring schedules, full group management, and Ember, Graphite, Sage, Midnight, Aubergine, and Bronze themes. Group cards expose every included app and website, and the editor supports adding or removing individual targets. Themes change both the complete surface palette and accent color. Recurring schedules select a saved group, start time, duration, and daily, weekday, weekend, or custom-day recurrence. The root LaunchDaemon evaluates these schedules independently of the UI.

Mindless runs as a macOS menu-bar accessory. Clicking its clock icon toggles the window: click once to show it and again to hide it. On launch or when switching displays, the window follows the display containing the pointer; on the same display it preserves its position. It is available on the current macOS Space. Its context menu also provides Show, Hide, and Quit actions. Quitting the interface never stops active system locks.

Saved quick locks, the chosen duration, draft apps, draft websites, partially entered domains, and active lock metadata persist between launches and app upgrades.

## Spotlight

macOS reliably indexes applications installed in `/Applications`. Building inside the project directory alone does not register an app with Spotlight. Copy `Mindless.app` to `/Applications`, then allow Spotlight a short time to index it.

## Platform limitation

This local, unsigned build cannot be literally impossible for a Mac administrator to bypass. A user with administrator credentials or Recovery Mode can disable any locally installed daemon. Strong process authorization and network filtering require Apple's restricted Endpoint Security and Network Extension entitlements, a paid developer account, signing, and approval.

The native browser policy closes the encrypted-DNS gap for Brave, Chrome, and Edge. Other browsers still depend on hosts and Packet Filter enforcement. Without Apple's Network Extension entitlement, this remains strong best-effort enforcement rather than a formal security boundary.
