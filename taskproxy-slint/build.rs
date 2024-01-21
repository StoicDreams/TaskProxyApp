use slint_build::CompilerConfiguration;

fn main() {
    slint_build::compile_with_config(
        "ui/appwindow.slint",
        CompilerConfiguration::new().with_style("native".to_string()),
    )
    .unwrap();
}
