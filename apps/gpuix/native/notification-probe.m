#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <UserNotifications/UserNotifications.h>
int probe(bool legacy) {
 @autoreleasepool {
  printf("bundle=%s\n", NSBundle.mainBundle.bundleIdentifier.UTF8String ?: "(none)");
  @try {
   if (legacy) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    NSUserNotificationCenter *center = NSUserNotificationCenter.defaultUserNotificationCenter;
    printf("legacy center=%s\n", center ? "available" : "nil");
#pragma clang diagnostic pop
   } else {
    UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
    printf("modern center=%s\n", center ? "available" : "nil");
   }
  } @catch (NSException *exception) {
   fprintf(stderr, "%s: %s\n", exception.name.UTF8String, exception.reason.UTF8String);
   return 2;
  }
 }
 return 0;
}

int main(int argc, const char **argv) { return probe(argc > 1 && strcmp(argv[1], "legacy") == 0); }
