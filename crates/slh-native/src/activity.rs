use std::time::Duration;
#[derive(Debug, Clone)]
pub struct Activity {
    pub home: bool,
    pub minimized: bool,
    pub economy: bool,
    pub fps: u32,
    pub dirty: bool,
    pub yaw: f32,
    pub pitch: f32,
    pub zoom: f32,
}
impl Default for Activity {
    fn default() -> Self {
        Self {
            home: true,
            minimized: false,
            economy: false,
            fps: 30,
            dirty: true,
            yaw: 0.,
            pitch: 0.12,
            zoom: 1.,
        }
    }
}
impl Activity {
    pub fn animating(&self) -> bool {
        self.home && !self.minimized && !self.economy
    }
    pub fn interval(&self) -> Duration {
        if self.fps == 0 {
            Duration::from_millis(1)
        } else {
            Duration::from_secs_f64(1. / self.fps.clamp(1, 60) as f64)
        }
    }
    pub fn frame_needed(&self) -> bool {
        self.home && !self.minimized && self.dirty
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn economy_has_no_continuous_frames() {
        let mut a = Activity::default();
        a.economy = true;
        a.dirty = false;
        assert!(!a.animating());
        assert!(!a.frame_needed());
        a.dirty = true;
        assert!(a.frame_needed());
    }
    #[test]
    fn minimize_stops_all_frames_and_restore_redraws() {
        let mut a = Activity::default();
        a.minimized = true;
        assert!(!a.animating());
        assert!(!a.frame_needed());
        a.minimized = false;
        a.dirty = true;
        assert!(a.frame_needed());
    }
    #[test]
    fn library_stops_idle() {
        let mut a = Activity::default();
        a.home = false;
        assert!(!a.animating());
        assert!(!a.frame_needed());
    }
    #[test]
    fn cap_has_full_range() {
        for fps in 1..=60 {
            let mut a = Activity::default();
            a.fps = fps;
            assert!((a.interval().as_secs_f64() - 1. / fps as f64).abs() < 1e-8);
        }
    }
}
