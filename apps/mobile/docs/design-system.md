# Kybern mobile design system

The bar is an app Apple could have shipped: restraint, one clear hierarchy per
screen, consistent spacing, real materials, native controls on iOS, and custom
themed controls of the same quality on Android. Everything below lives in
`src/ui/` and `src/components/liquid/motion.ts`. Don't hand-roll rows, menus,
sheets, buttons, toasts, colors, sizes or radii in screens; if the kit lacks
something, add it here first.

See every primitive live in the dev-only gallery: `exp://<host>:<port>/--/dev-kit`
in Expo Go (or `kybern://dev-kit` in a dev build). Release builds redirect home.

## Tokens (`src/ui/theme.tsx`)

### Type

`<T variant=…>` applies the role and a Dynamic Type ceiling (`maxScale`): 200 %
for `body`, `prose`, `callout`; 160 % for everything else. Text inputs always
set `letterSpacing: 0`.

| Role | Size/line | Weight | iOS style | Android M3 | Use |
|---|---|---|---|---|---|
| `largeTitle` | 34/41 | 700 | Large Title | headlineMedium | Home hero; native large titles do this for lists |
| `title` | 22/28 | 600 | Title 2 | titleLarge | One per screen: note/task title, Android header |
| `headline` | 17/22 | 600 | Headline | titleMedium | In-page headers, empty-state titles |
| `body` | 17/24 | 400 | Body | bodyLarge | Row titles, fields |
| `prose` | 17/26 | 400 | Body | bodyLarge | Long reading: Markdown, answers |
| `callout` | 16/21 | 400 | Callout | bodyLarge | Task titles, criteria |
| `subhead` | 15/20 | 400 | Subheadline | bodyMedium | Row subtitles, menu rows, toasts |
| `label` | 15/20 | 500 | — | labelLarge | Button and chip labels |
| `footnote` | 13/18 | 400 | Footnote | bodySmall | Meta lines, footers, captions |
| `sectionHeader` | 13/18 | 600 | Footnote semibold | labelLarge | `SectionHeader` |
| `caption` | 12/16 | 400 | Caption 1 | labelMedium | Badges, swipe-action labels |
| `code` | 13/18 MONO | 400 | — | — | Commands, paths, branches in rows |
| `mono` | 13/20 MONO | 400 | — | — | Code blocks |

`display` and `heading` are deprecated aliases of `largeTitle` and `headline`.
`MONO` is SF Mono on iOS (`ui-monospace`) and `monospace` on Android. Numbers in
rows use `fontVariant: ["tabular-nums"]`.

### Space, gutter, radius

`space = { 2xs 2, xs 4, sm 8, md 12, lg 16, xl 24, 2xl 32, 3xl 48 }`. Inside a
group things sit `sm` apart; groups sit `2xl` apart. Page edge: `gutter(width)`
(16 on phones, 24 from 600 pt), content max width `CONTENT_MAX_WIDTH` 760.

`radius = { xs 6, sm 10, md 14, lg 20, xl 28, full }`. Nested radii are
concentric (inner = outer − padding):

| Surface | Radius |
|---|---|
| InsetGroup, 48 pt buttons, multi-line fields, menu-row highlight, toast action | `md` 14 |
| Menus, toasts | `lg` 20 |
| Android sheets, dialogs | `xl` 28 |
| Search field | `sm` 10 |
| 36–44 pt buttons, chips, segmented track | `full` |

### Colors (light / dark)

| Token | Light | Dark | Use |
|---|---|---|---|
| `background` | #FFFFFF | #181818 | Plain pages and lists |
| `grouped` | #F2F2F7 | #111111 | Pages of InsetGroups (settings, task page, sheets) |
| `surface` | #FFFFFF | #202020 | InsetGroup, menus, sheets |
| `card` | #F4F4F5 | #232325 | A block lifted off `background` |
| `raised` | #F2F2F2 | #2B2B2B | Fields, chips, pressed rows, toasts |
| `ink` / `secondary` / `muted` | | | Text tiers; row titles are always `ink` |
| `line` | #E5E5E5 | #333333 | Hairlines |
| `accent` / `accentSoft` | | | Tint; tinted buttons |
| `prominent` / `onProminent` | #1A1C1F / #FFF | #E9E9EB / #141414 | The one commit button |
| `negative` / `negativeSoft` | | | Errors, destructive text |
| `warning` / `warningSoft` | | | Stale or conflict notices (not errors) |
| `scrim` / `scrimLight` | 32 % / 20 % black | | Under sheets / under menus |
| `chrome` | 72 % background | | Tint over bar blur |

Status hues for glyphs come from `taskColors()` in `TaskGlyphs.tsx`.

## Primitives

### `T`, `Icon`, `Tap`, `IconButton` (`primitives.tsx`)

- `Icon` defaults to 22 pt on iOS and 24 dp on Android; row icons use 20.
- `Tap` is the only pressable. `feedback`: `"scale"` (default, buttons: 0.96,
  no fade), `"highlight"` (rows: `raised` background, 80 ms in / 200 ms out),
  `"none"`. Column layouts are centered; `flexDirection: "row"` keeps its own
  alignment. Minimum target 44 pt; grow small visuals with `hitSlop`.
  `onPress`/`onLongPress` receive the press event.

### `Button`

`role`: `prominent` (one per screen, the commit: Connect, Start, Save),
`tinted` (default; secondary commits), `plain` (header actions, inline “New”,
“See all”; flush, no fill), `destructive` (red text, no fill). `size`: `large`
48 pt (forms, sheets, bottom bars) or `medium` 36 pt. Never a white or red slab;
a red fill exists only inside a confirmation. Full-width buttons only in forms,
sheets and bottom bars, never mid-reading or in menus.

### `Field`, `SearchField`, `ListSearch` (`primitives.tsx`, `Search.tsx`)

- `Field`: label (`label` role), 48 pt input on `surface` with a hairline,
  `md` radius, error in `footnote negative`. `variant="code"` is the pairing
  code: MONO 28 pt tabular, `oneTimeCode`, no letter spacing.
- `ListSearch`: on iOS configures the native header search bar (render it in a
  screen with a native header and a `contentInsetAdjustmentBehavior="automatic"`
  scroll view; on iOS 26 it sits at the bottom toolbar). On Android it renders a
  `SearchField` (44 pt `raised`, `sm` radius, clear button) where you place it.

### Lists (`List.tsx`)

```
┌ InsetGroup (surface, radius md) ──────────────────────────────────────────┐
│ 16 [lead 28] 12 [Title 17 ink ……………] 8 [meta 15 muted] [›|✓|value ⌄] 16 │ ≥ 44
│                 [Subtitle 15 secondary, 1–2 lines]                         │
│                 └ hairline starts at the title edge (56, or 16) ──────────│
└───────────────────────────────────────────────────────────────────────────┘
```

`ListRow` props: `title`, `subtitle`, `leading` (an `IconName` or any 28 pt node:
`StatusGlyph`, `ProviderMark`, `ProjectDot`), `meta`, `value` + `valueMenu`
(a value that opens a menu, e.g. Effort), `checked` (selectable option, accent
check), `chevron` (push), `trailing` (a `Toggle`), `selected` (sidebar/rail:
`accentSoft`), `destructive`, `onPress`, `menu` + `menuTitle` (long-press
actions), `swipe` ({`leading`, `trailing`} actions), `separator` (plain lists).

- `InsetGroup` draws separators between its rows (none after the last). Plain
  lists (Notes, Tasks, Threads) use `ListRow` without a group, full width (the
  row pads 16), with `ItemSeparatorComponent={() => <ListSeparator leading />}`.
- `SectionHeader`: `title`, `count`, one text `action` (“New”), `open` +
  `onToggle` for collapsible groups (rotating chevron), `inset` to align with
  rows inside a group, `first` to drop the top padding. `SectionFooter` explains
  a group in `footnote muted`.
- `DisclosureRow`: “Thread notes 3 ›” inside a list, aligned to the text edge.
- Swipe actions: `{ title, icon, tone: accent|positive|negative|neutral,
  onPress, full? }`. Notes: leading Pin, trailing Delete (full). Tasks: leading
  Done (full), trailing More + Delete. Threads: trailing Archive. A full swipe
  past 60 % commits the outermost action (light haptic at the threshold, medium
  on commit); pair destructive commits with an Undo toast.
- Row titles are always `ink`; an untitled item uses its first line.

### Menus (`ActionMenu.tsx`, `menuModel.ts`)

One item model: `{ title, icon?, onPress?, destructive?, checked?, disabled?,
subtitle?, children?, inline? }`. `children` is a submenu; `inline` shows them as
their own section. A trailing destructive run is set apart automatically. No
Cancel item, ever. Actions run after the menu has closed.

| Trigger | Component | iOS | Android |
|---|---|---|---|
| Long-press a row | `ListRow menu`, or `<ContextMenu items>{({ onLongPress, open }) => row}</ContextMenu>` | Native UIContextMenu (lift, blur, haptic, native submenus with checkmarks) | Themed menu growing out of the row at the touch point |
| Header buttons + “…” | `<HeaderActions buttons menu />` inside the screen | Native bar buttons (`Stack.Toolbar`), native pull-down menu | Text/icon buttons + themed menu |
| Tap a “…” or a value | `<MenuButton items label>` (children = custom trigger) | Themed menu over chrome blur (UIKit tap menus need a bar button or a native dependency) | Themed menu |

Themed menu (MorphingMenu + MenuPanel): opaque `surface` on Android, 272 pt
wide, radius 20, 6 pt padding, 20 % scrim; optional title naming the object;
48 pt rows with 20 pt icons, `subhead` labels, accent check, chevron for
submenus; submenus replace the list in place with a “‹ Status” back row while
the surface morphs to the new height; hairlines between sections; destructive
rows in red text. Imperative use: `useMenuSurface().show({ items, origin })`.

`HeaderActions` uses `Stack.Toolbar placement="right"`, which owns the whole
trailing side on iOS: put every trailing control in it.

Status and priority: `statusMenuItems(task)`, `priorityMenuItems(task)`;
notes: `noteMenuItems(note, opts)`; tasks: `taskMenuItems(task, opts)`; threads:
`threadMenuItems(thread, opts)` (`src/features/*Actions.ts`).

### Confirmations (`Alert.tsx`)

`confirm({ title, message, confirm, destructive, onConfirm })` — irreversible
actions only (Delete forever, Remove project). The title names the object
(“Delete “Project brief” forever?”), the button repeats the verb. iOS: the native
two-button alert. Android: the themed dialog (radius 28, `title` heading, text
buttons end-aligned in a row: Cancel `secondary`, action `accent`, destructive
`negative`). Prefer Undo for anything restorable. `Alert.alert` stays for
errors and acknowledgements, never for menus.

### Sheets (`Sheet.tsx`)

Sheets are routes. Give the screen `sheetOptions({ detents })` in
`app/_layout.tsx`. iOS: native `formSheet` with grabber and detents. Android:
`AndroidSheet` — opaque `surface`, top radius 28, 32 % scrim, grabber, drag to
dismiss carrying release velocity (flick down dismisses, flick up expands with
a light haptic), liquid-gooey outline. A sheet on a grouped page should set
`headerStyle: { backgroundColor: colors.grouped }`. Lists of more than ~6
actions, or grouped actions, are sheets, not menus.

### Toast (`Toast.tsx`)

`showToast(text, action?)` from anywhere (host mounted in `_layout.tsx`), or
`<Toast text action onDismiss bottom>` for screen-owned state (tasks, notes).
`raised` surface, hairline, shadow, radius 20, one action in `accent`. Swipe it
down or sideways (flicks count) to dismiss. Pass `bottom` when a bottom bar or
the iOS 26 bottom search bar is present so it sits above them.

### Empty states

`<Empty title detail action />` is the screen-level state: centred 34 pt icon,
`headline`, one `subhead` line, at most one tinted button, placed at 38 % of the
free height. `variant="inline"` is one `footnote muted` line for an empty group.
Filtered empty: “No notes match “quarterly”.” + a plain “Clear search”.

### ChromeBar (`ChromeBar.tsx`)

For custom floating chrome (the thread screen). Wrap the screen in
`ChromeProvider`; render `<ChromeBar edge="top" scrollY={…}>` and
`<ChromeBar edge="bottom">`; read `useChromeInsets()` for the list's content
insets. The bar pads the safe area, measures itself and publishes its height.
iOS: system chrome blur + `chrome` tint (opaque with Reduce Transparency); the
top material fades in over the first 8 pt of scroll. Android: opaque
`background`. On both, the material runs `EDGE_FADE` (20 pt) past the bar's
inner edge and dissolves into the content (a masked progressive edge on iOS, a
gradient on Android): no hairline, no hard-edged slab. Anything stacked on a bar
(status strip, held messages, capsules) sits on that material without a box of
its own. Interactive chrome always sits on the bar; when a bar grows, shift the list
by the delta in one frame instead of animating it. `useWindowControlsInset()`
keeps custom headers clear of the iPadOS window controls (78 pt when windowed);
ChromeBar top bars apply it automatically. Native stack headers handle it
themselves.

### Status (`src/state/status.ts`, `StatusGlyph`)

`runtimeStatus`, `delegationStatus`, `threadStatus`, `childStatus`, `taskStatus`
return `{ phase, word, tone, active }`. Words are sentence case (“Running”,
“Needs approval”, “Finished”). Draw the phase with
`<StatusGlyph phase={…} animated={info.active} />` (task statuses keep
`status={…}`): queued dashed ring, idle ring, working half pie, waiting
three-quarter pie, done check, failed “!”, stopped cross.

### Filters (`Segmented.tsx`)

`<Segmented compact options value onChange label />` for list scopes (All /
Working / Pinned / Archived): a capsule track with a raised thumb that slides.
Non-compact for short settings choices. Never a black pill or loose text tabs.

### Copy helpers

`plural(n, { one, other })` and `count(n, "helper")` in `src/state/format.ts`:
“1 helper”, “2 need you”. Build strings whole. Sentence case, verb-first
buttons, errors say what to do next.

### Haptics (`haptics.ts`)

| Moment | Call |
|---|---|
| A value commits (status, priority, criteria, segmented) | `haptics.select()` |
| Swipe threshold crossed, sheet detent catches | `haptics.threshold()` |
| Delete / archive commits | `haptics.commit()` |
| Task started, follow-up sent | `haptics.success()` |
| Android long-press menu opens | `haptics.menu()` (no-op on iOS) |
| Chip/scope switch, scroll, entrances | none |

Haptics are never the only feedback.

## Motion (`src/components/liquid/motion.ts`)

One vocabulary from liquid-gooey: **liquid** (mass leads via `MASS`, size
follows via `SIZE`, corners on `CORNER`), **weight** (sheets `SHEET`, panes
`PANE`; nothing appears from scale 0), **momentum** (`withMomentum(config,
velocity)` on release), **recoil** (`RECOIL`, dampingRatio 0.8, only when a
finger or mass carried energy), **inertia** (`project(position, velocity)`
decides where a flick lands), **gooey** (`gooeyLag` / `TRAIL`: an outline lags
its content; content never scales).

- Fingers → springs carrying velocity. No finger → `EASE_OUT` (`CSS_EASE_OUT`
  for Reanimated CSS transitions), `EASE_IN_OUT` for in-place morphs.
  Durations in `DURATION`; nothing without a finger runs past 300 ms.
- Animate transform and opacity. Width/height only on absolute, childless
  layers (the segmented thumb).
- Reduce Motion: every spring carries `ReduceMotion.System`; travel becomes a
  `FADE` cross-fade. Native iOS components keep their system motion.
- No motion on tab/scope switches, scrolling or typing. No `entering` on list
  rows.

## Don't

- Use `Alert.alert` as a menu, or add a Cancel row to a menu.
- Fill a button with `ink`, white or red; use more than one `prominent` per screen.
- Write a `fontSize`, `borderRadius`, hex color or `"Menlo"` in a screen.
- Letter-space an input.
- Hand-roll a row, section header, toast, sheet or segmented control.
- Center a row's content with `justifyContent: "center"`.
- Put `display: "contents"` on a native wrapper around interactive rows (it
  hides them from VoiceOver).
- Use stock Android dialogs, menus or ripples; translucent menus on Android.
- Animate `BlurView` intensity, `elevation`, or a layout property of a view with children.
