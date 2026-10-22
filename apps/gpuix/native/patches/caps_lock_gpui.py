# Caps Lock in the typed character. Executed at the end of backdrop_gpui.py.
#
# GPUI builds a macOS keystroke's `key_char` with UCKeyTranslate from the key code and only
# Shift and Option, so with Caps Lock on a letter's `key_char` is lowercase. AppKit's own text
# path (`insertText:` from `characters`) applies Caps Lock, so ordinary typing is right, but every
# path that inserts `key_char` is not: an `interceptKeys` key the app lets through and every key
# queued behind it while JS answers (`key_intercept::resolve` replays them with
# `dispatch_keystroke`), held-key repeat without press-and-hold, and `keyChar` in JS (terminal,
# type-to-select). Typing with Caps Lock in the composer came out as a mix of cases.
#
# The binding `key` stays the unmodified character, so shortcuts are unchanged; only the typed
# character gains alphaLock, which UCKeyTranslate maps per layout exactly as AppKit does.
e = 'crates/gpui_macos/src/events.rs'
edit(e, '''                    if alt {
                        mods |= OPTION_MOD;
                    }
''', '''                    if alt {
                        mods |= OPTION_MOD;
                    }
                    if modifiers.contains(NSEventModifierFlags::NSAlphaShiftKeyMask) {
                        mods |= ALPHA_LOCK_MOD;
                    }
''')
# `alphaLock` (0x0400) shifted >> 8 for UCKeyTranslate, like the other constants.
edit(e, 'const OPTION_MOD: u32 = 8;\n', 'const OPTION_MOD: u32 = 8;\nconst ALPHA_LOCK_MOD: u32 = 4;\n')
if (root / e).read_text() != pending[e]: (root / e).write_text(pending[e])
