# Runtime window background, the system title-bar double-click action, the save
# panel and image copy (window_platform.rs). Executed by apply_hooks.py with its
# `edit` helper; every anchor must match exactly once.
edit("lib.rs", "mod window_drag;\n", "mod window_drag;\nmod window_platform;\n")
edit("renderer.rs", "    pub fn zoom_window(&self) -> Result<()> {", '''    pub fn set_window_background(&self, mode: String) -> Result<()> {
        let appearance = crate::window_platform::background(&mode)?;
        #[cfg(target_os = "macos")]
        return update_window_without_view(move |window, _cx| window.set_background_appearance(appearance));
        #[cfg(not(target_os = "macos"))]
        { let _ = appearance; Err(Error::from_reason("Runtime window backgrounds are currently macOS-only")) }
    }

    /// The system title-bar double-click action (zoom, minimize or nothing, per System Settings).
    #[napi]
    pub fn titlebar_double_click(&self) -> Result<()> {
        #[cfg(target_os = "macos")]
        return update_window_without_view(|window, _cx| window.titlebar_double_click());
        #[cfg(not(target_os = "macos"))]
        Err(Error::from_reason("Title-bar actions are currently macOS-only"))
    }

    /// Put an image on the system pasteboard (`mediaType` such as `image/png`).
    #[napi]
    pub fn write_clipboard_image(&self, data: Buffer, media_type: String) -> Result<()> {
        let item = crate::window_platform::clipboard_image(&data, &media_type)?;
        update_window_without_view(move |_window, cx| cx.write_to_clipboard(item))
    }

    /// Open the platform save panel in `directory`. Resolves to `[path]`, or null when cancelled.
    #[napi(ts_return_type = "Promise<Array<string> | null>")]
    pub fn prompt_for_new_path<'env>(&self, env: &'env Env, directory: String, suggested_name: Option<String>) -> Result<Object<'env>> {
        let (deferred, promise): (PathPromptDeferred, Object<'env>) = env.create_deferred()?;
        #[cfg(target_os = "macos")]
        {
            let prompt = GPUI_APP.with(|app| {
                let app = app.borrow();
                let app = app.as_ref().ok_or_else(|| Error::from_reason("GPUI application is not initialized"))?;
                Ok(app.update(|cx| (cx.background_executor().clone(), cx.prompt_for_new_path(std::path::Path::new(&directory), suggested_name.as_deref()))))
            });
            match prompt {
                Ok((executor, receiver)) => executor
                    .spawn(async move {
                        let result = receiver
                            .await
                            .map_err(|_| Error::from_reason("The save panel closed without a result"))
                            .and_then(|result| path_prompt_result(result.map(|path| path.map(|path| vec![path]))));
                        match result {
                            Ok(paths) => deferred.resolve(Box::new(move |_env| Ok(paths))),
                            Err(error) => deferred.reject(error),
                        }
                    })
                    .detach(),
                Err(error) => deferred.reject(error),
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (directory, suggested_name);
            deferred.reject(Error::from_reason("The save panel is currently macOS-only"));
        }
        Ok(promise)
    }

    #[napi]
    pub fn zoom_window(&self) -> Result<()> {''')

# Title-bar drag regions skip presses on controls, like Tauri's `deep` drag
# regions (window_drag.rs `is_control`): presses on clickable, interactive-role
# or focusable children that are not drag regions themselves.
edit("renderer.rs", "        el = crate::window_drag::apply(el);\n    }\n\n    // Wire up events.\n", "        el = crate::window_drag::apply(el);\n    } else if crate::window_drag::is_control(element.events(), element.custom_props()) {\n        el = crate::window_drag::control(el);\n    }\n\n    // Wire up events.\n")

# A transparent title bar is drawn by the app, which moves the window itself
# (window_drag.rs): AppKit must not also drag from its 28pt titlebar band, or
# presses on title-bar controls move the window there.
edit("renderer.rs", "            appears_transparent: titlebar_transparent,\n            traffic_light_position,\n        }),\n", "            appears_transparent: titlebar_transparent,\n            traffic_light_position,\n        }),\n        app_owns_titlebar_drag: titlebar_transparent,\n")
