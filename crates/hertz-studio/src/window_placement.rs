// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Native outer-frame geometry, independent of the window toolkit and store.

use serde::{Deserialize, Serialize};

pub const PLACEMENT_KEY: &str = "native_window_placement";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(try_from = "RectWire")]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RectWire {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl TryFrom<RectWire> for Rect {
    type Error = &'static str;

    fn try_from(value: RectWire) -> Result<Self, Self::Error> {
        Self::new(value.x, value.y, value.width, value.height)
    }
}

impl Rect {
    pub fn new(x: i32, y: i32, width: u32, height: u32) -> Result<Self, &'static str> {
        if width == 0
            || height == 0
            || width > i32::MAX as u32
            || height > i32::MAX as u32
            || i64::from(x) + i64::from(width) > i64::from(i32::MAX)
            || i64::from(y) + i64::from(height) > i64::from(i32::MAX)
        {
            return Err("invalid physical rectangle");
        }
        Ok(Self {
            x,
            y,
            width,
            height,
        })
    }

    pub fn overlap(self, other: Self) -> u64 {
        let width = (self.right().min(other.right()) - i64::from(self.x.max(other.x))).max(0);
        let height = (self.bottom().min(other.bottom()) - i64::from(self.y.max(other.y))).max(0);
        (width * height) as u64
    }

    pub fn right(self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }
    pub fn bottom(self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", try_from = "PlacementWire")]
pub struct WindowPlacement {
    pub schema_version: u32,
    pub normal_bounds: Rect,
    pub work_area: Rect,
    pub scale_factor: f64,
    pub maximized: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlacementWire {
    schema_version: u32,
    normal_bounds: Rect,
    work_area: Rect,
    scale_factor: f64,
    maximized: bool,
}

impl TryFrom<PlacementWire> for WindowPlacement {
    type Error = &'static str;

    fn try_from(value: PlacementWire) -> Result<Self, Self::Error> {
        if value.schema_version != 1 {
            return Err("unsupported window placement schema");
        }
        Self::new(
            value.normal_bounds,
            value.work_area,
            value.scale_factor,
            value.maximized,
        )
    }
}

impl WindowPlacement {
    pub fn new(
        normal_bounds: Rect,
        work_area: Rect,
        scale_factor: f64,
        maximized: bool,
    ) -> Result<Self, &'static str> {
        Rect::new(
            normal_bounds.x,
            normal_bounds.y,
            normal_bounds.width,
            normal_bounds.height,
        )?;
        Rect::new(work_area.x, work_area.y, work_area.width, work_area.height)?;
        if !scale_factor.is_finite() || scale_factor <= 0.0 {
            return Err("invalid scale factor");
        }
        Ok(Self {
            schema_version: 1,
            normal_bounds,
            work_area,
            scale_factor,
            maximized,
        })
    }

    pub fn validate(self) -> Result<Self, &'static str> {
        if self.schema_version != 1 {
            return Err("unsupported window placement schema");
        }
        Self::new(
            self.normal_bounds,
            self.work_area,
            self.scale_factor,
            self.maximized,
        )
    }

    /// Preserve logical offsets and dimensions, then fit the complete frame.
    /// Minimum inner dimensions are DIP; frame dimensions are target physical pixels.
    pub fn recover(
        self,
        monitors: &[Monitor],
        minimum_inner: (f64, f64),
        frame: (u32, u32),
    ) -> Option<Self> {
        self.validate().ok()?;
        let monitor = select_monitor(self.normal_bounds, monitors)?;
        let work = monitor.work_area;
        let ratio = monitor.scale_factor / self.scale_factor;
        let dimension = |saved: u32, minimum: f64, border: u32, available: u32| {
            let minimum = (minimum * monitor.scale_factor + f64::from(border)).ceil();
            (f64::from(saved) * ratio)
                .round()
                .max(minimum)
                .min(f64::from(available))
                .max(1.0) as u32
        };
        let width = dimension(
            self.normal_bounds.width,
            minimum_inner.0,
            frame.0,
            work.width,
        );
        let height = dimension(
            self.normal_bounds.height,
            minimum_inner.1,
            frame.1,
            work.height,
        );
        let position = |saved: i32, original: i32, target: i32, available: u32, size: u32| {
            (f64::from(target) + (f64::from(saved) - f64::from(original)) * ratio)
                .round()
                .max(f64::from(target))
                .min(f64::from(target) + f64::from(available - size)) as i32
        };
        let normal = Rect::new(
            position(
                self.normal_bounds.x,
                self.work_area.x,
                work.x,
                work.width,
                width,
            ),
            position(
                self.normal_bounds.y,
                self.work_area.y,
                work.y,
                work.height,
                height,
            ),
            width,
            height,
        )
        .ok()?;
        Self::new(normal, work, monitor.scale_factor, self.maximized).ok()
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Monitor {
    pub bounds: Rect,
    pub work_area: Rect,
    pub scale_factor: f64,
    pub primary: bool,
}

pub fn select_monitor(bounds: Rect, monitors: &[Monitor]) -> Option<&Monitor> {
    let valid = |monitor: &&Monitor| {
        monitor.scale_factor.is_finite()
            && monitor.scale_factor > 0.0
            && Rect::new(
                monitor.bounds.x,
                monitor.bounds.y,
                monitor.bounds.width,
                monitor.bounds.height,
            )
            .is_ok()
            && Rect::new(
                monitor.work_area.x,
                monitor.work_area.y,
                monitor.work_area.width,
                monitor.work_area.height,
            )
            .is_ok()
            && monitor.bounds.overlap(monitor.work_area)
                == u64::from(monitor.work_area.width) * u64::from(monitor.work_area.height)
    };
    let overlapping = monitors
        .iter()
        .filter(valid)
        .max_by_key(|monitor| (bounds.overlap(monitor.bounds), monitor.primary));
    if overlapping.is_some_and(|monitor| bounds.overlap(monitor.bounds) > 0) {
        overlapping
    } else {
        monitors
            .iter()
            .filter(valid)
            .find(|monitor| monitor.primary)
            .or_else(|| monitors.iter().find(valid))
    }
}

/// WINDOWPLACEMENT stores a normal frame relative to the monitor workspace.
pub fn workspace_to_screen(normal: Rect, monitor: Rect, work: Rect) -> Result<Rect, &'static str> {
    let x = i64::from(normal.x) + i64::from(work.x) - i64::from(monitor.x);
    let y = i64::from(normal.y) + i64::from(work.y) - i64::from(monitor.y);
    Rect::new(
        i32::try_from(x).map_err(|_| "invalid workspace offset")?,
        i32::try_from(y).map_err(|_| "invalid workspace offset")?,
        normal.width,
        normal.height,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect::new(x, y, width, height).unwrap()
    }
    fn monitor(bounds: Rect, work_area: Rect, scale_factor: f64, primary: bool) -> Monitor {
        Monitor {
            bounds,
            work_area,
            scale_factor,
            primary,
        }
    }

    #[test]
    fn negative_desktop_overlap_selects_largest_monitor_intersection() {
        let monitors = [
            monitor(rect(0, 0, 1920, 1080), rect(0, 0, 1920, 1040), 1.0, true),
            monitor(
                rect(-1600, -200, 1600, 1200),
                rect(-1600, -160, 1600, 1160),
                1.25,
                false,
            ),
        ];
        assert_eq!(
            select_monitor(rect(-600, 100, 900, 600), &monitors),
            Some(&monitors[1])
        );
        assert_eq!(
            select_monitor(rect(-200, 100, 900, 600), &monitors),
            Some(&monitors[0])
        );
        assert_eq!(
            select_monitor(rect(7000, 4000, 500, 500), &monitors),
            Some(&monitors[0])
        );
        assert_eq!(
            rect(-600, 100, 900, 600).overlap(monitors[1].bounds),
            360_000
        );
    }

    #[test]
    fn dpi_change_preserves_logical_size_and_work_area_offset() {
        let saved = WindowPlacement::new(
            rect(-1500, 140, 900, 600),
            rect(-1600, 40, 1600, 1000),
            1.0,
            true,
        )
        .unwrap();
        let monitors = [monitor(
            rect(-2400, 0, 2400, 1600),
            rect(-2400, 60, 2400, 1540),
            1.5,
            true,
        )];
        let fitted = saved.recover(&monitors, (720.0, 480.0), (16, 40)).unwrap();
        assert_eq!(fitted.normal_bounds, rect(-2250, 210, 1350, 900));
        assert_eq!(fitted.work_area, monitors[0].work_area);
        assert_eq!(fitted.scale_factor, 1.5);
        assert!(fitted.maximized);
    }

    #[test]
    fn disconnected_display_uses_primary_and_fits_outer_frame_after_dpi_change() {
        let saved = WindowPlacement::new(
            rect(7000, -2000, 1000, 800),
            rect(6000, -2100, 2000, 1500),
            2.0,
            false,
        )
        .unwrap();
        let monitors = [monitor(
            rect(0, 0, 1280, 720),
            rect(0, 30, 1280, 690),
            1.0,
            true,
        )];
        let fitted = saved.recover(&monitors, (720.0, 480.0), (16, 40)).unwrap();
        assert_eq!(fitted.normal_bounds, rect(500, 80, 736, 520));
        assert_eq!(fitted.normal_bounds.overlap(fitted.work_area), 736 * 520);
    }

    #[test]
    fn tiny_work_area_overrides_minimum_and_clamps_all_frame_edges() {
        let saved = WindowPlacement::new(
            rect(-50, -100, 2000, 1500),
            rect(0, 0, 2000, 1600),
            1.0,
            false,
        )
        .unwrap();
        let monitors = [monitor(
            rect(0, 0, 600, 340),
            rect(0, 40, 600, 300),
            2.0,
            true,
        )];
        let fitted = saved.recover(&monitors, (720.0, 480.0), (32, 80)).unwrap();
        assert_eq!(fitted.normal_bounds, monitors[0].work_area);
        let same = fitted.recover(&monitors, (720.0, 480.0), (32, 80)).unwrap();
        assert_eq!(same, fitted);
    }

    #[test]
    fn maximized_workspace_coordinates_include_top_and_left_taskbar_offsets() {
        assert_eq!(
            workspace_to_screen(
                rect(-1500, -160, 800, 600),
                rect(-1600, -200, 1600, 1200),
                rect(-1550, -160, 1550, 1160)
            )
            .unwrap(),
            rect(-1450, -120, 800, 600)
        );
        assert!(workspace_to_screen(
            rect(i32::MAX - 10, 0, 10, 10),
            rect(0, 0, 100, 100),
            rect(20, 0, 80, 100)
        )
        .is_err());
    }

    #[test]
    fn strict_schema_rejects_unknown_fields_types_rectangles_and_nonfinite_scale() {
        let valid = json!({"schemaVersion":1,"normalBounds":{"x":-100,"y":40,"width":900,"height":600},"workArea":{"x":-1600,"y":0,"width":1600,"height":1000},"scaleFactor":1.25,"maximized":false});
        let decoded: WindowPlacement = serde_json::from_value(valid.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), valid);
        for (field, value) in [
            ("schemaVersion", json!(2)),
            ("schemaVersion", json!("1")),
            ("schemaVersion", json!(1.0)),
            ("scaleFactor", json!(0)),
            ("scaleFactor", json!(-1)),
            ("scaleFactor", json!("1.25")),
            ("maximized", json!(1)),
            ("extra", json!(true)),
            ("workArea", json!(null)),
        ] {
            let mut invalid = valid.clone();
            invalid[field] = value;
            assert!(
                serde_json::from_value::<WindowPlacement>(invalid).is_err(),
                "accepted field {field}"
            );
        }
        for (field, value) in [
            ("width", json!(0)),
            ("height", json!(-1)),
            ("width", json!(900.5)),
            ("x", json!(i32::MAX)),
            ("x", json!(null)),
            ("extra", json!(true)),
        ] {
            let mut invalid = valid.clone();
            invalid["normalBounds"][field] = value;
            assert!(
                serde_json::from_value::<WindowPlacement>(invalid).is_err(),
                "accepted rectangle field {field}"
            );
        }
        for scale in [f64::INFINITY, f64::NEG_INFINITY, f64::NAN, 0.0] {
            assert!(
                WindowPlacement::new(decoded.normal_bounds, decoded.work_area, scale, false)
                    .is_err()
            );
        }
        assert!(decoded.recover(&[], (720.0, 480.0), (16, 40)).is_none());
    }
}
