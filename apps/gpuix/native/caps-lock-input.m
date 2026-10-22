// Test-only in-process AppKit key events for caps-lock-check.ts. No global event posting:
// the events go to one lab window's own sendEvent:, the way AppKit delivers a real key press,
// so GPUI parses them in its macOS key path (parse_keystroke, handle_key_event).
#import <Cocoa/Cocoa.h>

enum { CAPS = 1, SHIFT = 2, SLOW = 4 };

// US ANSI virtual key codes, which also name these keys' positions on other layouts.
static int key_code(char c) {
  static const char *letters = "asdfhgzxcv?bqweryt";
  const char *at = strchr(letters, c);
  if (at && c != '?') return (int)(at - letters);
  switch (c) {
    case 'o': return 31; case 'u': return 32; case 'i': return 34; case 'p': return 35;
    case 'l': return 37; case 'j': return 38; case 'k': return 40; case 'n': return 45;
    case 'm': return 46; case ' ': return 49; case '\b': return 51; case 0x1b: return 53;
  }
  return -1;
}

static NSWindow *lab_window(const char *title) {
  NSString *name = [NSString stringWithUTF8String:title];
  for (NSWindow *window in NSApp.windows) if ([window.title isEqual:name]) return window;
  return nil;
}

static void send_key(NSWindow *window, char c, uint32_t flags) {
  int code = key_code(c);
  if (code < 0) return;
  NSEventModifierFlags modifiers = ((flags & CAPS) ? NSEventModifierFlagCapsLock : 0) | ((flags & SHIFT) ? NSEventModifierFlagShift : 0);
  // What AppKit reports for the key: Caps Lock and Shift both make a letter uppercase.
  NSString *text = c == '\b' ? @"\x7f" : [NSString stringWithFormat:@"%c", c];
  if (c >= 'a' && c <= 'z' && (flags & (CAPS | SHIFT))) text = text.uppercaseString;
  for (NSNumber *type in @[@(NSEventTypeKeyDown), @(NSEventTypeKeyUp)]) {
    NSEvent *event = [NSEvent keyEventWithType:type.unsignedIntegerValue location:NSZeroPoint modifierFlags:modifiers
                                      timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil
                                     characters:text charactersIgnoringModifiers:text isARepeat:NO keyCode:(unsigned short)code];
    [window sendEvent:event];
  }
}

// Types `keys` into the focused element of the window titled `title`. Without SLOW every key is
// sent in one main-thread turn (a fast burst: JS answers none of them in between); with SLOW one
// key per 80 ms turn, so each intercepted key is answered before the next arrives.
void kybern_caps_type(const char *title, const char *keys, uint32_t flags) {
  NSString *name = [NSString stringWithUTF8String:title], *text = [NSString stringWithUTF8String:keys];
  if (!(flags & SLOW)) {
    dispatch_async(dispatch_get_main_queue(), ^{
      NSWindow *window = lab_window(name.UTF8String);
      for (NSUInteger i = 0; window && i < text.length; i++) send_key(window, (char)[text characterAtIndex:i], flags);
    });
    return;
  }
  for (NSUInteger i = 0; i < text.length; i++) {
    char c = (char)[text characterAtIndex:i];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(i * 80 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
      NSWindow *window = lab_window(name.UTF8String);
      if (window) send_key(window, c, flags);
    });
  }
}
