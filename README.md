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
- adds IPv4 and IPv6 entries for selected domains to `/etc/hosts` and restores them if changed;
- resolves blocked domains into macOS Packet Filter rules, refreshes them as DNS changes, and kills existing connections;
- applies machine-level `URLBlocklist` policies to Brave, Chrome, and Edge, restoring prior policy files after the final lock expires;
- keeps browsers and unrelated tabs open while network and policy changes take effect;
- supports one-time schedules up to 31 days ahead and activates them while the UI is hidden or quit;
- persists if the Mindless UI closes;
- automatically removes its host entries when time expires;
- accepts durations from 1 minute through 12 hours.

The interface deliberately provides no early-unlock command or extra confirmation step. Multiple locks can overlap and each appears beneath the clock with its own expiration time. Reusable clusters are stored locally and can contain any mix of applications and websites. To create one, select every target, choose **Save Set**, and give it a name. Saved groups contain only apps and websites. Selecting a group adds it as one grouped row under Targets. Set the dial afterward, then choose **Lock Now**; the group is expanded internally and locked for the dial's current duration. Active lock rows show the exact app and domain targets. Choose **Schedule** to set a one-time future start while retaining the dial duration.

Mindless runs as a macOS menu-bar accessory. Clicking its clock icon toggles the window: click once to show it and again to hide it. On launch or when switching displays, the window follows the display containing the pointer; on the same display it preserves its position. It is available on the current macOS Space. Its context menu also provides Show, Hide, and Quit actions. Quitting the interface never stops active system locks.

Saved quick locks, the chosen duration, draft apps, draft websites, partially entered domains, and active lock metadata persist between launches and app upgrades.

## Spotlight

macOS reliably indexes applications installed in `/Applications`. Building inside the project directory alone does not register an app with Spotlight. Copy `Mindless.app` to `/Applications`, then allow Spotlight a short time to index it.

## Platform limitation

This local, unsigned build cannot be literally impossible for a Mac administrator to bypass. A user with administrator credentials or Recovery Mode can disable any locally installed daemon. Strong process authorization and network filtering require Apple's restricted Endpoint Security and Network Extension entitlements, a paid developer account, signing, and approval.

The native browser policy closes the encrypted-DNS gap for Brave, Chrome, and Edge. Other browsers still depend on hosts and Packet Filter enforcement. Without Apple's Network Extension entitlement, this remains strong best-effort enforcement rather than a formal security boundary.
