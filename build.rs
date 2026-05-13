use std::{env, fs, path::PathBuf};

fn main() {
    println!(
        "cargo:rustc-env=TARGET={}",
        env::var("TARGET").unwrap_or_default()
    );

    #[cfg(target_os = "windows")]
    {
        let out_dir = match env::var("OUT_DIR") {
            Ok(path) => PathBuf::from(path),
            Err(err) => {
                println!("cargo:warning=OUT_DIR is not set: {err}");
                return;
            }
        };

        let ico_path = out_dir.join("txt-reader.ico");
        println!("cargo:rerun-if-changed=frontend/public/icon.svg");

        if let Err(err) = build_windows_icon(&ico_path) {
            println!("cargo:warning=failed to build Windows icon: {err}");
            return;
        }

        let mut res = winres::WindowsResource::new();
        if let Some(icon_path) = ico_path.to_str() {
            res.set_icon(icon_path);
        }
        if let Err(err) = res.compile() {
            println!("cargo:warning=failed to compile Windows resource: {err}");
        }
    }
}

#[cfg(target_os = "windows")]
fn build_windows_icon(ico_path: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    use image::{ImageFormat, ImageReader};
    use resvg::usvg::{Options, Tree};

    let svg = fs::read("frontend/public/icon.svg")?;
    let opt = Options::default();
    let rtree = Tree::from_data(&svg, &opt)?;
    let mut pixmap = tiny_skia::Pixmap::new(256, 256).ok_or("failed to create pixmap")?;
    resvg::render(
        &rtree,
        tiny_skia::Transform::default(),
        &mut pixmap.as_mut(),
    );

    let png_path = ico_path.with_extension("png");
    pixmap.save_png(&png_path)?;
    let img = ImageReader::open(&png_path)?.decode()?;
    img.save_with_format(ico_path, ImageFormat::Ico)?;
    let _ = fs::remove_file(png_path);
    Ok(())
}
