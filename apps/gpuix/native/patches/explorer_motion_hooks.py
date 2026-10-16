# Additional native Explorer motion, applied after the existing motion hooks.
m='motion.rs'
edit('lib.rs','mod spring;','mod spring;\nmod physical_spring;')
edit(m,'    pub border_radius: Option<f64>,','    pub border_radius: Option<f64>,\n    pub rotate: Option<f64>,')
edit(m,'            border_radius: self.border_radius.or(fallback.border_radius),','            border_radius: self.border_radius.or(fallback.border_radius),\n            rotate: self.rotate.or(fallback.rotate),')
edit(m,'            border_radius: value(self.border_radius, target.border_radius, progress),','            border_radius: value(self.border_radius, target.border_radius, progress),\n            rotate: value(self.rotate, target.rotate, progress),')
edit(m,'        if let Some(value) = self.border_radius {','        style.rotate = self.rotate;\n        if let Some(value) = self.border_radius {')
edit(m,'        ("borderRadius", style.border_radius),','        ("borderRadius", style.border_radius),\n        ("rotate", style.rotate),')
edit('style.rs','pub struct StyleDesc {','pub struct StyleDesc {\n    /// Animated SVG rotation in degrees, about its centre.\n    pub rotate: Option<f64>,')
edit(m,'    kind: Option<String>,','    kind: Option<String>,\n    #[serde(default)]\n    stiffness: Option<f64>,\n    #[serde(default)]\n    damping: Option<f64>,\n    #[serde(default)]\n    mass: Option<f64>,')
edit(m,'            kind: None,','            kind: None,\n            stiffness: None, damping: None, mass: None,')
edit(m,'        let duration = seconds(self.transition.duration);','''        let physical = self.transition.physical();
        let duration = seconds(physical.map_or(self.transition.duration, |(k,c,m)| crate::physical_spring::physical_horizon(k,c,m)));
        let physical_time = now.saturating_duration_since(self.started).saturating_sub(delay).as_secs_f64();''')
edit(m,'            crate::spring::progress(raw.clamp(0.0, 1.0), self.transition.bounce)','''            if raw >= 1.0 { 1.0 } else if let Some((k,c,m)) = physical {
                crate::physical_spring::physical_response(physical_time,k,c,m)
            } else { crate::spring::progress(raw.clamp(0.0, 1.0), self.transition.bounce) }''')
for axis in ['x','y']:
    old=f'crate::spring::velocity_offset(raw, self.transition.bounce, self.transition.velocity_{axis}, self.transition.duration)'
    new=f'if let Some((k,c,m)) = physical {{ if raw>=1.0 {{0.0}} else {{crate::physical_spring::physical_velocity(physical_time,k,c,m,self.transition.velocity_{axis})}} }} else {{{old}}}'
    edit(m,old,'('+new+')')
edit(m,'    Ok(description)\n}', '''    for (name, value) in [("stiffness",description.transition.stiffness),("damping",description.transition.damping),("mass",description.transition.mass)] {
        if value.is_some_and(|v| !v.is_finite() || v <= 0.0 || v > 1_000_000.0) { return Err(format!("Spring {name} must be finite, positive and at most 1000000")); }
    }
    if let Some((k,c,m)) = description.transition.physical() {
        if crate::physical_spring::physical_horizon(k,c,m)>60.0 { return Err("Physical spring must settle within 60 seconds".into()); }
    }
    Ok(description)
}''')
pending[m]+='''
impl MotionTransition {
    fn physical(&self) -> Option<(f64,f64,f64)> {
        (self.kind.as_deref()==Some("spring") && (self.stiffness.is_some() || self.damping.is_some() || self.mass.is_some()))
            .then(||(self.stiffness.unwrap_or(100.),self.damping.unwrap_or(10.),self.mass.unwrap_or(1.)))
    }
}
'''
edit('custom_elements/img.rs','let degrees = ctx.props.get("rotate").and_then(serde_json::Value::as_f64).filter(|v| v.is_finite()).unwrap_or(0.0);','let degrees = ctx.style.and_then(|s|s.rotate).or_else(||ctx.props.get("rotate").and_then(serde_json::Value::as_f64)).filter(|v| v.is_finite()).unwrap_or(0.0);')
edit('renderer.rs','    pub fn zoom_window(&self) -> Result<()> {','''    pub fn get_motion_capabilities(&self) -> serde_json::Value {
        serde_json::json!({"rotate":true,"physicalSprings":true})
    }
    #[napi]
    pub fn zoom_window(&self) -> Result<()> {''')
