//! Actual production bridge + native child view regression, not a DOM-click mock.
use super::{bridge_call, browser, browser_bridge, evidence};
use base64::Engine;
use serde_json::json;
use std::time::Duration;
use tauri::{Manager, Webview};

async fn content_size(view: &Webview) -> Result<(f64, f64), String> {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let (tx, rx) = tokio::sync::oneshot::channel();
        view.with_webview(move |platform| {
            // Wry bounds() uses allocated_size(), which includes GTK margins.
            // The actual child content rectangle excludes those margins.
            let rect = platform.inner().allocation();
            let _ = tx.send((f64::from(rect.width()), f64::from(rect.height())));
        })
        .map_err(|_| "native content geometry dispatch failed")?;
        tokio::time::timeout(Duration::from_secs(8), rx)
            .await
            .map_err(|_| "native content geometry timed out")?
            .map_err(|_| "native content geometry callback closed".into())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let size = view
            .size()
            .map_err(|_| "fit native size missing")?
            .to_logical::<f64>(
                view.window()
                    .scale_factor()
                    .map_err(|_| "native scale missing")?,
            );
        Ok((size.width, size.height))
    }
}

pub async fn run(app: &tauri::AppHandle, guest: &Webview) -> Result<(), String> {
    let main = app.get_webview("main").ok_or("main missing")?;
    let bridge = app.state::<browser_bridge::BrowserBridge>();
    let connection = bridge.start(app).await?;
    evidence(guest,r#"(() => {
      window.fitClicks=[];
      const layer=document.createElement('div');layer.id='fit-fixture';layer.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483000';
      for(const [id,position,color] of [['tl','left:4px;top:4px','rgb(255,0,0)'],['tr','right:4px;top:4px','rgb(0,255,0)'],['bl','left:4px;bottom:4px','rgb(0,0,255)'],['br','right:4px;bottom:4px','rgb(255,255,0)']]){
        const button=document.createElement('button');button.id='fit-'+id;button.setAttribute('aria-label','Fit corner '+id);
        button.style.cssText='position:absolute;width:40px;height:24px;padding:0;border:0;pointer-events:auto;'+position+';background:'+color;
        button.onclick=e=>fitClicks.push({id,trusted:e.isTrusted});layer.append(button);
      }
      const panel=document.createElement('div');panel.style.cssText='position:absolute;left:50%;top:90px;transform:translateX(-50%);width:1000px;height:160px;pointer-events:none';
      const check=document.createElement('input');check.type='checkbox';check.id='fit-checkbox';check.setAttribute('aria-label','Fit modal permission');check.style.cssText='position:absolute;left:20px;top:20px;width:24px;height:24px;margin:0;pointer-events:auto';panel.append(check);layer.append(panel);document.body.append(layer);return true;
    })()"#).await?;
    let mut cases = Vec::new();
    for (index, width, height) in [(0, 426, 500), (1, 640, 400), (2, 360, 500)] {
        let prior = bridge_call(connection, "production-probe", "screenshot", json!({})).await?;
        browser::desktop_browser_bounds(
            main.clone(),
            app.state(),
            serde_json::from_value(json!({"x":10,"y":20,"width":width,"height":height})).unwrap(),
            Some(browser::viewport::Viewport {
                width: 1280,
                height: 720,
            }),
        )
        .await?;
        let stale = bridge_call(
            connection,
            "production-probe",
            "input",
            json!({"action":"click","frame_id":prior["result"]["frame_id"],"x":10,"y":10}),
        )
        .await?;
        if stale["result"]["effect"] != "not_started" {
            return Err("resize accepted an old native frame".into());
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
        loop {
            let dimensions = evidence(guest, "({width:innerWidth,height:innerHeight})").await?;
            let w = dimensions["width"].as_f64().unwrap_or_default();
            let h = dimensions["height"].as_f64().unwrap_or_default();
            if (w - 1280.0).abs() < 8.0 && (h - 720.0).abs() < 8.0 {
                break;
            }
            if tokio::time::Instant::now() > deadline {
                return Err(format!("fit viewport did not settle: {dimensions}"));
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        evidence(guest,"(() => {fitClicks=[];document.querySelector('#fit-checkbox').checked=false;return true})()").await?;
        let capture = bridge_call(connection, "production-probe", "screenshot", json!({})).await?;
        let png = base64::engine::general_purpose::STANDARD
            .decode(
                capture["result"]["png_base64"]
                    .as_str()
                    .ok_or("fit PNG missing")?,
            )
            .map_err(|_| "invalid fit PNG")?;
        let (native_width, native_height) = content_size(guest).await?;
        if native_width < 1.0
            || native_height < 1.0
            || native_width > f64::from(width) + 2.0
            || native_height > f64::from(height) + 2.0
        {
            return Err(format!("native preview overflowed its pane: native={native_width}x{native_height}, pane={width}x{height}, viewport={}",capture["result"]["viewport"]));
        }
        let markers=evidence(guest,"['tl','tr','bl','br'].map(id=>{const r=document.getElementById('fit-'+id).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})").await?;
        if let Some(root) = std::env::var_os("XHARNESS_NATIVE_API_EVIDENCE") {
            std::fs::write(
                std::path::PathBuf::from(root).join(format!("fit-{index}.png")),
                png,
            )
            .map_err(|_| "fit image write failed")?;
        }
        for id in ["tl", "tr", "bl", "br", "checkbox"] {
            let point=evidence(guest,&format!("(() => {{const r=document.getElementById('fit-{id}').getBoundingClientRect();return {{x:r.x+r.width/2,y:r.y+r.height/2}}}})()")).await?;
            let observation =
                bridge_call(connection, "production-probe", "observe", json!({})).await?;
            let receipt=bridge_call(connection,"production-probe","input",json!({"action":"click","frame_id":observation["result"]["frame_id"],"x":point["x"],"y":point["y"]})).await?;
            if receipt["result"]["effect"] != "applied" {
                return Err(format!("fit native click failed: {receipt}"));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let effects = evidence(
            guest,
            "({clicks:fitClicks,checked:document.querySelector('#fit-checkbox').checked})",
        )
        .await?;
        let clicks = effects["clicks"]
            .as_array()
            .ok_or("fit native clicks missing")?;
        if clicks.len() != 4
            || clicks
                .iter()
                .zip(["tl", "tr", "bl", "br"])
                .any(|(c, id)| c["id"] != id || c["trusted"] != true)
            || effects["checked"] != true
        {
            return Err(format!("fit actual page effects mismatch: {effects}"));
        }
        cases.push(json!({"index":index,"pane":[width,height],"preview":{"width":native_width,"height":native_height},"viewport":capture["result"]["viewport"],"image":capture["result"]["image"],"markers":markers,"trusted_corners":true,"modal_checkbox":true,"stale_frame":"denied"}));
    }
    browser::desktop_browser_bounds(
        main,
        app.state(),
        serde_json::from_value(json!({"x":0,"y":0,"width":780,"height":560})).unwrap(),
        None,
    )
    .await?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let restored = evidence(guest, "innerWidth").await?;
    if restored.as_f64().unwrap_or_default() > 800.0 {
        return Err("responsive viewport did not restore".into());
    }
    evidence(
        guest,
        "(() => {document.getElementById('fit-fixture').remove();return true})()",
    )
    .await?;
    println!(
        "FIT_VIEWPORT_EVIDENCE {}",
        json!({"passed":true,"cases":cases,"responsive_restored":true,"test_only":true})
    );
    Ok(())
}
