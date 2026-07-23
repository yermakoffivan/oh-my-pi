//! Stable N-API desktop surface for portable Linux builds without native GUI
//! linkage.
//!
//! The normal addon remains portable and does not acquire xcap/enigo GUI
//! `DT_NEEDED` entries. glibc builds can opt into the real backend with the
//! `native-desktop-linux` Cargo feature; musl remains explicitly unsupported.

use std::sync::{
	Arc,
	atomic::{AtomicBool, Ordering},
};

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::task;

#[cfg(target_env = "musl")]
const UNSUPPORTED: &str = "DESKTOP_BACKEND_UNAVAILABLE: native desktop capture/input is \
                           unavailable in the Linux musl build because xcap 0.9.6 requires \
                           dynamically linked graphical-session libraries; use a Linux glibc \
                           native-desktop build";

#[cfg(not(target_env = "musl"))]
const UNSUPPORTED: &str = "DESKTOP_BACKEND_UNAVAILABLE: native desktop capture/input is not \
                           linked into this portable Linux addon; rebuild pi-natives with the \
                           native-desktop-linux Cargo feature";

#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct DesktopSessionOptions {
	pub backend:    Option<String>,
	pub display:    Option<String>,
	pub max_width:  Option<u32>,
	pub max_height: Option<u32>,
}

#[napi(object)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DesktopPoint {
	pub x: i32,
	pub y: i32,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct DesktopAction {
	#[napi(js_name = "type")]
	pub action_type: String,
	pub x:           Option<i32>,
	pub y:           Option<i32>,
	pub button:      Option<String>,
	pub path:        Option<Vec<DesktopPoint>>,
	pub keys:        Option<Vec<String>>,
	#[napi(js_name = "scroll_x")]
	pub scroll_x:    Option<i32>,
	#[napi(js_name = "scroll_y")]
	pub scroll_y:    Option<i32>,
	pub text:        Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug, PartialEq)]
pub struct DesktopDisplay {
	pub id:           String,
	pub name:         String,
	pub x:            i32,
	pub y:            i32,
	pub width:        u32,
	pub height:       u32,
	pub scale:        f64,
	pub pixel_x:      u32,
	pub pixel_y:      u32,
	pub pixel_width:  u32,
	pub pixel_height: u32,
	pub is_primary:   bool,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct DesktopCapabilities {
	pub backend:            String,
	pub display_server:     Option<String>,
	pub capture:            bool,
	pub input:              bool,
	pub capture_permission: String,
	pub input_permission:   String,
	pub display_count:      u32,
}

#[napi(object)]
pub struct DesktopCapture {
	pub data:               Uint8Array,
	pub width:              u32,
	pub height:             u32,
	pub displays:           Vec<DesktopDisplay>,
	pub backend:            String,
	pub display_server:     Option<String>,
	pub capture_permission: String,
	pub input_permission:   String,
}

fn invalid_action(message: impl Into<String>) -> Error {
	Error::from_reason(format!("DESKTOP_INVALID_ACTION: {}", message.into()))
}

fn validate_point(x: Option<i32>, y: Option<i32>, action: &str) -> Result<()> {
	let x = x.ok_or_else(|| invalid_action(format!("{action} action requires `x`")))?;
	let y = y.ok_or_else(|| invalid_action(format!("{action} action requires `y`")))?;
	if x < 0 || y < 0 {
		return Err(invalid_action(format!("{action} coordinates must be non-negative")));
	}
	Ok(())
}

fn validate_actions(actions: &[DesktopAction]) -> Result<()> {
	for action in actions {
		let extra = |present: bool, field: &str| {
			if present {
				Err(invalid_action(format!(
					"{} action contains unexpected `{field}`",
					action.action_type
				)))
			} else {
				Ok(())
			}
		};
		match action.action_type.as_str() {
			"click" => {
				validate_point(action.x, action.y, "click")?;
				extra(
					action.path.is_some()
						|| action.scroll_x.is_some()
						|| action.scroll_y.is_some()
						|| action.text.is_some(),
					"field",
				)?;
				match action.button.as_deref() {
					Some("left" | "right" | "wheel" | "back" | "forward") => {},
					Some(button) => {
						return Err(invalid_action(format!("unsupported mouse button `{button}`")));
					},
					None => return Err(invalid_action("click action requires `button`")),
				}
			},
			"double_click" | "move" => {
				validate_point(action.x, action.y, &action.action_type)?;
				extra(
					action.button.is_some()
						|| action.path.is_some()
						|| action.scroll_x.is_some()
						|| action.scroll_y.is_some()
						|| action.text.is_some(),
					"field",
				)?;
			},
			"drag" => {
				extra(
					action.x.is_some()
						|| action.y.is_some()
						|| action.button.is_some()
						|| action.scroll_x.is_some()
						|| action.scroll_y.is_some()
						|| action.text.is_some(),
					"field",
				)?;
				let path = action
					.path
					.as_ref()
					.ok_or_else(|| invalid_action("drag action requires `path`"))?;
				if path.len() < 2 || path.iter().any(|point| point.x < 0 || point.y < 0) {
					return Err(invalid_action(
						"drag action requires at least two non-negative path points",
					));
				}
			},
			"keypress" => {
				extra(
					action.x.is_some()
						|| action.y.is_some()
						|| action.button.is_some()
						|| action.path.is_some()
						|| action.scroll_x.is_some()
						|| action.scroll_y.is_some()
						|| action.text.is_some(),
					"field",
				)?;
				if action
					.keys
					.as_ref()
					.is_none_or(|keys| keys.is_empty() || keys.iter().any(String::is_empty))
				{
					return Err(invalid_action("keypress action requires at least one non-empty key"));
				}
			},
			"screenshot" | "wait" => {
				extra(
					action.x.is_some()
						|| action.y.is_some()
						|| action.button.is_some()
						|| action.path.is_some()
						|| action.keys.is_some()
						|| action.scroll_x.is_some()
						|| action.scroll_y.is_some()
						|| action.text.is_some(),
					"field",
				)?;
			},
			"scroll" => {
				validate_point(action.x, action.y, "scroll")?;
				extra(
					action.button.is_some() || action.path.is_some() || action.text.is_some(),
					"field",
				)?;
				if action.scroll_x.is_none() || action.scroll_y.is_none() {
					return Err(invalid_action("scroll action requires `scroll_x` and `scroll_y`"));
				}
			},
			"type" => {
				extra(
					action.x.is_some()
						|| action.y.is_some()
						|| action.button.is_some()
						|| action.path.is_some()
						|| action.keys.is_some()
						|| action.scroll_x.is_some()
						|| action.scroll_y.is_some(),
					"field",
				)?;
				if action.text.is_none() {
					return Err(invalid_action("type action requires `text`"));
				}
			},
			other => return Err(invalid_action(format!("unsupported desktop action type `{other}`"))),
		}
	}
	Ok(())
}

#[napi]
pub struct DesktopSession {
	closed: Arc<AtomicBool>,
}

#[napi]
impl DesktopSession {
	#[napi(constructor)]
	pub fn new(options: Option<DesktopSessionOptions>) -> Result<Self> {
		let options = options.unwrap_or_default();
		match options.backend.as_deref().unwrap_or("auto") {
			"auto" | "native" => {},
			other => {
				return Err(Error::from_reason(format!(
					"DESKTOP_INVALID_OPTIONS: unsupported backend `{other}`; expected `auto` or \
					 `native`"
				)));
			},
		}
		if options.max_width == Some(0) || options.max_height == Some(0) {
			return Err(Error::from_reason(
				"DESKTOP_INVALID_OPTIONS: maxWidth and maxHeight must be greater than zero",
			));
		}
		if let Some(display) = options.display
			&& display != "all"
			&& display.parse::<u32>().is_err()
		{
			return Err(Error::from_reason(format!(
				"DESKTOP_INVALID_OPTIONS: display must be `all` or a numeric monitor id, got \
				 `{display}`"
			)));
		}
		Ok(Self { closed: Arc::new(AtomicBool::new(false)) })
	}

	#[napi(getter)]
	pub fn capabilities(&self) -> DesktopCapabilities {
		DesktopCapabilities {
			backend:            "unavailable".to_string(),
			display_server:     None,
			capture:            false,
			input:              false,
			capture_permission: "unavailable".to_string(),
			input_permission:   "unavailable".to_string(),
			display_count:      0,
		}
	}

	#[napi]
	pub fn capture(&self) -> task::Promise<DesktopCapture> {
		let closed = Arc::clone(&self.closed);
		task::blocking("desktop.capture.unsupported", (), move |_| {
			if closed.load(Ordering::Acquire) {
				Err(Error::from_reason("DESKTOP_SESSION_CLOSED: desktop session is closed"))
			} else {
				Err(Error::from_reason(UNSUPPORTED))
			}
		})
	}

	#[napi]
	pub fn execute(&self, actions: Vec<DesktopAction>) -> Result<task::Promise<DesktopCapture>> {
		validate_actions(&actions)?;
		let closed = Arc::clone(&self.closed);
		Ok(task::blocking("desktop.execute.unsupported", (), move |_| {
			if closed.load(Ordering::Acquire) {
				Err(Error::from_reason("DESKTOP_SESSION_CLOSED: desktop session is closed"))
			} else {
				Err(Error::from_reason(UNSUPPORTED))
			}
		}))
	}

	#[napi]
	pub fn close(&self) -> task::Promise<()> {
		let closed = Arc::clone(&self.closed);
		task::blocking("desktop.close.unsupported", (), move |_| {
			closed.store(true, Ordering::Release);
			Ok(())
		})
	}
}
