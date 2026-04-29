#![cfg(target_os = "windows")]

use std::sync::{OnceLock, mpsc};

use anyhow::{Context, Result};
use tray_icon::{
    Icon, TrayIconBuilder, TrayIconEvent,
    menu::{Menu, MenuEvent, MenuItem},
};
use winit::{
    application::ApplicationHandler,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy},
    window::{Window, WindowAttributes, WindowId},
};

pub enum AppEvent {
    ShowWindow,
    Exit,
    ServerFailed(String),
}

static EXIT_MENU_ID: OnceLock<tray_icon::menu::MenuId> = OnceLock::new();

pub fn run(server_failures: mpsc::Receiver<String>) -> Result<()> {
    let event_loop = EventLoop::<AppEvent>::with_user_event().build()?;
    let proxy = event_loop.create_proxy();
    forward_server_failures(server_failures, proxy.clone());
    let mut tray = TrayApp::new(proxy)?;
    event_loop.run_app(&mut tray)?;
    if let Some(error) = tray.server_error {
        anyhow::bail!(error);
    }
    Ok(())
}

struct TrayApp {
    window: Option<Window>,
    window_id: Option<WindowId>,
    _tray_icon: Option<tray_icon::TrayIcon>,
    server_error: Option<String>,
}

impl TrayApp {
    fn new(proxy: EventLoopProxy<AppEvent>) -> Result<Self> {
        let (menu, exit_item) = build_menu()?;
        let exit_menu_id = exit_item.id().clone();
        let _ = EXIT_MENU_ID.set(exit_menu_id);
        install_tray_event_forwarders(proxy.clone());
        let tray_icon = TrayIconBuilder::new()
            .with_tooltip("TXT Reader")
            .with_menu(Box::new(menu))
            .with_icon(build_icon()?)
            .build()
            .context("failed to build tray icon")?;

        Ok(Self {
            window: None,
            window_id: None,
            _tray_icon: Some(tray_icon),
            server_error: None,
        })
    }
}

impl ApplicationHandler<AppEvent> for TrayApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }

        let attrs = WindowAttributes::default()
            .with_title("TXT Reader")
            .with_visible(false)
            .with_resizable(false)
            .with_decorations(true)
            .with_inner_size(winit::dpi::LogicalSize::new(360.0, 180.0));
        let window = event_loop.create_window(attrs).expect("create window");
        self.window_id = Some(window.id());
        self.window = Some(window);
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: AppEvent) {
        match event {
            AppEvent::ShowWindow => {
                if let Some(window) = self.window.as_ref() {
                    window.set_visible(true);
                    window.focus_window();
                }
            }
            AppEvent::Exit => event_loop.exit(),
            AppEvent::ServerFailed(error) => {
                self.server_error = Some(error);
                event_loop.exit();
            }
        }
    }

    fn window_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) {
        if Some(window_id) != self.window_id {
            return;
        }

        match event {
            WindowEvent::CloseRequested => {
                if let Some(window) = self.window.as_ref() {
                    window.set_visible(false);
                }
            }
            WindowEvent::Destroyed => {
                self.window = None;
                self.window_id = None;
            }
            _ => {}
        }
    }
}

fn build_menu() -> Result<(Menu, MenuItem)> {
    let menu = Menu::new();
    let exit_item = MenuItem::new("Exit", true, None);
    menu.append(&exit_item)?;
    Ok((menu, exit_item))
}

fn build_icon() -> Result<Icon> {
    let svg = r##"
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#111827"/>
  <path d="M16 46L26 18H38L48 46H39.5L37.2 39.2H26.8L24.5 46Z" fill="#E5E7EB"/>
  <path d="M30.5 34H33.5L32 29.2Z" fill="#111827"/>
  <path d="M27 29.2L24.8 22.8H28.8L30.2 26.9L31.6 22.8H35.6L33.4 29.2Z" fill="#60A5FA"/>
</svg>
"##;

    let options = usvg::Options::default();
    let tree = usvg::Tree::from_str(svg, &options).context("failed to parse tray SVG")?;
    let size = tree.size().to_int_size();
    let mut pixmap = tiny_skia::Pixmap::new(size.width(), size.height())
        .context("failed to create tray pixmap")?;
    resvg::render(&tree, tiny_skia::Transform::default(), &mut pixmap.as_mut());
    Icon::from_rgba(pixmap.take(), size.width(), size.height()).context("failed to build tray icon")
}

fn install_tray_event_forwarders(proxy: EventLoopProxy<AppEvent>) {
    let tray_proxy = proxy.clone();
    TrayIconEvent::set_event_handler(Some(move |event| {
        if matches!(event, TrayIconEvent::DoubleClick { .. }) {
            let _ = tray_proxy.send_event(AppEvent::ShowWindow);
        }
    }));

    MenuEvent::set_event_handler(Some(move |event: tray_icon::menu::MenuEvent| {
        if EXIT_MENU_ID
            .get()
            .map(|id| id == &event.id)
            .unwrap_or(false)
        {
            let _ = proxy.send_event(AppEvent::Exit);
        }
    }));
}

fn forward_server_failures(failures: mpsc::Receiver<String>, proxy: EventLoopProxy<AppEvent>) {
    std::thread::spawn(move || {
        if let Ok(error) = failures.recv() {
            let _ = proxy.send_event(AppEvent::ServerFailed(error));
        }
    });
}
