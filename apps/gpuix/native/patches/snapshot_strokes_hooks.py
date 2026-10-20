edit("renderer.rs", """                window.kybern_prepare_snapshot(cx);
                window.render_to_image()""", """                window.kybern_prepare_image_snapshot(cx);
                window.render_to_image()""")
(src / "renderer.rs").write_text(pending["renderer.rs"])
