//! Optional Markdown layout/paint controls. Defaults retain upstream rendering.
use serde::Deserialize;
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MarkdownStyle {
    pub link: LinkStyle,
    pub table_border_width: Option<f32>,
    pub table_header_rule_width: Option<f32>,
    pub table_padding_x: Option<f32>,
    pub table_padding_y: Option<f32>,
    pub table_header_weight: Option<f32>,
    pub quote_border_width: Option<f32>,
    pub quote_padding_left: Option<f32>,
    pub quote_padding_right: Option<f32>,
    pub quote_padding_y: Option<f32>,
    pub quote_gap: Option<f32>,
    pub list_indent: Option<f32>,
    pub list_marker_gap: Option<f32>,
    pub list_child_gap: Option<f32>,
    pub list_item_gap: Option<f32>,
    pub list_marker_size: Option<f32>,
    pub inline_code_padding_x: Option<f32>,
    pub inline_code_padding_y: Option<f32>,
    pub inline_code_size_ratio: Option<f32>,
    pub heading_sizes: Option<Vec<f32>>,
    pub heading_line_heights: Option<Vec<f32>>,
    pub heading_weights: Option<Vec<f32>>,
    pub heading_margin_tops: Option<Vec<f32>>,
    pub heading_following_gap: Option<f32>,
    pub heading_margin_top: Option<f32>,
    pub heading_margin_bottom: Option<f32>,
    pub table_border: Option<String>,
    pub table_header_background: Option<String>,
    pub quote_border: Option<String>,
    pub quote_background: Option<String>,
    pub quote_text: Option<String>,
    pub list_marker: Option<String>,
    pub code_background: Option<String>,
    pub code_border: Option<String>,
    pub code_border_width: Option<f32>,
    pub code_header_border_width: Option<f32>,
    pub code_header_line_height: Option<f32>,
    pub code_header_background: Option<String>,
    pub strong_weight: Option<f32>,
    pub nested_list_markers: bool,
    pub table_grid: bool,
    pub code_wrap: bool,
    pub code_header: Option<bool>,
}
pub fn number(value: Option<f32>, fallback: f32) -> f32 {
    value.filter(|n| n.is_finite() && *n >= 0.0).unwrap_or(fallback)
}
pub fn color(value: &Option<String>, fallback: gpui::Hsla) -> gpui::Hsla {
    value.as_deref().and_then(crate::color::parse_color_rgba).map(Into::into).unwrap_or(fallback)
}

pub fn tier(values: &Option<Vec<f32>>, level: u8) -> Option<f32> {
    values.as_ref().and_then(|v| v.get(level.saturating_sub(1) as usize)).copied()
}
pub fn heading(theme: &crate::theme::Theme, level: u8) -> (f32, f32) {
    let (size, line) = theme.metrics.heading(level);
    (number(tier(&theme.markdown.heading_sizes, level), size), number(tier(&theme.markdown.heading_line_heights, level), line))
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LinkStyle {
    pub color: Option<String>,
    pub underline: Option<String>,
    pub weight: Option<f32>,
}
