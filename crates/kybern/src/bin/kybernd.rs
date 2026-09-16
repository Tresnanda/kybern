// kybernd rests with a large per-request projection high-water mark. jemalloc
// returns decayed pages to the OS via its background purge threads, so resting
// RSS tracks live data, not the biggest transcript ever folded. The CLI keeps
// the system allocator.
#[cfg(not(target_env = "msvc"))]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

// Purge freed pages on a background thread and decay dirty/muzzy runs after one
// second idle, so resting RSS follows live data instead of the fold high-water.
#[cfg(not(target_env = "msvc"))]
#[allow(non_upper_case_globals)]
#[unsafe(export_name = "_rjem_malloc_conf")]
pub static malloc_conf: &[u8] = b"background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:1000\0";

fn main() -> anyhow::Result<()> {
    kybern_daemon::run()
}
