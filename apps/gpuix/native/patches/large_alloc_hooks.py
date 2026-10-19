# Register the addon allocator; preserve every existing reconstruction hook.
pending['lib.rs'] += '\nmod large_alloc;\n'
pending['large_alloc.rs'] = (Path(__file__).parent / 'large_alloc.rs').read_text() + '''
pub(crate) fn memory_stats() -> serde_json::Value {
    let value = snapshot();
    serde_json::json!({"enabled":value.enabled,"thresholdBytes":value.threshold_bytes,
        "currentBytes":value.current_bytes,"peakBytes":value.peak_bytes,
        "mapCalls":value.map_calls,"unmapCalls":value.unmap_calls,
        "mapFailures":value.map_failures,"unmapFailures":value.unmap_failures})
}
'''
edit('renderer.rs', '"editorImages":crate::rich_editor::image_memory_stats(),',
     '"editorImages":crate::rich_editor::image_memory_stats(),\n            "largeAllocations":crate::large_alloc::memory_stats(),')
