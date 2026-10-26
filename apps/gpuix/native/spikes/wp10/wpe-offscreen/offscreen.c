// WP10 spike (Linux): render a page with WPE WebKit into CPU pixels, with no window, no GTK and no compositor, on a
// transparent background, and drive it with a synthesized click. This is the path GPUI would composite as a
// `PaintSurface` texture (`gpui_wgpu` `draw_surfaces`). See apps/gpuix/WEBVIEW-PLATFORMS.md "Linux".
//
// Checks, printed as `CHECK <name> ok|FAIL <detail>`:
//   frame        a buffer arrives through WPEView::buffer-rendered and imports to pixels
//   transparent  a pixel outside the page's box has alpha 0 (webkit_web_view_set_background_color with alpha 0)
//   translucent  a pixel inside the 50% box has alpha ≈ 128 (premultiplied)
//   input        a pointer press/release injected with wpe_view_event changes the page (title "clicked")
//   timing       ms from load to first frame and per-frame import cost
// Writes frame.pam (RGBA, viewable with ImageMagick) next to the binary.
#include <wpe/webkit.h>
#include <wpe/wpe-platform.h>
#include <wpe/headless/wpe-headless.h>
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *PAGE =
    "<!doctype html><style>html,body{margin:0;background:transparent}"
    "#box{position:absolute;left:40px;top:40px;width:200px;height:120px;border-radius:24px;background:rgba(255,0,0,.5)}</style>"
    "<div id=box></div><script>addEventListener('click',()=>{document.title='clicked';box.style.background='rgba(0,0,255,.5)'})</script>";

static GMainLoop *loop;
static WPEView *wpe_view;
static WebKitWebView *web;
static gint64 loaded_at, first_frame_at;
static int frames, clicked;
static double import_ms;

static void check(const char *name, gboolean ok, const char *detail) { printf("CHECK %s %s %s\n", name, ok ? "ok" : "FAIL", detail ? detail : ""); }

static void write_pam(const guint8 *px, int w, int h, int stride) {
  FILE *f = fopen("frame.pam", "wb");
  if (!f) return;
  fprintf(f, "P7\nWIDTH %d\nHEIGHT %d\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n", w, h);
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) {
      const guint8 *p = px + y * stride + x * 4; // ARGB8888 little endian = B,G,R,A in memory
      guint8 rgba[4] = {p[2], p[1], p[0], p[3]};
      fwrite(rgba, 1, 4, f);
    }
  fclose(f);
}

static void inject_click(void) {
  // Pointer coordinates are logical (view) pixels, inside #box.
  WPEEvent *down = wpe_event_pointer_button_new(WPE_EVENT_POINTER_DOWN, wpe_view, WPE_INPUT_SOURCE_MOUSE, 0, 0, 1, 100, 100, 1);
  WPEEvent *up = wpe_event_pointer_button_new(WPE_EVENT_POINTER_UP, wpe_view, WPE_INPUT_SOURCE_MOUSE, 0, 0, 1, 100, 100, 0);
  wpe_view_event(wpe_view, down);
  wpe_view_event(wpe_view, up);
  wpe_event_unref(down);
  wpe_event_unref(up);
}

static GBytes *last_bytes;
static int last_w, last_h, last_stride;

static void on_buffer(WPEView *view, WPEBuffer *buffer, gpointer data) {
  (void)view; (void)data;
  gint64 start = g_get_monotonic_time();
  GError *error = NULL;
  GBytes *bytes = wpe_buffer_import_to_pixels(buffer, &error);
  import_ms += (g_get_monotonic_time() - start) / 1000.0;
  if (!bytes) { check("frame", FALSE, error ? error->message : "import_to_pixels returned NULL"); g_main_loop_quit(loop); return; }
  int w = wpe_buffer_get_width(buffer), h = wpe_buffer_get_height(buffer);
  gsize size = 0;
  g_bytes_get_data(bytes, &size);
  int stride = h ? (int)(size / h) : 0;
  if (++frames == 1) {
    first_frame_at = g_get_monotonic_time();
    char detail[128];
    snprintf(detail, sizeof detail, "%dx%d stride %d bytes %zu %s", w, h, stride, size, G_OBJECT_TYPE_NAME(buffer));
    check("frame", w > 0 && h > 0 && size >= (gsize)(w * h * 4), detail);
  }
  // Keep the latest frame: a static page renders once or twice and then stops, so judging waits for a timer.
  if (last_bytes) g_bytes_unref(last_bytes);
  last_bytes = g_bytes_ref(bytes);
  last_w = w; last_h = h; last_stride = stride;
}

// The web process runs under bubblewrap when it sits in its own PID namespace (`NSpid:` lists two ids).
static void check_sandbox(void) {
  DIR *proc = opendir("/proc");
  struct dirent *entry;
  int found = 0, sandboxed = 0;
  char path[300], line[256], nspid[128] = "";
  while (proc && (entry = readdir(proc))) {
    snprintf(path, sizeof path, "/proc/%s/comm", entry->d_name);
    FILE *f = fopen(path, "r");
    if (!f) continue;
    gboolean web = fgets(line, sizeof line, f) && !strncmp(line, "WPEWebProcess", 13);
    fclose(f);
    if (!web) continue;
    found++;
    snprintf(path, sizeof path, "/proc/%s/status", entry->d_name);
    if (!(f = fopen(path, "r"))) continue;
    while (fgets(line, sizeof line, f))
      if (!strncmp(line, "NSpid:", 6)) {
        int ids = 0;
        for (char *t = strtok(line + 6, " \t\n"); t; t = strtok(NULL, " \t\n")) ids++;
        if (ids > 1) sandboxed++;
        snprintf(nspid, sizeof nspid, "%d pid namespace level(s)", ids);
      }
    fclose(f);
  }
  if (proc) closedir(proc);
  char detail[200];
  snprintf(detail, sizeof detail, "%d web process(es), %d in their own PID namespace; %s%s", found, sandboxed, nspid,
           getenv("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS") ? " (sandbox disabled by env)" : "");
  check("sandbox", found > 0 && sandboxed == found, detail);
}

static gboolean judge(gpointer data) {
  // A cold first start (font caches, the web process) can take longer than the timer: wait for a frame, up to 15 s.
  static int waited;
  if (!last_bytes && ++waited < 30) return G_SOURCE_CONTINUE;
  check_sandbox();
  (void)data;
  if (!last_bytes) { check("transparent", FALSE, "no frame"); g_main_loop_quit(loop); return G_SOURCE_REMOVE; }
  const guint8 *px = g_bytes_get_data(last_bytes, NULL);
  const guint8 *outside = px + 10 * last_stride + 10 * 4, *inside = px + 100 * last_stride + 100 * 4;
  char detail[128];
  snprintf(detail, sizeof detail, "alpha %u at (10,10)", outside[3]);
  check("transparent", outside[3] == 0, detail);
  snprintf(detail, sizeof detail, "BGRA %u,%u,%u,%u at (100,100)", inside[0], inside[1], inside[2], inside[3]);
  check("translucent", inside[3] > 100 && inside[3] < 160, detail);
  write_pam(px, last_w, last_h, last_stride);
  clicked = 1;
  inject_click();
  g_timeout_add(3000, (GSourceFunc)g_main_loop_quit, loop);
  return G_SOURCE_REMOVE;
}

static void on_title(WebKitWebView *view, GParamSpec *spec, gpointer data) {
  (void)spec; (void)data;
  const char *title = webkit_web_view_get_title(view);
  if (title && !strcmp(title, "clicked")) {
    check("input", TRUE, "title changed after injected click");
    char detail[160];
    snprintf(detail, sizeof detail, "first frame %.1f ms after load; %d frames; import %.2f ms/frame",
             (first_frame_at - loaded_at) / 1000.0, frames, frames ? import_ms / frames : 0);
    check("timing", TRUE, detail);
    g_main_loop_quit(loop);
  }
}

int main(void) {
  loop = g_main_loop_new(NULL, FALSE);
  WPEDisplay *display = wpe_display_headless_new();
  GError *error = NULL;
  if (!wpe_display_connect(display, &error)) { check("frame", FALSE, error ? error->message : "display connect failed"); return 1; }
  web = WEBKIT_WEB_VIEW(g_object_new(WEBKIT_TYPE_WEB_VIEW, "display", display, NULL));
  WebKitColor clear = {0, 0, 0, 0};
  webkit_web_view_set_background_color(web, &clear);
  wpe_view = webkit_web_view_get_wpe_view(web);
  g_signal_connect(wpe_view, "buffer-rendered", G_CALLBACK(on_buffer), NULL);
  g_signal_connect(web, "notify::title", G_CALLBACK(on_title), NULL);
  wpe_view_resized(wpe_view, 320, 200);
  wpe_view_focus_in(wpe_view);
  loaded_at = g_get_monotonic_time();
  webkit_web_view_load_html(web, PAGE, "about:blank");
  g_timeout_add(500, judge, NULL);
  g_timeout_add(25000, (GSourceFunc)g_main_loop_quit, loop);
  g_main_loop_run(loop);
  if (!clicked) check("input", FALSE, frames ? "never clicked" : "no frames");
  else if (strcmp(webkit_web_view_get_title(web) ?: "", "clicked")) check("input", FALSE, "title unchanged");
  return 0;
}
