use super::*;

fn visual() -> WireFeatures {
    // Numeric synthetic reconstruction of the incident's measured totals.
    // Shape is synthetic; no screenshots, prompts or user data are included.
    WireFeatures {
        buckets: [189_318, 202_698, 6_360],
        framing: 68_743,
        image_tokens: 906_197,
        images: Some(ImageFeatures {
            count: 130,
            pixels: 130 * 1920 * 1080,
            max_width: 1920,
            max_height: 1080,
        }),
    }
}

fn warm() -> (Calibration, String, WireFeatures) {
    let mut c = Calibration::default();
    let scope = "a".repeat(64);
    let f = visual();
    for i in 0..8 {
        c.observe(&scope, &format!("{i:064x}"), f.clone(), 197_454);
    }
    (c, scope, f)
}

#[test]
fn complete_visual_envelope_does_not_add_images_twice() {
    let (c, scope, f) = warm();
    let result = c.estimate(&scope, &f);
    assert_eq!(result.input_tokens, 247_074);
    assert!(result.input_tokens >= 197_454);
    assert!(result.input_tokens < 253_952);
    assert_eq!(result.accuracy, TokenCountAccuracy::Estimated);
    assert!(result.counter.starts_with("wire-calibration/v2:"));
    let text = WireFeatures {
        image_tokens: 0,
        images: None,
        ..f
    };
    assert_eq!(
        c.estimate(&scope, &text).input_tokens,
        text.units(),
        "mixed totals never train pure text"
    );
}

#[test]
fn warmup_shape_scope_and_extrapolation_fail_cold() {
    let (c, scope, mut f) = warm();
    assert_eq!(
        Calibration::default().estimate(&scope, &f).input_tokens,
        f.units() + f.image_tokens
    );
    assert_eq!(
        c.estimate(&"b".repeat(64), &f).input_tokens,
        f.units() + f.image_tokens
    );
    f.images.as_mut().unwrap().max_width += 1;
    assert!(c.estimate(&scope, &f).input_tokens >= f.image_tokens);
    let (_, _, mut f) = warm();
    f.images.as_mut().unwrap().count *= 3;
    f.images.as_mut().unwrap().pixels *= 3;
    f.image_tokens *= 3;
    assert!(c.estimate(&scope, &f).input_tokens >= f.image_tokens);
}

#[test]
fn visual_growth_scales_the_complete_total_and_preserves_margin() {
    let (c, scope, mut f) = warm();
    f.images.as_mut().unwrap().count *= 2;
    f.images.as_mut().unwrap().pixels *= 2;
    f.image_tokens *= 2;
    assert_eq!(c.estimate(&scope, &f).input_tokens, 493_891);
}

#[test]
fn restart_preserves_shape_and_underestimate_invalidates_the_scope() {
    let (c, scope, f) = warm();
    let mut c = Calibration::restore(&c.snapshot().unwrap()).unwrap();
    let bound = c.estimate(&scope, &f).input_tokens;
    assert_eq!(bound, 247_074);
    // A repeated body must still reveal a changed upstream processor/usage.
    c.observe(&scope, &format!("{:064x}", 0), f.clone(), bound + 1);
    let restarted = Calibration::restore(&c.snapshot().unwrap()).unwrap();
    assert!(restarted.estimate(&scope, &f).input_tokens >= f.image_tokens);
}

#[test]
fn legacy_mixed_observations_cannot_price_current_visual_shape() {
    let mut c = Calibration::default();
    let f = visual();
    for i in 0..8 {
        c.observe(
            "s",
            &i.to_string(),
            WireFeatures {
                images: None,
                ..f.clone()
            },
            1,
        );
    }
    assert!(c.mixed_request_upper("s", &f).is_none());
}

#[test]
fn attachment_caption_is_text_not_visual_allowance() {
    let mut f = visual();
    let allowance = f.image_tokens;
    let old_text = f.units();
    f.add_attachment_text("caption 中文");
    assert_eq!(f.image_tokens, allowance);
    assert_eq!(f.units() - old_text, "caption 中文".len() as u64 + 64);
}

#[test]
fn malformed_visual_observations_do_not_poison_warm_calibration() {
    let (mut c, scope, f) = warm();
    let before = c.snapshot().unwrap();
    for shape in [
        ImageFeatures::default(),
        ImageFeatures {
            count: 1_000_001,
            ..f.images.clone().unwrap()
        },
    ] {
        c.observe(
            &scope,
            &format!("{:064x}", 99),
            WireFeatures {
                images: Some(shape),
                ..f.clone()
            },
            1_000_000_000,
        );
    }
    c.observe(&scope, &format!("{:064x}", 99), f.clone(), 0);
    assert_eq!(c.snapshot().unwrap(), before);
    assert_eq!(c.estimate(&scope, &f).input_tokens, 247_074);
}
