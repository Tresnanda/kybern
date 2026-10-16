#include <metal_stdlib>
using namespace metal;
struct RegionVertex { float4 position [[position]]; };
vertex RegionVertex region_vertex(uint index [[vertex_id]]) {
    float2 p = index == 0 ? float2(-1,-1) : index == 1 ? float2(3,-1) : float2(-1,3);
    return {float4(p,0,1)};
}
fragment float4 region_clear(RegionVertex in [[stage_in]], constant float &alpha [[buffer(0)]]) {
    return float4(0,0,0,alpha);
}
fragment float4 region_copy(RegionVertex in [[stage_in]], texture2d<float, access::read> source [[texture(0)]]) {
    return source.read(uint2(in.position.xy));
}
