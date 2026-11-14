//! Trusted final-image geometry; never accepts model-supplied scale factors.
#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::let_underscore_must_use,
    unused_must_use
)]
#![cfg_attr(
    not(test),
    forbid(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::let_underscore_must_use,
        unused_must_use
    )
)]

use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

const MAX_OWNERS: usize = 64;
const MAX_AGE: Duration = Duration::from_secs(120);

pub(super) struct Projection {
    frame: String,
    css: (f64, f64),
    image: (u32, u32),
    created: Instant,
}

impl Projection {
    pub(super) fn annotate(
        result: &mut Value,
        image: (u32, u32),
        source: (u32, u32),
    ) -> Result<Self, String> {
        let frame = result["frame_id"]
            .as_str()
            .filter(|id| id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or("invalid screenshot frame")?
            .to_owned();
        let css = result["viewport"]["width"]
            .as_f64()
            .zip(result["viewport"]["height"].as_f64())
            .filter(|(w, h)| {
                [*w, *h]
                    .iter()
                    .all(|n| n.is_finite() && *n > 0.0 && *n <= 8192.0)
            })
            .ok_or("invalid screenshot CSS viewport")?;
        if image.0 == 0 || image.1 == 0 {
            return Err("invalid screenshot image geometry".into());
        }
        result["source_image"] = json!({"width":source.0,"height":source.1});
        result["image"] = json!({"width":image.0,"height":image.1});
        result["image_to_viewport"] =
            json!({"scale_x":css.0/f64::from(image.0),"scale_y":css.1/f64::from(image.1)});
        result["resolution"] = json!({"css_1x_or_better":f64::from(image.0)>=css.0-1.0 && f64::from(image.1)>=css.1-1.0,"host_upscaled":false});
        result["coordinate_space"] = json!("input defaults to CSS viewport pixels; coordinate_space=image uses final attached image pixels and a frame-bound Host transform");
        Ok(Self {
            frame,
            css,
            image,
            created: Instant::now(),
        })
    }
}

#[derive(Default)]
pub(super) struct Projections(HashMap<(bool, String), Projection>);

impl Projections {
    pub(super) fn forget(&mut self, headless: bool, owner: &str) {
        self.0.remove(&(headless, owner.to_owned()));
    }
    pub(super) fn remember(&mut self, headless: bool, owner: &str, frame: Projection) {
        self.0.retain(|_, p| p.created.elapsed() <= MAX_AGE);
        if self.0.len() >= MAX_OWNERS {
            if let Some(oldest) = self
                .0
                .iter()
                .min_by_key(|(_, p)| p.created)
                .map(|(k, _)| k.clone())
            {
                self.0.remove(&oldest);
            }
        }
        self.0.insert((headless, owner.to_owned()), frame);
    }
    pub(super) fn input(
        &mut self,
        headless: bool,
        owner: &str,
        args: &mut Map<String, Value>,
    ) -> Result<(), String> {
        match args.remove("coordinate_space") {
            None => {
                self.forget(headless, owner);
                return Ok(());
            }
            Some(Value::String(s)) if s == "css" => {
                self.forget(headless, owner);
                return Ok(());
            }
            Some(Value::String(s)) if s == "image" => {}
            _ => return Err("invalid browser coordinate_space; effect: not_started".into()),
        }
        if !matches!(
            args.get("action").and_then(Value::as_str),
            Some("click" | "move")
        ) {
            return Err("image coordinates require click or move; effect: not_started".into());
        }
        let p = self
            .0
            .remove(&(headless, owner.to_owned()))
            .filter(|p| {
                p.created.elapsed() <= MAX_AGE
                    && args.get("frame_id").and_then(Value::as_str) == Some(p.frame.as_str())
            })
            .ok_or("stale_image_frame: capture again; effect: not_started")?;
        let (x, y) = args
            .get("x")
            .and_then(Value::as_f64)
            .zip(args.get("y").and_then(Value::as_f64))
            .filter(|(x, y)| {
                x.is_finite()
                    && y.is_finite()
                    && *x >= 0.0
                    && *y >= 0.0
                    && *x < f64::from(p.image.0)
                    && *y < f64::from(p.image.1)
            })
            .ok_or("point outside final browser image; effect: not_started")?;
        args.insert("x".into(), json!(x * p.css.0 / f64::from(p.image.0)));
        args.insert("y".into(), json!(y * p.css.1 / f64::from(p.image.1)));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn projection() -> Projection {
        Projection::annotate(&mut json!({"frame_id":"a".repeat(32),"viewport":{"width":1280,"height":721},"image":{"width":9999,"height":9999}}),(426,240),(2560,1442)).unwrap()
    }
    fn input() -> Map<String, Value> {
        json!({"action":"click","frame_id":"a".repeat(32),"coordinate_space":"image","x":213.0,"y":120.0}).as_object().unwrap().clone()
    }
    #[test]
    fn final_png_dimensions_override_raw_or_claimed_image_size() {
        let mut v = json!({"frame_id":"a".repeat(32),"viewport":{"width":1280,"height":721},"image":{"width":2560,"height":1442}});
        Projection::annotate(&mut v, (1600, 901), (2560, 1442)).unwrap();
        assert_eq!(v["image"], json!({"width":1600,"height":901}));
        assert_eq!(v["image_to_viewport"]["scale_x"], json!(0.8));
    }
    #[test]
    fn image_mapping_is_scoped_by_owner_backend_frame_and_consumed_once() {
        let mut p = Projections::default();
        p.remember(false, "owner", projection());
        assert!(p.input(false, "other", &mut input()).is_err());
        assert!(p.input(true, "owner", &mut input()).is_err());
        let mut args = input();
        p.input(false, "owner", &mut args).unwrap();
        assert_eq!(args["x"], json!(640.0));
        assert_eq!(args["y"], json!(360.5));
        assert!(!args.contains_key("coordinate_space"));
        assert!(p.input(false, "owner", &mut input()).is_err());
    }
    #[test]
    fn legacy_css_points_are_unchanged_and_discard_old_image_projection() {
        let mut p = Projections::default();
        p.remember(false, "owner", projection());
        let mut args = input();
        args.remove("coordinate_space");
        let prior = args.clone();
        p.input(false, "owner", &mut args).unwrap();
        assert_eq!(args, prior);
        assert!(p.input(false, "owner", &mut input()).is_err());
    }
    #[test]
    fn resized_expired_or_invalid_points_never_reach_native_input() {
        let mut p = Projections::default();
        let mut old = projection();
        old.created = Instant::now() - MAX_AGE - Duration::from_secs(1);
        p.remember(false, "owner", old);
        assert!(p.input(false, "owner", &mut input()).is_err());
        for (k, v) in [
            ("x", json!(426)),
            ("y", json!(-1)),
            ("frame_id", json!("b".repeat(32))),
            ("action", json!("key")),
        ] {
            p.remember(false, "owner", projection());
            let mut args = input();
            args.insert(k.into(), v);
            assert!(p.input(false, "owner", &mut args).is_err());
        }
    }
    #[test]
    fn cache_is_bounded_and_replacement_never_reuses_old_geometry() {
        let mut p = Projections::default();
        for i in 0..80 {
            p.remember(false, &i.to_string(), projection());
        }
        assert!(p.0.len() <= MAX_OWNERS);
        let mut v = json!({"frame_id":"b".repeat(32),"viewport":{"width":640,"height":360}});
        p.remember(
            false,
            "owner",
            Projection::annotate(&mut v, (640, 360), (640, 360)).unwrap(),
        );
        assert!(p.input(false, "owner", &mut input()).is_err());
    }
}
