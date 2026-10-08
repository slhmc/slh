use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::database;
use crate::error::{AppError, AppResult};

const SETTING_KEY: &str = "window_state";
const DEFAULT_WIDTH: u32 = 1480;
const DEFAULT_HEIGHT: u32 = 920;
const MIN_WIDTH: u32 = 800;
const MIN_HEIGHT: u32 = 560;
const MIN_VISIBLE_WIDTH: i64 = 160;
const MIN_VISIBLE_HEIGHT: i64 = 96;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WindowPlacement {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct WorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
}

pub async fn restore(window: &WebviewWindow, pool: &SqlitePool) -> AppResult<()> {
    let monitors = window.available_monitors().map_err(|e| AppError::Window(e.to_string()))?;
    let primary = window.primary_monitor().map_err(|e| AppError::Window(e.to_string()))?;
    let work_areas = monitors
        .iter()
        .map(|monitor| WorkArea {
            x: monitor.work_area().position.x,
            y: monitor.work_area().position.y,
            width: monitor.work_area().size.width,
            height: monitor.work_area().size.height,
            scale_factor: monitor.scale_factor(),
        })
        .collect::<Vec<_>>();
    let primary_area = primary.as_ref().map(|monitor| WorkArea {
        x: monitor.work_area().position.x,
        y: monitor.work_area().position.y,
        width: monitor.work_area().size.width,
        height: monitor.work_area().size.height,
        scale_factor: monitor.scale_factor(),
    });
    let saved = load(pool).await?;
    let placement = normalize(saved, &work_areas, primary_area);

    window.set_size(PhysicalSize::new(placement.width, placement.height)).map_err(|e| AppError::Window(e.to_string()))?;
    window.set_position(PhysicalPosition::new(placement.x, placement.y)).map_err(|e| AppError::Window(e.to_string()))?;
    database::set_setting(pool, SETTING_KEY, &serde_json::to_value(placement)?).await?;
    if placement.maximized {
        window.maximize().map_err(|e| AppError::Window(e.to_string()))?;
    }
    Ok(())
}

pub async fn save(window: &WebviewWindow, pool: &SqlitePool) -> AppResult<()> {
    if window.is_minimized().map_err(|e| AppError::Window(e.to_string()))? {
        return Ok(());
    }
    let maximized = window.is_maximized().map_err(|e| AppError::Window(e.to_string()))?;
    let placement = if maximized {
        let mut previous = load(pool).await?.unwrap_or_else(|| {
            let position = window
                .outer_position()
                .unwrap_or(PhysicalPosition::new(0, 0));
            let size = window
                .outer_size()
                .unwrap_or(PhysicalSize::new(DEFAULT_WIDTH, DEFAULT_HEIGHT));
            WindowPlacement {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
                maximized: true,
            }
        });
        previous.maximized = true;
        previous
    } else {
        let position = window.outer_position().map_err(|e| AppError::Window(e.to_string()))?;
        let size = window.outer_size().map_err(|e| AppError::Window(e.to_string()))?;
        WindowPlacement {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
            maximized: false,
        }
    };
    database::set_setting(pool, SETTING_KEY, &serde_json::to_value(placement)?).await
}

async fn load(pool: &SqlitePool) -> AppResult<Option<WindowPlacement>> {
    Ok(database::all_settings(pool)
        .await?
        .get(SETTING_KEY)
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok()))
}

fn normalize(
    saved: Option<WindowPlacement>,
    work_areas: &[WorkArea],
    primary: Option<WorkArea>,
) -> WindowPlacement {
    let fallback = primary
        .or_else(|| work_areas.first().copied())
        .unwrap_or(WorkArea {
            x: 0,
            y: 0,
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            scale_factor: 1.0,
        });
    let Some(saved) = saved else {
        return centered(fallback, false);
    };
    let best = work_areas
        .iter()
        .copied()
        .map(|area| (intersection(saved, area), area))
        .max_by_key(|(intersection, _)| *intersection);
    let minimum_visible = MIN_VISIBLE_WIDTH * MIN_VISIBLE_HEIGHT;
    match best {
        Some((intersection, area)) if intersection >= minimum_visible => fit(saved, area),
        _ => centered(fallback, saved.maximized),
    }
}

fn centered(area: WorkArea, maximized: bool) -> WindowPlacement {
    let minimum_width = scaled(MIN_WIDTH, area.scale_factor).min(area.width).max(1);
    let minimum_height = scaled(MIN_HEIGHT, area.scale_factor)
        .min(area.height)
        .max(1);
    let width = scaled(DEFAULT_WIDTH, area.scale_factor)
        .min(area.width.saturating_mul(9) / 10)
        .max(minimum_width);
    let height = scaled(DEFAULT_HEIGHT, area.scale_factor)
        .min(area.height.saturating_mul(9) / 10)
        .max(minimum_height);
    WindowPlacement {
        x: area.x.saturating_add(((area.width - width) / 2) as i32),
        y: area.y.saturating_add(((area.height - height) / 2) as i32),
        width,
        height,
        maximized,
    }
}

fn fit(saved: WindowPlacement, area: WorkArea) -> WindowPlacement {
    let minimum_width = scaled(MIN_WIDTH, area.scale_factor).min(area.width).max(1);
    let minimum_height = scaled(MIN_HEIGHT, area.scale_factor)
        .min(area.height)
        .max(1);
    let width = saved.width.clamp(minimum_width, area.width.max(1));
    let height = saved.height.clamp(minimum_height, area.height.max(1));
    let max_x = i64::from(area.x) + i64::from(area.width - width);
    let max_y = i64::from(area.y) + i64::from(area.height - height);
    WindowPlacement {
        x: i64::from(saved.x).clamp(i64::from(area.x), max_x) as i32,
        y: i64::from(saved.y).clamp(i64::from(area.y), max_y) as i32,
        width,
        height,
        maximized: saved.maximized,
    }
}

fn scaled(value: u32, factor: f64) -> u32 {
    (f64::from(value) * factor.max(0.1)).round() as u32
}

fn intersection(window: WindowPlacement, area: WorkArea) -> i64 {
    let left = i64::from(window.x).max(i64::from(area.x));
    let top = i64::from(window.y).max(i64::from(area.y));
    let right = (i64::from(window.x) + i64::from(window.width))
        .min(i64::from(area.x) + i64::from(area.width));
    let bottom = (i64::from(window.y) + i64::from(window.height))
        .min(i64::from(area.y) + i64::from(area.height));
    (right - left).max(0) * (bottom - top).max(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRIMARY: WorkArea = WorkArea {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
        scale_factor: 1.0,
    };

    #[test]
    fn first_launch_is_centered_in_the_work_area() {
        let placement = normalize(None, &[PRIMARY], Some(PRIMARY));
        assert_eq!(placement.width, 1480);
        assert_eq!(placement.height, 920);
        assert_eq!((placement.x, placement.y), (220, 60));
    }

    #[test]
    fn disconnected_monitor_placement_returns_to_primary() {
        let saved = WindowPlacement {
            x: 4000,
            y: 200,
            width: 1200,
            height: 800,
            maximized: false,
        };
        let placement = normalize(Some(saved), &[PRIMARY], Some(PRIMARY));
        assert_eq!((placement.x, placement.y), (220, 60));
    }

    #[test]
    fn high_dpi_default_stays_inside_the_monitor() {
        let high_dpi = WorkArea {
            x: 0,
            y: 0,
            width: 2048,
            height: 1840,
            scale_factor: 2.0,
        };
        let placement = normalize(None, &[high_dpi], Some(high_dpi));
        assert!(placement.width <= high_dpi.width);
        assert!(placement.height <= high_dpi.height);
        assert_eq!(placement.x, ((high_dpi.width - placement.width) / 2) as i32);
        assert_eq!(
            placement.y,
            ((high_dpi.height - placement.height) / 2) as i32
        );
    }

    #[test]
    fn oversized_saved_window_is_clamped_to_monitor() {
        let saved = WindowPlacement {
            x: -500,
            y: -300,
            width: 5000,
            height: 3000,
            maximized: false,
        };
        let placement = normalize(Some(saved), &[PRIMARY], Some(PRIMARY));
        assert_eq!(
            placement,
            WindowPlacement {
                x: 0,
                y: 0,
                width: 1920,
                height: 1040,
                maximized: false,
            }
        );
    }

    #[test]
    fn negative_monitor_coordinates_are_preserved_when_valid() {
        let left = WorkArea {
            x: -1280,
            y: 40,
            width: 1280,
            height: 984,
            scale_factor: 1.0,
        };
        let saved = WindowPlacement {
            x: -1200,
            y: 80,
            width: 1000,
            height: 700,
            maximized: true,
        };
        assert_eq!(
            normalize(Some(saved), &[PRIMARY, left], Some(PRIMARY)),
            saved
        );
    }
}
