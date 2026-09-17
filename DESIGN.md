# Mindless Design System

## Visual Theme
A minimal near-black physical control surface inspired by dedicated industrial hardware. Directional highlights, restrained inset shadows, and fine warm-gray seams create believable material depth without decorative effects. Orange appears only as a live status signal or irreversible action cue.

## Color Palette
- Canvas: `oklch(0.095 0.004 70)`
- Enclosure: `oklch(0.135 0.006 65)`
- Raised surface: `oklch(0.17 0.006 65)`
- Hairline: `oklch(0.28 0.007 65)`
- Primary text: `oklch(0.82 0.008 70)`
- Muted text: `oklch(0.56 0.008 70)`
- Signal orange: `oklch(0.67 0.19 42)`
- Error: `oklch(0.62 0.19 28)`

## Typography
Use SF Mono for time, durations, counters, and compact labels. Use the macOS system sans stack for controls and explanatory copy. Numeric displays use tabular figures.

## Shape and Elevation
The app is a fixed 580px square with a clean 34px silhouette, no visible outer outline or native window shadow, and restrained internal lighting. Internal panels have 20px radii and thin borders. Buttons use 12px radii, never pills.

## Layout
A compact top status rail sits above a two-column workspace. The left time chamber occupies roughly 38% of the width and shows active lock countdowns beneath local time. The right control chamber always remains available for groups, target selection, duration, and a compact Now/Schedule mode.

## Motion
Transitions last 140–190ms using ease-out-quint. Motion is limited to view-state entry and direct control feedback, using opacity and transforms only. Honor `prefers-reduced-motion`.

## Components
- Time chamber: oversized two-line local time, date, and AM/PM.
- Groups rack: reusable app and website sets created after selecting targets and naming the set. Selecting a group adds one grouped row to Targets instead of expanding its contents. Lock Now resolves the group and uses the dial's current value.
- Target rows: selected app or domain, type indicator, and remove control.
- Duration dial: circular 15-minute-step scrub control. Hold and drag horizontally, left to decrease and right to increase. It also supports the mouse wheel, keyboard range input, and bounded plus/minus controls.
- Start mode: compact Now/Schedule segmented control with an inline native date-time field for schedules up to 31 days ahead.
- Commit control: immediate orange lock or schedule action with no intermediate confirmation.
- Sessions: compact independent rows below local time showing exact targets. Future sessions count down to their start; active sessions count down to release.
- Menu-bar item: monochrome template icon that toggles window visibility on primary click, with explicit show, hide, and quit context actions.
