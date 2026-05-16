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
        println!("cargo:rerun-if-changed=assets/app-icon.svg");

        if let Err(err) = build_windows_icon(&ico_path) {
            println!("cargo:warning=failed to build Windows icon: {err}");
            return;
        }
        if let Err(err) = copy_packaging_icon(&ico_path) {
            println!("cargo:warning=failed to copy Windows packaging icon: {err}");
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
    use image::codecs::ico::{IcoEncoder, IcoFrame};
    use image::ExtendedColorType;
    use resvg::usvg::{Options, Tree};

    const ICON_SIZES: &[u32] = &[16, 20, 24, 32, 40, 48, 64, 128, 256];

    let svg = fs::read("assets/app-icon.svg")?;
    let opt = Options::default();
    let rtree = Tree::from_data(&svg, &opt)?;
    let svg_size = rtree.size();
    let mut images = Vec::new();

    for size in ICON_SIZES {
        let mut pixmap =
            tiny_skia::Pixmap::new(*size, *size).ok_or("failed to create icon pixmap")?;
        let transform = tiny_skia::Transform::from_scale(
            *size as f32 / svg_size.width(),
            *size as f32 / svg_size.height(),
        );
        resvg::render(&rtree, transform, &mut pixmap.as_mut());
        images.push(pixmap.take());
    }

    let frames = images
        .iter()
        .zip(ICON_SIZES)
        .map(|(rgba, size)| IcoFrame::as_png(rgba, *size, *size, ExtendedColorType::Rgba8))
        .collect::<Result<Vec<_>, _>>()?;

    let file = fs::File::create(ico_path)?;
    IcoEncoder::new(file).encode_images(&frames)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn copy_packaging_icon(ico_path: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?);
    let profile = env::var("PROFILE")?;
    let target_dir = manifest_dir.join("target").join(profile);
    fs::create_dir_all(&target_dir)?;
    fs::copy(ico_path, target_dir.join("txt-reader.ico"))?;
    Ok(())
}
